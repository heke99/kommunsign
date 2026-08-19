import { randomToken } from '../../../packages/crypto/src/tokens.js';
import {
  FederationError, mapWorkforceIdentity, verifyWorkforceAssertion,
  type FederationConfig, type FederationRequestBinding, type WorkforceAssertion,
} from '../../../packages/federation/src/index.js';
import type { ApiDependencies } from './ports.js';

/**
 * Workforce federation over the wire.
 *
 * `packages/federation` decides whether an assertion may log somebody in, and
 * that decision stays entirely there — every tenant rule in one place rather
 * than half of them restated in a route where the two copies can drift. This
 * module does three things and nothing else: it starts a login and remembers
 * what it started, it hands the raw assertion to the validation service for
 * signature verification, and it turns the resulting normalised assertion over
 * to the decision layer.
 *
 * Two properties are load-bearing and easy to lose:
 *
 *   - **The tenant comes from the login request we recorded**, never from the
 *     assertion. An assertion naming its own tenant would let one municipality's
 *     IdP authenticate users into another's.
 *   - **The assertion must answer a login we started.** IdP-initiated flows are
 *     refused, because otherwise a captured assertion can be posted at any time
 *     inside its validity window. That is why the login request is durable: in
 *     process memory it would be gone on restart and unknown to other instances,
 *     so the only flows that worked would be the ones we refuse.
 */

const MAX_ASSERTION_BYTES = 512 * 1024;
const LOGIN_REQUEST_LIFETIME_SECONDS = 600;
const PROVIDER_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;

export async function handleFederationRequest(
  dependencies: ApiDependencies,
  request: Request,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/auth/federation/')) return null;

  try {
    const federation = dependencies.federation;
    const validation = dependencies.federationValidation;
    if (!federation || !validation) {
      throw new FederationRouteError('FEDERATION_NOT_CONFIGURED', 'Federated login is not configured', 503);
    }

    const startMatch = /^\/auth\/federation\/([^/]+)\/login$/.exec(url.pathname);
    if (startMatch && request.method === 'POST') {
      return await startLogin(dependencies, federation, providerKey(startMatch[1] ?? ''), url, requestId);
    }

    const acsMatch = /^\/auth\/federation\/([^/]+)\/acs$/.exec(url.pathname);
    if (acsMatch && request.method === 'POST') {
      const form = await readForm(request);
      return await consumeAssertion(dependencies, federation, validation, providerKey(acsMatch[1] ?? ''), {
        kind: 'SAML2',
        // RelayState carries our own request id back. It is the only thing that
        // can identify the login before the assertion is parsed.
        loginReference: form.get('RelayState'),
        payload: form.get('SAMLResponse'),
      }, requestId);
    }

    const callbackMatch = /^\/auth\/federation\/([^/]+)\/callback$/.exec(url.pathname);
    if (callbackMatch && (request.method === 'GET' || request.method === 'POST')) {
      const parameters = request.method === 'GET'
        ? new Map([...url.searchParams].map(([key, value]) => [key, value] as const))
        : await readForm(request);
      // `state` plays the same role for OIDC that RelayState plays for SAML.
      return await consumeAssertion(dependencies, federation, validation, providerKey(callbackMatch[1] ?? ''), {
        kind: 'OIDC',
        loginReference: parameters.get('state') ?? null,
        payload: parameters.get('id_token') ?? null,
      }, requestId);
    }

    throw new FederationRouteError('FEDERATION_ROUTE_NOT_FOUND', 'No such federation endpoint', 404);
  } catch (error) {
    if (error instanceof FederationRouteError) return errorResponse(error.code, error.message, error.status, requestId);
    if (error instanceof FederationError) {
      // The code is safe to return — it names the rule, not the message — and a
      // caller that cannot tell "expired" from "wrong audience" cannot fix
      // their configuration. 401 throughout: none of these are retryable.
      return errorResponse(error.code, 'The assertion was not accepted', 401, requestId);
    }
    dependencies.reportError?.(error, requestId);
    return errorResponse('FEDERATION_FAILED', 'The federated login could not be completed', 500, requestId);
  }
}

/**
 * Starts a login and records the binding the assertion will have to match.
 *
 * The return path is stored rather than accepted at the ACS. A return URL the
 * caller supplies when presenting an assertion is an open redirect with extra
 * steps, and an open redirect on a login endpoint is a phishing primitive.
 */
