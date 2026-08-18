import { sha256Hex } from '../../crypto/src/hash.js';
import type { EvidenceFile } from '../../evidence/src/index.js';
import { ArchiveError, type ArchivePackage } from './index.js';

/**
 * FGS Paketstruktur (RAFGS1V1.2) submission package descriptor.
 *
 * The archive package this repository already builds is a canonical-JSON
 * manifest. That format is good — deterministic and verifiable offline — but it
 * is ours, and calling it FGS would be a false claim about interoperability with
 * a Swedish e-archive. This module produces the real thing alongside it: a METS
 * `sip.xml` following the profile Riksarkivet publishes, so the package can be
 * ingested by a system that has never heard of Kommunsign.
 *
 * The JSON manifest is kept and shipped inside the package as metadata. It is
 * what makes offline verification possible without a METS toolchain, and losing
 * that to gain conformance would be a bad trade.
 *
 * Values below are taken from the published profile rather than inferred:
 *   http://xml.ra.se/e-arkiv/METS/CommonSpecificationSwedenPackageProfile.xml
 * which states it is "version 1.2 consistent with published version 1.2 of FGS
 * Paketstruktur (RAFGS1V1.2)".
 *
 * What this module does NOT do is validate against the FGS XSD. That needs the
 * schema set the receiving archive actually requires, and asserting conformance
 * we have not verified is precisely the overclaim this file exists to remove.
 * See `FGS_CONFORMANCE_STATUS`.
 */

export const FGS_SPECIFICATION = 'RAFGS1V1.2';
export const FGS_PROFILE_URI = 'http://xml.ra.se/e-arkiv/METS/CommonSpecificationSwedenPackageProfile.xml';
export const FGS_PACKAGE_DESCRIPTOR = 'sip.xml';

const METS_NS = 'http://www.loc.gov/METS/';
const EXT_NS = 'ExtensionMETS';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
const SCHEMA_LOCATION = [
  'http://www.loc.gov/METS/ http://xml.ra.se/e-arkiv/METS/CSPackageMETS.xsd',
  'ExtensionMETS http://xml.ra.se/e-arkiv/METS/CSPackageExtensionMETS.xsd',
].join(' ');

/**
 * The honest state of conformance.
 *
 * Structure follows the published profile. Schema validation against the XSD set
 * the receiving archive mandates is an external step, because the archive
 * chooses the version and any local extensions. Anything reporting on FGS
 * conformance must read this rather than assume.
 */
export const FGS_CONFORMANCE_STATUS = {
  specification: FGS_SPECIFICATION,
  profileUri: FGS_PROFILE_URI,
  structureFollowsProfile: true,
  schemaValidated: false,
  schemaValidationBlocker:
    'Requires the FGS XSD set and any local profile extensions the receiving archive mandates, plus a confirmed FGS version from the municipality.',
} as const;

export interface FgsAgents {
  /** The archive the package is delivered to. */
  readonly archivist: string;
  /** The organisation whose records these are. */
  readonly creator: string;
  /** The organisation transferring the package. */
  readonly submitter: string;
  /** Software that produced the package. */
  readonly producingSoftware: string;
  readonly producingSoftwareVersion: string;
}

export interface FgsPackage {
  /** The METS descriptor, written at the package root as `sip.xml`. */
  readonly descriptor: EvidenceFile;
  readonly descriptorSha256: string;
  readonly specification: typeof FGS_SPECIFICATION;
  readonly profileUri: typeof FGS_PROFILE_URI;
}

/**
 * Builds the METS descriptor for an already-built archive package.
 *
 * Deterministic by construction: file identifiers are derived from the file's
 * own path and hash rather than generated, entries keep the manifest's sorted
 * order, and every timestamp comes from the case. Exporting the same closed case
 * twice must produce identical bytes, or the archived copy cannot be shown to be
 * the copy that was delivered.
 */
