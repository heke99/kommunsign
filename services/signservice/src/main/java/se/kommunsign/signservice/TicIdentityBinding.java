package se.kommunsign.signservice;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

/**
 * The adapter between the verified TIC/BankID evidence and the signing request.
 *
 * Everything this class does is one idea: the bytes about to be signed must be
 * the bytes the identified person agreed to sign, in the tenant and the case
 * where they agreed to it. A signing service that checks the signer's identity
 * but not what they are signing has verified a person and authorised a document
 * they never saw.
 *
 * Four bindings are asserted, and all four have a concrete attack behind them:
 *
 *  - tenant, case, intent and signer must match the assertion, or a verified
 *    BankID session from one case could be replayed to sign another;
 *  - the canonical document hash must be one the signer approved, or a second
 *    document could be slipped into a multi-document intent;
 *  - the input bytes must hash to the declared input revision, or the caller
 *    could hand over different bytes than the ones it accounted for;
 *  - the assertion must carry a verification report, because an assertion that
 *    was never independently verified is a claim, not evidence.
 */
public final class TicIdentityBinding {

    private TicIdentityBinding() {}

    /** Thrown when a signing request is not bound to its identity evidence. */
    public static final class BindingViolation extends RuntimeException {
        private final String safeCode;
        BindingViolation(String safeCode, String message) { super(message); this.safeCode = safeCode; }
        public String safeCode() { return safeCode; }
    }

    public static void assertBound(SignCommand command, IdentityAssertion assertion, byte[] documentBytes) {
        if (command == null || assertion == null || documentBytes == null) {
            throw new BindingViolation("IDENTITY_BINDING_INCOMPLETE", "signing request, identity assertion and document bytes are all required");
        }
        mustMatch("TENANT", command.tenantId(), assertion.tenantId());
        mustMatch("SIGNATURE_CASE", command.signatureCaseId(), assertion.signatureCaseId());
        mustMatch("SIGNING_INTENT", command.signingIntentId(), assertion.signingIntentId());
        mustMatch("SIGNER", command.signerId(), assertion.signerId());

        if (!assertion.documentSha256List().contains(command.documentSha256())) {
            throw new BindingViolation("DOCUMENT_NOT_COVERED_BY_IDENTITY_EVIDENCE",
                "the requested document is not one the signer approved in this signing intent");
        }

        if (!command.verifiedIdentityEvidenceReference().equals(assertion.verificationReportSha256())) {
            throw new BindingViolation("IDENTITY_EVIDENCE_REFERENCE_MISMATCH",
                "the signing request references a different verification report than the assertion carries");
        }

        String actual = sha256Hex(documentBytes);
        if (!actual.equals(command.inputRevisionSha256())) {
            throw new BindingViolation("INPUT_REVISION_HASH_MISMATCH",
                "the bytes submitted for signing do not hash to the declared input revision");
        }
    }

    private static void mustMatch(String what, String fromCommand, String fromAssertion) {
        if (fromCommand == null || !fromCommand.equals(fromAssertion)) {
            throw new BindingViolation("IDENTITY_BINDING_" + what + "_MISMATCH",
                "signing request and identity evidence disagree about the " + what.toLowerCase().replace('_', ' '));
        }
    }

    public static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    public static String sha256Hex(String value) {
        return sha256Hex(value.getBytes(StandardCharsets.UTF_8));
    }
}
