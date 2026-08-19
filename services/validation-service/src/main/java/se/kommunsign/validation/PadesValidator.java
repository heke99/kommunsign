package se.kommunsign.validation;

import java.io.ByteArrayInputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import se.idsec.signservice.security.certificate.impl.SimpleCertificateValidator;
import se.idsec.signservice.security.sign.SignatureValidationResult;
import se.kommunsign.commons.HttpBoundary;
import se.swedenconnect.sigval.commons.data.SignedDocumentValidationResult;
import se.swedenconnect.sigval.commons.data.TimeValidationResult;
import se.swedenconnect.sigval.pdf.data.ExtendedPdfSigValResult;
import se.swedenconnect.sigval.pdf.pdfstruct.impl.DefaultPDFSignatureContextFactory;
import se.swedenconnect.sigval.pdf.verify.impl.PDFSingleSignatureValidatorImpl;
import se.swedenconnect.sigval.pdf.verify.impl.SVTenabledPDFDocumentSigVerifier;

/**
 * Independent PAdES validation on the Sweden Connect sigval stack.
 *
 * "Independent" is the operative word. This service shares no state, no key
 * material and no code path with the service that produced the signature; it is
 * given bytes and a trust anchor and asked what it can prove. That separation is
 * what lets a validation result count as evidence rather than as the signer
 * restating its own claim.
 *
 * This class deliberately does not decide a PAdES level. It reports which
 * evidence it found — trusted path, signature timestamp, revocation data,
 * archive timestamp — and the admission gate derives the level from that. Level
 * derivation in two places is level derivation that will eventually disagree,
 * and the disagreement would surface as a document archived at a level its
 * evidence never supported.
 */
public final class PadesValidator {

    public static final String ENGINE = "swedenconnect-sigval-pdf";
    public static final String ENGINE_VERSION = "1.3.0";

    public Map<String, Object> validate(PadesValidationRequest request) {
        List<Map<String, Object>> checks = new ArrayList<>();
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("engine", ENGINE);
        report.put("engineVersion", ENGINE_VERSION);
        report.put("policyVersion", request.policyVersion());
        report.put("validatedAt", Instant.now().toString());

        byte[] pdf;
        try {
            pdf = Base64.getDecoder().decode(request.pdfBase64());
        } catch (RuntimeException exception) {
            return fail(report, checks, "PDF_DECODE", "the submitted document is not valid base64");
        }

        String actualSha256 = HttpBoundary.sha256Hex(pdf);
        boolean integrity = actualSha256.equals(request.expectedDocumentSha256());
        checks.add(check("DOCUMENT_INTEGRITY", integrity, integrity ? null : "submitted bytes do not match the expected document hash"));
        if (!integrity) return conclude(report, checks, null);

        List<X509Certificate> trustAnchors;
        try {
            trustAnchors = decodeCertificates(request.trustAnchorsBase64());
        } catch (RuntimeException exception) {
            return fail(report, checks, "TRUST_ANCHOR_DECODE", "a configured trust anchor is not a valid X.509 certificate");
        }

        SimpleCertificateValidator certificateValidator = new SimpleCertificateValidator();
        certificateValidator.setDefaultTrustAnchors(trustAnchors);

        SignedDocumentValidationResult<ExtendedPdfSigValResult> result;
        try {
            SVTenabledPDFDocumentSigVerifier verifier = new SVTenabledPDFDocumentSigVerifier(
                new PDFSingleSignatureValidatorImpl(certificateValidator),
                new DefaultPDFSignatureContextFactory());
            result = verifier.extendedResultValidation(pdf);
        } catch (Exception exception) {
            return fail(report, checks, "SIGNATURE_PARSED", "the document could not be parsed as a signed PDF");
        }

        checks.add(check("SIGNATURE_PARSED", result.isSigned(), result.isSigned() ? null : "no signature was found in the document"));
        report.put("signatureCount", result.getSignatureCount());
        report.put("validSignatureCount", result.getValidSignatureCount());
        report.put("signsWholeDocument", result.isValidSignatureSignsWholeDocument());

        boolean anyTimestamp = false;
        boolean anyRevocation = certificateValidator.isRevocationCheckingActive();
        boolean allTrusted = result.getSignatureCount() > 0;
        boolean allAdes = result.getSignatureCount() > 0;

        List<Map<String, Object>> signatures = new ArrayList<>();
        for (ExtendedPdfSigValResult signature : result.getSignatureValidationResults()) {
            boolean success = signature.getStatus() == SignatureValidationResult.Status.SUCCESS;
            if (!success) allTrusted = false;
            if (!signature.isEtsiAdes()) allAdes = false;

            List<TimeValidationResult> times = signature.getTimeValidationResults();
            boolean hasTimestamp = times != null && !times.isEmpty();
            if (hasTimestamp) anyTimestamp = true;

            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("status", String.valueOf(signature.getStatus()));
            entry.put("statusMessage", signature.getStatusMessage());
            entry.put("coversDocument", signature.isCoversDocument());
            entry.put("etsiAdes", signature.isEtsiAdes());
            entry.put("signatureAlgorithm", signature.getSignatureAlgorithm());
            entry.put("claimedSigningTime", signature.getClaimedSigningTime() == null ? null : signature.getClaimedSigningTime().toInstant().toString());
            entry.put("timestampCount", hasTimestamp ? times.size() : 0);

            X509Certificate signer = signature.getSignerCertificate();
            if (signer != null) {
                entry.put("signerSubject", signer.getSubjectX500Principal().getName());
                entry.put("issuer", signer.getIssuerX500Principal().getName());
                entry.put("serialNumber", signer.getSerialNumber().toString(16));
                entry.put("notBefore", signer.getNotBefore().toInstant().toString());
                entry.put("notAfter", signer.getNotAfter().toInstant().toString());
                entry.put("certificateBase64", encode(signer));
                entry.put("certificateSha256", certificateSha256(signer));
            }
            List<X509Certificate> chain = signature.getSignatureCertificateChain();
            if (chain != null) {
                List<String> encoded = new ArrayList<>(chain.size());
                for (X509Certificate certificate : chain) encoded.add(encode(certificate));
                entry.put("certificateChainBase64", encoded);
            }
            signatures.add(entry);
        }
        report.put("signatures", signatures);

        boolean signerIdentity = signatures.stream().anyMatch(entry -> entry.get("signerSubject") != null);
        checks.add(check("SIGNER_IDENTITY_PRESENT", signerIdentity, signerIdentity ? null : "no signer certificate was recoverable"));
        checks.add(check("CERTIFICATE_PATH_TRUSTED", allTrusted, allTrusted ? null : "at least one signature did not chain to a configured trust anchor"));
        checks.add(check("SIGNATURE_COVERS_DOCUMENT", result.isValidSignatureSignsWholeDocument(), result.isValidSignatureSignsWholeDocument() ? null : "the newest valid signature does not cover the whole document"));
        checks.add(check("ETSI_ADES_PROFILE", allAdes, allAdes ? null : "at least one signature is not an ETSI AdES signature"));

        // These two are reported, never enforced here: whether their absence
        // matters depends on the level the tenant's policy actually requires.
        checks.add(informational("SIGNATURE_TIMESTAMP_PRESENT", anyTimestamp, anyTimestamp ? null : "no signature timestamp is present"));
        checks.add(informational("REVOCATION_CHECKED", anyRevocation, anyRevocation ? null : "revocation checking is not active in this validator configuration"));

        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("hasTrustedCertificatePath", allTrusted);
        evidence.put("hasSignatureTimestamp", anyTimestamp);
        evidence.put("hasRevocationEvidence", anyRevocation);
        evidence.put("hasArchiveTimestamp", false);
        report.put("levelEvidence", evidence);

        return conclude(report, checks, result);
    }

