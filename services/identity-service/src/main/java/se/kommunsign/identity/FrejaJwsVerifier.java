package se.kommunsign.identity;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Fail-closed compact JWS verification boundary. The signed payload still has to be
 * schema-validated and bound to tenant, transaction, signer, document digest, nonce and policy.
 */
public final class FrejaJwsVerifier {
    private static final Pattern ALG_PATTERN = Pattern.compile("\\\"alg\\\"\\s*:\\s*\\\"([A-Za-z0-9_-]+)\\\"");

    public boolean verifyCompactJws(String compactJws, PublicKey verificationKey, String expectedAlgorithm) {
        return verifyCompactJws(compactJws, verificationKey, Set.of(expectedAlgorithm));
    }

    public boolean verifyCompactJws(String compactJws, PublicKey verificationKey, Set<String> allowedAlgorithms) {
        if (compactJws == null || verificationKey == null || allowedAlgorithms == null || allowedAlgorithms.isEmpty()) return false;
        try {
            String[] parts = compactJws.split("\\.", -1);
            if (parts.length != 3 || parts[0].isEmpty() || parts[1].isEmpty() || parts[2].isEmpty()) return false;
            if (compactJws.chars().anyMatch(Character::isWhitespace)) return false;

            String header = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            String algorithm = extractSingleAlgorithm(header);
            if (algorithm == null || !allowedAlgorithms.contains(algorithm)) return false;
            if (header.matches("(?s).*\\\"crit\\\"\\s*:.*") || header.matches("(?s).*\\\"b64\\\"\\s*:\\s*false.*")) return false;

            String javaAlgorithm;
            byte[] signatureBytes = Base64.getUrlDecoder().decode(parts[2]);
            switch (algorithm) {
                case "RS256" -> {
                    if (!"RSA".equalsIgnoreCase(verificationKey.getAlgorithm())) return false;
                    javaAlgorithm = "SHA256withRSA";
                }
                case "ES256" -> {
                    if (!"EC".equalsIgnoreCase(verificationKey.getAlgorithm())) return false;
                    javaAlgorithm = "SHA256withECDSA";
                    signatureBytes = joseEcdsaToDer(signatureBytes, 32);
                }
                default -> { return false; }
            }

            Signature verifier = Signature.getInstance(javaAlgorithm);
            verifier.initVerify(verificationKey);
            verifier.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
            return verifier.verify(signatureBytes);
        } catch (Exception exception) {
            return false;
        }
    }

    private static String extractSingleAlgorithm(String header) {
        Matcher matcher = ALG_PATTERN.matcher(header);
        if (!matcher.find()) return null;
        String algorithm = matcher.group(1);
        if (matcher.find()) return null;
        return algorithm;
    }

    private static byte[] joseEcdsaToDer(byte[] joseSignature, int coordinateSize) {
        if (joseSignature.length != coordinateSize * 2) throw new IllegalArgumentException("Unexpected ES256 signature length");
        byte[] r = positiveInteger(joseSignature, 0, coordinateSize);
        byte[] s = positiveInteger(joseSignature, coordinateSize, coordinateSize);
        int payloadLength = 2 + r.length + 2 + s.length;
        if (payloadLength >= 128) throw new IllegalArgumentException("Unexpected ECDSA DER length");
        ByteArrayOutputStream output = new ByteArrayOutputStream(payloadLength + 2);
        output.write(0x30);
        output.write(payloadLength);
        output.write(0x02);
        output.write(r.length);
        output.writeBytes(r);
        output.write(0x02);
        output.write(s.length);
        output.writeBytes(s);
        return output.toByteArray();
    }

    private static byte[] positiveInteger(byte[] input, int offset, int length) {
        int first = offset;
        int end = offset + length;
        while (first < end - 1 && input[first] == 0) first++;
        boolean needsLeadingZero = (input[first] & 0x80) != 0;
        byte[] result = new byte[end - first + (needsLeadingZero ? 1 : 0)];
        System.arraycopy(input, first, result, needsLeadingZero ? 1 : 0, end - first);
        return result;
    }
}
