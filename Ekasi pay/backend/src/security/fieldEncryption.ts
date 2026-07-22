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

function resolveEncryptionKey(): Buffer {
  const raw = process.env.DATA_ENCRYPTION_KEY?.trim() ?? '';
  if (raw) {
    const key = /^[a-f0-9]{64}$/iu.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('DATA_ENCRYPTION_KEY must encode exactly 32 bytes');
    }
    return key;
  }
  const nodeEnv = process.env.NODE_ENV?.trim() || 'development';
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return LOCAL_DEV_KEY;
  }
  throw new Error('DATA_ENCRYPTION_KEY is required outside local development.');
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
  const cipher = createCipheriv('aes-256-gcm', resolveEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptField(value: string): string {
  if (!value) return '';
  if (!isEncryptedField(value)) {
    // Legacy plaintext row (pre-encryption).
    return value;
  }
  const [ivRaw, tagRaw, encryptedRaw] = value.split('.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    resolveEncryptionKey(),
    Buffer.from(ivRaw, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
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
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
