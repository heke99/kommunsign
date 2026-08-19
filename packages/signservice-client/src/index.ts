/**
 * Client for the private SignService boundary.
 *
 * The service holds signing key material and is never published, so this client
 * is the only thing that talks to it. Every field sent is part of the binding the
 * service re-checks on arrival: the request states what it believes it is signing
 * and for whom, and the service refuses if its own view of the identity evidence
 * disagrees. Sending less would move that check to the only party that cannot
 * perform it independently.
 */

export interface SignServiceIdentityAssertion {
  readonly tenantId: string;
  readonly signatureCaseId: string;
  readonly signingIntentId: string;
  readonly signerId: string;
  readonly verificationReportSha256: string;
  readonly assuranceLevel: string;
  readonly verifiedAt: string;
  readonly documentSha256List: readonly string[];
}

export interface SignRequest {
  readonly tenantId: string;
  readonly signatureCaseId: string;
  readonly signingIntentId: string;
  readonly signerId: string;
  readonly documentVersionId: string;
  /** The canonical document hash the signer consented to. */
  readonly documentSha256: string;
  /** The hash of the revision actually submitted for signing. */
  readonly inputRevisionSha256: string;
  readonly verifiedIdentityEvidenceReference: string;
  readonly policyReference: string;
  readonly requestedPadesLevel: 'PAdES-B' | 'PAdES-T' | 'PAdES-LT' | 'PAdES-LTA';
  readonly signerSubjectAttributes?: readonly string[];
  readonly identityAssertion: SignServiceIdentityAssertion;
  readonly documentBase64: string;
}

export interface SignedArtifact {
  readonly status: 'SIGNED';
  readonly signedDocumentBase64: string;
  readonly signedRevisionSha256: string;
  readonly signingCertificateBase64: string;
  readonly certificateChainBase64: readonly string[];
  readonly signatureAlgorithm: string;
  readonly adesProfile: string;
  readonly signingTime: string;
}

export class SignServiceNotConfiguredError extends Error {
  constructor(message: string) { super(message); this.name = 'SignServiceNotConfiguredError'; }
}
export class SignServiceRefusedError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'SignServiceRefusedError'; }
}

export class SignServiceClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly serviceToken: string, private readonly http: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    // Plain HTTP is tolerated only on the private network the service lives on.
    // Anywhere else a signing request would cross a link someone can read.
    const privateHttp = parsed.protocol === 'http:'
      && (['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.hostname.endsWith('.railway.internal'));
    if (parsed.protocol !== 'https:' && !privateHttp) throw new Error('SIGNSERVICE_URL_INVALID');
    if (!serviceToken.trim()) throw new Error('SIGNSERVICE_TOKEN_MISSING');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
  }

  async sign(request: SignRequest): Promise<SignedArtifact> {
    const controller = new AbortController();
    // Signing a large PDF with an HSM round trip is slower than a validation
    // call, so this timeout is deliberately longer than the validation client's.
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const response = await this.http(`${this.baseUrl}/v1/sign`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.serviceToken}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as { readonly status?: string; readonly reason?: string } | null;

      // 503 means the deployment has no signing backend. That is an operator
      // task, not a bad request, and it must never be retried into a signature.
      if (response.status === 503) throw new SignServiceNotConfiguredError(body?.reason ?? 'SIGNSERVICE_NOT_CONFIGURED');
      if (response.status === 422) throw new SignServiceRefusedError(body?.reason ?? 'SIGNSERVICE_REFUSED');
      if (!response.ok) throw new Error(`SIGNSERVICE_FAILED:${response.status}`);

      const artifact = body as unknown as SignedArtifact | null;
      if (!artifact || artifact.status !== 'SIGNED' || !artifact.signedDocumentBase64 || !artifact.signedRevisionSha256) {
        throw new Error('SIGNSERVICE_PROTOCOL_INVALID');
      }
      if (!/^[0-9a-f]{64}$/.test(artifact.signedRevisionSha256)) throw new Error('SIGNSERVICE_PROTOCOL_INVALID');
      return artifact;
    } finally {
      clearTimeout(timeout);
    }
  }
}
