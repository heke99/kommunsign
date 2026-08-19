package se.kommunsign.signservice;

import java.util.List;
import java.util.Set;

/**
 * One request to produce a PAdES signature over one PDF revision.
 *
 * Two hashes are carried, and the difference between them is the whole point.
 *
 * {@code documentSha256} is the canonical document version the signer actually
 * agreed to — it is the hash that appears inside the BankID evidence payload, so
 * it is what binds the signature to a human decision.
 *
 * {@code inputRevisionSha256} is the hash of the bytes handed to this service.
 * For the first signer the two are equal. For every later signer the input is
 * the previous signed revision, which necessarily hashes differently because it
 * contains the earlier signature. Collapsing the two into one field would force
 * a choice between refusing multi-signer cases and dropping the binding to the
 * signer's consent, and neither is acceptable.
 */
public record SignCommand(
    String tenantId,
    String signatureCaseId,
    String signingIntentId,
    String signerId,
    String documentVersionId,
    String documentSha256,
    String inputRevisionSha256,
    String verifiedIdentityEvidenceReference,
    String policyReference,
    String requestedPadesLevel,
    List<String> signerSubjectAttributes) {

    private static final Set<String> PADES_LEVELS = Set.of("PAdES-B", "PAdES-T", "PAdES-LT", "PAdES-LTA");

    public SignCommand {
        require(tenantId, "tenantId");
        require(signatureCaseId, "signatureCaseId");
        require(signingIntentId, "signingIntentId");
        require(signerId, "signerId");
        require(documentVersionId, "documentVersionId");
        require(verifiedIdentityEvidenceReference, "verifiedIdentityEvidenceReference");
        require(policyReference, "policyReference");
        requireSha256(documentSha256, "documentSha256");
        requireSha256(inputRevisionSha256, "inputRevisionSha256");
        if (!PADES_LEVELS.contains(requestedPadesLevel)) throw new IllegalArgumentException("supported PAdES level required");
        signerSubjectAttributes = signerSubjectAttributes == null ? List.of() : List.copyOf(signerSubjectAttributes);
    }

    private static void require(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " required");
    }

    private static void requireSha256(String value, String field) {
        if (value == null || !value.matches("[0-9a-f]{64}")) throw new IllegalArgumentException(field + " must be a lowercase SHA-256 hex digest");
    }
}
