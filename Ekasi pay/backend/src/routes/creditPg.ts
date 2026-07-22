import { randomUUID } from 'node:crypto';

import { Router } from 'express';

import {
  CREDIT_OTP_TTL_MS,
  CREDIT_VERIFY_TOKEN_TTL_MS,
  generateCreditOtpCode,
  generateCreditVerificationToken,
  hashCreditOtp,
  hashSaIdForStorage,
  idsMatchHash,
  type CreditOtpPurpose,
} from '../creditVerification.js';
import { NODE_ENV } from '../config.js';
import { getPgPool } from '../dbPg.js';
import { toCreditCustomer, toCreditTransaction } from '../mappers.js';
import {
  parseIntegerCents,
  parseZarToCents,
  type Cents,
} from '../money.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantIdPg } from '../services/merchantPg.js';
import { sendSms } from '../services/sms.js';
import {
  creditCustomerCreateSchema,
  creditTxnSchema,
  creditVerifyConfirmSchema,
  creditVerifyRequestSchema,
} from '../validation.js';

export const creditRouterPg = Router();

creditRouterPg.use(requireAuth, requireApprovedMerchant);

type OtpRow = {
  id: string;
  merchant_id: string;
  phone: string;
  purpose: string;
  customer_id: string | null;
  code_hash: string;
  sa_id_hash: string | null;
  verification_token: string | null;
  verification_expires_at: string | null;
  used_at: string | null;
  token_used_at: string | null;
  created_at: string;
};

async function requireMerchant(req: { auth?: { userId: string } }) {
  const pool = getPgPool();
  const merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  return { pool, merchantId };
}

async function loadCustomerForMerchant(
  pool: ReturnType<typeof getPgPool>,
  merchantId: string,
  customerId: string,
) {
  const customerQ = await pool.query<{
    id: string;
    merchant_id: string;
    phone: string;
    sa_id_hash: string | null;
    total_owed_cents: string;
    credit_limit_cents: string;
  }>(`SELECT * FROM credit_customers WHERE id = $1`, [customerId]);
  const customer = customerQ.rows[0];
  if (!customer || customer.merchant_id !== merchantId) return null;
  return customer;
}

async function consumeVerificationToken(
  pool: ReturnType<typeof getPgPool>,
  merchantId: string,
  token: string,
  purpose: CreditOtpPurpose,
  customerId?: string,
): Promise<OtpRow | null> {
  const now = new Date().toISOString();
  const q = await pool.query<OtpRow>(
    `SELECT * FROM credit_otp_codes
      WHERE verification_token = $1
        AND merchant_id = $2
        AND purpose = $3
        AND token_used_at IS NULL
        AND verification_expires_at > $4
        AND ($5::text IS NULL OR customer_id = $5)`,
    [token, merchantId, purpose, now, customerId ?? null],
  );
  const row = q.rows[0];
  if (!row) return null;
  await pool.query(`UPDATE credit_otp_codes SET token_used_at = $1 WHERE id = $2`, [
    now,
    row.id,
  ]);
  return row;
}

