package se.kommunsign.signservice;

import java.util.Set;

public record SignCommand(
    String tenantId,
    String signatureCaseId,
    String documentVersionId,
    String documentSha256,
    String verifiedIdentityEvidenceReference,
    String policyReference,
    String requestedPadesLevel) {
    private static final Set<String> PADES_LEVELS = Set.of("PAdES-B", "PAdES-T", "PAdES-LT", "PAdES-LTA");

    public SignCommand {
        require(tenantId, "tenantId");
        require(signatureCaseId, "signatureCaseId");
        require(documentVersionId, "documentVersionId");
        require(verifiedIdentityEvidenceReference, "verifiedIdentityEvidenceReference");
        require(policyReference, "policyReference");
        if (documentSha256 == null || !documentSha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("SHA-256 required");
        if (!PADES_LEVELS.contains(requestedPadesLevel)) throw new IllegalArgumentException("supported PAdES level required");
    }

    private static void require(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " required");
    }
}
