function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Bytes(input: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
}

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return toHex(await sha256Bytes(bytes));
}
