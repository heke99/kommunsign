package se.kommunsign.signservice;

public record SignCommand(
    String tenantId,
    String signatureCaseId,
    String documentVersionId,
    String documentSha256,
    String verifiedIdentityEvidenceReference,
    String policyReference,
    String requestedPadesLevel) {
    public SignCommand {
        if (tenantId == null || tenantId.isBlank()) throw new IllegalArgumentException("tenantId required");
        if (documentSha256 == null || !documentSha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("SHA-256 required");
        if (verifiedIdentityEvidenceReference == null || verifiedIdentityEvidenceReference.isBlank()) throw new IllegalArgumentException("verified identity evidence required");
    }
}
