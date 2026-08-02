package se.kommunsign.validation;

public record ValidationResult(String indication, String reportReference, String safeMessage) {
    public static ValidationResult notConfigured() {
        return new ValidationResult("NOT_CONFIGURED", null, "EU DSS, trust lists, OCSP/CRL and TSA validation must be configured.");
    }
}
