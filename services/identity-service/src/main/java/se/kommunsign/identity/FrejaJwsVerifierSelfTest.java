package se.kommunsign.identity;

import se.kommunsign.commons.CompactJwsVerifier;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Base64;

public final class FrejaJwsVerifierSelfTest {
    private FrejaJwsVerifierSelfTest() {}

    public static void main(String[] args) throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
        generator.initialize(2048);
        KeyPair keyPair = generator.generateKeyPair();
        String header = encode("{\"alg\":\"RS256\",\"typ\":\"JWT\"}");
        String payload = encode("{\"transactionReference\":\"test\"}");
        String input = header + "." + payload;
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(keyPair.getPrivate());
        signer.update(input.getBytes(StandardCharsets.US_ASCII));
        String compact = input + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(signer.sign());

        CompactJwsVerifier verifier = new CompactJwsVerifier();
        if (!verifier.verifyCompactJws(compact, keyPair.getPublic(), "RS256")) throw new AssertionError("valid RS256 JWS rejected");
        if (verifier.verifyCompactJws(compact, keyPair.getPublic(), "ES256")) throw new AssertionError("algorithm mismatch accepted");
        if (verifier.verifyCompactJws(compact + "x", keyPair.getPublic(), "RS256")) throw new AssertionError("modified JWS accepted");
        System.out.println("Freja JWS verifier self-test: OK");
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }
}
