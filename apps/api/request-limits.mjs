const maximumRequestBytes = Number.parseInt(process.env.API_MAX_REQUEST_BYTES ?? String(1024 * 1024), 10);
export { maximumRequestBytes };

// Per-route request body ceilings, shared by the server and its tests.
// The router declares its own per-route ceilings (2 MiB for provider webhooks, 250 MiB for evidence
// package verification), but this server rejected everything above 1 MiB first, so both were
// unreachable and evidence verification failed 250x below its documented limit. The cap is therefore
// per route, and stays tight everywhere else so a generic JSON endpoint is never a memory bomb.
export const maximumWebhookBytes = Number.parseInt(process.env.API_MAX_WEBHOOK_BYTES ?? String(2 * 1024 * 1024), 10);
export const maximumEvidenceBytes = Number.parseInt(process.env.API_MAX_EVIDENCE_UPLOAD_BYTES ?? String(250 * 1024 * 1024), 10);
const LARGE_BODY_ROUTES = [
  ['/v1/provider-webhooks/', () => maximumWebhookBytes],
  ['/v1/public/verifications/packages/verify', () => maximumEvidenceBytes],
];

export function bodyLimitFor(pathname, defaultLimit = maximumRequestBytes) {
  for (const [prefix, limit] of LARGE_BODY_ROUTES) {
    if (pathname === prefix || pathname.startsWith(prefix)) return limit();
  }
  return defaultLimit;
}
