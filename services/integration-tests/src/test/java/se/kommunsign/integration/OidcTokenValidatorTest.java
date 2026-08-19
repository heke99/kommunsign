package se.kommunsign.integration;

import static org.junit.jupiter.api.Assertions.*;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.*;
import org.bouncycastle.asn1.x500.X500Name;
import org.bouncycastle.cert.jcajce.*;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder;
import org.junit.jupiter.api.Test;
import se.kommunsign.validation.OidcTokenRequest;
import se.kommunsign.validation.OidcTokenValidator;

/**
 * Proves the OIDC path against really signed tokens.
 *
 * The cases are the ones that turn a signature check into no check at all:
 * `alg: none`, a header that names where to fetch the key, a token signed by
 * somebody else, and a payload edited after signing.
 */
final class OidcTokenValidatorTest {

    static { Security.addProvider(new BouncyCastleProvider()); }

    private static final String ISSUER = "https://idp.kungalv.se";
    private static final String AUDIENCE = "kommunsign-kungalv";

    @Test
    void aTokenSignedByTheConfiguredIdpIsAcceptedAndNormalised() throws Exception {
        Idp idp = new Idp();
        String token = idp.sign(claims(Map.of()));

        Map<String,Object> result = new OidcTokenValidator().validate(new OidcTokenRequest(
            token, idp.certificateBase64(), ISSUER, AUDIENCE, "_nonce-1"));

        assertEquals("PASS", result.get("result"), () -> "reason: " + result.get("reason"));
        assertEquals(Boolean.TRUE, result.get("signatureVerified"));
        assertEquals("OIDC", result.get("protocol"));
        assertEquals(ISSUER, result.get("issuer"));
        assertEquals(AUDIENCE, result.get("audience"));
        assertEquals("anna.andersson", result.get("subject"));
        assertEquals("_nonce-1", result.get("inResponseTo"), "the nonce binds the token to a login we started");
        assertEquals("_jti-1", result.get("assertionId"), "the ledger consumes this");
        // auth_time, not iat: a freshly minted token can describe an old session.
        assertTrue(result.get("authenticatedAt").toString().startsWith("20"));

        @SuppressWarnings("unchecked")
        Map<String,List<String>> attributes = (Map<String,List<String>>) result.get("attributes");
        assertEquals(List.of("CN=Kommunsign-Handlaggare"), attributes.get("groups"));
    }

    @Test
    void anUnsignedTokenIsRefused() throws Exception {
        Idp idp = new Idp();
        // alg: none is the whole attack. The verifier's algorithm allow-list is
        // what makes it unreachable rather than merely unusual.
        String header = base64Url("{\"alg\":\"none\",\"typ\":\"JWT\"}");
        String payload = base64Url(claims(Map.of()));
        String token = header + "." + payload + ".";

        Map<String,Object> result = new OidcTokenValidator().validate(new OidcTokenRequest(
            token, idp.certificateBase64(), ISSUER, AUDIENCE, "_nonce-1"));

        assertEquals("FAIL", result.get("result"));
        assertEquals(Boolean.FALSE, result.get("signatureVerified"));
    }

    @Test
    void aTokenThatNamesItsOwnKeyIsRefusedBeforeVerification() throws Exception {
        Idp idp = new Idp();
        String token = idp.signWithHeader(
            "{\"alg\":\"RS256\",\"typ\":\"JWT\",\"jku\":\"https://evil.example/keys\"}", claims(Map.of()));

        Map<String,Object> result = new OidcTokenValidator().validate(new OidcTokenRequest(
            token, idp.certificateBase64(), ISSUER, AUDIENCE, "_nonce-1"));

        // Refused for naming a key source at all, not merely because the key
        // would not have matched. Following jku is fetching the attacker's key.
        assertEquals("FAIL", result.get("result"));
        assertEquals("ID_TOKEN_SELECTS_ITS_OWN_KEY", result.get("reason"));
    }

    @Test
    void aTokenFromAnotherIdpIsRefused() throws Exception {
        Idp real = new Idp();
        Idp impostor = new Idp();
        String token = impostor.sign(claims(Map.of()));

        Map<String,Object> result = new OidcTokenValidator().validate(new OidcTokenRequest(
            token, real.certificateBase64(), ISSUER, AUDIENCE, "_nonce-1"));

        assertEquals("FAIL", result.get("result"));
        assertEquals("SIGNATURE_INVALID", result.get("reason"));
    }

