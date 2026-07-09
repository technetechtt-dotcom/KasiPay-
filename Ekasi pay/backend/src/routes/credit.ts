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
import { getDb } from '../db.js';
import { toCreditCustomer, toCreditTransaction } from '../mappers.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireMerchantId } from '../services/merchant.js';
import { sendSms } from '../services/sms.js';
import {
  creditCustomerCreateSchema,
  creditTxnSchema,
  creditVerifyConfirmSchema,
  creditVerifyRequestSchema,
} from '../validation.js';

export const creditRouter = Router();

type OtpRow = {
  id: string;
  merchant_id: string;
  phone: string;
  purpose: string;
  customer_id: string | null;
  code_hash: string;
  sa_id_hash: string | null;
  verification_token: string | null;
  expires_at: string;
  verification_expires_at: string | null;
  used_at: string | null;
  token_used_at: string | null;
  created_at: string;
};

type CustomerRow = {
  id: string;
  merchant_id: string;
  name: string;
  phone: string;
  total_owed: number;
  credit_limit: number;
  last_payment_date: string | null;
  created_at: string;
  sa_id_hash: string | null;
  id_verified_at: string | null;
};

function loadCustomerForMerchant(
  database: ReturnType<typeof getDb>,
  merchantId: string,
  customerId: string,
) {
  const customer = database
    .prepare(`SELECT * FROM credit_customers WHERE id = ?`)
    .get(customerId) as CustomerRow | undefined;
  if (!customer || customer.merchant_id !== merchantId) return null;
  return customer;
}

function consumeVerificationToken(
  database: ReturnType<typeof getDb>,
  merchantId: string,
  token: string,
  purpose: CreditOtpPurpose,
  customerId?: string,
): OtpRow | null {
  const now = new Date().toISOString();
  const row = database
    .prepare(
      `SELECT * FROM credit_otp_codes
        WHERE verification_token = ?
          AND merchant_id = ?
          AND purpose = ?
          AND token_used_at IS NULL
          AND verification_expires_at > ?
          AND (? IS NULL OR customer_id = ?)`,
    )
    .get(token, merchantId, purpose, now, customerId ?? null, customerId ?? null) as
    | OtpRow
    | undefined;
  if (!row) return null;
  database
    .prepare(`UPDATE credit_otp_codes SET token_used_at = ? WHERE id = ?`)
    .run(now, row.id);
  return row;
}

creditRouter.post('/credit/verify/request', requireAuth, async (req, res) => {
  const parsed = creditVerifyRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const database = getDb();
  const { phone, purpose } = parsed.data;
  const customerId = parsed.data.customerId;
  if (purpose === 'purchase') {
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required for purchase verification' });
    }
    const customer = loadCustomerForMerchant(database, merchantId, customerId);
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
  database
    .prepare(
      `DELETE FROM credit_otp_codes
        WHERE merchant_id = ? AND phone = ? AND purpose = ?
          AND (? IS NULL OR customer_id = ?)`,
    )
    .run(merchantId, phone, purpose, customerId ?? null, customerId ?? null);
  database
    .prepare(
      `INSERT INTO credit_otp_codes (
        id, merchant_id, phone, purpose, customer_id, code_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      merchantId,
      phone,
      purpose,
      customerId ?? null,
      hashCreditOtp({ merchantId, phone, purpose, customerId, code }),
      nowIso,
      new Date(now + CREDIT_OTP_TTL_MS).toISOString(),
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

creditRouter.post('/credit/verify/confirm', requireAuth, (req, res) => {
  const parsed = creditVerifyConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const database = getDb();
  const { phone, purpose, code, saIdDocument } = parsed.data;
  const customerId = parsed.data.customerId;
  const saIdHash = hashSaIdForStorage(saIdDocument);

  if (purpose === 'purchase') {
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is required for purchase verification' });
    }
    const customer = loadCustomerForMerchant(database, merchantId, customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    if (customer.sa_id_hash && !idsMatchHash(customer.sa_id_hash, saIdDocument)) {
      return res.status(400).json({
        error: 'ID number does not match the customer on file. Customer must present their ID book.',
      });
    }
  }

  const otpRow = database
    .prepare(
      `SELECT * FROM credit_otp_codes
        WHERE merchant_id = ? AND phone = ? AND purpose = ?
          AND used_at IS NULL AND expires_at > ?
          AND (? IS NULL OR customer_id = ?)
        ORDER BY created_at DESC
        LIMIT 1`,
    )
    .get(
      merchantId,
      phone,
      purpose,
      new Date().toISOString(),
      customerId ?? null,
      customerId ?? null,
    ) as OtpRow | undefined;

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
  database
    .prepare(
      `UPDATE credit_otp_codes
          SET used_at = ?,
              sa_id_hash = ?,
              verification_token = ?,
              verification_expires_at = ?
        WHERE id = ?`,
    )
    .run(
      nowIso,
      saIdHash,
      verificationToken,
      new Date(now + CREDIT_VERIFY_TOKEN_TTL_MS).toISOString(),
      otpRow.id,
    );

  return res.json({
    ok: true,
    verificationToken,
    expiresInSec: Math.floor(CREDIT_VERIFY_TOKEN_TTL_MS / 1000),
  });
});

creditRouter.get('/credit/customers', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const q = typeof req.query.merchantId === 'string' ? req.query.merchantId : '';
  if (q && q !== merchantId) {
    return res.status(403).json({ error: 'Cannot read another merchant customers' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      'SELECT * FROM credit_customers WHERE merchant_id = ? ORDER BY name COLLATE NOCASE',
    )
    .all(merchantId) as CustomerRow[];
  return res.json({ customers: rows.map(toCreditCustomer) });
});

creditRouter.get('/credit/transactions', requireAuth, (req, res) => {
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT ct.* FROM credit_transactions ct
       INNER JOIN credit_customers cc ON cc.id = ct.customer_id
       WHERE cc.merchant_id = ?
       ORDER BY datetime(ct.created_at) DESC
       LIMIT 500`,
    )
    .all(merchantId) as {
    id: string;
    customer_id: string;
    type: string;
    amount: number;
    description: string;
    created_at: string;
  }[];
  return res.json({ transactions: rows.map(toCreditTransaction) });
});

