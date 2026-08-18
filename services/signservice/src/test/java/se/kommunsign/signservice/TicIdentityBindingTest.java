package se.kommunsign.signservice;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * These tests exist because every one of them is a way to get a valid signature
 * over the wrong thing. The binding is the only place that stops them, so if a
 * refactor loosens it the failure is silent everywhere else.
 */
class TicIdentityBindingTest {

    private static final byte[] DOCUMENT = "a municipal decision".getBytes(StandardCharsets.UTF_8);
    private static final String DOCUMENT_HASH = TicIdentityBinding.sha256Hex(DOCUMENT);
    private static final String CANONICAL_HASH = TicIdentityBinding.sha256Hex("canonical pdf/a bytes");
    private static final String REPORT_HASH = TicIdentityBinding.sha256Hex("verification report");

    private static SignCommand command() {
        return new SignCommand("tenant-1", "case-1", "intent-1", "signer-1", "version-1",
            CANONICAL_HASH, DOCUMENT_HASH, REPORT_HASH, "policy-1", "PAdES-B", List.of());
    }

    private static IdentityAssertion assertion() {
        return new IdentityAssertion("tenant-1", "case-1", "intent-1", "signer-1",
            REPORT_HASH, "HIGH", "2026-08-18T10:00:00Z", List.of(CANONICAL_HASH));
    }

    @Test
    void a_request_that_matches_its_evidence_is_bound() {
        assertDoesNotThrow(() -> TicIdentityBinding.assertBound(command(), assertion(), DOCUMENT));
    }

    @Test
    void evidence_from_another_tenant_cannot_authorise_this_signature() {
        IdentityAssertion other = new IdentityAssertion("tenant-2", "case-1", "intent-1", "signer-1",
            REPORT_HASH, "HIGH", "2026-08-18T10:00:00Z", List.of(CANONICAL_HASH));
        TicIdentityBinding.BindingViolation violation = assertThrows(TicIdentityBinding.BindingViolation.class,
            () -> TicIdentityBinding.assertBound(command(), other, DOCUMENT));
        assertEquals("IDENTITY_BINDING_TENANT_MISMATCH", violation.safeCode());
    }

    @Test
    void a_verified_session_from_one_case_cannot_be_replayed_into_another() {
        IdentityAssertion other = new IdentityAssertion("tenant-1", "case-2", "intent-1", "signer-1",
            REPORT_HASH, "HIGH", "2026-08-18T10:00:00Z", List.of(CANONICAL_HASH));
        assertEquals("IDENTITY_BINDING_SIGNATURE_CASE_MISMATCH",
            assertThrows(TicIdentityBinding.BindingViolation.class,
                () -> TicIdentityBinding.assertBound(command(), other, DOCUMENT)).safeCode());
    }

    @Test
    void one_signers_evidence_cannot_sign_for_another_signer() {
        IdentityAssertion other = new IdentityAssertion("tenant-1", "case-1", "intent-1", "signer-2",
            REPORT_HASH, "HIGH", "2026-08-18T10:00:00Z", List.of(CANONICAL_HASH));
        assertEquals("IDENTITY_BINDING_SIGNER_MISMATCH",
            assertThrows(TicIdentityBinding.BindingViolation.class,
                () -> TicIdentityBinding.assertBound(command(), other, DOCUMENT)).safeCode());
    }

    @Test
    void a_document_the_signer_never_approved_is_refused() {
        IdentityAssertion other = new IdentityAssertion("tenant-1", "case-1", "intent-1", "signer-1",
            REPORT_HASH, "HIGH", "2026-08-18T10:00:00Z", List.of(TicIdentityBinding.sha256Hex("a different document")));
        assertEquals("DOCUMENT_NOT_COVERED_BY_IDENTITY_EVIDENCE",
            assertThrows(TicIdentityBinding.BindingViolation.class,
                () -> TicIdentityBinding.assertBound(command(), other, DOCUMENT)).safeCode());
    }

    @Test
    void substituted_bytes_are_caught_even_when_every_identifier_matches() {
        byte[] substituted = "a different municipal decision".getBytes(StandardCharsets.UTF_8);
        assertEquals("INPUT_REVISION_HASH_MISMATCH",
            assertThrows(TicIdentityBinding.BindingViolation.class,
                () -> TicIdentityBinding.assertBound(command(), assertion(), substituted)).safeCode());
    }

    @Test
    void an_assertion_pointing_at_a_different_verification_report_is_refused() {
        IdentityAssertion other = new IdentityAssertion("tenant-1", "case-1", "intent-1", "signer-1",
            TicIdentityBinding.sha256Hex("another report"), "HIGH", "2026-08-18T10:00:00Z", List.of(CANONICAL_HASH));
        assertEquals("IDENTITY_EVIDENCE_REFERENCE_MISMATCH",
            assertThrows(TicIdentityBinding.BindingViolation.class,
                () -> TicIdentityBinding.assertBound(command(), other, DOCUMENT)).safeCode());
    }
}
