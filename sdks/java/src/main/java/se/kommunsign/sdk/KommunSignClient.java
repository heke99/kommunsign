package se.kommunsign.sdk;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Objects;
import java.util.function.Supplier;

/** OpenAPI version 2026-08-02.2. */
public final class KommunSignClient {
  public static final String OPENAPI_VERSION = "2026-08-02.2";
  private final HttpClient http;
  private final URI baseUri;
  private final Supplier<String> accessToken;
  public KommunSignClient(HttpClient http, URI baseUri, Supplier<String> accessToken) {
    this.http = Objects.requireNonNull(http); this.baseUri = Objects.requireNonNull(baseUri); this.accessToken = Objects.requireNonNull(accessToken);
  }
  public HttpResponse<String> listSignatureCases() throws Exception { return send("GET", "signature-cases", null, null, null); }
  public HttpResponse<String> getSignatureCase(String id) throws Exception { return send("GET", "signature-cases/" + id, null, null, null); }
  public HttpResponse<String> createSignatureCase(String json, String key) throws Exception { return send("POST", "signature-cases", json, key, null); }
  public HttpResponse<String> sendSignatureCase(String id, String key, Long version) throws Exception { return send("POST", "signature-cases/" + id + "/send", null, key, version); }
  private HttpResponse<String> send(String method, String path, String json, String key, Long version) throws Exception {
    var builder = HttpRequest.newBuilder(baseUri.resolve(path)).header("Authorization", "Bearer " + accessToken.get());
    if (key != null) builder.header("Idempotency-Key", key);
    if (version != null) builder.header("If-Match", version.toString());
    if (json != null) builder.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(json));
    else builder.method(method, HttpRequest.BodyPublishers.noBody());
    var response = http.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    if (response.statusCode() < 200 || response.statusCode() >= 300) throw new IllegalStateException("KommunSign API returned " + response.statusCode());
    return response;
  }
}
