function normalizeSignature(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('sha256=') ? trimmed.slice(7) : trimmed;
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) throw new TypeError('Invalid hex');
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i += 1) result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return result;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) diff |= (left[i % left.length] ?? 0) ^ (right[i % right.length] ?? 0);
  return diff === 0;
}

export async function hmacSha256Hex(secret: Uint8Array | string, payload: Uint8Array | string): Promise<string> {
  const secretBytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  const payloadBytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, payloadBytes));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyHmacSha256Hex(
  secret: Uint8Array | string,
  payload: Uint8Array | string,
  providedSignature: string,
): Promise<boolean> {
  try {
    const expected = fromHex(await hmacSha256Hex(secret, payload));
    const provided = fromHex(normalizeSignature(providedSignature));
    return constantTimeEqual(expected, provided);
  } catch {
    return false;
  }
}
