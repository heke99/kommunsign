package se.kommunsign.signservice;

public record SignResult(String status, String artifactReference, String safeMessage) {
    public static SignResult notConfigured() {
        return new SignResult("NOT_CONFIGURED", null, "Sweden Connect SignService, CA/TSP and HSM must be configured before cryptographic signing is enabled.");
    }
}