creditRouterPg.post('/credit/verify/request', requireAuth, async (req, res) => {
  const parsed = creditVerifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let merchantId: string;
  let pool: ReturnType<typeof getPgPool>;
  try {
    ({ pool, merchantId } = await requireMerchant(req));
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const { phone, purpose } = parsed.data;
  const customerId = parsed.data.customerId;
  if (purpose === 'purchase') {
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required for purchase verification' });
    }
    const customer = await loadCustomerForMerchant(pool, merchantId, customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    if (customer.phone.replace(/\D/g, '') !== phone) {
      return res.status(400).json({ error: 'Phone does not match this credit customer' });
    }
  }

  const code = generateCreditOtpCode();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  await pool.query(
    `DELETE FROM credit_otp_codes
      WHERE merchant_id = $1 AND phone = $2 AND purpose = $3
        AND ($4::text IS NULL OR customer_id = $4)`,
    [merchantId, phone, purpose, customerId ?? null],
  );
  await pool.query(
    `INSERT INTO credit_otp_codes (
      id, merchant_id, phone, purpose, customer_id, code_hash, created_at, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      randomUUID(),
      merchantId,
      phone,
      purpose,
      customerId ?? null,
      hashCreditOtp({ merchantId, phone, purpose, customerId, code }),
      nowIso,
      new Date(now + CREDIT_OTP_TTL_MS).toISOString(),
    ],
  );

  const smsBody =
    purpose === 'onboard'
      ? `Ekasi Pay credit book: your verification code is ${code}. Valid 10 minutes. Show your ID at the shop. Do not share this code.`
      : `Ekasi Pay credit purchase code: ${code}. Valid 10 minutes. Confirm with your ID book at the shop. Do not share this code.`;

  const generic = {
    ok: true,
    message: 'If the phone number is correct, a 6-digit verification code has been sent.',
  };

  try {
    await sendSms(phone, smsBody);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'SMS delivery failed';
    console.error(`[credit-otp] SMS failed for ${phone}: ${msg}`);
    if (NODE_ENV === 'production') {
      return res.status(503).json({
        error: 'Could not send verification code right now. Try again shortly.',
      });
    }
    console.info(`[credit-otp] dev fallback code for ${phone} = ${code}`);
    return res.json({ ...generic, devCode: code });
  }

  if (NODE_ENV !== 'production') {
    return res.json({ ...generic, devCode: code });
  }
  return res.json(generic);
});

creditRouterPg.post('/credit/verify/confirm', requireAuth, async (req, res) => {
  const parsed = creditVerifyConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let merchantId: string;
  let pool: ReturnType<typeof getPgPool>;
  try {
    ({ pool, merchantId } = await requireMerchant(req));
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const { phone, purpose, code, saIdDocument } = parsed.data;
  const customerId = parsed.data.customerId;
  const saIdHash = hashSaIdForStorage(saIdDocument);

  if (purpose === 'purchase') {
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required for purchase verification' });
    }
    const customer = await loadCustomerForMerchant(pool, merchantId, customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    if (customer.sa_id_hash && !idsMatchHash(customer.sa_id_hash, saIdDocument)) {
      return res.status(400).json({
        error: 'ID number does not match the customer on file. Customer must present their ID book.',
      });
    }
  }

  const otpQ = await pool.query<OtpRow & { expires_at: string }>(
    `SELECT * FROM credit_otp_codes
      WHERE merchant_id = $1 AND phone = $2 AND purpose = $3
        AND used_at IS NULL AND expires_at > $4
        AND ($5::text IS NULL OR customer_id = $5)
      ORDER BY created_at DESC
      LIMIT 1`,
    [merchantId, phone, purpose, new Date().toISOString(), customerId ?? null],
  );
  const otpRow = otpQ.rows[0];
  if (
    !otpRow ||
    otpRow.code_hash !==
      hashCreditOtp({ merchantId, phone, purpose, customerId, code })
  ) {
    return res.status(400).json({ error: 'Invalid or expired verification code' });
  }

  const verificationToken = generateCreditVerificationToken();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  await pool.query(
    `UPDATE credit_otp_codes
        SET used_at = $1,
            sa_id_hash = $2,
            verification_token = $3,
            verification_expires_at = $4
      WHERE id = $5`,
    [
      nowIso,
      saIdHash,
      verificationToken,
      new Date(now + CREDIT_VERIFY_TOKEN_TTL_MS).toISOString(),
      otpRow.id,
    ],
  );

  return res.json({
    ok: true,
    verificationToken,
    expiresInSec: Math.floor(CREDIT_VERIFY_TOKEN_TTL_MS / 1000),
  });
});

creditRouterPg.get('/credit/customers', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const q = typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
  if (q && q !== merchantId) {
    return res.status(403).json({ error: 'Cannot read another merchant customers' });
  }

  const rows = await pool.query<{
    id: string;
    merchant_id: string;
    name: string;
    phone: string;
    last_payment_date: string | null;
    created_at: string;
    sa_id_hash: string | null;
    id_verified_at: string | null;
  }>(
    `SELECT * FROM credit_customers WHERE merchant_id = $1 ORDER BY lower(name)`,
    [merchantId],
  );
  return res.json({ customers: rows.rows.map(toCreditCustomer) });
});

creditRouterPg.get('/credit/transactions', requireAuth, async (req, res) => {
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const rows = await pool.query<{
    id: string;
    customer_id: string;
    type: string;
    amount_cents: string;
    description: string;
    created_at: string;
  }>(
    `SELECT ct.*
       FROM credit_transactions ct
       INNER JOIN credit_customers cc ON cc.id = ct.customer_id
      WHERE cc.merchant_id = $1
      ORDER BY ct.created_at DESC
      LIMIT 500`,
    [merchantId],
  );
  return res.json({ transactions: rows.rows.map(toCreditTransaction) });
});

creditRouterPg.post('/credit/customers', requireAuth, async (req, res) => {
  const parsed = creditCustomerCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const c = parsed.data;
  const tokenRow = await consumeVerificationToken(
    pool,
    merchantId,
    c.verificationToken,
    'onboard',
  );
  if (!tokenRow) {
    return res.status(400).json({
      error: 'OTP verification expired. Scan the customer ID and request a new code.',
    });
  }
  if (tokenRow.phone !== c.phone) {
    return res.status(400).json({ error: 'Phone does not match verified OTP session' });
  }
  if (!tokenRow.sa_id_hash || !idsMatchHash(tokenRow.sa_id_hash, c.saIdDocument)) {
    return res.status(400).json({
      error: 'ID number does not match the verified OTP session',
    });
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const saIdHash = hashSaIdForStorage(c.saIdDocument);
  await pool.query(
    `INSERT INTO credit_customers (
      id, merchant_id, name, phone, total_owed_cents, credit_limit_cents, created_at, sa_id_hash, id_verified_at
    ) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, $8)`,
    [
      id,
      merchantId,
      c.name,
      c.phone,
      parseZarToCents(c.creditLimit).toString(),
      now,
      saIdHash,
      now,
    ],
  );
  const row = await pool.query<{
    id: string;
    merchant_id: string;
    name: string;
    phone: string;
    total_owed_cents: string;
    credit_limit_cents: string;
    last_payment_date: string | null;
    created_at: string;
    sa_id_hash: string | null;
    id_verified_at: string | null;
  }>(`SELECT * FROM credit_customers WHERE id = $1`, [id]);
  return res.status(201).json({ customer: toCreditCustomer(row.rows[0]) });
});

creditRouterPg.post(
  '/credit/transactions',
  requireAuth,
  idempotentPg('POST /credit/transactions'),
  async (req, res) => {
  const parsed = creditTxnSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const pool = getPgPool();
  let merchantId: string;
  try {
    merchantId = await requireMerchantIdPg(pool, req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const { customerId, type, amount, description } = parsed.data;
  const amountCents = parseZarToCents(amount);
  const customerQ = await pool.query<{
    id: string;
    merchant_id: string;
    total_owed_cents: string;
    credit_limit_cents: string;
    sa_id_hash: string | null;
  }>(`SELECT * FROM credit_customers WHERE id = $1`, [customerId]);
  const customer = customerQ.rows[0];
  if (!customer || customer.merchant_id !== merchantId) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  let verifiedSaIdHash: string | null = customer.sa_id_hash;
  if (type === 'purchase') {
    const tokenRow = await consumeVerificationToken(
      pool,
      merchantId,
      parsed.data.verificationToken!,
      'purchase',
      customerId,
    );
    if (!tokenRow) {
      return res.status(400).json({
        error: 'OTP verification expired. Customer must present ID and confirm with a new code.',
      });
    }
    if (!tokenRow.sa_id_hash) {
      return res.status(400).json({ error: 'ID verification missing from OTP session' });
    }
    if (customer.sa_id_hash && customer.sa_id_hash !== tokenRow.sa_id_hash) {
      return res.status(400).json({
        error: 'ID number does not match the customer on file',
      });
    }
    verifiedSaIdHash = tokenRow.sa_id_hash;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const owedCents = parseIntegerCents(customer.total_owed_cents, {
    allowZero: true,
  });
  const creditLimitCents = parseIntegerCents(customer.credit_limit_cents);
  let nextTotalCents: Cents = owedCents;
  if (type === 'purchase') {
    nextTotalCents = (owedCents + amountCents) as Cents;
    if (nextTotalCents > creditLimitCents) {
      return res.status(400).json({ error: 'Would exceed credit limit' });
    }
  } else {
    nextTotalCents = (amountCents >= owedCents
      ? 0n
      : owedCents - amountCents) as Cents;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO credit_transactions (id, customer_id, type, amount_cents, description, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, customerId, type, amountCents.toString(), description, now],
    );
    if (type === 'payment') {
      await client.query(
        `UPDATE credit_customers SET total_owed_cents = $1, last_payment_date = $2 WHERE id = $3`,
        [nextTotalCents.toString(), now, customerId],
      );
    } else {
      await client.query(
        `UPDATE credit_customers
            SET total_owed_cents = $1,
                sa_id_hash = COALESCE(sa_id_hash, $2),
                id_verified_at = COALESCE(id_verified_at, $3)
          WHERE id = $4`,
        [nextTotalCents.toString(), verifiedSaIdHash, now, customerId],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  const updated = await pool.query<{
    id: string;
    merchant_id: string;
    name: string;
    phone: string;
    total_owed_cents: string;
    credit_limit_cents: string;
    last_payment_date: string | null;
    created_at: string;
    sa_id_hash: string | null;
    id_verified_at: string | null;
  }>(`SELECT * FROM credit_customers WHERE id = $1`, [customerId]);
  const txnRow = await pool.query<{
    id: string;
    customer_id: string;
    type: string;
    amount_cents: string;
    description: string;
    created_at: string;
  }>(`SELECT * FROM credit_transactions WHERE id = $1`, [id]);
  return res.status(201).json({
    transaction: toCreditTransaction(txnRow.rows[0]),
    customer: toCreditCustomer(updated.rows[0]),
  });
  },
);
