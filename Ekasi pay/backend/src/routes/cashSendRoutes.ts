import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import {
  cashSendIdsMatch,
  isSaCellphoneInput,
  normalizeCashSendId,
  parseCashSendVoucherReference,
  validateSaIdDigits,
} from '../cashSendKyc.js';
import { optionalSaIdBody, saIdBody } from '../cashSendSchemas.js';
import { getDb, getEscrowWalletIdForPool } from '../db.js';
import { toCashSendVoucher } from '../extraMappers.js';
import { idempotent } from '../middleware/idempotency.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { hashPin, verifyPin } from '../password.js';
import {
  recordCommissionPosting,
  reverseCommissionPostings,
} from '../services/commissions.js';
import { createComplianceFlag } from '../services/compliance.js';
import { notifySenderCashSendVoucher } from '../services/cashSendSms.js';
import { postBetweenWallets } from '../services/walletPosting.js';
import { cashSendVoucherPin } from '../validation.js';
import {
  clearCollectPinFailures,
  ensureCollectNotLocked,
  recordCollectPinFailure,
} from '../security/collectPinAttempts.js';

type CashSendVoucherDbRow = {
  id: string;
  reference_number: string;
  sender_user_id: string;
  status: string;
  expires_at: string;
  amount: number;
  fee: number;
  pin_hash: string;
  recipient_phone: string;
  recipient_id_document?: string;
  sender_id_document?: string;
};

/** Sender share of every cash-send fee. Tweak as commission policy changes. */
const COMMISSION_FEE_SHARE = 0.5;

export const cashSendRouter = Router();

const FEE = 10;
const DAYS_VALID = 14;

cashSendRouter.get('/cash-send/me', requireAuth, (req, res) => {
  const database = getDb();
  const rows = database
    .prepare(
      `SELECT * FROM cash_send_vouchers WHERE sender_user_id = ? ORDER BY datetime(created_at) DESC LIMIT 50`
    )
    .all(req.auth!.userId) as {
    id: string;
    sender_user_id: string;
    sender_phone: string;
    sender_name: string | null;
    recipient_phone: string;
    recipient_name: string | null;
    amount: number;
    fee: number;
    pin_hash: string;
    reference_number: string;
    status: string;
    created_at: string;
    expires_at: string;
    collected_at: string | null;
    cancel_reason: string | null;
  }[];
  return res.json({ vouchers: rows.map((r) => toCashSendVoucher(r)) });
});

function findVoucherByReference(
  database: ReturnType<typeof getDb>,
  rawReference: string,
) {
  const ref = parseCashSendVoucherReference(rawReference);
  if (!ref) return undefined;
  return database
    .prepare('SELECT * FROM cash_send_vouchers WHERE reference_number = ?')
    .get(ref) as CashSendVoucherDbRow | undefined;
}

const COLLECT_REFERENCE_MSG =
  'Cash can only be collected with the voucher number (starts with CS…) and 4-digit PIN from the sender.';

cashSendRouter.get('/cash-send/lookup', requireAuth, (req, res) => {
  const rawRef = String(req.query.reference ?? '').trim();
  const pin = String(req.query.pin ?? '').trim();

  if (!rawRef) {
    return res.status(400).json({ error: 'Enter the voucher number.' });
  }
  if (!/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'Enter the 4-digit voucher PIN.' });
  }
  const ref = parseCashSendVoucherReference(rawRef);
  if (!ref) {
    return res.status(400).json({
      error: isSaCellphoneInput(rawRef) ?
        'Use the voucher number (CS…) from the sender — not a cellphone number.'
      : COLLECT_REFERENCE_MSG,
    });
  }

  const row = findVoucherByReference(getDb(), ref);
  if (!row) {
    return res.status(404).json({
      error:
        'Voucher not found — ask the beneficiary for the unique CS… reference they received from the sender.',
    });
  }
  if (!verifyPin(pin, row.pin_hash)) {
    return res.status(401).json({ error: 'Incorrect PIN for this voucher.' });
  }
  return res.json({
    referenceNumber: row.reference_number,
    status: row.status,
    amount: row.amount,
    recipientPhone: row.recipient_phone,
    expiresAt: row.expires_at,
  });
});

const phoneDigits = z
  .string()
  .min(9)
  .max(20)
  .transform((v) => v.replace(/\s+/g, ''));

const nameField = z
  .string()
  .min(1)
  .max(120)
  .transform((s) => s.trim());

const addressField = z
  .string()
  .min(3)
  .max(500)
  .transform((s) => s.trim());

