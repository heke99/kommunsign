# Personal-number handling

## Default policy

A Swedish personal number is required for a BankID signer by default. It is normalized to `YYYYMMDDNNNN`, calendar-validated and Luhn-validated on the server.

The value is encrypted at rest with the sensitive-data adapter. A keyed blind index supports exact matching. UI shows only a masked value such as `1990••••-0009`. Logs, audit payloads, email and public verification never contain the clear value.

At `STRICT_PREBOUND`, the normalized value is sent to TIC as `personalNumber` and independently compared with the verified identity extracted from the signed evidence.

## Controlled exception

`BANKID_DISCOVERED` requires all of:

- tenant policy allows exceptions;
- actor has `signer:personnummer-binding-exempt`;
- an allowlisted code;
- encrypted reason for `OTHER`;
- approving actor and timestamp;
- risk acknowledgement in UI;
- audit event without clear reason text.

The exception reason is never sent to TIC. The verified BankID personal number is encrypted after evidence validation.

## Data subject and retention controls

Access requires tenant context and purpose-bound decryption. Export, support and incident tools must remain masked. Retention follows the tenant-approved signing/evidence policy; test signings use a separately documented retention decision.
