import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const LOCAL_DEV_KEY = Buffer.from(
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  'hex',
);

/** Active encryption key version written into new ciphertexts (`vN.…`). */
export const ACTIVE_ENCRYPTION_KEY_VERSION = Number(
  process.env.DATA_ENCRYPTION_KEY_VERSION?.trim() || '1',
);

function decodeKeyMaterial(raw: string): Buffer {
  const key = /^[a-f0-9]{64}$/iu.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must encode exactly 32 bytes');
  }
  return key;
}

function resolveEncryptionKey(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY?.trim() ?? '';
  if (raw) return decodeKeyMaterial(raw);
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return LOCAL_DEV_KEY;
  }
  throw new Error('DATA_ENCRYPTION_KEY is required outside local development.');
}

/**
 * Previous keys for decrypt-during-rotation.
 * Format: `1:<key>,2:<key>` where key is 64 hex or base64 of 32 bytes.
 */
function previousKeysByVersion(): Map<number, Buffer> {
  const map = new Map<number, Buffer>();
  const raw = process.env.DATA_ENCRYPTION_KEY_PREVIOUS?.trim() ?? '';
  if (!raw) return map;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      throw new Error(
        'DATA_ENCRYPTION_KEY_PREVIOUS entries must be version:key (e.g. 1:<32-byte-key>).',
      );
    }
    const version = Number(trimmed.slice(0, colon));
    if (!Number.isInteger(version) || version < 1) {
      throw new Error('DATA_ENCRYPTION_KEY_PREVIOUS versions must be positive integers.');
    }
    map.set(version, decodeKeyMaterial(trimmed.slice(colon + 1)));
  }
  return map;
}

function keyForVersion(version: number): Buffer {
  if (version === ACTIVE_ENCRYPTION_KEY_VERSION) return resolveEncryptionKey();
  const previous = previousKeysByVersion().get(version);
  if (previous) return previous;
  throw new Error(`No encryption key configured for version ${version}.`);
}

function resolveHashPepper(): string {
  const pepper =
    process.env.PII_HASH_PEPPER?.trim() ||
    process.env.DATA_ENCRYPTION_KEY?.trim() ||
    '';
  if (pepper.length >= 32) return pepper;
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return LOCAL_DEV_KEY.toString('hex');
  }
  throw new Error(
    'PII_HASH_PEPPER (or DATA_ENCRYPTION_KEY) must be at least 32 characters.',
  );
}

export function encryptField(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const version = ACTIVE_ENCRYPTION_KEY_VERSION;
  const cipher = createCipheriv('aes-256-gcm', keyForVersion(version), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v${version}.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptParts(
  version: number,
  ivRaw: string,
  tagRaw: string,
  encryptedRaw: string,
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyForVersion(version),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function decryptField(value: string): string {
  if (!value) return '';
  if (!isEncryptedField(value)) {
    // Legacy plaintext row (pre-encryption). Prefer backfill before relying on this.
    return value;
  }
  const parts = value.split('.');
  if (parts.length === 4 && /^v\d+$/u.test(parts[0])) {
    const version = Number(parts[0].slice(1));
    return decryptParts(version, parts[1], parts[2], parts[3]);
  }
  // Legacy unversioned ciphertext (pre key-versioning) uses active key as v1.
  return decryptParts(1, parts[0], parts[1], parts[2]);
}

/** Blind-index hash for exact match of normalized sensitive identifiers. */
export function hashSensitiveIdentifier(normalized: string): string {
  if (!normalized) return '';
  return createHmac('sha256', resolveHashPepper()).update(normalized).digest('hex');
}

export function hashesEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** Mask SA ID / similar values for ops UI and logs. */
export function maskIdentifier(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 5) return '••••';
  return `${digits.slice(0, 2)}••••••••${digits.slice(-3)}`;
}

export function isEncryptedField(value: string | null | undefined): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length === 4 && /^v\d+$/u.test(parts[0])) {
    return parts.slice(1).every((p) => p.length > 0);
  }
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function encryptionKeyVersionOf(value: string): number | null {
  if (!isEncryptedField(value)) return null;
  const parts = value.split('.');
  if (parts.length === 4 && /^v\d+$/u.test(parts[0])) {
    return Number(parts[0].slice(1));
  }
  return 1;
}

/** Re-encrypt a ciphertext (or legacy plaintext) with the active key version. */
export function rotateFieldToActiveKey(value: string): string {
  if (!value) return '';
  const plain = decryptField(value);
  return encryptField(plain);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
