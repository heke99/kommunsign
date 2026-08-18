package se.kommunsign.validation;

import java.util.List;

/**
 * A request to independently validate a PAdES-signed PDF.
 *
 * {@code trustAnchorsBase64} is required and has no default. A validator with an
 * implicit trust store would answer "valid" for any certificate the host JDK
 * happens to trust, which for a municipal signature service is the wrong question
 * entirely — the question is whether the signer chains to the CA this tenant's
 * policy names.
 */
public record PadesValidationRequest(
    String pdfBase64,
    String expectedDocumentSha256,
    List<String> trustAnchorsBase64,
    String policyVersion) {

    public PadesValidationRequest {
        if (pdfBase64 == null || pdfBase64.isBlank()) throw new IllegalArgumentException("pdfBase64 required");
        if (expectedDocumentSha256 == null || !expectedDocumentSha256.matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("expectedDocumentSha256 must be a lowercase SHA-256 hex digest");
        }
        if (trustAnchorsBase64 == null || trustAnchorsBase64.isEmpty()) {
            throw new IllegalArgumentException("at least one trust anchor is required");
        }
        if (policyVersion == null || policyVersion.isBlank()) throw new IllegalArgumentException("policyVersion required");
        trustAnchorsBase64 = List.copyOf(trustAnchorsBase64);
    }
}