const createBody = z.object({
  senderFirstName: nameField,
  senderLastName: nameField,
  senderIdDocument: saIdBody,
  senderPhone: phoneDigits,
  senderAddress: addressField,
  recipientFirstName: nameField,
  recipientLastName: nameField,
  recipientPhone: phoneDigits,
  recipientIdDocument: optionalSaIdBody,
  amount: z.coerce.number().positive(),
  atmPin: cashSendVoucherPin,
});

function digitsOnlyPhoneSame(a: string, b: string): boolean {
  return a.replace(/\D/g, '') === b.replace(/\D/g, '');
}

cashSendRouter.post(
  '/cash-send',
  requireAuth,
  idempotent('POST /cash-send'),
  async (req, res) => {
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (
    digitsOnlyPhoneSame(parsed.data.recipientPhone, parsed.data.senderPhone)
  ) {
    return res
      .status(400)
      .json({ error: 'Beneficiary cellphone must differ from the sender’s.' });
  }
  const database = getDb();
  const userId = req.auth!.userId;
  const phone = parsed.data.senderPhone;
  const wallet = database
    .prepare(
      `SELECT * FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(userId) as
    | { id: string; balance: number; status: string; pool_id?: string }
    | undefined;
  if (!wallet || wallet.status !== 'active') {
    return res.status(400).json({ error: 'Wallet unavailable' });
  }
  const total = parsed.data.amount + FEE;
  const poolId = wallet.pool_id ?? DEFAULT_POOL_ID;
  const escrowId = getEscrowWalletIdForPool(database, poolId);
  if (!escrowId) {
    return res.status(503).json({ error: 'Regional escrow float is not available' });
  }
  if (wallet.balance < total) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }
  const id = randomUUID();
  const pinHash = hashPin(parsed.data.atmPin);
  const ref = `CS${Date.now()}${Math.floor(100 + Math.random() * 900)}`;
  const now = new Date();
  const expires = new Date(now.getTime() + DAYS_VALID * 86400000).toISOString();
  const nowIso = now.toISOString();
  database.transaction(() => {
    postBetweenWallets(database, {
      fromWalletId: wallet.id,
      toWalletId: escrowId,
      amount: total,
      type: 'cash_send_hold',
      referencePrefix: 'CSH',
      description:
        `Cash Send hold (${ref}) — principal ${parsed.data.amount} ZAR + fee ${FEE} → escrow pool ${poolId}`,
    });
    const senderDisplay = `${parsed.data.senderFirstName} ${parsed.data.senderLastName}`.trim();
    const recipientDisplay =
      `${parsed.data.recipientFirstName} ${parsed.data.recipientLastName}`.trim();
    database
      .prepare(
        `INSERT INTO cash_send_vouchers (
          id, sender_user_id, sender_phone, sender_name,
          sender_first_name, sender_last_name, sender_id_document, sender_address,
          recipient_phone, recipient_name,
          recipient_first_name, recipient_last_name, recipient_id_document,
          amount, fee, pin_hash, reference_number, status, created_at, expires_at,
          collector_scanned_id, collected_with_id_verified
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?, 'active', ?, ?,
          NULL, 0
        )`
      )
      .run(
        id,
        userId,
        phone,
        senderDisplay,
        parsed.data.senderFirstName,
        parsed.data.senderLastName,
        parsed.data.senderIdDocument,
        parsed.data.senderAddress,
        parsed.data.recipientPhone,
        recipientDisplay || null,
        parsed.data.recipientFirstName,
        parsed.data.recipientLastName,
        parsed.data.recipientIdDocument,
        parsed.data.amount,
        FEE,
        pinHash,
        ref,
        nowIso,
        expires
      );
    recordCommissionPosting(database, {
      agentUserId: userId,
      sourceType: 'cash_send',
      sourceId: id,
      amount: Number((FEE * COMMISSION_FEE_SHARE).toFixed(2)),
      description: `Cash Send fee share for voucher ${ref}`,
    });
    if (parsed.data.amount >= 3000) {
      createComplianceFlag(database, {
        userId,
        severity: parsed.data.amount >= 7000 ? 'high' : 'medium',
        reason: `Large Cash Send created (R${parsed.data.amount.toFixed(2)})`,
      });
    }
  })();
  const row = database.prepare('SELECT * FROM cash_send_vouchers WHERE id = ?').get(id) as {
    id: string;
    sender_phone: string;
    sender_name: string | null;
    recipient_phone: string;
    recipient_name: string | null;
    amount: number;
    fee: number;
    reference_number: string;
    status: string;
    created_at: string;
    expires_at: string;
    collected_at: string | null;
    cancel_reason: string | null;
  };
  const merchant = database
    .prepare('SELECT business_name, location FROM merchants WHERE user_id = ?')
    .get(userId) as { business_name: string; location: string } | undefined;
  const beneficiaryName =
    `${parsed.data.recipientFirstName} ${parsed.data.recipientLastName}`.trim();
  const smsSent = await notifySenderCashSendVoucher({
    senderPhone: phone,
    amount: parsed.data.amount,
    beneficiaryName,
    referenceNumber: ref,
    pin: parsed.data.atmPin,
    expiresAt: expires,
    shopName: merchant?.business_name,
    shopLocation: merchant?.location,
  });
  return res.status(201).json({
    voucher: toCashSendVoucher(row, parsed.data.atmPin),
    smsSent,
  });
  },
);

const collectBody = z.object({
  referenceNumber: z
    .string()
    .min(1)
    .transform((v) => parseCashSendVoucherReference(v))
    .refine((v): v is string => v !== null, {
      message: COLLECT_REFERENCE_MSG,
    }),
  pin: cashSendVoucherPin,
  scannedIdDocument: z.string().min(1),
});

cashSendRouter.post(
  '/cash-send/collect',
  requireAuth,
  idempotent('POST /cash-send/collect'),
  (req, res) => {
  const parsed = collectBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const database = getDb();
  const row = findVoucherByReference(database, parsed.data.referenceNumber);
  if (!row) {
    return res.status(404).json({
      error:
        'Voucher not found — ask the beneficiary for the unique CS… reference they received from the sender.',
    });
  }
  const voucherRef = row.reference_number;

  if (row.status !== 'active') {
    return res.status(400).json({ error: 'Voucher is not active' });
  }

  /** Resolve sender wallet + escrow used when this voucher was created. */
  const senderWalletRow = database
    .prepare(
      `SELECT * FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(row.sender_user_id) as
    | { id: string; balance: number; status: string; pool_id?: string }
    | undefined;

  if (Date.now() > new Date(row.expires_at).getTime()) {
    if (!senderWalletRow) {
      database
        .prepare('UPDATE cash_send_vouchers SET status = ?, cancel_reason = ? WHERE id = ?')
        .run(
          'expired',
          'Expired — sender wallet missing; escalate support',
          row.id
        );
      return res.status(400).json({ error: 'Voucher expired' });
    }
    const poolId = senderWalletRow.pool_id ?? DEFAULT_POOL_ID;
    const escrowId = getEscrowWalletIdForPool(database, poolId);
    const refundTotal = row.amount + row.fee;
    if (!escrowId) {
      return res.status(503).json({ error: 'Regional escrow float is not available' });
    }
    try {
      database.transaction(() => {
        postBetweenWallets(database, {
          fromWalletId: escrowId,
          toWalletId: senderWalletRow.id,
          amount: refundTotal,
          type: 'cash_send_expire_refund',
          referencePrefix: 'CSE',
          description: `Cash Send expired (${row.reference_number}) — refund principal + fee from escrow (${poolId})`,
        });
        database
          .prepare(
            `UPDATE cash_send_vouchers SET status = ?, cancel_reason = ? WHERE id = ?`
          )
          .run('expired', 'Expired — refunded to sender from escrow', row.id);
        reverseCommissionPostings(database, 'cash_send', row.id);
      })();
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string };
      const msg = err.message ?? 'Could not settle expired voucher';
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: msg,
      });
    }
    return res.status(400).json({
      error: 'Voucher expired — funds were returned to the sender.',
    });
  }

  if (!senderWalletRow) {
    return res.status(400).json({ error: 'Sender wallet not found for this voucher' });
  }

  try {
    ensureCollectNotLocked(database, voucherRef);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return res.status(err.status ?? 423).json({
      error: err.message ?? 'Too many wrong PINs for this voucher.',
    });
  }

  if (!verifyPin(parsed.data.pin, row.pin_hash)) {
    recordCollectPinFailure(database, voucherRef);
    return res.status(401).json({ error: 'Incorrect PIN' });
  }

  clearCollectPinFailures(database, voucherRef);

  const storedRecipientId = normalizeCashSendId(row.recipient_id_document ?? '');
  const storedSenderId = normalizeCashSendId(row.sender_id_document ?? '');
  const scannedNorm = normalizeCashSendId(parsed.data.scannedIdDocument);
  if (!validateSaIdDigits(scannedNorm)) {
    return res.status(400).json({
      error:
        'Capture the beneficiary’s SA ID number in full (13 digits — use the barcode scanner pointed at their ID, or enter the number carefully).',
    });
  }
  if (
    storedSenderId.length >= 13 &&
    cashSendIdsMatch(storedSenderId, scannedNorm)
  ) {
    return res.status(400).json({
      error:
        'The sender cannot collect this cash. The beneficiary must present their own SA ID.',
    });
  }
  if (
    storedRecipientId.length >= 13 &&
    !cashSendIdsMatch(storedRecipientId, scannedNorm)
  ) {
    return res.status(400).json({
      error:
        'The ID scanned does not match the beneficiary on file for this voucher. Confirm the beneficiary and try again.',
    });
  }

  const collectorWallet = database
    .prepare(
      `SELECT * FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(req.auth!.userId) as
    | { id: string; status: string; pool_id?: string }
    | undefined;
  if (!collectorWallet || collectorWallet.status !== 'active') {
    return res.status(400).json({ error: 'Collector wallet unavailable' });
  }
  const poolId = senderWalletRow.pool_id ?? DEFAULT_POOL_ID;
  if (
    (collectorWallet.pool_id ?? DEFAULT_POOL_ID) !== poolId
  ) {
    return res.status(400).json({
      error: 'Cash Send can only be collected in the same region (wallet pool) as the sender.',
    });
  }
  const escrowId = getEscrowWalletIdForPool(database, poolId);
  if (!escrowId) {
    return res.status(503).json({ error: 'Regional escrow float is not available' });
  }
  const nowIso = new Date().toISOString();
  try {
    database.transaction(() => {
      postBetweenWallets(database, {
        fromWalletId: escrowId,
        toWalletId: collectorWallet.id,
        amount: row.amount,
        type: 'cash_send_collect',
        referencePrefix: 'CSC',
        description:
          `Cash Send payout (${row.reference_number}) principal ${row.amount} from escrow (${poolId}); fee ${row.fee} retained in escrow`,
      });
      const verified = 1;
      database
        .prepare(
          `UPDATE cash_send_vouchers SET status = 'collected', collected_at = ?,
           collector_scanned_id = ?, collected_with_id_verified = ?,
           recipient_id_document = CASE
             WHEN COALESCE(recipient_id_document, '') = '' THEN ?
             ELSE recipient_id_document
           END
           WHERE id = ?`
        )
        .run(nowIso, scannedNorm, verified, scannedNorm, row.id);
    })();
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return res.status(typeof err.status === 'number' ? err.status : 500).json({
      error: err.message ?? 'Collection failed',
    });
  }
  const updated = database
    .prepare('SELECT * FROM cash_send_vouchers WHERE id = ?')
    .get(row.id) as {
    sender_phone: string;
    sender_name: string | null;
    recipient_phone: string;
    recipient_name: string | null;
    amount: number;
    fee: number;
    reference_number: string;
    status: string;
    created_at: string;
    expires_at: string;
    collected_at: string | null;
    cancel_reason: string | null;
    id: string;
  };
  return res.json({ voucher: toCashSendVoucher(updated) });
  },
);

cashSendRouter.post('/cash-send/:id/cancel', requireAuth, (req, res) => {
  const database = getDb();
  const voucher = database
    .prepare('SELECT * FROM cash_send_vouchers WHERE id = ?')
    .get(req.params.id) as
    | {
        id: string;
        sender_user_id: string;
        amount: number;
        fee: number;
        status: string;
      }
    | undefined;
  if (!voucher || voucher.sender_user_id !== req.auth!.userId) {
    return res.status(404).json({ error: 'Voucher not found' });
  }
  if (voucher.status !== 'active') {
    return res.status(400).json({ error: 'Cannot cancel' });
  }
  const senderWalletFull = database
    .prepare(
      `SELECT * FROM wallets WHERE user_id = ? AND COALESCE(wallet_kind, 'user') = 'user'`
    )
    .get(req.auth!.userId) as
    | { id: string; pool_id?: string }
    | undefined;
  if (!senderWalletFull) {
    return res.status(400).json({ error: 'Wallet missing' });
  }

  const poolId = senderWalletFull.pool_id ?? DEFAULT_POOL_ID;
  const escrowId = getEscrowWalletIdForPool(database, poolId);
  if (!escrowId) {
    return res.status(503).json({ error: 'Regional escrow float is not available' });
  }

  const refund = voucher.amount + voucher.fee;

  try {
    database.transaction(() => {
      postBetweenWallets(database, {
        fromWalletId: escrowId,
        toWalletId: senderWalletFull.id,
        amount: refund,
        type: 'cash_send_cancel_refund',
        referencePrefix: 'CSX',
        description:
          `Cash Send cancelled (${voucher.id}) — refund principal + fee from escrow (${poolId})`,
      });
      database
        .prepare(
          `UPDATE cash_send_vouchers SET status = 'cancelled', cancel_reason = ? WHERE id = ?`
        )
        .run('Cancelled by sender — refunded from escrow', voucher.id);
      reverseCommissionPostings(database, 'cash_send', voucher.id);
    })();
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return res.status(typeof err.status === 'number' ? err.status : 500).json({
      error: err.message ?? 'Cancel failed',
    });
  }

  return res.json({ ok: true });
});
