package se.kommunsign.integration;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import se.kommunsign.signservice.IdentityAssertion;
import se.kommunsign.signservice.SignCommand;
import se.kommunsign.signservice.SignResult;
import se.kommunsign.signservice.SwedenConnectSigningEngine;
import se.kommunsign.signservice.TicIdentityBinding;
import se.kommunsign.validation.PadesValidationRequest;
import se.kommunsign.validation.PadesValidator;
import se.swedenconnect.security.credential.PkiCredential;

/**
 * The signing chain, end to end, across both boundary services.
 *
 * This is the test that would have caught the defect this work started from: a
 * case can reach "signed" only if a PDF was actually signed and an independent
 * validator confirmed it. Verified identity evidence alone proves who was
 * present, not what they signed.
 */
class SigningChainIntegrationTest {

    private static final String CASE = "11111111-1111-1111-1111-111111111111";
    private static final String INTENT = "22222222-2222-2222-2222-222222222222";
    private static final String TENANT = "33333333-3333-3333-3333-333333333333";
    private static final String POLICY = "kommunsign.signature-policy.v1";

    private record Signed(byte[] bytes, SignResult result) {}

    private Signed sign(SigningTestAuthority authority, String signerId, String signerName, byte[] input, String canonicalHash) throws Exception {
        PkiCredential credential = authority.issueSignerCredential(signerName, "196408233234");
        SwedenConnectSigningEngine engine = new SwedenConnectSigningEngine(credential, "SOFTWARE", false, false);

        String reportHash = TicIdentityBinding.sha256Hex("verification-report:" + signerId);
        SignCommand command = new SignCommand(TENANT, CASE, INTENT, signerId, "version-1",
            canonicalHash, TicIdentityBinding.sha256Hex(input), reportHash, POLICY, "PAdES-B", List.of());
        IdentityAssertion assertion = new IdentityAssertion(TENANT, CASE, INTENT, signerId,
            reportHash, "HIGH", "2026-08-18T10:00:00Z", List.of(canonicalHash));

        SignResult result = engine.sign(command, assertion, input);
        return new Signed(result.signedDocument(), result);
    }

    @Test
    void two_signers_produce_incremental_revisions_that_both_validate() throws Exception {
        SigningTestAuthority authority = new SigningTestAuthority("Kommunsign Test CA");
        byte[] canonical = SigningTestAuthority.singlePagePdf();
        String canonicalHash = TicIdentityBinding.sha256Hex(canonical);

        Signed first = sign(authority, "signer-1", "Anna Andersson", canonical, canonicalHash);
        assertTrue(first.result().isSigned(), "the first signature must be produced");

        // The second signer signs the first signer's revision, not the original.
        Signed second = sign(authority, "signer-2", "Bertil Bengtsson", first.bytes(), canonicalHash);
        assertTrue(second.result().isSigned(), "the second signature must be produced");

        // The load-bearing property: the earlier revision survives byte for byte.
        assertTrue(isPrefix(canonical, first.bytes()), "the canonical document must remain intact inside revision one");
        assertTrue(isPrefix(first.bytes(), second.bytes()), "revision one must remain intact inside revision two");

        Map<String, Object> report = validate(second.bytes(), authority);
        assertEquals("PASS", report.get("result"));
        assertEquals("TOTAL_PASSED", report.get("indication"));
        assertEquals(2, report.get("signatureCount"));
        assertEquals(2, report.get("validSignatureCount"));
        assertEquals(true, report.get("signsWholeDocument"));

        List<?> signatures = (List<?>) report.get("signatures");
        assertEquals(2, signatures.size());
        for (Object entry : signatures) {
            Map<?, ?> signature = (Map<?, ?>) entry;
            assertEquals("SUCCESS", signature.get("status"));
            assertEquals(true, signature.get("etsiAdes"));
            assertNotNull(signature.get("signerSubject"));
            assertNotNull(signature.get("certificateBase64"));
        }
    }

    @Test
    void a_signature_from_an_untrusted_authority_fails_closed() throws Exception {
        SigningTestAuthority signingAuthority = new SigningTestAuthority("Kommunsign Test CA");
        SigningTestAuthority unrelatedAuthority = new SigningTestAuthority("Some Other CA");

        byte[] canonical = SigningTestAuthority.singlePagePdf();
        Signed signed = sign(signingAuthority, "signer-1", "Anna Andersson", canonical, TicIdentityBinding.sha256Hex(canonical));
        assertTrue(signed.result().isSigned());

        // Structurally the same signature — only the trust anchor differs.
        Map<String, Object> report = validate(signed.bytes(), unrelatedAuthority);
        assertEquals("FAIL", report.get("result"));
        assertFalse(passed(report, "CERTIFICATE_PATH_TRUSTED"));
    }

