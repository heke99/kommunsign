# KommunSign SDKs

Källklienter för TypeScript, C# och Java är bundna till OpenAPI-version `2026-08-02.3`. De skickar aldrig `tenantId`; tenant härleds av API-auth. Klienterna är avsiktligt tunna och ska publiceras först efter att OAuth-tokenendpoint, paketmetadata, release-signering och genererade modelltester är färdiga.
