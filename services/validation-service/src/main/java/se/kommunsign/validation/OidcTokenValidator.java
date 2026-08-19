package se.kommunsign.validation;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.time.Instant;
import java.util.*;
import se.kommunsign.commons.CompactJwsVerifier;
import se.kommunsign.commons.Json;

/**
 * Verifies an OIDC id_token and normalises it into the same shape a SAML
 * assertion produces.
 *
 * The point of the shared shape is that verifyWorkforceAssertion decides
 * admission once, for both protocols. Two decision paths would eventually
 * disagree about something — the maximum session age, say, or whether an
 * unmapped group grants anything — and the disagreement would be invisible
 * until a tenant switched protocol.
 *
 * As on the SAML side this class does cryptography and parsing and nothing
 * else. Issuer, audience and nonce are read and reported; whether they are
 * acceptable is not decided here.
 *
 * The signing key comes from the tenant's configured certificate, never from
 * the token. A `jku` or `x5u` header naming where to fetch the key, or an
 * embedded `jwk`, is the key the attacker chose.
 */
public final class OidcTokenValidator {
    private static final int MAX_TOKEN_CHARS = 16_000;
    /** Asymmetric only. An HMAC alg with an RSA public key is the classic confusion. */
    private static final Set<String> ALLOWED_ALGORITHMS = Set.of("RS256", "ES256");

    private final CompactJwsVerifier jws = new CompactJwsVerifier();

