// OpenAPI version: 2026-08-03.2
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace KommunSign.Sdk;
public sealed class KommunSignClient(HttpClient http, Func<CancellationToken, Task<string>> accessToken)
{
    public const string OpenApiVersion = "2026-08-03.2";
    public Task<JsonDocument> ListSignatureCasesAsync(CancellationToken ct = default) => SendAsync(HttpMethod.Get, "signature-cases", null, null, null, ct);
    public Task<JsonDocument> GetSignatureCaseAsync(Guid id, CancellationToken ct = default) => SendAsync(HttpMethod.Get, $"signature-cases/{id}", null, null, null, ct);
    public Task<JsonDocument> CreateSignatureCaseAsync(object body, string idempotencyKey, CancellationToken ct = default) => SendAsync(HttpMethod.Post, "signature-cases", body, idempotencyKey, null, ct);
    public Task<JsonDocument> AddDocumentAsync(Guid id, object body, string key, CancellationToken ct = default) => SendAsync(HttpMethod.Post, $"signature-cases/{id}/documents", body, key, null, ct);
    public Task<JsonDocument> AddSignerAsync(Guid id, object body, string key, CancellationToken ct = default) => SendAsync(HttpMethod.Post, $"signature-cases/{id}/signers", body, key, null, ct);
    public Task<JsonDocument> UpdateSignerAsync(Guid id, Guid signerId, object body, string key, long? version = null, CancellationToken ct = default) => SendAsync(HttpMethod.Patch, $"signature-cases/{id}/signers/{signerId}", body, key, version, ct);
    public Task<JsonDocument> CreateUploadAsync(object body, string key, CancellationToken ct = default) => SendAsync(HttpMethod.Post, "uploads", body, key, null, ct);
    public Task<JsonDocument> CompleteUploadAsync(Guid uploadId, string sha256, string key, CancellationToken ct = default) => SendAsync(HttpMethod.Post, $"uploads/{uploadId}/complete", new { sha256 }, key, null, ct);
    public Task<JsonDocument> SendCaseAsync(Guid id, string key, long? version = null, CancellationToken ct = default) => SendAsync(HttpMethod.Post, $"signature-cases/{id}/send", null, key, version, ct);
    public Task<JsonDocument> CancelCaseAsync(Guid id, string key, long? version = null, CancellationToken ct = default) => SendAsync(HttpMethod.Post, $"signature-cases/{id}/cancel", null, key, version, ct);
    private async Task<JsonDocument> SendAsync(HttpMethod method, string path, object? body, string? key, long? version, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", await accessToken(ct));
        if (key is not null) request.Headers.Add("Idempotency-Key", key);
        if (version is not null) request.Headers.TryAddWithoutValidation("If-Match", version.Value.ToString());
        if (body is not null) request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"KommunSign API returned {(int)response.StatusCode}");
        return JsonDocument.Parse(bytes);
    }
}
