package se.kommunsign.signservice;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import se.kommunsign.commons.HttpBoundary;
import se.kommunsign.commons.Json;

/**
 * The signing boundary.
 *
 * This service is private. It is not published on a domain, it is reachable only
 * from the worker on the internal network, and it requires a bearer token. That
 * matters more here than anywhere else in the system: this is the one process
 * that holds signing key material, so its reachable surface is the blast radius.
 *
 * {@code /health} reports the backend's real state rather than a fixed string, so
 * a deployment that thinks it has signing configured and has not can find out
 * from a health check instead of from a failed case.
 */
public final class SignServiceApplication {

    /** A PDF revision plus base64 overhead. Documents are capped at 50 MB upstream. */
    private static final int MAX_BODY_BYTES = 96 * 1024 * 1024;

    private SignServiceApplication() {}

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8081"));
        String token = System.getenv("SIGNSERVICE_TOKEN");
        SigningEngine engine = SigningEngineFactory.fromEnvironment(System.getenv());
        SigningEngineCapabilities capabilities = engine.capabilities();

        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 64);
        server.setExecutor(Executors.newFixedThreadPool(4));

        server.createContext("/health", exchange -> {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("status", "UP");
            body.put("signingEngine", capabilities.backend());
            body.put("keyProtection", capabilities.keyProtection());
            body.put("supportedPadesLevels", new ArrayList<>(capabilities.supportedPadesLevels()));
            body.put("timestampConfigured", capabilities.timestampConfigured());
            body.put("productionReady", capabilities.productionReady());
            body.put("signingAvailable", !(engine instanceof BlockedSigningEngine));
            HttpBoundary.respondJson(exchange, 200, Json.stringify(body));
        });

        server.createContext("/v1/sign", exchange -> handleSign(exchange, token, engine));

        server.start();
    }

    private static void handleSign(HttpExchange exchange, String token, SigningEngine engine) throws IOException {
        try {
            HttpBoundary.requireMethod(exchange, "POST");
            HttpBoundary.requireBearer(exchange, token);
            HttpBoundary.requireJsonContentType(exchange);
            byte[] body = HttpBoundary.readBody(exchange, MAX_BODY_BYTES);
            Map<String, Object> parsed = Json.parseObject(new String(body, StandardCharsets.UTF_8));

            SignCommand command = new SignCommand(
                Json.string(parsed, "tenantId", true),
                Json.string(parsed, "signatureCaseId", true),
                Json.string(parsed, "signingIntentId", true),
                Json.string(parsed, "signerId", true),
                Json.string(parsed, "documentVersionId", true),
                Json.string(parsed, "documentSha256", true),
                Json.string(parsed, "inputRevisionSha256", true),
                Json.string(parsed, "verifiedIdentityEvidenceReference", true),
                Json.string(parsed, "policyReference", true),
                Json.string(parsed, "requestedPadesLevel", true),
                Json.stringList(parsed, "signerSubjectAttributes", false));

            Map<String, Object> assertionJson = objectField(parsed, "identityAssertion");
            IdentityAssertion assertion = new IdentityAssertion(
                Json.string(assertionJson, "tenantId", true),
                Json.string(assertionJson, "signatureCaseId", true),
                Json.string(assertionJson, "signingIntentId", true),
                Json.string(assertionJson, "signerId", true),
                Json.string(assertionJson, "verificationReportSha256", true),
                Json.string(assertionJson, "assuranceLevel", true),
                Json.string(assertionJson, "verifiedAt", true),
                Json.stringList(assertionJson, "documentSha256List", true));

            byte[] documentBytes = Base64.getDecoder().decode(Json.string(parsed, "documentBase64", true));

            SignResult result = engine.sign(command, assertion, documentBytes);
            respondResult(exchange, result);
        } catch (HttpBoundary.Rejected rejected) {
            HttpBoundary.respondJson(exchange, rejected.status(), Json.stringify(Map.of("status", "REFUSED", "reason", codeFor(rejected.status()))));
        } catch (Exception exception) {
            // Never surface the exception: it can carry document bytes or key paths.
            HttpBoundary.respondJson(exchange, 400, Json.stringify(Map.of("status", "REFUSED", "reason", "SIGN_REQUEST_INVALID")));
        }
    }

    private static void respondResult(HttpExchange exchange, SignResult result) throws IOException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", result.status());
        if (!result.isSigned()) {
            body.put("reason", result.safeMessage());
            // 503 for "not configured" and 422 for "refused" are different
            // operational problems: one is a deployment gap the operator must
            // close, the other is a request that must never be retried as-is.
            HttpBoundary.respondJson(exchange, SignResult.STATUS_NOT_CONFIGURED.equals(result.status()) ? 503 : 422, Json.stringify(body));
            return;
        }
        body.put("signedDocumentBase64", Base64.getEncoder().encodeToString(result.signedDocument()));
        body.put("signedRevisionSha256", result.signedRevisionSha256());
        body.put("signingCertificateBase64", Base64.getEncoder().encodeToString(result.signingCertificate()));
        List<String> chain = new ArrayList<>();
        for (byte[] certificate : result.certificateChain()) chain.add(Base64.getEncoder().encodeToString(certificate));
        body.put("certificateChainBase64", chain);
        body.put("signatureAlgorithm", result.signatureAlgorithm());
        body.put("adesProfile", result.adesProfile());
        body.put("signingTime", result.signingTime());
        HttpBoundary.respondJson(exchange, 200, Json.stringify(body));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> objectField(Map<String, Object> parent, String key) {
        Object value = parent.get(key);
        if (!(value instanceof Map<?, ?>)) throw new IllegalArgumentException(key + " must be an object");
        return (Map<String, Object>) value;
    }

    private static String codeFor(int status) {
        return switch (status) {
            case 401 -> "UNAUTHORIZED";
            case 405 -> "METHOD_NOT_ALLOWED";
            case 413 -> "BODY_TOO_LARGE";
            case 415 -> "CONTENT_TYPE_REQUIRED";
            case 503 -> "SERVICE_TOKEN_NOT_CONFIGURED";
            default -> "SIGN_REQUEST_INVALID";
        };
    }
}
