package se.kommunsign.validation;

public record ValidationRequest(String tenantId, String signedDocumentReference, String signedDocumentSha256, String requiredPadesLevel) {
    public ValidationRequest {
        if (tenantId == null || tenantId.isBlank()) throw new IllegalArgumentException("tenantId required");
        if (signedDocumentSha256 == null || !signedDocumentSha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("SHA-256 required");
    }
}
