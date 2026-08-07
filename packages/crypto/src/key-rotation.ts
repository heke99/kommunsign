/**
 * Key and blind-index rotation.
 *
 * Kommunsign's data-encryption key and blind-index key were exposed in Git
 * history. They have been removed from the working tree, but history is not a
 * revocation: anyone who cloned the repository still holds them. Both keys must
 * therefore be rotated, and every existing ciphertext and blind index
 * re-derived under the new ones.
 *
 * The dangerous way to do that is a single cutover: switch the key, and
 * everything encrypted under the old one becomes unreadable at the moment the
 * switch lands. This module is the staged alternative, and the invariants it
 * enforces are the ones that make the staged version actually safe:
 *
 *   1. **Read old, write new.** During migration both keys decrypt and only the
 *      new key encrypts. Skipping the dual-read window is what makes a rotation
 *      unrecoverable.
 *
 *   2. **The old key is retired only when nothing needs it.** Retirement is
 *      gated on a counted, verified re-encryption — never on elapsed time,
 *      because "it has probably finished by now" is how the last few thousand
 *      rows become unreadable.
 *
 *   3. **A compromised blind index must be overwritten, not merely
 *      supplemented.** A blind index is a keyed hash of a personal number.
 *      Anyone with the old key can compute the index for a given person and
 *      look them up. Leaving the old index in place next to a new one keeps
 *      that lookup working, so the old value has to be destroyed, not retained
 *      for convenience.
 */

export type KeyRotationErrorCode =
  | 'KEY_VERSION_UNKNOWN'
  | 'KEY_VERSION_RETIRED'
  | 'KEY_NO_ACTIVE_VERSION'
  | 'KEY_MULTIPLE_ACTIVE_VERSIONS'
  | 'KEY_WRITE_TO_NON_ACTIVE_VERSION'
  | 'KEY_ROTATION_INCOMPLETE'
  | 'KEY_ROTATION_NOT_VERIFIED'
  | 'KEY_COMPROMISED_INDEX_RETAINED'
  | 'KEY_STATE_INVALID';

export class KeyRotationError extends Error {
  constructor(readonly code: KeyRotationErrorCode, message: string) {
    super(message);
    this.name = 'KeyRotationError';
  }
}

/**
 * `pending` exists so a key can be provisioned and distributed before anything
 * is written under it. Going straight to `active` means a node that has not yet
 * received the key writes ciphertext its neighbours cannot read.
 */
export type KeyVersionState = 'pending' | 'active' | 'decrypt_only' | 'retired';

export interface KeyVersion {
  readonly version: number;
  readonly state: KeyVersionState;
  readonly secretReference: string;
  readonly createdAt: string;
  /** Set when the key material is known to have leaked. */
  readonly compromised: boolean;
}

export interface KeyRing {
  readonly purpose: 'sensitive_data' | 'blind_index';
  readonly versions: readonly KeyVersion[];
}

/**
 * Exactly one active version, ever.
 *
 * Two active versions mean two writers producing ciphertext under different
 * keys with no record of which is which, and the only way back is to try both
 * on every row.
 */
export function assertKeyRingIsSane(ring: KeyRing): void {
  if (ring.versions.length === 0) {
    throw new KeyRotationError('KEY_NO_ACTIVE_VERSION', 'A key ring must contain at least one version');
  }
  const active = ring.versions.filter((version) => version.state === 'active');
  if (active.length === 0) {
    throw new KeyRotationError('KEY_NO_ACTIVE_VERSION', 'A key ring must have exactly one active version');
  }
  if (active.length > 1) {
    throw new KeyRotationError('KEY_MULTIPLE_ACTIVE_VERSIONS', 'Only one key version may be active at a time');
  }
  const numbers = ring.versions.map((version) => version.version);
  if (new Set(numbers).size !== numbers.length) {
    throw new KeyRotationError('KEY_STATE_INVALID', 'Duplicate key version number');
  }
}

/**
 * True when the active key is known to have leaked.
 *
 * Deliberately a predicate rather than a check inside `assertKeyRingIsSane`.
 * The first draft of this module threw on a compromised active key, which made
 * the one situation the module exists for — rotating *away* from a leaked key —
 * impossible: every operation on the ring failed before the rotation could
 * start. A compromised active key is an urgent state, not an invalid one.
 *
 * The real invariant is narrower and is enforced where it belongs: a
 * compromised version may never be *promoted* to active (`beginDualRead`) and
 * may never be rolled back onto (`rollbackRotation`).
 */
