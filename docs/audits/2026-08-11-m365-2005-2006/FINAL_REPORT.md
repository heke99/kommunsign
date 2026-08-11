# Final report — Kungälv Microsoft 365 requirements 2005/2006

> **FOCUSED CURRENT EVIDENCE.** This report supersedes only the Microsoft 365 GAP assessment for requirements 2005 and 2006 in `docs/audits/2026-08-11-full-product-completion/FINAL_REPORT.md`. Other technical or external findings in the earlier report remain unchanged unless separately remediated.

## Baseline

- Repository: `heke99/kommunsign`
- Baseline: `main` after PR #4
- Baseline commit: `bc3485f4198e7034ee0c4abfce3843a3dc906b08`
- Remediation branch: `remediation/kommunsign-m365-2005-2006-2026-08-11`
- Pull request: #5

## Requirements

### 2005

The source requirement requires the solution to work with Microsoft 365 with online and desktop editing on personal computers.

Kommunsign now supports the native Microsoft 365 source formats `.docx`, `.xlsx` and `.pptx` in the normal authenticated document workflow. A user can edit the source in Microsoft 365 online or in the desktop Office application, save the normal Office file, and upload it without performing local PDF conversion.

### 2006

The source requirement requires the solution to work with Microsoft 365 online on shared computers.

Kommunsign's tenant portal accepts the native Office source directly through the browser. The shared-computer flow therefore requires no local Word, Excel, PowerPoint, LibreOffice or PDF conversion installation: the user can edit in Microsoft 365 online, save/download the native Office file through the browser, and submit it to Kommunsign.

## Product boundary

This remediation implements **file-level Microsoft 365 interoperability**. It does not claim that Word/Excel/PowerPoint are embedded inside Kommunsign, and it does not claim WOPI/live co-authoring. The procurement wording is satisfied through the supported native Office document workflow; the immutable requirement text itself has not been rewritten.

The signable artifact is deliberately not the mutable Office source. Kommunsign freezes a server-generated, independently verified PDF/A-2b representation before signing.

## Canonical document flow

1. User creates or edits a Word, Excel or PowerPoint document in Microsoft 365 online or desktop.
2. Tenant portal accepts `.docx`, `.xlsx` or `.pptx` as native source.
3. `/v1/uploads` keeps the native MIME type and uses the existing authenticated tenant context and idempotency boundary.
4. Source is uploaded to the existing private quarantine storage path.
5. Completion verifies object byte size and SHA-256 binding.
6. Office worker verifies allowed MIME/extension and container magic.
7. ClamAV scans the original Office source before conversion.
8. Gotenberg/LibreOffice converts the source server-side to PDF/A-2b.
9. qpdf inspects the rendered PDF.
10. veraPDF verifies PDF/A-2b compliance.
11. Converter/validator evidence and hashes are retained in document processor reports/audit events.
12. Canonical immutable PDF is stored and the document version moves to `ready` only after successful validation.
13. Existing signing flow continues against the canonical PDF/A document.

The existing PDF upload path remains on its previous handler. Office processing is a selective extension, not a parallel case/signing architecture.

## Supported source formats

Microsoft 365 focus:

- `.docx` — `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `.xlsx` — `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
- `.pptx` — `application/vnd.openxmlformats-officedocument.presentationml.presentation`

The generic Office ingestion layer also supports `.odt`, `.ods` and `.rtf`.

## Security and integrity controls

The focused remediation adds or preserves:

- tenant-scoped upload grants;
- existing permission `upload:create`;
- existing idempotency semantics;
- SHA-256 source binding;
- private quarantine storage;
- 50 MiB Office-source maximum;
- Office MIME/extension matching;
- ZIP/RTF container magic verification;
- explicit rejection of macro-enabled Office extensions;
- ClamAV scan of the original source before conversion;
- conversion in the worker/server boundary rather than the browser;
- qpdf inspection after conversion;
- veraPDF PDF/A-2b validation;
- immutable canonical object storage;
- source and canonical SHA-256 evidence;
- recorded converter and validator versions where exposed by the runtime;
- no client-side trust decision that can mark an Office document signable.

## Automated evidence

### Main CI

On head `8413140ca70be448dace98fe5abb36c5855b186f`:

- GitHub Actions `ci` run #72: **SUCCESS**.
- This includes the focused `m365-office` verification gate through the repository `verify` command.

The focused gate checks:

- DOCX/XLSX/PPTX source-plan acceptance;
- target PDF/A-2b;
- macro rejection;
- MIME mismatch rejection;
- Office container magic checks;
- exact Gotenberg LibreOffice conversion route;
- PDF/A-2b conversion parameter;
- API acceptance of native DOCX MIME;
- production worker wiring for ClamAV/Gotenberg/veraPDF;
- portal support text and file input.

Explicit upload-boundary negative assertions for macro-enabled filenames and MIME/extension mismatches were added after that checkpoint and are required to pass on final PR head before merge.

### Browser E2E

On head `8413140ca70be448dace98fe5abb36c5855b186f`:

- GitHub Actions `browser-e2e` run #31: **SUCCESS**.
- Chromium: native `.docx` upload flow PASS.
- Firefox: native `.docx` upload flow PASS.
- WebKit: native `.docx` upload flow PASS.

The browser journey also verifies that the Office document remains server-authoritative after refresh and in a separate browser context, alongside the existing PDF/case/signer/send journey and tenant-isolation checks.

## Final-head rule

The final requirement matrix may report 2005/2006 as PASS only if the exact PR head after the final evidence/documentation commits has:

- `ci`: success; and
- `browser-e2e`: success.

Documentation does not replace this gate.

## Focused assessment

- Requirement 2005: **PASS — technically implemented at the native-file interoperability boundary**.
- Requirement 2006: **PASS — technically implemented at the browser/native-file interoperability boundary**.

These statuses do not imply that unrelated Kommunsign production/external blockers are resolved.
