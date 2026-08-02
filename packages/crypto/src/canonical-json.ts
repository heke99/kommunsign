export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

function encode(value: CanonicalJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers');
    if (Object.is(value, -0)) return '0';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item)).join(',')}]`;
  }
  const objectValue = value as { readonly [key: string]: CanonicalJsonValue };
  const entries = Object.keys(objectValue)
    .sort()
    .map((key) => {
      const item = objectValue[key];
      if (item === undefined) throw new TypeError(`Canonical JSON rejects undefined at key: ${key}`);
      return `${JSON.stringify(key)}:${encode(item)}`;
    });
  return `{${entries.join(',')}}`;
}

export function canonicalJson(value: CanonicalJsonValue): string {
  return encode(value);
}

export function canonicalJsonBytes(value: CanonicalJsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