export function rotationRequired(ring: KeyRing): boolean {
  return activeKeyVersion(ring).compromised;
}

export function activeKeyVersion(ring: KeyRing): KeyVersion {
  assertKeyRingIsSane(ring);
  return ring.versions.find((version) => version.state === 'active')!;
}

/**
 * The version new ciphertext must be written under. Always the active one:
 * writing under anything else silently grows the set of rows that still need
 * migrating, so a rotation that looks nearly finished never converges.
 */
export function assertWritableVersion(ring: KeyRing, version: number): void {
  const active = activeKeyVersion(ring);
  if (version !== active.version) {
    throw new KeyRotationError(
      'KEY_WRITE_TO_NON_ACTIVE_VERSION',
      `Ciphertext must be written under version ${active.version}, not ${version}`,
    );
  }
}

/**
 * The versions that may still decrypt. `decrypt_only` is the dual-read window;
 * `retired` is refused, because a retired key that still decrypts is not
 * retired.
 */
export function assertReadableVersion(ring: KeyRing, version: number): void {
  const found = ring.versions.find((candidate) => candidate.version === version);
  if (found === undefined) {
    throw new KeyRotationError('KEY_VERSION_UNKNOWN', `Unknown key version ${version}`);
  }
  if (found.state === 'retired') {
    throw new KeyRotationError('KEY_VERSION_RETIRED', `Key version ${version} is retired and may no longer decrypt`);
  }
  if (found.state === 'pending') {
    throw new KeyRotationError('KEY_STATE_INVALID', `Key version ${version} was never used to encrypt`);
  }
}

/* ------------------------------------------------------------------ *
 * Rotation lifecycle
 * ------------------------------------------------------------------ */

export const ROTATION_STATES = ['PLANNED', 'DUAL_READ', 'REENCRYPTING', 'VERIFIED', 'COMPLETED', 'ROLLED_BACK'] as const;
export type RotationState = (typeof ROTATION_STATES)[number];

export interface RotationProgress {
  readonly purpose: KeyRing['purpose'];
  readonly state: RotationState;
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Rows known to exist under the old version when the rotation started. */
  readonly totalRows: number;
  readonly reencryptedRows: number;
  /** Rows re-read and confirmed to decrypt under the new version. */
  readonly verifiedRows: number;
  readonly failedRows: number;
}

/**
 * Promotes the new key to active and the old one to decrypt-only.
 *
 * Both moves happen together on purpose. Promoting the new key without
 * demoting the old one leaves two active versions; demoting the old one first
 * leaves no active version at all and every write fails.
 */
export function beginDualRead(ring: KeyRing, toVersion: number): KeyRing {
  const current = activeKeyVersion(ring);
  const next = ring.versions.find((version) => version.version === toVersion);
  if (next === undefined) throw new KeyRotationError('KEY_VERSION_UNKNOWN', `Unknown key version ${toVersion}`);
  if (next.state !== 'pending') {
    throw new KeyRotationError('KEY_STATE_INVALID', `Version ${toVersion} must be pending to be promoted`);
  }
  if (next.compromised) {
    throw new KeyRotationError('KEY_STATE_INVALID', 'Cannot rotate onto a compromised key version');
  }
  return {
    ...ring,
    versions: ring.versions.map((version) =>
      version.version === toVersion ? { ...version, state: 'active' as const }
      : version.version === current.version ? { ...version, state: 'decrypt_only' as const }
      : version),
  };
}

/**
 * Whether the old key may be retired.
 *
 * Gated on counted, verified progress rather than on elapsed time. "It has
 * probably finished by now" is exactly how the last few thousand rows become
 * unreadable, and unlike most mistakes this one has no recovery path once the
 * key material is destroyed.
 */