    private Map<String, Object> conclude(Map<String, Object> report, List<Map<String, Object>> checks,
                                         SignedDocumentValidationResult<ExtendedPdfSigValResult> result) {
        boolean allPassed = checks.stream()
            .filter(check -> Boolean.TRUE.equals(check.get("mandatory")))
            .allMatch(check -> Boolean.TRUE.equals(check.get("passed")));
        boolean structurallyValid = result != null && result.isCompleteSuccess();

        // INDETERMINATE is not a softer PASS. It is the honest answer when the
        // signature itself verifies but the surrounding evidence is incomplete —
        // and whether that is acceptable is a policy decision made downstream.
        String indication;
        if (allPassed && structurallyValid) indication = "TOTAL_PASSED";
        else if (result != null && result.getValidSignatureCount() > 0) indication = "INDETERMINATE";
        else indication = "TOTAL_FAILED";

        report.put("checks", checks);
        report.put("indication", indication);
        report.put("result", "TOTAL_PASSED".equals(indication) ? "PASS" : "FAIL");
        return report;
    }

    private Map<String, Object> fail(Map<String, Object> report, List<Map<String, Object>> checks, String code, String detail) {
        checks.add(check(code, false, detail));
        report.put("checks", checks);
        report.put("indication", "TOTAL_FAILED");
        report.put("result", "FAIL");
        return report;
    }

    /**
     * A mandatory check decides the outcome; an informational one only describes
     * what evidence exists.
     *
     * The distinction is not cosmetic. Revocation data and timestamps are absent
     * at PAdES-B and required at LT and above, so treating their absence as a
     * validation failure would make every B-level signature fail, and treating it
     * as a pass would let an LT claim through on B-level evidence. Neither
     * question belongs here: this validator reports, and the admission gate —
     * which knows the tenant's required level — decides.
     */
    private static Map<String, Object> check(String code, boolean passed, boolean mandatory, String detail) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("code", code);
        entry.put("passed", passed);
        entry.put("mandatory", mandatory);
        if (detail != null) entry.put("detail", detail);
        return entry;
    }

    private static Map<String, Object> check(String code, boolean passed, String detail) {
        return check(code, passed, true, detail);
    }

    private static Map<String, Object> informational(String code, boolean passed, String detail) {
        return check(code, passed, false, detail);
    }

    private static List<X509Certificate> decodeCertificates(List<String> base64Certificates) {
        try {
            CertificateFactory factory = CertificateFactory.getInstance("X.509");
            List<X509Certificate> certificates = new ArrayList<>(base64Certificates.size());
            for (String encoded : base64Certificates) {
                certificates.add((X509Certificate) factory.generateCertificate(
                    new ByteArrayInputStream(Base64.getDecoder().decode(encoded))));
            }
            return certificates;
        } catch (Exception exception) {
            throw new IllegalArgumentException("invalid certificate");
        }
    }

    private static String encode(X509Certificate certificate) {
        try {
            return Base64.getEncoder().encodeToString(certificate.getEncoded());
        } catch (Exception exception) {
            throw new IllegalStateException("certificate could not be encoded");
        }
    }

    private static String certificateSha256(X509Certificate certificate) {
        try {
            return HttpBoundary.sha256Hex(certificate.getEncoded());
        } catch (Exception exception) {
            throw new IllegalStateException("certificate could not be encoded");
        }
    }
}
