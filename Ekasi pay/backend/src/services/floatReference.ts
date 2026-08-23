import { createHash } from 'node:crypto';

/** Deterministic merchant float deposit reference: KP-FLOAT-{short}-{checksum} */
export function generateMerchantFloatReference(merchantId: string): string {
  const compact = merchantId.replace(/-/g, '').toUpperCase();
  const shortId = compact.slice(0, 8).padEnd(8, '0');
  const checksum = createHash('sha256')
    .update(`KP-FLOAT:${shortId}`)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase();
  return `KP-FLOAT-${shortId}-${checksum}`;
}

export function parseMerchantFloatReference(
  raw: string,
): { shortId: string; checksum: string } | null {
  const match = /^KP-FLOAT-([A-Z0-9]{8})-([A-F0-9]{4})$/.exec(raw.trim().toUpperCase());
  if (!match) return null;
  const expected = generateMerchantFloatReference(match[1]);
  if (expected !== `KP-FLOAT-${match[1]}-${match[2]}`) return null;
  return { shortId: match[1], checksum: match[2] };
}
