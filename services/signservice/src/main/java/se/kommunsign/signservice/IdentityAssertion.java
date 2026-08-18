package se.kommunsign.signservice;

import java.util.List;

/**
 * The already-verified TIC/BankID identity evidence, restated for this service.
 *
 * This is deliberately not a live provider session. By the time a signing request
 * reaches here the BankID transaction has completed, its XML-DSig and OCSP have
 * been independently verified, and the result is an immutable artifact. Re-opening
 * a provider session at signing time would create a second, weaker identity path
 * next to the verified one — exactly the split this service exists to prevent.
 *
 * {@code documentSha256List} is the set of canonical document hashes the signer
 * saw and approved. A signing request naming any other document is refused.
 */
public record IdentityAssertion(
    String tenantId,
    String signatureCaseId,
    String signingIntentId,
    String signerId,
    String verificationReportSha256,
    String assuranceLevel,
    String verifiedAt,
    List<String> documentSha256List) {

    public IdentityAssertion {
        require(tenantId, "tenantId");
        require(signatureCaseId, "signatureCaseId");
        require(signingIntentId, "signingIntentId");
        require(signerId, "signerId");
        require(assuranceLevel, "assuranceLevel");
        require(verifiedAt, "verifiedAt");
        if (verificationReportSha256 == null || !verificationReportSha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("verificationReportSha256 must be a lowercase SHA-256 hex digest");
        }
        if (documentSha256List == null || documentSha256List.isEmpty()) {
            throw new IllegalArgumentException("documentSha256List required");
        }
        for (String hash : documentSha256List) {
            if (hash == null || !hash.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("documentSha256List entries must be SHA-256 hex digests");
        }
        documentSha256List = List.copyOf(documentSha256List);
    }

    private static void require(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " required");
    }
}
