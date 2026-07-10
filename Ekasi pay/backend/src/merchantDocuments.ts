/** Required compliance documents for merchant onboarding. */
export const MERCHANT_DOC_TYPES = [
  'cipc_14_3',
  'beee_certificate',
  'municipal_business_reg',
  'proof_of_bank',
] as const;

export type MerchantDocType = (typeof MERCHANT_DOC_TYPES)[number];

export const MERCHANT_DOC_LABELS: Record<MerchantDocType, string> = {
  cipc_14_3: 'CIPC 14.3 document',
  beee_certificate: 'B-BBEE certificate',
  municipal_business_reg: 'Municipal business registration certificate',
  proof_of_bank: 'Proof of bank account',
};

export const MAX_MERCHANT_DOC_BYTES = 5 * 1024 * 1024; // 5 MB

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function isMerchantDocType(value: string): value is MerchantDocType {
  return (MERCHANT_DOC_TYPES as readonly string[]).includes(value);
}

export function assertAllowedContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType.toLowerCase());
}

export function decodeDocumentBase64(dataBase64: string): Buffer {
  const cleaned = dataBase64.replace(/^data:[^;]+;base64,/, '').trim();
  return Buffer.from(cleaned, 'base64');
}
