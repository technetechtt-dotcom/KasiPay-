import { randomUUID, timingSafeEqual } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { toMerchant } from '../mappers.js';
import {
  assertAllowedContentType,
  decodeDocumentBase64,
  isMerchantDocType,
  MAX_MERCHANT_DOC_BYTES,
  MERCHANT_DOC_TYPES,
  type MerchantDocType,
} from '../merchantDocuments.js';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  createKycUploadUrl,
  MAX_KYC_BYTES,
  validateDocumentSignature,
} from '../services/privateObjectStorage.js';
import { encryptSensitive } from '../security/totp.js';

export const merchantsRouterPg = Router();

merchantsRouterPg.post('/internal/kyc/scan-callback', async (req, res) => {
  const expected = process.env.MALWARE_SCANNER_CALLBACK_SECRET ?? '';
  const supplied =
    typeof req.headers['x-scanner-signature'] === 'string'
      ? req.headers['x-scanner-signature']
      : '';
  if (
    expected.length < 32 ||
    expected.length !== supplied.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
  ) {
    return res.status(401).json({ error: 'Invalid scanner callback.' });
  }
  const parsed = z.object({
    objectKey: z.string().min(10).max(1000),
    verdict: z.enum(['clean', 'infected', 'failed']),
    detectedContentType: z.string().min(1).max(100),
    sizeBytes: z.number().int().positive().max(MAX_KYC_BYTES),
    signatureSampleBase64: z.string().min(4).max(4096),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const signatureValid = validateDocumentSignature(
    parsed.data.detectedContentType,
    parsed.data.signatureSampleBase64,
  );
  const nextState =
    parsed.data.verdict === 'clean' && signatureValid ? 'clean' : 'quarantined';
  const updated = await getPgPool().query(
    `UPDATE merchant_documents SET scan_state = $1, scan_completed_at = NOW(),
       content_type = $3, size_bytes = $4,
       quarantined_at = CASE WHEN $1 = 'quarantined' THEN NOW() ELSE NULL END
     WHERE object_key = $2 AND scan_state = 'pending' RETURNING id`,
    [
      nextState,
      parsed.data.objectKey,
      parsed.data.detectedContentType.toLowerCase(),
      parsed.data.sizeBytes,
    ],
  );
  if (!updated.rowCount) return res.status(404).json({ error: 'Pending document not found.' });
  if (nextState === 'quarantined') {
    await getPgPool().query(
      `INSERT INTO kyc_retention_jobs (id, document_id, action, not_before)
       VALUES ($1,$2,'quarantine',NOW())`,
      [randomUUID(), updated.rows[0].id],
    );
  }
  return res.json({ ok: true, scanState: nextState });
});

type MerchantRow = {
  id: string;
  user_id: string;
  business_name: string;
  location: string;
  category: string;
  approval_status: string;
  rejection_reason: string | null;
  reviewed_at: string | Date | null;
  reviewed_by: string | null;
  docs_submitted_at: string | Date | null;
};

type DocMetaRow = {
  doc_type: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  uploaded_at: string | Date;
};

function toDocMeta(row: DocMetaRow) {
  return {
    docType: row.doc_type as MerchantDocType,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    uploadedAt:
      typeof row.uploaded_at === 'string' ?
        row.uploaded_at
      : row.uploaded_at.toISOString(),
  };
}

merchantsRouterPg.get('/merchants/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const q = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE user_id = $1`,
    [req.auth!.userId],
  );
  const row = q.rows[0];
  if (!row) return res.json({ merchant: null });
  return res.json({ merchant: toMerchant(row) });
});

