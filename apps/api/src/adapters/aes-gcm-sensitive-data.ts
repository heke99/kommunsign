import type { SensitiveDataAdapter } from '../production-adapters/postgres/infrastructure.js';
import {
  activeKeyVersion, assertKeyRingIsSane, assertReadableVersion,
  type KeyRing, type KeyVersion,
} from '../../../../packages/crypto/src/key-rotation.js';

/**
 * AES-GCM over a key ring, not a key.
 *
 * The envelope has always carried a version byte, but it was the constant 1 and
 * the adapter held one key — so decryption of anything not written under that
 * exact key failed. That made the rotation procedure in
 * docs/runbooks/KEY_ROTATION.md impossible to carry out: its second step is
 * "enter dual read", and there was nothing to read with. Activating a new key
 * would have made every row not yet re-encrypted unreadable, which is precisely
 * the outcome the runbook exists to prevent.
 *
 * Now the version byte means what it says. Ciphertext is written under the
 * active version and read under whichever version the envelope names, provided
 * that version is still allowed to decrypt. `packages/crypto/src/key-rotation.ts`
 * owns those rules; this adapter only supplies the key material.
 *
 * Blind indexes are different and are deliberately not versioned here. An index
 * is a bare digest in a column with no envelope to carry a version, so which
 * key produced it is recorded by the row's `key_version` column instead
 * (migration data/0029). Rotating one means recomputing every index for a
 * lookup together — see `planBlindIndexRotation` — because a half-rotated index
 * silently stops finding rows.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;
const MAXIMUM_VERSION = 255;

export async function createSensitiveDataAdapter(
  configuration: Readonly<Record<string, string>>,
): Promise<SensitiveDataAdapter> {
  const { ring, keys } = await loadEncryptionRing(configuration);
  const writeVersion = activeKeyVersion(ring).version;
  const writeKey = keys.get(writeVersion)!;

  const blindIndexKey = await importKey(
    required(configuration, 'SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64'),
    'HMAC',
    ['sign'],
  );

  return {
    async encryptText(value, purpose) {
      validatePurpose(purpose);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const plaintext = new TextEncoder().encode(value);
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose), tagLength: 128 },
        writeKey,
        plaintext,
      ));
      const envelope = new Uint8Array(1 + IV_BYTES + ciphertext.length);
      envelope[0] = writeVersion;
      envelope.set(iv, 1);
      envelope.set(ciphertext, 1 + IV_BYTES);
      return envelope;
    },

    async decryptText(value, purpose) {
      validatePurpose(purpose);
      if (value.length <= 1 + IV_BYTES) throw new Error('SENSITIVE_DATA_ENVELOPE_INVALID');
      const version = value[0]!;
      // Two different failures, kept apart on purpose. A version this
      // deployment has never heard of means the row came from somewhere else;
      // a version that is retired means the operator decided it may no longer
      // decrypt, and quietly reading it anyway would make retirement a
      // suggestion.
      try {
        assertReadableVersion(ring, version);
      } catch (cause) {
        throw new Error('SENSITIVE_DATA_KEY_VERSION_NOT_READABLE', { cause });
      }
      const iv = value.slice(1, 1 + IV_BYTES);
      const ciphertext = value.slice(1 + IV_BYTES);
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose), tagLength: 128 },
          keys.get(version)!,
          ciphertext,
        );
        return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
      } catch (cause) {
        throw new Error('SENSITIVE_DATA_DECRYPTION_FAILED', { cause });
      }
    },

    async blindIndex(value, purpose) {
      validatePurpose(purpose);
      const normalized = value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
      const material = new TextEncoder().encode(`${purpose}\u0000${normalized}`);
      return new Uint8Array(await crypto.subtle.sign('HMAC', blindIndexKey, material));
    },

    keyVersion() {
      return writeVersion;
    },
  };
}

/**
 * Builds the ring from the environment.
 *
 * Version 1 is `SENSITIVE_DATA_ENCRYPTION_KEY_BASE64`, unchanged, because every
 * row written before this existed carries version 1 in its envelope. Later
 * versions are `SENSITIVE_DATA_ENCRYPTION_KEY_V<n>_BASE64`. A deployment that
 * sets nothing else gets exactly the behaviour it had before.
 *
 * States are derived rather than configured separately: the version named by
 * SENSITIVE_DATA_ACTIVE_KEY_VERSION is active, versions listed in
 * SENSITIVE_DATA_RETIRED_KEY_VERSIONS are retired, and everything else present
 * is decrypt_only. That is the dual-read window, and it cannot be misconfigured
 * into two active versions because there is only one variable naming one.
 */
