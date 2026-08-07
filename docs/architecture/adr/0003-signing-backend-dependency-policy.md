# ADR 0003 — Signing backend and the dependency policy for cryptography

Status: accepted
Date: 2026-08-07
Supersedes: the blanket "no external dependencies" reading of ADR 0001

## Context

ADR 0001 established a clean-room core. In practice that was applied as a
near-total ban on external dependencies, and it started to cause the opposite
of the harm it was written to prevent. Kungälv requirement F001 demands a
signature that satisfies Digg's definition of an *advanced electronic
signature*. Producing and validating one means CMS/PKCS#7 SignedData, ASN.1,
certificate path building, OCSP and CRL handling, RFC 3161 timestamps and
PAdES revision management.

There are exactly two ways to get that:

1. Write it. That is writing our own cryptography, by any reasonable
   definition. It is the single highest-risk thing a team in our position
   could do, and a homegrown ASN.1 parser in the trust path of a municipal
   signature service is indefensible.
2. Depend on a maintained, audited implementation.

Option 2 is correct. The dependency rule therefore has to change from
"dependencies are forbidden" to "dependencies are admitted through a gate".

## Decision

**We do not implement cryptographic primitives, ASN.1, CMS or certificate path
validation ourselves.** Where a standard-compliant implementation is required
we adopt an established one through the admission gate below.

**The core stays provider-neutral.** `packages/signing-engine` defines
`SigningEngine`, `SignatureValidator`, `TimestampProvider` and
`CertificateProvider`. No application code names a backend. Swapping the
backend is a registry change, and the pipeline invariants (stage ordering,
document binding, level derivation) are enforced in our own tested code
regardless of which backend is behind the interface.

**EU DSS (`eu.europa.ec.joinup.sd-dss`) is the intended backend** for PAdES
creation, augmentation, signature validation, certificate validation,
timestamp validation and validation reports. It is the reference
implementation behind the EU trusted list infrastructure, it is LGPL-2.1, and
it tracks ETSI EN 319 102/122/142 directly. It is reached only through the
`services/signservice` and `services/validation-service` boundaries.

**Until a backend is configured, the service refuses to sign.**
`SigningEngineFactory` returns `BlockedSigningEngine` unless both a backend and
a declared key-protection level are configured. `NotConfiguredSigningEngine` is
the TypeScript-side equivalent. Neither degrades to a permissive stub, because
a stub produces cases that look signed and are not.

## Dependency admission gate

A dependency may only enter the build when every item below is satisfied and
recorded in `PROVENANCE_REPORT.txt`, `SBOM.cdx.json` and
`THIRD_PARTY_NOTICES.md`:

| Requirement | Rule |
| --- | --- |
| Pinned version | Exact version, no ranges. |
| Integrity | Checksum recorded in the lockfile and in the SBOM. |
| Provenance | Upstream coordinates and release artifact recorded. |
| Licence | Reviewed and compatible; recorded in `LICENSE_POLICY.md`. |
| Vulnerabilities | Scanned at adoption and on every release. |
| Maintenance | Actively maintained; a named upstream release cadence. |
| Trust boundary | Reached only through a boundary service, never linked into the core. |
| Upgrade policy | Named owner and a review trigger on upstream advisories. |

This replaces "no dependency" with "no *unadmitted* dependency". It is a
tightening for everything except cryptography, where it is the only safe
option.

## Consequences

- The technical work in `packages/signing-engine` — pipeline ordering,
  document binding, evidence collection, level derivation, fail-closed
  admission — is complete and tested now, independent of the backend.
- Actually emitting a signature remains blocked on things code cannot supply:
  CA-issued key material, an HSM or remote QSCD, and a TSA contract. Those are
  recorded as `BLOCKED_EXTERNAL` with their exact blockers, not as
  implementation gaps.
- Wiring DSS in requires adding a dependency-resolving build to
  `services/signservice`. `scripts/build-java.sh` is javac-only and offline
  today; that migration lands with the credentials, because a build that
  cannot resolve DSS offline would break `npm run verify` for everyone while
  delivering nothing until the key material exists.