merchantsRouterPg.post('/merchants/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const userId = req.auth!.userId;

  const existingQ = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE user_id = $1`,
    [userId],
  );
  const existing = existingQ.rows[0];
  if (existing) return res.json({ merchant: toMerchant(existing) });

  const userQ = await pool.query<{ name: string }>(
    `SELECT name FROM users WHERE id = $1`,
    [userId],
  );
  const user = userQ.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const body = (req.body ?? {}) as {
    businessName?: string;
    location?: string;
    category?: string;
  };
  const businessName = body.businessName?.trim() || `${user.name}'s Shop`;
  const location = body.location?.trim() || 'South Africa';
  const category = body.category?.trim() || 'Retail';
  const approvalStatus = 'pending_docs';

  const id = randomUUID();
  await pool.query(
    `INSERT INTO merchants (
       id, user_id, business_name, location, category, approval_status
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, userId, businessName, location, category, approvalStatus],
  );
  const rowQ = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE id = $1`,
    [id],
  );
  return res.status(201).json({ merchant: toMerchant(rowQ.rows[0]) });
});

const merchantPatchBody = z.object({
  businessName: z.string().trim().min(1).max(120).optional(),
  location: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(60).optional(),
});

merchantsRouterPg.patch('/merchants/me', requireAuth, async (req, res) => {
  const parsed = merchantPatchBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const pool = getPgPool();
  const rowQ = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE user_id = $1`,
    [req.auth!.userId],
  );
  const row = rowQ.rows[0];
  if (!row) {
    return res.status(404).json({ error: 'Merchant profile not set up yet.' });
  }

  const next = {
    business_name: parsed.data.businessName ?? row.business_name,
    location: parsed.data.location ?? row.location,
    category: parsed.data.category ?? row.category,
  };
  await pool.query(
    `UPDATE merchants
        SET business_name = $1, location = $2, category = $3
      WHERE id = $4`,
    [next.business_name, next.location, next.category, row.id],
  );
  const freshQ = await pool.query<MerchantRow>(
    `SELECT * FROM merchants WHERE id = $1`,
    [row.id],
  );
  return res.json({ merchant: toMerchant(freshQ.rows[0]) });
});

merchantsRouterPg.get(
  '/merchants/me/documents',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    const merchantQ = await pool.query<MerchantRow>(
      `SELECT * FROM merchants WHERE user_id = $1`,
      [req.auth!.userId],
    );
    const merchant = merchantQ.rows[0];
    if (!merchant) {
      return res.status(404).json({ error: 'Merchant profile not set up yet.' });
    }

    const docsQ = await pool.query<DocMetaRow>(
      `SELECT doc_type, file_name, content_type, size_bytes, uploaded_at
         FROM merchant_documents
        WHERE merchant_id = $1`,
      [merchant.id],
    );
    const byType = new Map(docsQ.rows.map((r) => [r.doc_type, toDocMeta(r)]));
    return res.json({
      merchant: toMerchant(merchant),
      required: MERCHANT_DOC_TYPES,
      documents: MERCHANT_DOC_TYPES.map((docType) => ({
        docType,
        uploaded: byType.has(docType),
        ...(byType.get(docType) ?? {}),
      })),
    });
  },
);

const uploadBody = z.object({
  docType: z.string(),
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(100),
  dataBase64: z.string().min(1),
});

const signedUploadBody = z.object({
  docType: z.string(),
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(1).max(100),
  sizeBytes: z.number().int().positive().max(MAX_KYC_BYTES),
});

merchantsRouterPg.post('/merchants/me/documents/upload-url', requireAuth, async (req, res) => {
  const parsed = signedUploadBody.safeParse(req.body);
  if (!parsed.success || !isMerchantDocType(parsed.data?.docType ?? '')) {
    return res.status(400).json({ error: 'Invalid document upload request.' });
  }
  const merchant = await getPgPool().query<MerchantRow>(
    `SELECT * FROM merchants WHERE user_id = $1`,
    [req.auth!.userId],
  );
  if (!merchant.rows[0]) return res.status(404).json({ error: 'Merchant profile not found.' });
  if (!['pending_docs', 'rejected'].includes(merchant.rows[0].approval_status)) {
    return res.status(409).json({ error: 'Documents cannot be changed during or after review.' });
  }
  const signed = createKycUploadUrl(
    merchant.rows[0].id,
    parsed.data.docType,
    parsed.data.contentType,
  );
  return res.json({ upload: signed });
});

const completeUploadBody = signedUploadBody.extend({
  objectKey: z.string().regex(/^kyc\/[a-zA-Z0-9-]+\/[a-z_]+\/[a-zA-Z0-9-]+$/u),
  signatureSampleBase64: z.string().min(4).max(4096),
  encryptionKeyRef: z.string().min(1).max(200),
});

merchantsRouterPg.post('/merchants/me/documents/complete', requireAuth, async (req, res) => {
  const parsed = completeUploadBody.safeParse(req.body);
  if (!parsed.success || !isMerchantDocType(parsed.data?.docType ?? '')) {
    return res.status(400).json({ error: 'Invalid document completion request.' });
  }
  const merchant = await getPgPool().query<MerchantRow>(
    `SELECT * FROM merchants WHERE user_id = $1`,
    [req.auth!.userId],
  );
  const row = merchant.rows[0];
  if (!row || !parsed.data.objectKey.startsWith(`kyc/${row.id}/${parsed.data.docType}/`)) {
    return res.status(403).json({ error: 'Document object is outside this merchant scope.' });
  }
  if (!validateDocumentSignature(parsed.data.contentType, parsed.data.signatureSampleBase64)) {
    return res.status(400).json({ error: 'File signature does not match its MIME type.' });
  }
  await getPgPool().query(
    `INSERT INTO merchant_documents
      (id, merchant_id, doc_type, file_name, content_type, size_bytes, file_data,
       uploaded_at, object_key, storage_provider, encryption_key_ref, scan_state)
     VALUES ($1,$2,$3,$4,$5,$6,''::bytea,NOW(),$7,$8,$9,'pending')
     ON CONFLICT (merchant_id, doc_type) DO UPDATE SET
       id=EXCLUDED.id, file_name=EXCLUDED.file_name, content_type=EXCLUDED.content_type,
       size_bytes=EXCLUDED.size_bytes, file_data=''::bytea, uploaded_at=NOW(),
       object_key=EXCLUDED.object_key, storage_provider=EXCLUDED.storage_provider,
       encryption_key_ref=EXCLUDED.encryption_key_ref, scan_state='pending',
       scan_completed_at=NULL, quarantined_at=NULL`,
    [
      randomUUID(), row.id, parsed.data.docType, `${parsed.data.docType}.document`,
      parsed.data.contentType.toLowerCase(), parsed.data.sizeBytes,
      parsed.data.objectKey, process.env.PRIVATE_STORAGE_PROVIDER ?? 'external',
      parsed.data.encryptionKeyRef,
    ],
  );
  await getPgPool().query(
    `UPDATE merchant_documents SET metadata_encrypted = $1 WHERE object_key = $2`,
    [
      encryptSensitive(JSON.stringify({ originalFileName: parsed.data.fileName })),
      parsed.data.objectKey,
    ],
  );
  return res.status(202).json({ ok: true, scanState: 'pending' });
});

merchantsRouterPg.post(
  '/merchants/me/documents',
  requireAuth,
  async (req, res) => {
    if (process.env.NODE_ENV === 'production' || process.env.ALLOW_LEGACY_DB_KYC_UPLOAD !== 'true') {
      return res.status(410).json({
        error: 'Legacy database document uploads are disabled. Use signed private-storage upload.',
      });
    }
    const parsed = uploadBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    if (!isMerchantDocType(parsed.data.docType)) {
      return res.status(400).json({ error: 'Invalid document type.' });
    }
    if (!assertAllowedContentType(parsed.data.contentType)) {
      return res.status(400).json({
        error: 'Only PDF, JPEG, PNG, or WebP files are allowed.',
      });
    }

    let buffer: Buffer;
    try {
      buffer = decodeDocumentBase64(parsed.data.dataBase64);
    } catch {
      return res.status(400).json({ error: 'Invalid file data.' });
    }
    if (buffer.length === 0 || buffer.length > MAX_MERCHANT_DOC_BYTES) {
      return res.status(400).json({
        error: `File must be between 1 byte and ${MAX_MERCHANT_DOC_BYTES / (1024 * 1024)} MB.`,
      });
    }

    const pool = getPgPool();
    const merchantQ = await pool.query<MerchantRow>(
      `SELECT * FROM merchants WHERE user_id = $1`,
      [req.auth!.userId],
    );
    const merchant = merchantQ.rows[0];
    if (!merchant) {
      return res.status(404).json({ error: 'Merchant profile not set up yet.' });
    }
    if (merchant.approval_status === 'pending_approval') {
      return res.status(409).json({
        error: 'Documents are under review. Wait for admin approval.',
      });
    }
    if (merchant.approval_status === 'approved') {
      return res.status(409).json({
        error: 'Account already approved — documents cannot be changed.',
      });
    }

    const now = new Date().toISOString();
    const id = randomUUID();
    await pool.query(
      `INSERT INTO merchant_documents (
         id, merchant_id, doc_type, file_name, content_type, size_bytes, file_data, uploaded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (merchant_id, doc_type) DO UPDATE SET
         id = EXCLUDED.id,
         file_name = EXCLUDED.file_name,
         content_type = EXCLUDED.content_type,
         size_bytes = EXCLUDED.size_bytes,
         file_data = EXCLUDED.file_data,
         uploaded_at = EXCLUDED.uploaded_at`,
      [
        id,
        merchant.id,
        parsed.data.docType,
        parsed.data.fileName,
        parsed.data.contentType.toLowerCase(),
        buffer.length,
        buffer,
        now,
      ],
    );

    // Re-upload after rejection returns the merchant to pending_docs.
    if (merchant.approval_status === 'rejected') {
      await pool.query(
        `UPDATE merchants
            SET approval_status = 'pending_docs',
                rejection_reason = NULL,
                reviewed_at = NULL,
                reviewed_by = NULL,
                docs_submitted_at = NULL
          WHERE id = $1`,
        [merchant.id],
      );
    }

    const freshQ = await pool.query<MerchantRow>(
      `SELECT * FROM merchants WHERE id = $1`,
      [merchant.id],
    );
    return res.status(201).json({
      merchant: toMerchant(freshQ.rows[0]),
      document: {
        docType: parsed.data.docType,
        fileName: parsed.data.fileName,
        contentType: parsed.data.contentType.toLowerCase(),
        sizeBytes: buffer.length,
        uploadedAt: now,
        uploaded: true,
      },
    });
  },
);

merchantsRouterPg.post(
  '/merchants/me/documents/submit',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    const merchantQ = await pool.query<MerchantRow>(
      `SELECT * FROM merchants WHERE user_id = $1`,
      [req.auth!.userId],
    );
    const merchant = merchantQ.rows[0];
    if (!merchant) {
      return res.status(404).json({ error: 'Merchant profile not set up yet.' });
    }
    if (merchant.approval_status === 'approved') {
      return res.json({ merchant: toMerchant(merchant) });
    }
    if (merchant.approval_status === 'pending_approval') {
      return res.json({ merchant: toMerchant(merchant) });
    }

    const docsQ = await pool.query<{ doc_type: string; scan_state: string }>(
      `SELECT doc_type, scan_state FROM merchant_documents
        WHERE merchant_id = $1 AND deleted_at IS NULL`,
      [merchant.id],
    );
    const have = new Set(
      docsQ.rows.filter((r) => r.scan_state === 'clean').map((r) => r.doc_type),
    );
    const missing = MERCHANT_DOC_TYPES.filter((t) => !have.has(t));
    if (missing.length > 0) {
      return res.status(400).json({
        error: 'All required documents must be uploaded and pass malware scanning before submission.',
        missing,
      });
    }

    const now = new Date().toISOString();
    await pool.query(
      `UPDATE merchants
          SET approval_status = 'pending_approval',
              docs_submitted_at = $1,
              rejection_reason = NULL
        WHERE id = $2`,
      [now, merchant.id],
    );
    const freshQ = await pool.query<MerchantRow>(
      `SELECT * FROM merchants WHERE id = $1`,
      [merchant.id],
    );
    return res.json({ merchant: toMerchant(freshQ.rows[0]) });
  },
);
