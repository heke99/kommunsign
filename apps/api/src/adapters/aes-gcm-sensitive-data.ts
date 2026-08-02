import type { SensitiveDataAdapter } from '../production-adapters/postgres/infrastructure.js';

const VERSION = 1;
const IV_BYTES = 12;
const KEY_BYTES = 32;

export async function createSensitiveDataAdapter(
  configuration: Readonly<Record<string, string>>,
): Promise<SensitiveDataAdapter> {
  const encryptionKey = await importKey(
    required(configuration, 'SENSITIVE_DATA_ENCRYPTION_KEY_BASE64'),
    'AES-GCM',
    ['encrypt', 'decrypt'],
  );
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
        encryptionKey,
        plaintext,
      ));
      const envelope = new Uint8Array(1 + IV_BYTES + ciphertext.length);
      envelope[0] = VERSION;
      envelope.set(iv, 1);
      envelope.set(ciphertext, 1 + IV_BYTES);
      return envelope;
    },

    async decryptText(value, purpose) {
      validatePurpose(purpose);
      if (value.length <= 1 + IV_BYTES || value[0] !== VERSION) {
        throw new Error('SENSITIVE_DATA_ENVELOPE_INVALID');
      }
      const iv = value.slice(1, 1 + IV_BYTES);
      const ciphertext = value.slice(1 + IV_BYTES);
      try {
        const plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(purpose), tagLength: 128 },
          encryptionKey,
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
  };
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
