package se.kommunsign.integration;

import static org.junit.jupiter.api.Assertions.*;

import java.security.Security;
import java.util.List;
import java.util.Map;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.junit.jupiter.api.Test;
import se.kommunsign.signservice.*;
import se.kommunsign.validation.PadesValidationRequest;
import se.kommunsign.validation.PadesValidator;

/**
 * Regression test for a defect the unit tests could not have caught.
 *
 * Neither production class registered BouncyCastle. Every existing Java test
 * passed anyway, because SigningTestAuthority registers it in a static
 * initialiser — so the fixture was supplying what production was missing. The
 * services would start, report healthy, and then:
 *
 *   - SignService refused every signature with an opaque SIGNING_FAILED, and
 *   - the validator reported every signature as unverifiable, because sigval-pdf
 *     does not throw without the provider, it just recovers no signer
 *     certificate.
 *
 * It was found by running the real chain over HTTP against the built services,
 * which is the only place the difference between "the fixture set it up" and
 * "the code sets it up" is observable.
 *
 * This test removes the provider first, which is what makes it a real check
 * rather than a restatement of whatever some earlier test already did.
 */
final class SecurityProviderRegistrationTest {

    @Test
    void signing_works_when_nothing_else_registered_the_provider() throws Exception {
        SigningTestAuthority authority = new SigningTestAuthority("Provider Test CA");
        byte[] canonical = SigningTestAuthority.singlePagePdf();
        String canonicalHash = TicIdentityBinding.sha256Hex(canonical);
        String reportHash = TicIdentityBinding.sha256Hex("report".getBytes(java.nio.charset.StandardCharsets.UTF_8));

        SigningEngine engine = new SwedenConnectSigningEngine(
            authority.issueSignerCredential("Anna Andersson", "195001011234"), "SOFTWARE", false, false);

        // The fixture registered it. Take it away again: the engine has to stand
        // on its own, and a long-lived process can lose it for other reasons.
        Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME);
        assertNull(Security.getProvider(BouncyCastleProvider.PROVIDER_NAME));

        SignCommand command = new SignCommand(
            "tenant-1", "case-1", "intent-1", "signer-1", "version-1",
            canonicalHash, canonicalHash, reportHash, "policy-1", "PAdES-B", List.of());
        IdentityAssertion assertion = new IdentityAssertion(
            "tenant-1", "case-1", "intent-1", "signer-1",
            reportHash, "HIGH", "2026-08-19T10:00:00Z", List.of(canonicalHash));

        SignResult result = engine.sign(command, assertion, canonical);
        assertTrue(result.isSigned(), () -> "signing must not depend on a test fixture: " + result.safeMessage());
        assertNotNull(Security.getProvider(BouncyCastleProvider.PROVIDER_NAME),
            "the engine must have registered the provider itself");
    }

    @Test
    void validation_recovers_a_signer_when_nothing_else_registered_the_provider() throws Exception {
        SigningTestAuthority authority = new SigningTestAuthority("Provider Test CA");
        byte[] canonical = SigningTestAuthority.singlePagePdf();
        String canonicalHash = TicIdentityBinding.sha256Hex(canonical);
        String reportHash = TicIdentityBinding.sha256Hex("report".getBytes(java.nio.charset.StandardCharsets.UTF_8));

        SigningEngine engine = new SwedenConnectSigningEngine(
            authority.issueSignerCredential("Anna Andersson", "195001011234"), "SOFTWARE", false, false);
        SignResult signed = engine.sign(
            new SignCommand("tenant-1", "case-1", "intent-1", "signer-1", "version-1",
                canonicalHash, canonicalHash, reportHash, "policy-1", "PAdES-B", List.of()),
            new IdentityAssertion("tenant-1", "case-1", "intent-1", "signer-1",
                reportHash, "HIGH", "2026-08-19T10:00:00Z", List.of(canonicalHash)),
            canonical);
        assertTrue(signed.isSigned());

        Security.removeProvider(BouncyCastleProvider.PROVIDER_NAME);
        assertNull(Security.getProvider(BouncyCastleProvider.PROVIDER_NAME));

        Map<String, Object> report = new PadesValidator().validate(new PadesValidationRequest(
            java.util.Base64.getEncoder().encodeToString(signed.signedDocument()),
            TicIdentityBinding.sha256Hex(signed.signedDocument()),
            List.of(authority.certificateBase64()),
            "provider-test"));

        // Without the provider this came back FAIL with "no signer certificate
        // was recoverable" — which reads as a bad signature, not as a broken
        // validator. That indistinguishability is what made it dangerous.
        assertEquals("PASS", report.get("result"), () -> "validation must not depend on a test fixture: " + report);
        assertNotNull(Security.getProvider(BouncyCastleProvider.PROVIDER_NAME),
            "the validator must have registered the provider itself");
    }
}