    public Map<String,Object> validate(OidcTokenRequest request) {
        List<Map<String,Object>> checks = new ArrayList<>();
        Map<String,Object> out = new LinkedHashMap<>();

        try {
            String token = require(request.idToken(), "ID_TOKEN_REQUIRED");
            if (token.length() > MAX_TOKEN_CHARS) throw new IllegalArgumentException("ID_TOKEN_TOO_LARGE");
            X509Certificate trusted = certificate(require(request.trustedCertificateBase64(), "TRUSTED_CERTIFICATE_REQUIRED"));

            String[] parts = token.split("\\.", -1);
            if (parts.length != 3) return fail(out, checks, "ID_TOKEN_MALFORMED");

            // Header inspection before verification, so a key-selection header
            // is refused rather than followed. Nothing is trusted from it — it
            // is only checked for what must not be there.
            String header = new String(Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8);
            for (String forbidden : new String[]{"\"jku\"", "\"x5u\"", "\"jwk\""}) {
                if (header.contains(forbidden)) return fail(out, checks, "ID_TOKEN_SELECTS_ITS_OWN_KEY");
            }
            add(checks, "HEADER_DOES_NOT_SELECT_KEY", true, null);

            boolean verified = jws.verifyCompactJws(token, trusted.getPublicKey(), ALLOWED_ALGORITHMS);
            add(checks, "JWS_SIGNATURE_VALID", verified, null);
            if (!verified) return fail(out, checks, "SIGNATURE_INVALID");

            Map<String,Object> claims = Json.parseObject(
                new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8));

            out.put("protocol", "OIDC");
            out.put("signatureVerified", true);
            out.put("issuer", string(claims, "iss"));
            out.put("audience", audience(claims));
            out.put("subject", string(claims, "sub"));
            // jti is the assertion identifier the replay ledger consumes. A
            // token without one cannot be made single-use, so it is reported as
            // absent rather than substituted with something derived.
            out.put("assertionId", string(claims, "jti"));
            // The nonce is what binds the token to a login we started, the same
            // role InResponseTo plays for SAML.
            out.put("inResponseTo", string(claims, "nonce"));
            out.put("notBefore", instant(claims, "nbf"));
            out.put("notOnOrAfter", instant(claims, "exp"));
            // auth_time is when the user actually authenticated; iat is when the
            // token was minted. Using iat would let a fresh token describe a
            // session established days ago.
            String authTime = instant(claims, "auth_time");
            out.put("authenticatedAt", authTime != null ? authTime : instant(claims, "iat"));
            add(checks, "AUTH_TIME_PRESENT", authTime != null, null);
            out.put("authnContext", string(claims, "acr"));
            // The redirect URI is not a claim; the caller knows which endpoint
            // received the token and supplies it to the decision layer.
            out.put("destination", null);

            Map<String,List<String>> attributes = new LinkedHashMap<>();
            for (Map.Entry<String,Object> claim : claims.entrySet()) {
                Object value = claim.getValue();
                if (value instanceof String text) attributes.put(claim.getKey(), List.of(text));
                else if (value instanceof List<?> list) {
                    List<String> values = new ArrayList<>();
                    for (Object item : list) if (item instanceof String text) values.add(text);
                    if (!values.isEmpty()) attributes.put(claim.getKey(), values);
                }
            }
            out.put("attributes", attributes);

            // Reported, not enforced. Same split as the SAML validator.
            add(checks, "ISSUER_MATCHES_EXPECTED",
                Objects.equals(out.get("issuer"), request.expectedIssuer()), null);
            add(checks, "AUDIENCE_MATCHES_EXPECTED",
                Objects.equals(out.get("audience"), request.expectedAudience()), null);
            add(checks, "NONCE_MATCHES_EXPECTED",
                request.expectedNonce() == null || Objects.equals(out.get("inResponseTo"), request.expectedNonce()), null);

            out.put("result", "PASS");
            out.put("checks", checks);
            return out;
        } catch (RuntimeException error) {
            return fail(out, checks, safeCode(error.getMessage()));
        } catch (Exception error) {
            return fail(out, checks, "OIDC_VALIDATION_FAILED");
        }
    }

    private static Map<String,Object> fail(Map<String,Object> out, List<Map<String,Object>> checks, String reason) {
        out.put("protocol", "OIDC");
        out.put("signatureVerified", false);
        out.put("result", "FAIL");
        out.put("reason", reason);
        out.put("checks", checks);
        return out;
    }

    private static String string(Map<String,Object> claims, String name) {
        Object value = claims.get(name);
        return value instanceof String text && !text.isBlank() ? text : null;
    }

    /**
     * The audience, when there is exactly one.
     *
     * A multi-valued `aud` is legal but means the token was minted for several
     * parties, and the decision layer compares a single configured value. It is
     * reported as absent rather than as "the first one", which would silently
     * accept a token issued to somebody else as well.
     */
    private static String audience(Map<String,Object> claims) {
        Object value = claims.get("aud");
        if (value instanceof String text) return text.isBlank() ? null : text;
        if (value instanceof List<?> list && list.size() == 1 && list.get(0) instanceof String text) return text;
        return null;
    }

    /** Numeric date to ISO-8601, so both protocols hand the caller the same shape. */
    private static String instant(Map<String,Object> claims, String name) {
        Object value = claims.get(name);
        if (value instanceof Number number) return Instant.ofEpochSecond(number.longValue()).toString();
        return null;
    }

    private static X509Certificate certificate(String base64) throws Exception {
        byte[] der = Base64.getDecoder().decode(base64);
        if (der.length == 0 || der.length > 50_000) throw new IllegalArgumentException("TRUSTED_CERTIFICATE_BASE64_INVALID");
        return (X509Certificate) CertificateFactory.getInstance("X.509")
            .generateCertificate(new ByteArrayInputStream(der));
    }

    private static String require(String value, String code) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(code);
        return value;
    }

    private static void add(List<Map<String,Object>> checks, String name, boolean passed, String detail) {
        Map<String,Object> check = new LinkedHashMap<>();
        check.put("name", name);
        check.put("passed", passed);
        if (detail != null) check.put("detail", detail);
        checks.add(check);
    }

    /** Never the raw exception text: it can carry fragments of the token. */
    private static String safeCode(String message) {
        if (message == null) return "OIDC_VALIDATION_FAILED";
        String upper = message.toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9_]", "_");
        return upper.length() > 80 ? upper.substring(0, 80) : upper;
    }
}