    @Test
    void anEditedPayloadIsRefused() throws Exception {
        Idp idp = new Idp();
        String token = idp.sign(claims(Map.of("groups", List.of("CN=Kommunsign-Lasare"))));
        String[] parts = token.split("\\.");
        String edited = parts[0] + "."
            + base64Url(claims(Map.of("groups", List.of("CN=Kommunsign-Admin"))))
            + "." + parts[2];

        Map<String,Object> result = new OidcTokenValidator().validate(new OidcTokenRequest(
            edited, idp.certificateBase64(), ISSUER, AUDIENCE, "_nonce-1"));

        assertEquals("FAIL", result.get("result"));
        assertEquals("SIGNATURE_INVALID", result.get("reason"));
    }

    @Test
    void aTokenMintedForSeveralPartiesReportsNoSingleAudience() throws Exception {
        Idp idp = new Idp();
        String token = idp.sign(claims(Map.of("aud", List.of(AUDIENCE, "another-service"))));

        Map<String,Object> result = new OidcTokenValidator().validate(new OidcTokenRequest(
            token, idp.certificateBase64(), ISSUER, AUDIENCE, "_nonce-1"));

        // The signature is genuine so this passes, but reporting the first
        // entry would silently accept a token issued to somebody else as well.
        // Null makes the decision layer refuse it on audience.
        assertEquals("PASS", result.get("result"));
        assertNull(result.get("audience"));
    }

    private static String claims(Map<String,Object> overrides) {
        long now = Instant.now().getEpochSecond();
        StringBuilder json = new StringBuilder("{");
        Map<String,Object> claims = new LinkedHashMap<>();
        claims.put("iss", ISSUER);
        claims.put("aud", AUDIENCE);
        claims.put("sub", "anna.andersson");
        claims.put("jti", "_jti-1");
        claims.put("nonce", "_nonce-1");
        claims.put("iat", now);
        claims.put("auth_time", now - 30);
        claims.put("nbf", now - 60);
        claims.put("exp", now + 300);
        claims.put("acr", "urn:oasis:names:tc:SAML:2.0:ac:classes:MultiFactor");
        claims.put("groups", List.of("CN=Kommunsign-Handlaggare"));
        claims.putAll(overrides);

        boolean first = true;
        for (Map.Entry<String,Object> claim : claims.entrySet()) {
            if (!first) json.append(",");
            first = false;
            json.append("\"").append(claim.getKey()).append("\":").append(render(claim.getValue()));
        }
        return json.append("}").toString();
    }

    private static String render(Object value) {
        if (value instanceof Number number) return number.toString();
        if (value instanceof List<?> list) {
            StringBuilder out = new StringBuilder("[");
            for (int index = 0; index < list.size(); index += 1) {
                if (index > 0) out.append(",");
                out.append("\"").append(list.get(index)).append("\"");
            }
            return out.append("]").toString();
        }
        return "\"" + value + "\"";
    }

    private static String base64Url(String value) {
        return Base64.getUrlEncoder().withoutPadding()
            .encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static final class Idp {
        private final KeyPair keyPair;
        private final X509Certificate certificate;

        Idp() throws Exception {
            KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA");
            generator.initialize(2048);
            this.keyPair = generator.generateKeyPair();
            X500Name name = new X500Name("CN=idp.kungalv.se,O=Kungalvs kommun,C=SE");
            this.certificate = new JcaX509CertificateConverter().setProvider("BC").getCertificate(
                new JcaX509v3CertificateBuilder(name, BigInteger.valueOf(System.nanoTime()),
                    new Date(System.currentTimeMillis() - 86_400_000L),
                    new Date(System.currentTimeMillis() + 86_400_000L * 365),
                    name, keyPair.getPublic())
                    .build(new JcaContentSignerBuilder("SHA256withRSA").setProvider("BC").build(keyPair.getPrivate())));
        }

        String certificateBase64() throws Exception {
            return Base64.getEncoder().encodeToString(certificate.getEncoded());
        }

        String sign(String payload) throws Exception {
            return signWithHeader("{\"alg\":\"RS256\",\"typ\":\"JWT\"}", payload);
        }

        String signWithHeader(String header, String payload) throws Exception {
            String signingInput = base64Url(header) + "." + base64Url(payload);
            Signature signature = Signature.getInstance("SHA256withRSA");
            signature.initSign(keyPair.getPrivate());
            signature.update(signingInput.getBytes(StandardCharsets.US_ASCII));
            return signingInput + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(signature.sign());
        }
    }
}
