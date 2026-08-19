package se.kommunsign.signservice;

import java.util.List;

/**
 * The outcome of a signing request.
 *
 * A plain class rather than a record because it carries byte arrays: a record's
 * generated equals/hashCode compare array identity, which quietly does the wrong
 * thing for anyone who treats the type as a value.
 *
 * Note what is absent. There is no "level" the caller asked for. The service
 * reports the profile it actually produced and the evidence it actually attached;
 * deciding which PAdES level that adds up to is the admission gate's job, and
 * splitting that decision across two components is how a level gets over-claimed.
 */
public final class SignResult {
    public static final String STATUS_SIGNED = "SIGNED";
    public static final String STATUS_NOT_CONFIGURED = "NOT_CONFIGURED";
    public static final String STATUS_REFUSED = "REFUSED";

    private final String status;
    private final String safeMessage;
    private final byte[] signedDocument;
    private final String signedRevisionSha256;
    private final byte[] signingCertificate;
    private final List<byte[]> certificateChain;
    private final String signatureAlgorithm;
    private final String adesProfile;
    private final String signingTime;

    private SignResult(String status, String safeMessage, byte[] signedDocument, String signedRevisionSha256,
                       byte[] signingCertificate, List<byte[]> certificateChain, String signatureAlgorithm,
                       String adesProfile, String signingTime) {
        this.status = status;
        this.safeMessage = safeMessage;
        this.signedDocument = signedDocument;
        this.signedRevisionSha256 = signedRevisionSha256;
        this.signingCertificate = signingCertificate;
        this.certificateChain = certificateChain == null ? List.of() : List.copyOf(certificateChain);
        this.signatureAlgorithm = signatureAlgorithm;
        this.adesProfile = adesProfile;
        this.signingTime = signingTime;
    }

    public static SignResult notConfigured() {
        return new SignResult(STATUS_NOT_CONFIGURED,
            "Sweden Connect SignService, CA/TSP and HSM must be configured before cryptographic signing is enabled.",
            null, null, null, null, null, null, null);
    }

    public static SignResult refused(String safeMessage) {
        return new SignResult(STATUS_REFUSED, safeMessage, null, null, null, null, null, null, null);
    }

    public static SignResult signed(byte[] signedDocument, String signedRevisionSha256, byte[] signingCertificate,
                                    List<byte[]> certificateChain, String signatureAlgorithm, String adesProfile,
                                    String signingTime) {
        return new SignResult(STATUS_SIGNED, null, signedDocument, signedRevisionSha256, signingCertificate,
            certificateChain, signatureAlgorithm, adesProfile, signingTime);
    }

    public String status() { return status; }
    public String safeMessage() { return safeMessage; }
    public byte[] signedDocument() { return signedDocument == null ? null : signedDocument.clone(); }
    public String signedRevisionSha256() { return signedRevisionSha256; }
    public byte[] signingCertificate() { return signingCertificate == null ? null : signingCertificate.clone(); }
    public List<byte[]> certificateChain() { return certificateChain; }
    public String signatureAlgorithm() { return signatureAlgorithm; }
    public String adesProfile() { return adesProfile; }
    public String signingTime() { return signingTime; }
    public boolean isSigned() { return STATUS_SIGNED.equals(status); }
}
