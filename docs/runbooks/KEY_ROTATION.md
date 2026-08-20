# Runbook: rotating an encryption key

## When to use this

Any of these:

- **Confirmed exposure.** A key reached somewhere it should not have — a log, a
  repository, a screenshot, a laptop that left the building. Treat as urgent.
- **Suspected exposure.** You cannot rule out the above. Treat as confirmed;
  the cost of an unnecessary rotation is a day of work, and the cost of a
  skipped one is every record the key protects.
- **Scheduled.** The key ring's `maximumAgeDays` has elapsed.
- **Algorithm change.** Moving to different parameters.

Kommunsign encrypts identifiers, e-mail addresses, session metadata and webhook
secrets. Those columns are listed by:

```sql
SELECT table_name, column_name
  FROM information_schema.columns
 WHERE table_schema = 'app'
   AND (column_name LIKE '%\_ciphertext' OR column_name LIKE '%\_blind_index')
 ORDER BY 1, 2;
```

## The failure this procedure exists to prevent

Retiring a key while some row still decrypts with it. Nothing breaks at the
time. It breaks when somebody needs that row — typically years later, typically
because a court, an auditor or a data subject asked for it, and by then the key
is gone.

Every step below exists to make that outcome impossible rather than unlikely.
The database enforces it too: `app.assert_key_rotation_complete` refuses to mark
a rotation verified while any column still reports outstanding rows.

## Before you start

- [ ] The new key exists in the KMS/HSM and the service can load it. Verify by
      loading it, not by reading the console.
- [ ] You know the current key version: `SELECT DISTINCT key_version FROM app.signers;`
      and the same for each table in the list above. More than one distinct
      value means a previous rotation did not finish — resolve that first.
- [ ] You have a second person available. Not required by the schema, but a
      rotation is irreversible past the point the old key is retired.
- [ ] You have checked the row counts. A rotation over tens of millions of rows
      is a multi-hour operation and should be started accordingly.

## Procedure

### 1. Record the rotation

```sql
INSERT INTO app.key_rotations (tenant_id, purpose, state, from_version, to_version, reason, requested_by)
VALUES ($tenant, 'signer.identifier', 'PLANNED', 1, 2, 'CONFIRMED_EXPOSURE', $operator)
RETURNING id;
```

`reason` is not decoration. A scheduled rotation and a rotation because the key
leaked have different urgency and different evidence requirements, and six
months later nobody remembers which this was.

Only one rotation per purpose may be live at a time. The unique index enforces
it, because two overlapping rotations would each believe they knew the target
version and leave rows split across three keys with no record of which.

### 2. Enter dual read

```sql
UPDATE app.key_rotations SET state = 'DUAL_READ' WHERE id = $rotation;
```

Then deploy with the new key present and the old one still active:

```
SENSITIVE_DATA_ENCRYPTION_KEY_BASE64=<version 1, unchanged>
SENSITIVE_DATA_ENCRYPTION_KEY_V2_BASE64=<the new key>
```

Do **not** set `SENSITIVE_DATA_ACTIVE_KEY_VERSION` yet. At this point every node
can read under both versions and still writes under version 1, which is what
makes the next step safe to start and safe to abandon.

When every node has the new key, point writes at it:

```
SENSITIVE_DATA_ACTIVE_KEY_VERSION=2
```

Rows written before this keep working: the version byte in each envelope names
the key that encrypted it, and `assertReadableVersion` in
`packages/crypto/src/key-rotation.ts` allows any version that is not retired.

**Do not skip this.** Re-encrypting before dual read is in place makes every
re-encrypted row unreadable to instances that have not yet picked up the new
key. The state machine refuses the transition, but understand why.

### 3. Record what has to be re-encrypted

One row per column, with the real count:

```sql
INSERT INTO app.key_rotation_columns (tenant_id, key_rotation_id, table_name, column_name, rows_total)
SELECT $tenant, $rotation, 'signers', 'verified_identifier_ciphertext',
       count(*) FROM app.signers WHERE tenant_id = $tenant AND key_version = 1;
```

Repeat for every column on the old version. A rotation with no recorded columns
cannot be verified — `KEY_ROTATION_NOTHING_VERIFIED` — because a rotation that
verified nothing reporting success is exactly how this goes wrong quietly.

### 4. Re-encrypt

```sql
UPDATE app.key_rotations SET state = 'REENCRYPTING' WHERE id = $rotation;
```

Work in batches, updating `rows_reencrypted` as you go. Batching is what makes
the operation resumable: a rotation over a large table *will* be interrupted,
and starting again from the beginning is how a rotation never finishes.

For each batch: read the value and write it straight back. The adapter reads
under whichever version the envelope names and writes under the active one, so
re-encryption is a read followed by a write and needs no special key handling.
Set `key_version = 2` on the row and add the batch size to `rows_reencrypted`.
Do the row update and the progress update in the same transaction, or a crash
between them leaves the counter lying in the direction that matters.

Blind indexes are recomputed, not re-encrypted — see `planBlindIndexRotation`.
An index computed under the old key does not match one computed under the new,
so a partially rotated index silently stops finding rows. Rotate every blind
index for a given lookup together.

### 5. Verify

```sql
-- Must return zero rows.
SELECT table_name, column_name, rows_total - rows_reencrypted AS outstanding
  FROM app.key_rotation_columns
 WHERE key_rotation_id = $rotation AND rows_reencrypted < rows_total;

-- And independently, from the data rather than the counters:
SELECT count(*) FROM app.signers WHERE tenant_id = $tenant AND key_version = 1;
```

Check both. The counters are what the rotation believes; the `key_version`
column is what is true. If they disagree, the counters are wrong and the
rotation is not finished.

```sql
UPDATE app.key_rotations SET state = 'VERIFIED' WHERE id = $rotation;
```

### 6. Complete, then retire

```sql
UPDATE app.key_rotations SET state = 'COMPLETED', completed_at = now() WHERE id = $rotation;
```

Only now move the old key version to `decrypt_only`, and only after a further
observation window move it to `retired`. `retireOldVersion` in
`packages/crypto` calls `assertRotationComplete` first and will refuse if the
progress does not add up.

Retiring the key is the irreversible step. Everything before it can be rolled
back.

## Rolling back

Up until the old key is retired:

```sql
UPDATE app.key_rotations
   SET state = 'ROLLED_BACK', rolled_back_reason = 'the new key could not be loaded in the HSM'
 WHERE id = $rotation;
```

The reason is mandatory. "It was rolled back" with no reason is not a record
anybody can act on later.

Rows already re-encrypted stay re-encrypted and stay readable, because the old
version is still `active` and the new one is still loaded. Do not attempt to
re-encrypt backwards; leave the mixed state and start a new rotation when the
blocker is resolved.

## After a confirmed exposure

Rotation removes the key's future value. It does not undo the past: anything the
holder decrypted while they had it stays decrypted. So also:

- [ ] Determine the exposure window from the key's creation and the evidence of
      exposure.
- [ ] Assess whether the exposure is a personal data breach under GDPR art. 33.
      If it is, the 72-hour clock started when you became aware, not when you
      finished rotating.
- [ ] Check `audit.audit_events` for access during the window.
- [ ] Record the assessment. A documented decision that a breach was *not*
      notifiable is itself evidence; an undocumented one is indistinguishable
      from not having considered it.

## What this repository does not do

Kommunsign holds no production key material and performs no rotation on its own.
This runbook, the migration and the guards make a rotation trackable and
verifiable; **performing one is an operator action** against the customer's own
KMS or HSM. Until a real key management service is connected, the rotation
capability is `BLOCKED_EXTERNAL`, not implemented-and-untested.
