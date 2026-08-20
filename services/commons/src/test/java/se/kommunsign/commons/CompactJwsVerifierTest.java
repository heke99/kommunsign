package se.kommunsign.commons;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.Base64;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Every case here is a full authentication bypass if the verifier gets it
 * wrong. Freja's signed assertions and an OIDC id_token are the same
 * construction, so this one class stands behind both.
 *
 * This lives in the Maven reactor rather than as a hand-rolled main(): a test
 * that only runs when someone remembers to invoke it is not a gate, and the
 * standalone self-test it replaces covered three of the cases below and none of
 * the rest.
 */
final class CompactJwsVerifierTest {

    private final CompactJwsVerifier verifier = new CompactJwsVerifier();

    @Test
    void aTokenSignedByTheExpectedKeyAndAlgorithmIsAccepted() throws Exception {
        KeyPair keyPair = rsa();
        String jws = signRsa(keyPair.getPrivate(), "{\"alg\":\"RS256\",\"typ\":\"JWT\"}", "{\"transactionReference\":\"test\"}");
        assertTrue(verifier.verifyCompactJws(jws, keyPair.getPublic(), "RS256"));
    }

    @Test
    void anAlgorithmTheCallerDidNotNameIsRefused() throws Exception {
        // The caller says which algorithms it will accept. Trusting the header
        // instead is how `alg: none` becomes reachable.
        KeyPair keyPair = rsa();
        String jws = signRsa(keyPair.getPrivate(), "{\"alg\":\"RS256\",\"typ\":\"JWT\"}", "{\"sub\":\"anna\"}");
        assertFalse(verifier.verifyCompactJws(jws, keyPair.getPublic(), "ES256"));
        assertFalse(verifier.verifyCompactJws(jws, keyPair.getPublic(), Set.of()));
    }

    @Test
    void anUnsignedTokenIsRefused() throws Exception {
        KeyPair keyPair = rsa();
        String header = encode("{\"alg\":\"none\"}");
        String payload = encode("{\"sub\":\"attacker\"}");
        assertFalse(verifier.verifyCompactJws(header + "." + payload + ".", keyPair.getPublic(), "RS256"));
        assertFalse(verifier.verifyCompactJws(header + "." + payload + ".", keyPair.getPublic(), Set.of("RS256", "none")));
    }

    @Test
    void aModifiedTokenIsRefused() throws Exception {
        KeyPair keyPair = rsa();
        String jws = signRsa(keyPair.getPrivate(), "{\"alg\":\"RS256\",\"typ\":\"JWT\"}", "{\"sub\":\"anna\"}");
        assertFalse(verifier.verifyCompactJws(jws + "x", keyPair.getPublic(), "RS256"));

        // Swapping the payload for another one that is well-formed base64url is
        // the interesting case: the token still parses, and only the signature
        // says it is not the one that was issued.
        String[] parts = jws.split("\\.");
        String forged = parts[0] + "." + encode("{\"sub\":\"attacker\"}") + "." + parts[2];
        assertFalse(verifier.verifyCompactJws(forged, keyPair.getPublic(), "RS256"));
    }

    @Test
    void aHeaderWithTwoAlgorithmsIsRefused() throws Exception {
        // Two `alg` members let a parser that reads the first and a verifier
        // that reads the last disagree about what was signed.
        KeyPair keyPair = rsa();
        String jws = signRsa(keyPair.getPrivate(), "{\"alg\":\"RS256\",\"alg\":\"none\"}", "{\"sub\":\"anna\"}");
        assertFalse(verifier.verifyCompactJws(jws, keyPair.getPublic(), "RS256"));
    }

    @Test
    void headerExtensionsThatChangeTheMeaningOfTheSignatureAreRefused() throws Exception {
        KeyPair keyPair = rsa();
        // crit names an extension the verifier does not implement, and b64:false
        // changes which bytes the signature covers. Both are refused rather than
        // ignored.
        String critical = signRsa(keyPair.getPrivate(), "{\"alg\":\"RS256\",\"crit\":[\"exp\"]}", "{\"sub\":\"anna\"}");
        assertFalse(verifier.verifyCompactJws(critical, keyPair.getPublic(), "RS256"));
        String unencoded = signRsa(keyPair.getPrivate(), "{\"alg\":\"RS256\",\"b64\":false}", "{\"sub\":\"anna\"}");
        assertFalse(verifier.verifyCompactJws(unencoded, keyPair.getPublic(), "RS256"));
    }

    @Test
    void aKeyOfTheWrongTypeForTheAlgorithmIsRefused() throws Exception {
        // An EC public key presented for RS256 must not verify. Type confusion
        // between key and algorithm is the classic JWS bypass.
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(256);
        KeyPair ec = generator.generateKeyPair();
        KeyPair rsa = rsa();
        String jws = signRsa(rsa.getPrivate(), "{\"alg\":\"RS256\"}", "{\"sub\":\"anna\"}");
        assertFalse(verifier.verifyCompactJws(jws, ec.getPublic(), "RS256"));
    }

    @Test
    void aMalformedTokenIsRefusedRatherThanThrowing() throws Exception {
        KeyPair keyPair = rsa();
        for (String malformed : new String[] { "", ".", "a.b", "a.b.c.d", "..", "a..c", "a.b.", " a.b.c" }) {
            assertFalse(verifier.verifyCompactJws(malformed, keyPair.getPublic(), "RS256"), malformed);
        }
        assertFalse(verifier.verifyCompactJws(null, keyPair.getPublic(), "RS256"));
    }

    private static KeyPair rsa() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        return generator.generateKeyPair();
    }

    private static String signRsa(PrivateKey key, String header, String payload) throws Exception {
        String input = encode(header) + "." + encode(payload);
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(key);
        signer.update(input.getBytes(StandardCharsets.US_ASCII));
        return input + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign());
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }
}
