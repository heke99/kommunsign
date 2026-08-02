# Runbook: anslut kunddomän

1. Skapa domänbegäran mot tenantens production environment.
2. Visa aktuellt TXT-challenge för kunden.
3. Kunden publicerar TXT-posten.
4. Kör DNS-verifiering och provider attachment.
5. Vänta på certifikat och kör health check.
6. Verifiera tenant-ID, routing, auth callback, same-origin API, signerportal och verifieringsportal.
7. Kör readiness.
8. Begär byte av primärdomän och låt en annan behörig aktör godkänna.
9. Verifiera att nya e-post-/signeringslänkar använder custom domain och att standarddomänen fortfarande fungerar.

Markera aldrig ett mockat resultat som liveverifierat.
