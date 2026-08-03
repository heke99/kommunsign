package se.kommunsign.validation;

public record TicBankIdValidationRequest(
    String signatureXmlBase64,
    String ocspResponseBase64,
    String expectedVisibleData,
    String expectedNonVisibleData,
    String expectedPersonalNumber,
    String policyVersion
) {
    public TicBankIdValidationRequest {
        if (signatureXmlBase64 == null || signatureXmlBase64.isBlank() || signatureXmlBase64.length() > 4_000_000) throw new IllegalArgumentException("signatureXmlBase64 invalid");
        if (ocspResponseBase64 == null || ocspResponseBase64.isBlank() || ocspResponseBase64.length() > 1_000_000) throw new IllegalArgumentException("ocspResponseBase64 invalid");
        if (expectedVisibleData == null || expectedVisibleData.length() > 200_000) throw new IllegalArgumentException("expectedVisibleData invalid");
        if (expectedNonVisibleData == null || expectedNonVisibleData.length() > 200_000) throw new IllegalArgumentException("expectedNonVisibleData invalid");
        if (expectedPersonalNumber != null && !expectedPersonalNumber.matches("\\d{12}")) throw new IllegalArgumentException("expectedPersonalNumber invalid");
        if (policyVersion == null || !policyVersion.matches("[A-Za-z0-9._-]{1,100}")) throw new IllegalArgumentException("policyVersion invalid");
    }
}
