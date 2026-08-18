# Third-party notices and production image inventory

Kommunsign clean-room application code remains governed by the repository's own licensing/provenance records. This file records runtime dependencies; it does not replace each dependency's license text.

| Component | Version/tag used | Role | License/source | Production digest status |
|---|---|---|---|---|
| Node.js | 22.16.0 bookworm-slim | API/worker runtime | Node.js / Docker Official Image | Resolve and record deployment-platform manifest digest before release. |
| PostgreSQL | 17.10-bookworm | Control/data database | PostgreSQL License | Resolve and record digest before release. |
| ClamAV | 1.5.3-debian13-slim | Malware scanning | GPL-2.0; official Cisco Talos image | Resolve architecture-specific/manifest digest in the target registry before release. |
| qpdf | Debian bookworm package | PDF structural/policy checks | Apache-2.0 | Record installed `qpdf --version` and package checksum in build attestation. |
| Gotenberg | 8.34.0 | PDF/A conversion | MIT | Resolve and record digest before release. |
| veraPDF | approved pinned release required | PDF/A-2b validation | GPL/MPL components; veraPDF project | **Release blocker:** select approved REST image/build and record exact version and digest; never use `latest`. |
| Mailpit | 1.27.8 | local email testing only | MIT | Not permitted as production provider. |
| Java/Temurin | 21.0.10_7 | Java boundary services | Eclipse Temurin | Resolve and record digest before release. |
| Maven | 3.9.11 | build of the Java boundary services | Apache-2.0 | Build-time only; not present in the runtime image. |
| Sweden Connect signservice-pdf-commons | 2.2.1 | PAdES creation (signservice) | Apache-2.0; se.idsec.signservice.commons | Admitted under ADR 0003 gate; see ADR 0004. |
| Sweden Connect signservice-authn-base | 1.1.3 | SignService authentication boundary | Apache-2.0; se.swedenconnect.signservice | Admitted under ADR 0003 gate; see ADR 0004. |
| Sweden Connect credentials-support | 2.0.4 | key protection: software, PKCS#11, remote QSCD | Apache-2.0; se.swedenconnect.security | Admitted under ADR 0003 gate; see ADR 0004. |
| Sweden Connect sigval-pdf | 1.3.0 | independent PAdES validation (validation-service) | Apache-2.0; se.swedenconnect.sigval | Admitted under ADR 0003 gate; see ADR 0004. |
| BouncyCastle bcprov/bcpkix | 1.80 / 1.79 | cryptographic primitives, ASN.1, CMS (transitive) | MIT-style BouncyCastle licence | Reached only through the Java boundary services. |
| Apache PDFBox | 3.0.4 | PDF parsing and incremental revision writing (transitive) | Apache-2.0 | Reached only through the Java boundary services. |
| SLF4J simple | 2.0.16 | logging provider for the Java boundary services | MIT | Runtime only. |
| Log4j-to-SLF4J | 2.24.3 | routes Log4j API calls to SLF4J | Apache-2.0 | Runtime only; the Log4j *core* backend is deliberately absent. |
| TIC | production API | BankID provider | Commercial provider agreement | Credentials/account activation external. |
| Resend/Svix | configured account | Email/webhook delivery | Commercial service and Svix protocol | Data-residency approval is a separate release gate. |

`docker-compose.yml` is a local integration stack, not production orchestration. Production deployment evidence must include immutable image digests, vulnerability scan, SBOM and license review.
