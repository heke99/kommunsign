export function randomToken(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 32) throw new RangeError('Tokens require at least 256 bits');
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isSafeOpaqueToken(value: string): boolean {
  return /^[0-9a-f]{64,}$/i.test(value);
}
