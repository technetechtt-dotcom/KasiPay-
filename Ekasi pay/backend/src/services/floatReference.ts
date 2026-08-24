import { createHash, randomBytes } from 'node:crypto';

const LEGACY =
  /^KP-FLOAT-([A-Z0-9]{8})-([A-F0-9]{4})$/;
const CURRENT =
  /^KP-FLOAT-([A-Z0-9]{8})-([A-Z0-9]{8})-([A-F0-9]{4})$/;

function merchantShortId(merchantId: string): string {
  const compact = merchantId.replace(/-/g, '').toUpperCase();
  return compact.slice(0, 8).padEnd(8, '0');
}

function checksum(shortId: string, unique: string): string {
  return createHash('sha256')
    .update(`KP-FLOAT:${shortId}:${unique}`)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
}

function legacyChecksum(shortId: string): string {
  return createHash('sha256')
    .update(`KP-FLOAT:${shortId}`)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
}

/** Unique per request: KP-FLOAT-{merchant}-{entropy}-{checksum} */
export function generateMerchantFloatReference(merchantId: string): string {
  const shortId = merchantShortId(merchantId);
  const unique = randomBytes(4).toString('hex').toUpperCase();
  return `KP-FLOAT-${shortId}-${unique}-${checksum(shortId, unique)}`;
}

export function parseMerchantFloatReference(
  raw: string,
): { shortId: string; unique?: string; checksum: string } | null {
  const value = raw.trim().toUpperCase();
  const current = CURRENT.exec(value);
  if (current) {
    const expected = checksum(current[1], current[2]);
    if (expected !== current[3]) return null;
    return { shortId: current[1], unique: current[2], checksum: current[3] };
  }
  const legacy = LEGACY.exec(value);
  if (!legacy) return null;
  if (legacyChecksum(legacy[1]) !== legacy[2]) return null;
  return { shortId: legacy[1], checksum: legacy[2] };
}