async function startLogin(
  dependencies: ApiDependencies,
  federation: NonNullable<ApiDependencies['federation']>,
  provider: string,
  url: URL,
  requestId: string,
): Promise<Response> {
  const tenantId = requireUuid(url.searchParams.get('tenantId'), 'tenantId');
  const environment = requireEnvironment(url.searchParams.get('environment') ?? 'production');
  const returnPath = safeReturnPath(url.searchParams.get('returnPath'));

  const config = await federation.configFor(tenantId, provider, environment);
  if (!config) throw new FederationRouteError('FEDERATION_PROVIDER_NOT_CONFIGURED', 'No such identity provider for this tenant', 404);
  if (!config.enabled) throw new FederationRouteError('FEDERATION_PROVIDER_DISABLED', 'Federation is not enabled for this tenant', 403);

  // Prefixed with an underscore because a SAML ID must be an xsd:ID, which may
  // not start with a digit. A random token that happened to begin with one
  // would produce a message some IdPs reject and others accept.
  const federationRequestId = `_${randomToken(32)}`;
  await federation.startLogin({
    tenantId,
    requestId: federationRequestId,
    providerKey: provider,
    environment,
    redirectUri: config.destination,
    returnPath,
    lifetimeSeconds: LOGIN_REQUEST_LIFETIME_SECONDS,
  });

  return json({
    requestId: federationRequestId,
    issuer: config.issuer,
    audience: config.audience,
    destination: config.destination,
    protocol: config.protocol,
    expiresInSeconds: LOGIN_REQUEST_LIFETIME_SECONDS,
  }, 201, requestId);
}

/**
 * Consumes an assertion posted to the ACS.
 *
 * Order matters here. The login request is consumed first, because it is what
 * establishes the tenant and therefore which configuration and which trust
 * certificate apply. Reading anything from the assertion before that would mean
 * choosing a tenant based on attacker-supplied bytes.
 */
interface PresentedAssertion {
  readonly kind: 'SAML2' | 'OIDC';
  readonly loginReference: string | null | undefined;
  readonly payload: string | null | undefined;
}

async function consumeAssertion(
  dependencies: ApiDependencies,
  federation: NonNullable<ApiDependencies['federation']>,
  validation: NonNullable<ApiDependencies['federationValidation']>,
  provider: string,
  presented: PresentedAssertion,
  requestId: string,
): Promise<Response> {
  const payload = presented.payload;
  const loginReference = presented.loginReference;
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new FederationRouteError('FEDERATION_ASSERTION_MISSING', 'No assertion was presented', 400);
  }
  if (payload.length > MAX_ASSERTION_BYTES) {
    throw new FederationRouteError('FEDERATION_ASSERTION_TOO_LARGE', 'The assertion is too large', 413);
  }
  if (typeof loginReference !== 'string' || !/^_[A-Za-z0-9_-]{16,255}$/.test(loginReference)) {
    throw new FederationRouteError('FEDERATION_RELAY_STATE_INVALID', 'The assertion does not identify a login we started', 400);
  }

  const login = await federation.consumeLogin(loginReference, new Date());
  // Unknown, expired and already-answered are one response. Telling them apart
  // would confirm which request ids existed.
  if (!login) throw new FederationRouteError('FEDERATION_LOGIN_REQUEST_INVALID', 'The assertion does not answer a login we started', 401);
  if (login.providerKey !== provider) {
    throw new FederationRouteError('FEDERATION_LOGIN_REQUEST_INVALID', 'The assertion does not answer a login we started', 401);
  }

  const config = await federation.configFor(login.tenantId, login.providerKey, login.environment);
  if (!config) throw new FederationRouteError('FEDERATION_PROVIDER_NOT_CONFIGURED', 'No such identity provider for this tenant', 404);

  const trustedCertificateBase64 = await dependencies.federationTrust?.(config, login.tenantId);
  if (!trustedCertificateBase64) {
    // Fail closed. Without the configured certificate the only thing that could
    // be verified is that the message signed itself.
    throw new FederationRouteError('FEDERATION_TRUST_NOT_CONFIGURED', 'No IdP signing certificate is configured for this tenant', 503);
  }

  // The protocol comes from the tenant's configuration, not from which endpoint
  // was called. A tenant configured for SAML must not be able to log in with an
  // id_token by posting to the callback instead.
  if (config.protocol !== presented.kind) {
    throw new FederationRouteError('FEDERATION_PROTOCOL_MISMATCH', 'That endpoint is not the one this tenant is configured for', 400);
  }

  const report = presented.kind === 'SAML2'
    ? await validation.validateSaml({
        responseXmlBase64: payload,
        trustedCertificateBase64,
        expectedAudience: config.audience,
        expectedDestination: config.destination,
      })
    : await validation.validateOidc({
        idToken: payload,
        trustedCertificateBase64,
        expectedIssuer: config.issuer,
        expectedAudience: config.audience,
        // The nonce must equal the login we started. Supplying it here means the
        // validator reports the comparison, and the decision layer enforces it
        // through the same InResponseTo check SAML uses.
        expectedNonce: login.requestId,
      });

  const binding: FederationRequestBinding = {
    requestId: login.requestId,
    tenantId: login.tenantId,
    redirectUri: login.redirectUri,
  };
  // An id_token carries no destination claim, so the endpoint that received it
  // is what the decision layer compares — and it is our own recorded value, not
  // anything the token said.
  const assertion = toWorkforceAssertion(report, config, login.redirectUri);

  // The full decision, in one call, against the durable replay ledger.
  await verifyWorkforceAssertion(assertion, config, binding, federation.ledgerFor(login.tenantId), new Date());
  const identity = mapWorkforceIdentity(assertion, config, binding);

  return json({
    tenantId: identity.tenantId,
    subject: identity.subject,
    roles: identity.roles,
    authenticatedAt: identity.authenticatedAt,
    protocol: identity.protocol,
    returnPath: login.returnPath,
  }, 200, requestId);
}

