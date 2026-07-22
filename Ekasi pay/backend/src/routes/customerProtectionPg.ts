import { createHash, randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireCapability } from '../security/authorization.js';
import { stableJsonSha256 } from '../services/regulatedProducts.js';

export const customerProtectionRouterPg = Router();
export const customerProtectionOpsRouterPg = Router();

customerProtectionRouterPg.use(requireAuth);

const statementQuery = z.object({
  q: z.string().trim().max(120).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  type: z.string().trim().max(60).optional(),
  status: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

customerProtectionRouterPg.get('/customer/statements', async (req, res) => {
  const parsed = statementQuery.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { q, from, to, type, status, limit } = parsed.data;
  const result = await getPgPool().query(
    `SELECT t.id,t.amount_cents,t.type,t.status,t.reference,t.description,t.created_at,
            CASE WHEN t.from_wallet_id = w.id THEN 'debit' ELSE 'credit' END direction
       FROM wallets w
       JOIN transactions t ON t.from_wallet_id = w.id OR t.to_wallet_id = w.id
      WHERE w.user_id = $1 AND COALESCE(w.wallet_kind,'user') = 'user'
        AND ($2::text IS NULL OR
             t.reference ILIKE '%' || $2 || '%' OR t.description ILIKE '%' || $2 || '%')
        AND ($3::timestamptz IS NULL OR t.created_at >= $3)
        AND ($4::timestamptz IS NULL OR t.created_at <= $4)
        AND ($5::text IS NULL OR t.type = $5)
        AND ($6::text IS NULL OR t.status = $6)
      ORDER BY t.created_at DESC,t.id DESC LIMIT $7`,
    [req.auth!.userId, q ?? null, from ?? null, to ?? null, type ?? null, status ?? null, limit],
  );
  return res.json({ statement: result.rows, query: parsed.data });
});

const exportBody = statementQuery.omit({ limit: true }).extend({
  format: z.enum(['json', 'csv', 'pdf']),
});

customerProtectionRouterPg.post('/customer/statements/exports', async (req, res) => {
  const parsed = exportBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const digest = stableJsonSha256({ userId: req.auth!.userId, query: parsed.data, empty: true });
  await getPgPool().query(
    `INSERT INTO customer_statement_exports
       (id,user_id,format,query,item_count,content_sha256,expires_at)
     VALUES ($1,$2,$3,$4,0,$5,clock_timestamp() + interval '24 hours')`,
    [id, req.auth!.userId, parsed.data.format, parsed.data, digest],
  );
  return res.status(202).json({
    exportId: id,
    state: 'queued',
    message: 'Export evidence recorded. A configured private object worker must render and store the artifact.',
  });
});

customerProtectionRouterPg.get('/customer/receipts/:resourceType/:resourceId', async (req, res) => {
  const existing = await getPgPool().query(
    `SELECT * FROM durable_receipts
      WHERE user_id=$1 AND resource_type=$2 AND resource_id=$3`,
    [req.auth!.userId, req.params.resourceType, req.params.resourceId],
  );
  if (existing.rows[0]) return res.json({ receipt: existing.rows[0] });
  if (req.params.resourceType !== 'transaction') {
    return res.status(404).json({ error: 'Receipt not found.' });
  }
  const transaction = await getPgPool().query<{
    id: string; amount_cents: string; status: string; reference: string;
    description: string; type: string; created_at: string; currency: string;
  }>(
    `SELECT t.id,t.amount_cents,t.status,t.reference,t.description,t.type,t.created_at,w.currency
       FROM transactions t JOIN wallets w ON w.id IN (t.from_wallet_id,t.to_wallet_id)
      WHERE t.id=$1 AND w.user_id=$2 LIMIT 1`,
    [req.params.resourceId, req.auth!.userId],
  );
  const row = transaction.rows[0];
  if (!row) return res.status(404).json({ error: 'Transaction not found.' });
  const content = { ...row, issuer: 'KasiPay', receiptVersion: 'phase8-v1' };
  const receipt = {
    id: randomUUID(),
    receiptNumber: `KP-${row.created_at.slice(0, 10).replaceAll('-', '')}-${row.id.slice(0, 8).toUpperCase()}`,
    contentSha256: stableJsonSha256(content),
  };
  await getPgPool().query(
    `INSERT INTO durable_receipts
       (id,user_id,resource_type,resource_id,receipt_number,amount_cents,fee_cents,
        currency,status,content,content_sha256)
     VALUES ($1,$2,'transaction',$3,$4,$5,0,$6,$7,$8,$9)
     ON CONFLICT (resource_type,resource_id,user_id) DO NOTHING`,
    [receipt.id, req.auth!.userId, row.id, receipt.receiptNumber, row.amount_cents,
      row.currency, row.status, content, receipt.contentSha256],
  );
  const stored = await getPgPool().query(
    `SELECT * FROM durable_receipts
      WHERE user_id=$1 AND resource_type='transaction' AND resource_id=$2`,
    [req.auth!.userId, row.id],
  );
  return res.status(201).json({ receipt: stored.rows[0] });
});

const feeConfirmationBody = z.object({
  quoteId: z.string().trim().min(1).max(160),
  operationType: z.enum(['transfer', 'cash_send', 'utility', 'sale', 'refund', 'closing_withdrawal']),
  principalCents: z.string().regex(/^[1-9]\d*$/u),
  feeCents: z.string().regex(/^\d+$/u),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  disclosureVersion: z.string().trim().min(1).max(80),
  disclosureSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  acceptanceText: z.string().trim().min(10).max(500),
});

customerProtectionRouterPg.post('/customer/fee-confirmations', async (req, res) => {
  const parsed = feeConfirmationBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const total = BigInt(parsed.data.principalCents) + BigInt(parsed.data.feeCents);
  const evidenceSha256 = stableJsonSha256({
    userId: req.auth!.userId,
    sessionId: req.auth!.sessionId,
    ...parsed.data,
    totalCents: total.toString(),
  });
  await getPgPool().query(
    `INSERT INTO fee_confirmation_evidence
       (id,user_id,authenticated_session_id,quote_id,operation_type,principal_cents,
        fee_cents,total_cents,currency,disclosure_version,disclosure_sha256,
        acceptance_text,evidence_sha256,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
             clock_timestamp() + interval '10 minutes')`,
    [id, req.auth!.userId, req.auth!.sessionId, parsed.data.quoteId,
      parsed.data.operationType, parsed.data.principalCents, parsed.data.feeCents,
      total.toString(), parsed.data.currency, parsed.data.disclosureVersion,
      parsed.data.disclosureSha256, parsed.data.acceptanceText, evidenceSha256],
  );
  return res.status(201).json({ confirmationId: id, totalCents: total.toString(), evidenceSha256 });
});

customerProtectionRouterPg.get('/customer/notifications', async (req, res) => {
  const rows = await getPgPool().query(
    `SELECT * FROM customer_notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`,
    [req.auth!.userId],
  );
  return res.json({ notifications: rows.rows });
});

const preferencesBody = z.object({
  loginEnabled: z.boolean(),
  transactionEnabled: z.boolean(),
  complaintEnabled: z.boolean(),
  refundEnabled: z.boolean(),
  channels: z.array(z.enum(['in_app', 'sms', 'email', 'push'])).min(1).max(4),
  locale: z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/u),
});

customerProtectionRouterPg.put('/customer/notifications/preferences', async (req, res) => {
  const parsed = preferencesBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const row = await getPgPool().query(
    `INSERT INTO customer_notification_preferences
       (user_id,login_enabled,transaction_enabled,complaint_enabled,refund_enabled,channels,locale)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id) DO UPDATE SET
       login_enabled=EXCLUDED.login_enabled,transaction_enabled=EXCLUDED.transaction_enabled,
       complaint_enabled=EXCLUDED.complaint_enabled,refund_enabled=EXCLUDED.refund_enabled,
       channels=EXCLUDED.channels,locale=EXCLUDED.locale,updated_at=clock_timestamp()
     RETURNING *`,
    [req.auth!.userId, parsed.data.loginEnabled, parsed.data.transactionEnabled,
      parsed.data.complaintEnabled, parsed.data.refundEnabled, parsed.data.channels,
      parsed.data.locale],
  );
  return res.json({ preferences: row.rows[0] });
});

const caseBody = z.object({
  caseType: z.enum(['incorrect_payment', 'suspected_fraud', 'complaint', 'dispute', 'account_recovery', 'refund_query']),
  subject: z.string().trim().min(3).max(160),
  description: z.string().trim().min(10).max(4000),
  resourceType: z.string().trim().max(80).optional(),
  resourceId: z.string().trim().max(160).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
});

customerProtectionRouterPg.post('/customer/cases', async (req, res) => {
  const parsed = caseBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  const caseNumber = `KP-C-${Date.now().toString(36).toUpperCase()}-${id.slice(0, 6).toUpperCase()}`;
  const urgent = parsed.data.priority === 'urgent' || parsed.data.caseType === 'suspected_fraud';
  const row = await getPgPool().query(
    `INSERT INTO customer_cases
       (id,user_id,case_number,case_type,subject,description,resource_type,resource_id,
        priority,acknowledged_due_at,resolution_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
             clock_timestamp() + $10::interval,clock_timestamp() + $11::interval)
     RETURNING *`,
    [id, req.auth!.userId, caseNumber, parsed.data.caseType, parsed.data.subject,
      parsed.data.description, parsed.data.resourceType ?? null, parsed.data.resourceId ?? null,
      parsed.data.priority, urgent ? '1 hour' : '1 day', urgent ? '1 day' : '10 days'],
  );
  await getPgPool().query(
    `INSERT INTO customer_case_events
       (id,case_id,event_type,to_state,actor_type,actor_id,notes)
     VALUES ($1,$2,'submitted','submitted','user',$3,'Case submitted by customer')`,
    [randomUUID(), id, req.auth!.userId],
  );
  return res.status(201).json({ case: row.rows[0] });
});

customerProtectionRouterPg.get('/customer/cases', async (req, res) => {
  const rows = await getPgPool().query(
    `SELECT * FROM customer_cases WHERE user_id=$1 ORDER BY created_at DESC`,
    [req.auth!.userId],
  );
  return res.json({ cases: rows.rows });
});

customerProtectionRouterPg.post('/customer/account/freeze', async (req, res) => {
  const parsed = z.object({ reason: z.string().trim().min(10).max(1000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const client = await getPgPool().connect();
  const id = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO account_protection_actions
         (id,user_id,action,state,reason,requested_by_type,requested_by_id,
          authenticated_session_id,verification_evidence,applied_at)
       VALUES ($1,$2,'freeze','applied',$3,'user',$2,$4,$5,clock_timestamp())`,
      [id, req.auth!.userId, parsed.data.reason, req.auth!.sessionId,
        { requestId: req.requestId, correlationId: req.correlationId }],
    );
    await client.query(`UPDATE users SET suspended_at=clock_timestamp(),token_version=token_version+1 WHERE id=$1`, [req.auth!.userId]);
    await client.query(`UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL`, [req.auth!.userId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return res.status(201).json({ actionId: id, state: 'applied', message: 'Account frozen and active sessions revoked.' });
});

customerProtectionRouterPg.get('/customer/terms', async (req, res) => {
  const rows = await getPgPool().query(
    `SELECT t.*,a.accepted_at
       FROM customer_terms_versions t
       LEFT JOIN customer_terms_acceptances a ON a.terms_version_id=t.id AND a.user_id=$1
      WHERE t.state='published' AND t.effective_at <= clock_timestamp()
      ORDER BY t.document_type,t.effective_at DESC`,
    [req.auth!.userId],
  );
  return res.json({ terms: rows.rows });
});

customerProtectionRouterPg.post('/customer/terms/:id/accept', async (req, res) => {
  const parsed = z.object({ acceptanceText: z.string().trim().min(10).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const acceptanceSha256 = stableJsonSha256({
    userId: req.auth!.userId, termsVersionId: req.params.id, text: parsed.data.acceptanceText,
  });
  const row = await getPgPool().query(
    `INSERT INTO customer_terms_acceptances
       (id,user_id,terms_version_id,authenticated_session_id,acceptance_text,
        acceptance_sha256,ip_hash,user_agent_hash)
     SELECT $1,$2,t.id,$3,$4,$5,$6,$7 FROM customer_terms_versions t
      WHERE t.id=$8 AND t.state='published' AND t.effective_at <= clock_timestamp()
     ON CONFLICT (user_id,terms_version_id) DO NOTHING RETURNING *`,
    [randomUUID(), req.auth!.userId, req.auth!.sessionId, parsed.data.acceptanceText,
      acceptanceSha256, createHash('sha256').update(req.ip ?? '').digest('hex'),
      createHash('sha256').update(req.get('user-agent') ?? '').digest('hex'), req.params.id],
  );
  if (!row.rows[0]) return res.status(409).json({ error: 'Terms are unavailable or already accepted.' });
  return res.status(201).json({ acceptance: row.rows[0] });
});

customerProtectionRouterPg.get('/customer/refunds', async (req, res) => {
  const rows = await getPgPool().query(
    `SELECT r.*,COALESCE(jsonb_agg(e ORDER BY e.created_at)
       FILTER (WHERE e.id IS NOT NULL),'[]'::jsonb) status_events
       FROM refund_requests r LEFT JOIN refund_status_events e ON e.refund_request_id=r.id
      WHERE r.requested_by_type='user' AND r.requested_by_id=$1
      GROUP BY r.id ORDER BY r.created_at DESC`,
    [req.auth!.userId],
  );
  return res.json({ refunds: rows.rows });
});

const closingBody = z.object({
  walletId: z.string().min(1).max(160),
  destinationType: z.enum(['bank_account', 'cash_voucher', 'other_wallet']),
  destinationToken: z.string().trim().min(8).max(500),
  feeConfirmationId: z.string().uuid(),
});

customerProtectionRouterPg.post('/customer/account/closing-withdrawals', async (req, res) => {
  const parsed = closingBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const client = await getPgPool().connect();
  const id = randomUUID();
  try {
    await client.query('BEGIN');
    const wallet = await client.query<{ balance_cents: string }>(
      `SELECT balance_cents FROM wallets WHERE id=$1 AND user_id=$2 AND status='active' FOR UPDATE`,
      [parsed.data.walletId, req.auth!.userId],
    );
    const balance = wallet.rows[0];
    if (!balance) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active wallet not found.' });
    }
    const confirmation = await client.query<{ fee_cents: string }>(
      `SELECT fee_cents FROM fee_confirmation_evidence
        WHERE id=$1 AND user_id=$2 AND operation_type='closing_withdrawal'
          AND expires_at > clock_timestamp() AND consumed_by_resource_id IS NULL
        FOR UPDATE`,
      [parsed.data.feeConfirmationId, req.auth!.userId],
    );
    if (!confirmation.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A current, unused closing-withdrawal fee confirmation is required.' });
    }
    await client.query(
      `INSERT INTO closing_balance_withdrawals
         (id,user_id,wallet_id,destination_type,destination_token,requested_cents,
          fee_cents,state,fee_confirmation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'verification_required',$8)`,
      [id, req.auth!.userId, parsed.data.walletId, parsed.data.destinationType,
        parsed.data.destinationToken, balance.balance_cents,
        confirmation.rows[0].fee_cents, parsed.data.feeConfirmationId],
    );
    await client.query(
      `UPDATE fee_confirmation_evidence SET consumed_by_resource_id=$1 WHERE id=$2`,
      [id, parsed.data.feeConfirmationId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return res.status(202).json({
    withdrawalId: id,
    state: 'verification_required',
    message: 'No funds moved. Destination verification and operator review are required.',
  });
});

customerProtectionOpsRouterPg.get(
  '/ops/customer-cases',
  ...requireCapability('support:read'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT *,clock_timestamp() > acknowledged_due_at AS acknowledgement_breached,
                clock_timestamp() > resolution_due_at AS resolution_breached
         FROM customer_cases ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,created_at`,
    );
    return res.json({ cases: rows.rows });
  },
);
