package se.kommunsign.commons;

import com.sun.net.httpserver.HttpExchange;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

/**
 * The rules every Java boundary service applies before it looks at a request body.
 *
 * These checks are shared rather than reimplemented per service because each one
 * has a failure mode that is easy to reintroduce by hand: a token compared with
 * {@code equals} leaks its length and prefix through timing, a body read without
 * a cap lets one request exhaust the heap, and a service that ignores
 * Content-Type will happily parse a form post as JSON.
 */
public final class HttpBoundary {

    private HttpBoundary() {}

    /** Thrown to signal an HTTP status; the message is always safe to return. */
    public static final class Rejected extends RuntimeException {
        private final int status;
        public Rejected(int status, String safeMessage) { super(safeMessage); this.status = status; }
        public int status() { return status; }
    }

    public static void requireMethod(HttpExchange exchange, String method) {
        if (!method.equalsIgnoreCase(exchange.getRequestMethod())) {
            throw new Rejected(405, "method not allowed");
        }
    }

    public static void requireJsonContentType(HttpExchange exchange) {
        String contentType = exchange.getRequestHeaders().getFirst("Content-Type");
        if (contentType == null || !contentType.toLowerCase().startsWith("application/json")) {
            throw new Rejected(415, "application/json required");
        }
    }

    /**
     * Compares a Bearer token in constant time.
     *
     * The digest step matters: comparing the raw bytes still leaks length, so
     * both sides are hashed to a fixed width first and the digests are compared.
     */
    public static void requireBearer(HttpExchange exchange, String expectedToken) {
        if (expectedToken == null || expectedToken.isBlank()) throw new Rejected(503, "service token not configured");
        String header = exchange.getRequestHeaders().getFirst("Authorization");
        if (header == null || !header.startsWith("Bearer ")) throw new Rejected(401, "unauthorized");
        String presented = header.substring("Bearer ".length()).trim();
        if (!MessageDigest.isEqual(sha256(presented), sha256(expectedToken))) throw new Rejected(401, "unauthorized");
    }

    /** Reads at most {@code maximumBytes}, refusing rather than truncating. */
    public static byte[] readBody(HttpExchange exchange, int maximumBytes) throws IOException {
        try (InputStream stream = exchange.getRequestBody()) {
            byte[] body = stream.readNBytes(maximumBytes + 1);
            if (body.length > maximumBytes) throw new Rejected(413, "request body too large");
            return body;
        }
    }

    public static void respondJson(HttpExchange exchange, int status, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.getResponseHeaders().add("Cache-Control", "no-store");
        exchange.getResponseHeaders().add("X-Content-Type-Options", "nosniff");
        exchange.sendResponseHeaders(status, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
    }

    public static String sha256Hex(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (Exception exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }
}