export function assertRotationComplete(progress: RotationProgress): void {
  if (progress.failedRows > 0) {
    throw new KeyRotationError(
      'KEY_ROTATION_INCOMPLETE',
      `${progress.failedRows} rows failed to re-encrypt; the old key must stay readable`,
    );
  }
  if (progress.reencryptedRows < progress.totalRows) {
    throw new KeyRotationError(
      'KEY_ROTATION_INCOMPLETE',
      `${progress.totalRows - progress.reencryptedRows} rows still hold ciphertext under version ${progress.fromVersion}`,
    );
  }
  // Re-encrypting and confirming the result are different claims. A writer can
  // report success for a row that does not actually decrypt under the new key.
  if (progress.verifiedRows < progress.totalRows) {
    throw new KeyRotationError(
      'KEY_ROTATION_NOT_VERIFIED',
      `${progress.totalRows - progress.verifiedRows} rows were re-encrypted but never verified`,
    );
  }
}

export function retireOldVersion(ring: KeyRing, progress: RotationProgress): KeyRing {
  assertRotationComplete(progress);
  assertReadableVersion(ring, progress.fromVersion);
  return {
    ...ring,
    versions: ring.versions.map((version) =>
      version.version === progress.fromVersion ? { ...version, state: 'retired' as const } : version),
  };
}

/**
 * Rolling back is always permitted before retirement and never after.
 *
 * Before retirement the old key still decrypts, so returning to it costs
 * nothing. After retirement the rows encrypted under the new key have no other
 * reader, and "rolling back" would mean losing them.
 */
export function rollbackRotation(ring: KeyRing, progress: RotationProgress): KeyRing {
  const old = ring.versions.find((version) => version.version === progress.fromVersion);
  if (old === undefined) throw new KeyRotationError('KEY_VERSION_UNKNOWN', 'Unknown source version');
  if (old.state === 'retired') {
    throw new KeyRotationError('KEY_STATE_INVALID', 'Cannot roll back after the old key has been retired');
  }
  if (old.compromised) {
    // Rolling back onto a leaked key would undo the only thing the rotation
    // was for.
    throw new KeyRotationError('KEY_STATE_INVALID', 'Cannot roll back onto a compromised key version');
  }
  return {
    ...ring,
    versions: ring.versions.map((version) =>
      version.version === progress.fromVersion ? { ...version, state: 'active' as const }
      : version.version === progress.toVersion ? { ...version, state: 'pending' as const }
      : version),
  };
}

/* ------------------------------------------------------------------ *
 * Blind index rotation
 * ------------------------------------------------------------------ */

export interface BlindIndexEntry {
  readonly keyVersion: number;
  readonly indexValue: string;
}

/**
 * Blind index rotation differs from ciphertext rotation in one decisive way,
 * and getting it wrong quietly preserves the compromise.
 *
 * A blind index is a keyed hash of a personal number. Anyone holding the leaked
 * key can compute the index for a person they are looking for and match it. So
 * while a *dual lookup* across old and new indexes is needed during migration —
 * otherwise searches stop finding people mid-rotation — the old index value
 * must be destroyed once the new one exists. Keeping it "just in case" keeps
 * the attacker's lookup working, which is the entire thing being fixed.
 */
export function planBlindIndexRotation(
  entries: readonly BlindIndexEntry[],
  compromisedVersions: readonly number[],
  activeVersion: number,
): { readonly lookupVersions: readonly number[]; readonly mustOverwrite: readonly number[] } {
  const present = [...new Set(entries.map((entry) => entry.keyVersion))].sort((a, b) => a - b);
  return {
    // Lookups span every version still present, so a search keeps finding
    // people while the rotation runs.
    lookupVersions: present,
    // Every compromised version present must be overwritten, not retained.
    mustOverwrite: present.filter((version) => compromisedVersions.includes(version) && version !== activeVersion),
  };
}

/**
 * Refuses to declare a blind-index rotation finished while a compromised index
 * value still exists. Deliberately separate from the ciphertext check: a
 * ciphertext under a leaked key is readable by an attacker who already has the
 * data, but a *searchable index* under a leaked key lets them find a specific
 * person, which is a different and worse capability.
 */
export function assertNoCompromisedIndexRemains(
  entries: readonly BlindIndexEntry[],
  compromisedVersions: readonly number[],
): void {
  const remaining = entries.filter((entry) => compromisedVersions.includes(entry.keyVersion));
  if (remaining.length > 0) {
    throw new KeyRotationError(
      'KEY_COMPROMISED_INDEX_RETAINED',
      `${remaining.length} blind index values still exist under a compromised key and must be overwritten`,
    );
  }
}
