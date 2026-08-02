# Runbook: domänincident

Vid takeover-misstanke, certifikatfel eller fel tenantbindning:

1. Sätt domänen `suspended` och invalidiera gatewaycache.
2. Flytta primary till verifierad standarddomän genom tvåpersonsproceduren.
3. Stoppa nya signerarlänkar till den drabbade hosten.
4. Bevara DNS-, certifikat-, routing- och audit-evidens.
5. Rotera provider-token/challenge vid misstänkt läckage.
6. Verifiera att inga andra tenants delar hostname, cookie eller cachepost.
7. Återaktivera först efter ny DNS/TLS/takeover/readiness-kontroll.

Använd inte borttagning som första åtgärd; suspension bevarar incidenthistoriken.
