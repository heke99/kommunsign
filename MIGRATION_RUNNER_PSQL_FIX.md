# Migration runner psql interpolation fix

The previous runner used psql variables inside SQL supplied with `-c`. In the
reported environment psql sent the literal `:'migration_scope'` token to
PostgreSQL, causing SQLSTATE 42601.

The corrected runner:

- sends checksum lookup SQL through stdin, where psql variable interpolation is applied;
- writes the registry insert to a temporary SQL file;
- executes the migration and registry insert in one `--single-transaction` psql process;
- preserves checksum verification and idempotent re-runs.

No schema reset is required after the reported failure because execution stopped
before the first numbered migration was applied.