    @Test
    void a_document_altered_after_signing_is_detected() throws Exception {
        SigningTestAuthority authority = new SigningTestAuthority("Kommunsign Test CA");
        byte[] canonical = SigningTestAuthority.singlePagePdf();
        Signed signed = sign(authority, "signer-1", "Anna Andersson", canonical, TicIdentityBinding.sha256Hex(canonical));

        byte[] tampered = signed.bytes().clone();
        // Flip a byte inside the original page content, which the signature's
        // ByteRange covers. Picking an offset by eye would land in the signature
        // container itself, which ByteRange deliberately excludes — that edit is
        // invisible to the signature and would make this test pass for the wrong
        // reason.
        tampered[canonical.length / 2] ^= 0x01;

        Map<String, Object> report = new PadesValidator().validate(new PadesValidationRequest(
            Base64.getEncoder().encodeToString(tampered),
            TicIdentityBinding.sha256Hex(tampered),
            List.of(authority.certificateBase64()),
            POLICY));
        assertEquals("FAIL", report.get("result"));
    }

    @Test
    void the_validator_refuses_bytes_that_are_not_the_document_it_was_asked_about() throws Exception {
        SigningTestAuthority authority = new SigningTestAuthority("Kommunsign Test CA");
        byte[] canonical = SigningTestAuthority.singlePagePdf();
        Signed signed = sign(authority, "signer-1", "Anna Andersson", canonical, TicIdentityBinding.sha256Hex(canonical));

        Map<String, Object> report = new PadesValidator().validate(new PadesValidationRequest(
            Base64.getEncoder().encodeToString(signed.bytes()),
            TicIdentityBinding.sha256Hex("a completely different document"),
            List.of(authority.certificateBase64()),
            POLICY));
        assertEquals("FAIL", report.get("result"));
        assertFalse(passed(report, "DOCUMENT_INTEGRITY"));
    }

    @Test
    void a_backend_without_a_timestamp_source_refuses_to_be_asked_for_a_timestamped_level() throws Exception {
        SigningTestAuthority authority = new SigningTestAuthority("Kommunsign Test CA");
        PkiCredential credential = authority.issueSignerCredential("Anna Andersson", "196408233234");
        SwedenConnectSigningEngine engine = new SwedenConnectSigningEngine(credential, "SOFTWARE", false, false);

        byte[] canonical = SigningTestAuthority.singlePagePdf();
        String canonicalHash = TicIdentityBinding.sha256Hex(canonical);
        String reportHash = TicIdentityBinding.sha256Hex("verification-report");

        SignCommand command = new SignCommand(TENANT, CASE, INTENT, "signer-1", "version-1",
            canonicalHash, canonicalHash, reportHash, POLICY, "PAdES-T", List.of());
        IdentityAssertion assertion = new IdentityAssertion(TENANT, CASE, INTENT, "signer-1",
            reportHash, "HIGH", "2026-08-18T10:00:00Z", List.of(canonicalHash));

        SignResult result = engine.sign(command, assertion, canonical);
        assertFalse(result.isSigned(), "a level the backend cannot reach must be refused, not silently downgraded");
        assertEquals("REQUESTED_PADES_LEVEL_NOT_SUPPORTED_BY_BACKEND", result.safeMessage());
    }

    @Test
    void the_reported_evidence_never_claims_more_than_was_collected() throws Exception {
        SigningTestAuthority authority = new SigningTestAuthority("Kommunsign Test CA");
        byte[] canonical = SigningTestAuthority.singlePagePdf();
        Signed signed = sign(authority, "signer-1", "Anna Andersson", canonical, TicIdentityBinding.sha256Hex(canonical));

        Map<String, Object> report = validate(signed.bytes(), authority);
        @SuppressWarnings("unchecked")
        Map<String, Object> evidence = (Map<String, Object>) report.get("levelEvidence");

        // No TSA is configured in this fixture, so nothing above PAdES-B is
        // supportable and the report must say so rather than stay silent.
        assertEquals(true, evidence.get("hasTrustedCertificatePath"));
        assertEquals(false, evidence.get("hasSignatureTimestamp"));
        assertEquals(false, evidence.get("hasArchiveTimestamp"));
    }

    private Map<String, Object> validate(byte[] pdf, SigningTestAuthority trustAnchor) throws Exception {
        List<String> anchors = new ArrayList<>();
        anchors.add(trustAnchor.certificateBase64());
        return new PadesValidator().validate(new PadesValidationRequest(
            Base64.getEncoder().encodeToString(pdf),
            TicIdentityBinding.sha256Hex(pdf),
            anchors,
            POLICY));
    }

    @SuppressWarnings("unchecked")
    private static boolean passed(Map<String, Object> report, String code) {
        for (Object entry : (List<Object>) report.get("checks")) {
            Map<?, ?> check = (Map<?, ?>) entry;
            if (code.equals(check.get("code"))) return Boolean.TRUE.equals(check.get("passed"));
        }
        return false;
    }

    private static boolean isPrefix(byte[] prefix, byte[] whole) {
        if (whole.length < prefix.length) return false;
        for (int index = 0; index < prefix.length; index += 1) if (prefix[index] != whole[index]) return false;
        return true;
    }
}
