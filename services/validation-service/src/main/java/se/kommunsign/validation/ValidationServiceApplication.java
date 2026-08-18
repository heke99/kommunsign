package se.kommunsign.validation;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import se.kommunsign.commons.HttpBoundary;
import se.kommunsign.commons.Json;

/**
 * The independent evidence validator.
 *
 * Two validators live behind this boundary and they are deliberately different
 * stacks: TIC BankID evidence is checked with the JDK's XML-DSig implementation,
 * PAdES with Sweden Connect sigval. Neither shares code with the service that
 * produced the evidence it checks.
 *
 * The service is private: it is not exposed publicly, it takes a bearer token,
 * and it needs no outbound network access for the checks it performs.
 */
public final class ValidationServiceApplication {

    /** TIC evidence is small. A 5 MB cap is generous for an XML-DSig plus OCSP. */
    private static final int TIC_MAX_BODY_BYTES = 5_000_000;
    /** A signed PDF plus base64 overhead plus trust anchors. */
    private static final int PADES_MAX_BODY_BYTES = 96 * 1024 * 1024;

    private ValidationServiceApplication() {}

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8082"));
        String token = required("VALIDATION_SERVICE_TOKEN");

        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 64);
        server.setExecutor(Executors.newFixedThreadPool(4));

        TicBankIdEvidenceValidator ticValidator = new TicBankIdEvidenceValidator();
        PadesValidator padesValidator = new PadesValidator();

        server.createContext("/health", exchange -> respond(exchange, 200, Map.of(
            "status", "UP",
            "ticValidator", "TIC_BANKID_XMLDSIG_V1",
            "padesValidator", PadesValidator.ENGINE + "/" + PadesValidator.ENGINE_VERSION,
            "egress", "NOT_REQUIRED")));

        server.createContext("/v1/validate/tic-bankid", exchange -> handle(exchange, token, TIC_MAX_BODY_BYTES, parsed -> {
            TicBankIdValidationRequest request = new TicBankIdValidationRequest(
                Json.string(parsed, "signatureXmlBase64", true),
                Json.string(parsed, "ocspResponseBase64", true),
                Json.string(parsed, "expectedVisibleData", true),
                Json.string(parsed, "expectedNonVisibleData", true),
                Json.string(parsed, "expectedPersonalNumber", false),
                Json.string(parsed, "policyVersion", true));
            return ticValidator.validate(request);
        }));

        server.createContext("/v1/validate/pades", exchange -> handle(exchange, token, PADES_MAX_BODY_BYTES, parsed -> {
            PadesValidationRequest request = new PadesValidationRequest(
                Json.string(parsed, "pdfBase64", true),
                Json.string(parsed, "expectedDocumentSha256", true),
                Json.stringList(parsed, "trustAnchorsBase64", true),
                Json.string(parsed, "policyVersion", true));
            return padesValidator.validate(request);
        }));

        server.start();
    }

    @FunctionalInterface
    private interface Validation {
        Map<String, Object> run(Map<String, Object> parsed);
    }

    private static void handle(HttpExchange exchange, String token, int maximumBytes, Validation validation) throws IOException {
        try {
            HttpBoundary.requireMethod(exchange, "POST");
            HttpBoundary.requireBearer(exchange, token);
            HttpBoundary.requireJsonContentType(exchange);
            byte[] body = HttpBoundary.readBody(exchange, maximumBytes);
            Map<String, Object> parsed = Json.parseObject(new String(body, StandardCharsets.UTF_8));
            Map<String, Object> report = validation.run(parsed);
            // A failing report is a successful validation that returned "no".
            // 422 keeps that distinct from 400, which means we could not even
            // understand the request — the caller must not retry those the same way.
            respond(exchange, "PASS".equals(report.get("result")) ? 200 : 422, report);
        } catch (HttpBoundary.Rejected rejected) {
            respond(exchange, rejected.status(), errorBody(rejected.status()));
        } catch (Exception exception) {
            // No exception detail crosses the boundary: it can carry document content.
            respond(exchange, 400, Map.of("error", "VALIDATION_REQUEST_INVALID"));
        }
    }

    private static Map<String, Object> errorBody(int status) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", switch (status) {
            case 401 -> "UNAUTHORIZED";
            case 405 -> "METHOD_NOT_ALLOWED";
            case 413 -> "BODY_TOO_LARGE";
            case 415 -> "CONTENT_TYPE_REQUIRED";
            case 503 -> "SERVICE_NOT_CONFIGURED";
            default -> "VALIDATION_REQUEST_INVALID";
        });
        return body;
    }

    private static void respond(HttpExchange exchange, int status, Object value) throws IOException {
        HttpBoundary.respondJson(exchange, status, Json.stringify(value));
    }

    private static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) throw new IllegalStateException(name + "_MISSING");
        return value;
    }
}
