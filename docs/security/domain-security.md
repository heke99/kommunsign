# Domänsäkerhet

Kontroller:

- strikt hostname-normalisering inklusive IDN till ASCII
- globalt unikt canonical hostname
- fail-closed okänd/inaktiv värd
- betrodd proxy krävs för forwarded host
- challenge med hög entropi och krypterad återläsning
- verifiering, certifikat och health-evidens före active
- tvåpersonsbyte av primärdomän
- ingen wildcard-CORS för credential-endpoints
- host-only sessions utan Domain-attribut
- standarddomän bevaras som fallback

Testerna täcker slug/IDN, okänd host, auth-code replay, host-bound destination och cookiegräns. DNS rebinding/takeover måste dessutom testas i en kontrollerad extern miljö.