creditRouter.post('/credit/customers', requireAuth, (req, res) => {
  const parsed = creditCustomerCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const database = getDb();
  const c = parsed.data;
  const tokenRow = consumeVerificationToken(
    database,
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
  database
    .prepare(
      `INSERT INTO credit_customers (
        id, merchant_id, name, phone, total_owed, credit_limit, created_at, sa_id_hash, id_verified_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    )
    .run(id, merchantId, c.name, c.phone, c.creditLimit, now, saIdHash, now);
  const row = database.prepare('SELECT * FROM credit_customers WHERE id = ?').get(id) as CustomerRow;
  return res.status(201).json({ customer: toCreditCustomer(row) });
});

creditRouter.post('/credit/transactions', requireAuth, (req, res) => {
  const parsed = creditTxnSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  let merchantId: string;
  try {
    merchantId = requireMerchantId(req.auth!.userId);
  } catch {
    return res.status(403).json({ error: 'Merchant profile required' });
  }

  const { customerId, type, amount, description } = parsed.data;
  const database = getDb();
  const customer = database
    .prepare('SELECT * FROM credit_customers WHERE id = ?')
    .get(customerId) as CustomerRow | undefined;
  if (!customer || customer.merchant_id !== merchantId) {
    return res.status(404).json({ error: 'Customer not found' });
  }

  let verifiedSaIdHash: string | null = customer.sa_id_hash;
  if (type === 'purchase') {
    const tokenRow = consumeVerificationToken(
      database,
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
  let nextTotal = customer.total_owed;
  if (type === 'purchase') {
    nextTotal += amount;
    if (nextTotal > customer.credit_limit) {
      return res.status(400).json({ error: 'Would exceed credit limit' });
    }
  } else {
    nextTotal = Math.max(0, customer.total_owed - amount);
  }

  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO credit_transactions (id, customer_id, type, amount, description, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, customerId, type, amount, description, now);
    if (type === 'payment') {
      database
        .prepare(
          `UPDATE credit_customers SET total_owed = ?, last_payment_date = ? WHERE id = ?`,
        )
        .run(nextTotal, now, customerId);
    } else {
      database
        .prepare(
          `UPDATE credit_customers
              SET total_owed = ?,
                  sa_id_hash = COALESCE(sa_id_hash, ?),
                  id_verified_at = COALESCE(id_verified_at, ?)
            WHERE id = ?`,
        )
        .run(nextTotal, verifiedSaIdHash, now, customerId);
    }
  })();

  const updated = database
    .prepare('SELECT * FROM credit_customers WHERE id = ?')
    .get(customerId) as CustomerRow;
  const txnRow = database.prepare('SELECT * FROM credit_transactions WHERE id = ?').get(id) as {
    id: string;
    customer_id: string;
    type: string;
    amount: number;
    description: string;
    created_at: string;
  };

  return res.status(201).json({
    transaction: toCreditTransaction(txnRow),
    customer: toCreditCustomer(updated),
  });
});
