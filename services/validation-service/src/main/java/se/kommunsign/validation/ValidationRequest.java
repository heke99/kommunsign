package se.kommunsign.validation;

import java.util.Set;

public record ValidationRequest(String tenantId, String signedDocumentReference, String signedDocumentSha256, String requiredPadesLevel) {
    private static final Set<String> PADES_LEVELS = Set.of("PAdES-B", "PAdES-T", "PAdES-LT", "PAdES-LTA");

    public ValidationRequest {
        if (tenantId == null || tenantId.isBlank()) throw new IllegalArgumentException("tenantId required");
        if (signedDocumentReference == null || signedDocumentReference.isBlank()) throw new IllegalArgumentException("signedDocumentReference required");
        if (signedDocumentSha256 == null || !signedDocumentSha256.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("SHA-256 required");
        if (!PADES_LEVELS.contains(requiredPadesLevel)) throw new IllegalArgumentException("supported PAdES level required");
    }
}
