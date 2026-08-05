# Kommunsign PostgreSQL 17 RLS-testroll – v2

Kör från projektroten:

```bash
unzip -qo "/Users/hekmath/Downloads/kommunsign-rls-role-test-postgres17-v2-fix.zip" -d .
npm run db:verify
```

Ingen migration krävs. Patchen ändrar endast `tests/sql/tenant-isolation.sql`.
Den ger sessionsanvändaren `SET TRUE` men försöker inte ge `ADMIN TRUE` tillbaka
till samma grantor. Testroll, medlemskap, rättigheter och testdata omfattas av
transaktionen och tas bort av `ROLLBACK`.