export async function buildFgsPackage(archive: ArchivePackage, agents: FgsAgents): Promise<FgsPackage> {
  if (archive.manifest.entries.length === 0) {
    throw new ArchiveError('ARCHIVE_DOCUMENT_MISSING', 'An FGS package must reference at least one file');
  }
  requireAgent(agents.archivist, 'archivist');
  requireAgent(agents.creator, 'creator');
  requireAgent(agents.submitter, 'submitter');
  requireAgent(agents.producingSoftware, 'producingSoftware');

  const files = [];
  for (const entry of archive.manifest.entries) {
    files.push({
      id: `ID${await deterministicIdentifier(entry.path, entry.sha256)}`,
      href: `file:///${entry.path}`,
      mediaType: entry.mediaType,
      bytes: entry.bytes,
      sha256: entry.sha256,
      // The profile allows USE to mark files with a special function. The
      // distinction matters to an ingesting archive: content is the record,
      // everything else is what lets a reader trust it.
      use: entry.category === 'content' ? 'Datafile' : entry.category === 'metadata' ? 'Metadata' : 'Evidence',
    });
  }

  const created = archive.manifest.closedAt;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<mets:mets xmlns:mets="${METS_NS}" xmlns:ext="${EXT_NS}" xmlns:xlink="${XLINK_NS}" xmlns:xsi="${XSI_NS}"`
    + ` xsi:schemaLocation="${SCHEMA_LOCATION}"`
    + ` OBJID="UUID:${attribute(archive.manifest.signatureCaseId)}"`
    + ` LABEL="${attribute(archive.manifest.title)}"`
    + ' TYPE="Archival information"'
    + ` PROFILE="${FGS_PROFILE_URI}">`,
  );

  lines.push(`  <mets:metsHdr CREATEDATE="${attribute(created)}" RECORDSTATUS="NEW" ext:OAISSTATUS="SIP">`);
  lines.push(agent('ARCHIVIST', 'ORGANIZATION', agents.archivist));
  lines.push(agent('CREATOR', 'ORGANIZATION', agents.creator));
  lines.push(agentOther('OTHER', 'SUBMITTER', 'ORGANIZATION', agents.submitter));
  lines.push(
    '    <mets:agent ROLE="CREATOR" TYPE="OTHER" OTHERTYPE="SOFTWARE">'
    + `<mets:name>${text(agents.producingSoftware)}</mets:name>`
    + `<mets:note>${text(agents.producingSoftwareVersion)}</mets:note>`
    + '</mets:agent>',
  );
  lines.push(`    <mets:metsDocumentID>${FGS_PACKAGE_DESCRIPTOR}</mets:metsDocumentID>`);
  lines.push('  </mets:metsHdr>');

  // The manifest hash is delivered outside the package so it can certify the
  // manifest. Recording it here as provenance lets an archivist see which
  // manifest this descriptor was built from without trusting the package alone.
  lines.push('  <mets:amdSec>');
  lines.push('    <mets:digiprovMD ID="IDprovenance">');
  lines.push('      <mets:mdWrap MDTYPE="OTHER" OTHERMDTYPE="COMMENT">');
  lines.push('        <mets:xmlData>');
  lines.push(`          <ext:provenance xmlns:ext="${EXT_NS}"`
    + ` manifestSchema="${attribute(archive.manifest.schema)}"`
    + ` manifestSha256="${attribute(archive.manifestSha256)}"`
    + ` regulation="${attribute(archive.manifest.regulation)}"`
    + ` auditTrailSha256="${attribute(archive.manifest.auditTrailSha256)}"`
    + ` decisionMode="${attribute(archive.manifest.decisionMode)}"`
    + ` reference="${attribute(archive.manifest.reference)}"/>`);
  lines.push('        </mets:xmlData>');
  lines.push('      </mets:mdWrap>');
  lines.push('    </mets:digiprovMD>');
  lines.push('  </mets:amdSec>');

  lines.push('  <mets:fileSec>');
  lines.push('    <mets:fileGrp>');
  for (const file of files) {
    lines.push(
      `      <mets:file ID="${attribute(file.id)}" MIMETYPE="${attribute(file.mediaType)}"`
      + ` SIZE="${file.bytes}" CREATED="${attribute(created)}" USE="${attribute(file.use)}"`
      + ` CHECKSUM="${attribute(file.sha256)}" CHECKSUMTYPE="SHA-256">`,
    );
    lines.push(`        <mets:FLocat LOCTYPE="URL" xlink:href="${attribute(file.href)}" xlink:type="simple"/>`);
    lines.push('      </mets:file>');
  }
  lines.push('    </mets:fileGrp>');
  lines.push('  </mets:fileSec>');

  // The profile defines exactly one simple structMap and leaves richer
  // structures to information-type-specific specifications. Inventing one here
  // would be a local extension no receiving archive agreed to.
  lines.push('  <mets:structMap LABEL="Profilestructmap">');
  lines.push('    <mets:div>');
  for (const file of files) {
    lines.push(`      <mets:fptr FILEID="${attribute(file.id)}"/>`);
  }
  lines.push('    </mets:div>');
  lines.push('  </mets:structMap>');
  lines.push('</mets:mets>');
  lines.push('');

  const bytes = new TextEncoder().encode(lines.join('\n'));
  return {
    descriptor: { path: FGS_PACKAGE_DESCRIPTOR, bytes, mediaType: 'text/xml' },
    descriptorSha256: await sha256Hex(bytes),
    specification: FGS_SPECIFICATION,
    profileUri: FGS_PROFILE_URI,
  };
}

function agent(role: string, type: string, name: string): string {
  return `    <mets:agent ROLE="${attribute(role)}" TYPE="${attribute(type)}"><mets:name>${text(name)}</mets:name></mets:agent>`;
}

function agentOther(role: string, otherRole: string, type: string, name: string): string {
  return `    <mets:agent ROLE="${attribute(role)}" OTHERROLE="${attribute(otherRole)}" TYPE="${attribute(type)}">`
    + `<mets:name>${text(name)}</mets:name></mets:agent>`;
}

function requireAgent(value: string, field: string): void {
  if (!value || !value.trim()) {
    // Reuses the existing code rather than adding a synonym: a package missing a
    // required agent is precisely a package that does not satisfy the profile.
    throw new ArchiveError('ARCHIVE_PROFILE_NOT_VERIFIED', `FGS package requires an agent name for ${field}`);
  }
}

/**
 * A stable identifier for a file inside the descriptor.
 *
 * The profile suggests "ID" followed by a UUID. A random one would break the
 * determinism the archive package depends on, so this derives a UUID-shaped
 * value from the file's own path and content hash: same file, same identifier,
 * on every export and every machine.
 */
async function deterministicIdentifier(path: string, sha256: string): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(`${path} ${sha256}`));
  const characters = digest.slice(0, 32).split('');
  // Set the version and variant nibbles so the value is a well-formed UUID
  // rather than something that merely looks like one.
  characters[12] = '5';
  characters[16] = '8';
  const hex = characters.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Escapes a value for use in an XML attribute.
 *
 * Case titles and organisation names are operator-supplied text. Without this a
 * quote in a case title would end the attribute and let the rest of the title be
 * read as markup — in a document an archive ingests unattended, that is an
 * injection rather than a formatting bug.
 */
function attribute(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;');
}

function text(value: string): string {
  return escapeXml(value);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Control characters other than tab, newline and carriage return cannot be
    // represented in XML 1.0 at all, so they are dropped rather than emitted
    // into a file the archive would then fail to parse.
    .replace(/[ --]/g, '');
}
