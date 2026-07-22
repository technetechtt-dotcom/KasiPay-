import { createHmac, randomUUID } from 'node:crypto';

export const ALLOWED_KYC_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
export const MAX_KYC_BYTES = 5 * 1024 * 1024;

export type SignedObjectRequest = {
  objectKey: string;
  url: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
};

function config() {
  const endpoint = process.env.PRIVATE_STORAGE_SIGNING_ENDPOINT?.trim() ?? '';
  const secret = process.env.PRIVATE_STORAGE_SIGNING_SECRET?.trim() ?? '';
  if (!endpoint || secret.length < 32) {
    throw Object.assign(new Error('Private object storage signing is unavailable.'), { status: 503 });
  }
  return { endpoint: endpoint.replace(/\/$/u, ''), secret };
}

function signedUrl(operation: 'upload' | 'download', objectKey: string, contentType?: string): SignedObjectRequest {
  const { endpoint, secret } = config();
  const expires = Date.now() + 5 * 60 * 1000;
  const canonical = `${operation}\n${objectKey}\n${expires}\n${contentType ?? ''}`;
  const signature = createHmac('sha256', secret).update(canonical).digest('base64url');
  const query = new URLSearchParams({
    operation,
    key: objectKey,
    expires: String(expires),
    signature,
  });
  if (contentType) query.set('contentType', contentType);
  return {
    objectKey,
    url: `${endpoint}?${query}`,
    expiresAt: new Date(expires).toISOString(),
    requiredHeaders: contentType ? { 'Content-Type': contentType } : {},
  };
}

export function createKycUploadUrl(merchantId: string, docType: string, contentType: string) {
  if (!ALLOWED_KYC_MIME.has(contentType.toLowerCase())) {
    throw Object.assign(new Error('Unsupported KYC document MIME type.'), { status: 400 });
  }
  return signedUrl(
    'upload',
    `kyc/${merchantId}/${docType}/${randomUUID()}`,
    contentType.toLowerCase(),
  );
}

export function createKycDownloadUrl(objectKey: string) {
  return signedUrl('download', objectKey);
}

/** Validate a small leading-byte sample reported by the trusted storage callback. */
export function validateDocumentSignature(contentType: string, sampleBase64: string): boolean {
  const sample = Buffer.from(sampleBase64, 'base64');
  const signatures: Record<string, (b: Buffer) => boolean> = {
    'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
    'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
    'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  };
  return signatures[contentType.toLowerCase()]?.(sample) ?? false;
}
