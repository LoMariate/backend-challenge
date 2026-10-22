import { createHash } from 'node:crypto';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;

  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();

  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(obj[key])}`,
    )
    .join(',')}}`;
}

export function payloadHash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');
}