async function loadEncryptionRing(
  configuration: Readonly<Record<string, string>>,
): Promise<{ readonly ring: KeyRing; readonly keys: Map<number, CryptoKey> }> {
  const material = new Map<number, string>();
  material.set(1, required(configuration, 'SENSITIVE_DATA_ENCRYPTION_KEY_BASE64'));
  for (const [name, value] of Object.entries(configuration)) {
    const match = /^SENSITIVE_DATA_ENCRYPTION_KEY_V(\d+)_BASE64$/.exec(name);
    if (!match || !value?.trim()) continue;
    const version = Number(match[1]);
    if (!Number.isInteger(version) || version < 1 || version > MAXIMUM_VERSION) {
      throw new Error('SENSITIVE_DATA_KEY_VERSION_INVALID');
    }
    // Version 1 has two possible spellings; they must not disagree about which
    // key it is, or half the deployment writes under a key the other half
    // cannot read.
    if (material.has(version) && material.get(version) !== value.trim()) {
      throw new Error('SENSITIVE_DATA_KEY_VERSION_CONFLICT');
    }
    material.set(version, value.trim());
  }

  const activeVersion = versionNumber(configuration, 'SENSITIVE_DATA_ACTIVE_KEY_VERSION', 1);
  if (!material.has(activeVersion)) throw new Error('SENSITIVE_DATA_ACTIVE_KEY_MISSING');
  const retired = new Set(
    (configuration.SENSITIVE_DATA_RETIRED_KEY_VERSIONS ?? '')
      .split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
      .map((entry) => {
        const version = Number(entry);
        if (!Number.isInteger(version) || version < 1) throw new Error('SENSITIVE_DATA_KEY_VERSION_INVALID');
        return version;
      }),
  );
  if (retired.has(activeVersion)) throw new Error('SENSITIVE_DATA_ACTIVE_KEY_RETIRED');

  const versions: KeyVersion[] = [...material.keys()].sort((left, right) => left - right).map((version) => ({
    version,
    state: version === activeVersion ? 'active' : retired.has(version) ? 'retired' : 'decrypt_only',
    secretReference: version === 1
      ? 'env://SENSITIVE_DATA_ENCRYPTION_KEY_BASE64'
      : `env://SENSITIVE_DATA_ENCRYPTION_KEY_V${version}_BASE64`,
    createdAt: new Date(0).toISOString(),
    compromised: false,
  }));
  const ring: KeyRing = { purpose: 'sensitive_data', versions };
  assertKeyRingIsSane(ring);

  const keys = new Map<number, CryptoKey>();
  for (const version of versions) {
    keys.set(version.version, await importKey(material.get(version.version)!, 'AES-GCM', ['encrypt', 'decrypt']));
  }
  return { ring, keys };
}

function versionNumber(configuration: Readonly<Record<string, string>>, name: string, fallback: number): number {
  const raw = configuration[name]?.trim();
  if (!raw) return fallback;
  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1 || version > MAXIMUM_VERSION) {
    throw new Error('SENSITIVE_DATA_KEY_VERSION_INVALID');
  }
  return version;
}

async function importKey(
  encoded: string,
  algorithm: 'AES-GCM' | 'HMAC',
  usages: readonly KeyUsage[],
): Promise<CryptoKey> {
  const bytes = decodeBase64(encoded);
  if (bytes.length !== KEY_BYTES) throw new Error(`${algorithm.replace('-', '_')}_KEY_LENGTH_INVALID`);
  return crypto.subtle.importKey(
    'raw',
    bytes,
    algorithm === 'HMAC' ? { name: 'HMAC', hash: 'SHA-256' } : { name: 'AES-GCM' },
    false,
    usages,
  );
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch (cause) {
    throw new Error('SENSITIVE_DATA_KEY_BASE64_INVALID', { cause });
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function validatePurpose(purpose: string): void {
  if (!/^[A-Za-z0-9._:-]{3,100}$/.test(purpose)) throw new Error('SENSITIVE_DATA_PURPOSE_INVALID');
}

function required(configuration: Readonly<Record<string, string>>, name: string): string {
  const value = configuration[name]?.trim();
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}
