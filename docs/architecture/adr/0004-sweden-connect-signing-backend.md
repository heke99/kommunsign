# ADR 0004 — Sweden Connect as the signing and validation backend

Status: accepted
Date: 2026-08-18
Supersedes: ADR 0003's choice of EU DSS as the intended backend
Retains: ADR 0003's dependency admission gate, unchanged

## Context

ADR 0003 settled the important question — we do not write our own cryptography —
and named EU DSS as the intended backend. That decision was made before any
backend was wired in, and it left `services/signservice` returning
`BlockedSigningEngine` unconditionally.

Two things have changed since.

First, the gap between "designed" and "connected" turned out to be doing real
harm. `handleSignatureValidate` marked a signer `signed` once TIC/BankID evidence
verified. That is an identity proof, not a signature: it establishes who was
present and what they consented to, and it produces no signed PDF at all.
Meanwhile `packages/signing-engine`, `packages/pades` and ten evidence tables sat
with no runtime caller. The system had a complete identity chain, a complete
design for a signature chain, and nothing joining them.

Second, on re-examination the Sweden Connect stack is the better fit for this
deployment, not merely an acceptable alternative:

- It is the Swedish reference implementation behind Digg's trust framework, which
  is the framework Kungälv requirement F001 is written against.
- `se.idsec.signservice.commons:signservice-pdf-commons` produces PAdES over
  PDFBox with incremental revisions, which is what sequential signing needs.
- `se.swedenconnect.sigval:sigval-pdf` performs independent PAdES validation —
  certificate path, revocation, timestamps, signature coverage — from a separate
  codebase, so a validation result is evidence rather than the signer restating
  its own claim.
- `se.swedenconnect.security:credentials-support` abstracts software keystores,
  PKCS#11 tokens and remote QSCDs behind one credential API, so key protection
  becomes configuration rather than a code path.

The stack builds on BouncyCastle and PDFBox, so this is not a retreat from
ADR 0003's principle. It is the same principle applied with a more specific
implementation.

## Decision

**Sweden Connect is the signing and validation backend.** EU DSS is no longer the
intended backend; nothing in the repository depended on it.

**The core stays provider-neutral.** `packages/signing-engine` still defines the
boundary and no application code names a backend. Selection remains a factory
registration in `SigningEngineFactory`.

**Level is derived from evidence, in one place.** The signing engine reports the
profile it produced and the material it attached. The validator reports which
evidence it found. Neither claims a PAdES level. `packages/pades` derives the
attained level and is the only component permitted to admit one, and a database
guard mirrors the same ladder so the rule survives a bug in application code.

**The service refuses by default, and refuses harder in production.**
`SigningEngineFactory` returns `BlockedSigningEngine` unless a recognised backend,
a declared key protection level and loadable key material are all present. In
production a `SOFTWARE` key protection level is refused outright, because an
advanced electronic signature is a claim about sole control of the signing key
and a PKCS#12 file on a container filesystem does not support that claim however
valid the resulting CMS structure is.

**Signing is bound to identity, not merely accompanied by it.**
`TicIdentityBinding` asserts that the tenant, case, signing intent and signer in
the request match the verified TIC evidence, that the document is one the signer
actually approved, and that the submitted bytes hash to the declared revision. A
signing service that checks who the signer is but not what they are signing has
authorised a document the signer never saw.

## Build consequence

`services/signservice` and `services/validation-service` are now Maven modules.
`scripts/build-java.sh` stays javac-only and offline for `identity-service` and
the Java SDK; the dependency-bearing services are built by
`scripts/build-java-maven.sh` (`npm run verify:java:maven`) in a dedicated CI job
with a Maven cache.

This split is deliberate. Folding Maven into `npm run verify` would make every
local verification require network access to Maven Central, a cost paid by
everyone on every run to catch a break the dedicated job catches anyway.

Versions are pinned individually in `services/pom.xml` rather than imported from
upstream BOMs. An imported BOM can move a transitive version without the change
appearing in any file we review, and "which exact version signs a municipal
document" is the one thing that must not move silently. The enforcer plugin fails
the build on any SNAPSHOT dependency or unpinned plugin.

## Dependency admission (ADR 0003 gate)

| Artifact | Version | Licence | Boundary |
| --- | --- | --- | --- |
| `se.idsec.signservice.commons:signservice-pdf-commons` | 2.2.1 | Apache-2.0 | signservice only |
| `se.swedenconnect.signservice:signservice-authn-base` | 1.1.3 | Apache-2.0 | signservice only |
| `se.swedenconnect.security:credentials-support` | 2.0.4 | Apache-2.0 | signservice only |
| `se.swedenconnect.sigval:sigval-pdf` | 1.3.0 | Apache-2.0 | validation-service only |
| `org.slf4j:slf4j-simple` | 2.0.16 | MIT | runtime logging |
| `org.apache.logging.log4j:log4j-to-slf4j` | 2.24.3 | Apache-2.0 | runtime logging |

Transitively these bring BouncyCastle (`bcprov`/`bcpkix` 1.79–1.80) and Apache
PDFBox 3.0.4. Both are reached only through the boundary services and are never
linked into the TypeScript core.

## Consequences

- The signing chain is connected: TIC evidence verified → identity verified →
  PAdES created → PAdES independently validated → admission gate → signer signed.
- Multi-signer cases preserve earlier signatures, because each signature is an
  incremental PDF revision. This is asserted in code, not assumed: the engine
  refuses a result that is not a byte-prefix extension of its input.
- Emitting a *production* signature still depends on things code cannot supply:
  a CA-issued certificate, an HSM or remote QSCD, and a TSA contract. Those stay
  recorded as `BLOCKED_EXTERNAL` with their exact blockers. Without a TSA the
  backend can only reach PAdES-B, and a policy demanding more is refused rather
  than quietly downgraded.
