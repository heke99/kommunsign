package se.kommunsign.identity;

import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;

public final class FrejaJwsVerifier {
    public boolean verifyCompactJws(String compactJws, PublicKey verificationKey, String algorithm) {
        try {
            String[] parts = compactJws.split("\\.");
            if (parts.length != 3) return false;
            String javaAlgorithm = switch (algorithm) {
                case "RS256" -> "SHA256withRSA";
                case "ES256" -> "SHA256withECDSA";
                default -> throw new IllegalArgumentException("Unsupported JWS algorithm");
            };
            Signature verifier = Signature.getInstance(javaAlgorithm);
            verifier.initVerify(verificationKey);
            verifier.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
            return verifier.verify(Base64.getUrlDecoder().decode(parts[2]));
        } catch (Exception exception) {
            return false;
        }
    }
}