/**
 * Turns the validator's report into the assertion the decision layer expects.
 *
 * `signatureVerified` is copied from the report and never assumed. Defaulting
 * it to true would make every check below it meaningless, since the decision
 * layer short-circuits on an unsigned assertion precisely because nothing else
 * means anything without it.
 */
function toWorkforceAssertion(
  report: { readonly result: string; readonly signatureVerified: boolean;
            readonly assertionId?: string; readonly issuer?: string | null;
            readonly audience?: string | null; readonly destination?: string | null;
            readonly inResponseTo?: string | null; readonly notBefore?: string | null;
            readonly notOnOrAfter?: string | null; readonly authenticatedAt?: string | null;
            readonly authnContext?: string | null; readonly subject?: string;
            readonly attributes?: Readonly<Record<string, readonly string[]>> },
  config: FederationConfig,
  receivedAt: string,
): WorkforceAssertion {
  if (report.result !== 'PASS' || !report.signatureVerified) {
    throw new FederationError('FEDERATION_SIGNATURE_NOT_VERIFIED', 'Assertion signature was not verified');
  }
  // A missing validity window is not a permissive one. Substituting a default
  // would turn an assertion with no expiry into one that never expires.
  if (!report.notOnOrAfter) throw new FederationError('FEDERATION_ASSERTION_EXPIRED', 'Assertion carries no validity window');
  if (!report.authenticatedAt) throw new FederationError('FEDERATION_SESSION_TOO_OLD', 'Assertion does not say when the user authenticated');
  if (!report.assertionId) throw new FederationError('FEDERATION_ASSERTION_REPLAYED', 'Assertion carries no identifier to consume');

  return {
    protocol: config.protocol,
    signatureVerified: report.signatureVerified,
    issuer: report.issuer ?? '',
    audience: report.audience ?? '',
    destination: report.destination ?? receivedAt,
    assertionId: report.assertionId,
    inResponseTo: report.inResponseTo ?? null,
    notBefore: report.notBefore ?? null,
    notOnOrAfter: report.notOnOrAfter,
    authenticatedAt: report.authenticatedAt,
    authnContext: report.authnContext ?? null,
    subject: report.subject ?? '',
    attributes: report.attributes ?? {},
  };
}

class FederationRouteError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = 'FederationRouteError';
  }
}

async function readForm(request: Request): Promise<Map<string, string>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.startsWith('application/x-www-form-urlencoded')) {
    throw new FederationRouteError('FEDERATION_CONTENT_TYPE_INVALID', 'An assertion is posted as a form', 415);
  }
  const text = await request.text();
  if (text.length > MAX_ASSERTION_BYTES * 2) {
    throw new FederationRouteError('FEDERATION_ASSERTION_TOO_LARGE', 'The assertion is too large', 413);
  }
  const parsed = new URLSearchParams(text);
  const form = new Map<string, string>();
  for (const [key, value] of parsed) if (!form.has(key)) form.set(key, value);
  return form;
}

function providerKey(value: string): string {
  if (!PROVIDER_KEY_PATTERN.test(value)) {
    throw new FederationRouteError('FEDERATION_PROVIDER_KEY_INVALID', 'The provider key is not valid', 400);
  }
  return value;
}

function requireUuid(value: string | null, field: string): string {
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new FederationRouteError('FEDERATION_REQUEST_INVALID', `${field} is required`, 400);
  }
  return value;
}

function requireEnvironment(value: string): string {
  if (!['development', 'test', 'staging', 'production'].includes(value)) {
    throw new FederationRouteError('FEDERATION_REQUEST_INVALID', 'environment is not valid', 400);
  }
  return value;
}

/**
 * A return path, not a return URL.
 *
 * Only a same-origin path is accepted, and `//host` is rejected explicitly
 * because a browser reads it as protocol-relative and follows it off-site — an
 * open redirect on the login endpoint, which is where phishing wants one.
 */
function safeReturnPath(value: string | null): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new FederationRouteError('FEDERATION_RETURN_PATH_INVALID', 'returnPath must be a same-origin path', 400);
  }
  return value.length > 512 ? '/' : value;
}

function json(body: unknown, status: number, requestId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
    },
  });
}

function errorResponse(code: string, message: string, status: number, requestId: string): Response {
  return json({ error: { code, message, requestId } }, status, requestId);
}
