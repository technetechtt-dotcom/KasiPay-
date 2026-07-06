import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import {
  cashSendIdsMatch,
  normalizeCashSendId,
  validateSaIdDigits,
} from '../cashSendKyc.js';
import { getPgPool } from '../dbPg.js';
import { toCashSendVoucher } from '../extraMappers.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { hashPin, verifyPin } from '../password.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import {
  recordCommissionPostingPg,
  reverseCommissionPostingsPg,
} from '../services/commissionsPg.js';
import { createComplianceFlagPg } from '../services/compliancePg.js';
import { getEscrowWalletIdForPoolPg } from '../services/escrowPg.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';
import { strongMoneyPin } from '../validation.js';

const COMMISSION_FEE_SHARE = 0.5;

export const cashSendRouterPg = Router();

const FEE = 10;
const DAYS_VALID = 14;

type VoucherRow = {
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
  recipient_id_document?: string;
};

cashSendRouterPg.get('/cash-send/me', requireAuth, async (req, res) => {
  const pool = getPgPool();
  const r = await pool.query<VoucherRow>(
    `SELECT * FROM cash_send_vouchers
     WHERE sender_user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.auth!.userId],
  );
  return res.json({ vouchers: r.rows.map((row) => toCashSendVoucher(row)) });
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

const saIdBody = z
  .string()
  .min(1)
  .transform((v) => normalizeCashSendId(v))
  .refine((v) => validateSaIdDigits(v), 'SA identity number must be 13 digits');

const createBody = z.object({
  senderFirstName: nameField,
  senderLastName: nameField,
  senderIdDocument: saIdBody,
  senderPhone: phoneDigits,
  senderAddress: addressField,
  recipientFirstName: nameField,
  recipientLastName: nameField,
  recipientPhone: phoneDigits,
  recipientIdDocument: saIdBody,
  amount: z.coerce.number().positive(),
  atmPin: strongMoneyPin,
});

function digitsOnlyPhoneSame(a: string, b: string): boolean {
  return a.replace(/\D/g, '') === b.replace(/\D/g, '');
}

cashSendRouterPg.post(
  '/cash-send',
  requireAuth,
  idempotentPg('POST /cash-send'),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    if (!digitsOnlyPhoneSame(parsed.data.senderPhone, req.auth!.phone)) {
      return res.status(400).json({
        error: 'Sender cell number must match the logged-in shop account.',
      });
    }
    const pool = getPgPool();
    const userId = req.auth!.userId;
    const phone = parsed.data.senderPhone;
    const walletQ = await pool.query<{
      id: string;
      balance: number;
      status: string;
      pool_id: string | null;
    }>(
      `SELECT * FROM wallets
       WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
      [userId],
    );
    const wallet = walletQ.rows[0];
    if (!wallet || wallet.status !== 'active') {
      return res.status(400).json({ error: 'Wallet unavailable' });
    }
    const total = parsed.data.amount + FEE;
    const poolId = wallet.pool_id ?? DEFAULT_POOL_ID;
    const escrowId = await getEscrowWalletIdForPoolPg(pool, poolId);
    if (!escrowId) {
      return res
        .status(503)
        .json({ error: 'Regional escrow float is not available' });
    }
    if (wallet.balance < total) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }
    const id = randomUUID();
    const pinHash = hashPin(parsed.data.atmPin);
    const ref = `CS${Date.now()}${Math.floor(100 + Math.random() * 900)}`;
    const now = new Date();
    const expires = new Date(
      now.getTime() + DAYS_VALID * 86400000,
    ).toISOString();
    const nowIso = now.toISOString();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await postBetweenWalletsPg(client, {
        fromWalletId: wallet.id,
        toWalletId: escrowId,
        amount: total,
        type: 'cash_send_hold',
        referencePrefix: 'CSH',
        description: `Cash Send hold (${ref}) — principal ${parsed.data.amount} ZAR + fee ${FEE} → escrow pool ${poolId}`,
      });
      const senderDisplay =
        `${parsed.data.senderFirstName} ${parsed.data.senderLastName}`.trim();
      const recipientDisplay =
        `${parsed.data.recipientFirstName} ${parsed.data.recipientLastName}`.trim();
      await client.query(
        `INSERT INTO cash_send_vouchers (
          id, sender_user_id, sender_phone, sender_name,
          sender_first_name, sender_last_name, sender_id_document, sender_address,
          recipient_phone, recipient_name,
          recipient_first_name, recipient_last_name, recipient_id_document,
          amount, fee, pin_hash, reference_number, status, created_at, expires_at,
          collector_scanned_id, collected_with_id_verified
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10,
          $11, $12, $13,
          $14, $15, $16, $17, 'active', $18, $19,
          NULL, 0
        )`,
        [
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
          expires,
        ],
      );
      await recordCommissionPostingPg(client, {
        agentUserId: userId,
        sourceType: 'cash_send',
        sourceId: id,
        amount: Number((FEE * COMMISSION_FEE_SHARE).toFixed(2)),
        description: `Cash Send fee share for voucher ${ref}`,
      });
      if (parsed.data.amount >= 3000) {
        await createComplianceFlagPg(client, {
          userId,
          severity: parsed.data.amount >= 7000 ? 'high' : 'medium',
          reason: `Large Cash Send created (R${parsed.data.amount.toFixed(2)})`,
        });
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Cash Send failed',
      });
    } finally {
      client.release();
    }
    const rowQ = await pool.query<VoucherRow>(
      `SELECT * FROM cash_send_vouchers WHERE id = $1`,
      [id],
    );
    const row = rowQ.rows[0];
    return res.status(201).json({
      voucher: toCashSendVoucher(row, parsed.data.atmPin),
    });
  },
);

const collectBody = z.object({
  referenceNumber: z.string().min(1),
  pin: z.string().min(4).max(8),
  scannedIdDocument: z.string().min(1),
});

cashSendRouterPg.post(
  '/cash-send/collect',
  requireAuth,
  idempotentPg('POST /cash-send/collect'),
  async (req, res) => {
    const parsed = collectBody.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }
    const pool = getPgPool();
    const rowQ = await pool.query<VoucherRow>(
      `SELECT * FROM cash_send_vouchers WHERE reference_number = $1`,
      [parsed.data.referenceNumber],
    );
    const row = rowQ.rows[0];
    if (!row) {
      return res.status(404).json({ error: 'Voucher not found' });
    }
    if (row.status !== 'active') {
      return res.status(400).json({ error: 'Voucher is not active' });
    }

    const senderWalletQ = await pool.query<{
      id: string;
      balance: number;
      status: string;
      pool_id: string | null;
    }>(
      `SELECT * FROM wallets
       WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
      [row.sender_user_id],
    );
    const senderWalletRow = senderWalletQ.rows[0];

    if (Date.now() > new Date(row.expires_at).getTime()) {
      if (!senderWalletRow) {
        await pool.query(
          `UPDATE cash_send_vouchers SET status = $1, cancel_reason = $2 WHERE id = $3`,
          [
            'expired',
            'Expired — sender wallet missing; escalate support',
            row.id,
          ],
        );
        return res.status(400).json({ error: 'Voucher expired' });
      }
      const poolId = senderWalletRow.pool_id ?? DEFAULT_POOL_ID;
      const escrowId = await getEscrowWalletIdForPoolPg(pool, poolId);
      const refundTotal = row.amount + row.fee;
      if (!escrowId) {
        return res
          .status(503)
          .json({ error: 'Regional escrow float is not available' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await postBetweenWalletsPg(client, {
          fromWalletId: escrowId,
          toWalletId: senderWalletRow.id,
          amount: refundTotal,
          type: 'cash_send_expire_refund',
          referencePrefix: 'CSE',
          description: `Cash Send expired (${row.reference_number}) — refund principal + fee from escrow (${poolId})`,
        });
        await client.query(
          `UPDATE cash_send_vouchers SET status = $1, cancel_reason = $2 WHERE id = $3`,
          ['expired', 'Expired — refunded to sender from escrow', row.id],
        );
        await reverseCommissionPostingsPg(client, 'cash_send', row.id);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        const err = e as { status?: number; message?: string };
        const msg = err.message ?? 'Could not settle expired voucher';
        return res.status(typeof err.status === 'number' ? err.status : 500).json({
          error: msg,
        });
      } finally {
        client.release();
      }
      return res.status(400).json({
        error: 'Voucher expired — funds were returned to the sender.',
      });
    }

    if (!senderWalletRow) {
      return res
        .status(400)
        .json({ error: 'Sender wallet not found for this voucher' });
    }

    if (!verifyPin(parsed.data.pin, row.pin_hash)) {
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    const storedRecipientId = normalizeCashSendId(
      row.recipient_id_document ?? '',
    );
    const scannedNorm = normalizeCashSendId(parsed.data.scannedIdDocument);
    if (!validateSaIdDigits(scannedNorm)) {
      return res.status(400).json({
        error:
          'Capture the beneficiary’s SA ID number in full (13 digits — use the barcode scanner pointed at their ID, or enter the number carefully).',
      });
    }
    if (
      storedRecipientId.length >= 13 &&
      !cashSendIdsMatch(storedRecipientId, scannedNorm)
    ) {
      return res.status(400).json({
        error:
          'The ID you scanned does not match the beneficiary on file for this voucher. Confirm the beneficiary and try again.',
      });
    }

    const collectorWalletQ = await pool.query<{
      id: string;
      status: string;
      pool_id: string | null;
    }>(
      `SELECT * FROM wallets
       WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
      [req.auth!.userId],
    );
    const collectorWallet = collectorWalletQ.rows[0];
    if (!collectorWallet || collectorWallet.status !== 'active') {
      return res.status(400).json({ error: 'Collector wallet unavailable' });
    }
    const poolId = senderWalletRow.pool_id ?? DEFAULT_POOL_ID;
    if ((collectorWallet.pool_id ?? DEFAULT_POOL_ID) !== poolId) {
      return res.status(400).json({
        error:
          'Cash Send can only be collected in the same region (wallet pool) as the sender.',
      });
    }
    const escrowId = await getEscrowWalletIdForPoolPg(pool, poolId);
    if (!escrowId) {
      return res
        .status(503)
        .json({ error: 'Regional escrow float is not available' });
    }
    const nowIso = new Date().toISOString();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await postBetweenWalletsPg(client, {
        fromWalletId: escrowId,
        toWalletId: collectorWallet.id,
        amount: row.amount,
        type: 'cash_send_collect',
        referencePrefix: 'CSC',
        description: `Cash Send payout (${row.reference_number}) principal ${row.amount} from escrow (${poolId}); fee ${row.fee} retained in escrow`,
      });
      const verified = storedRecipientId.length >= 13 ? 1 : 0;
      await client.query(
        `UPDATE cash_send_vouchers
            SET status = 'collected', collected_at = $1,
                collector_scanned_id = $2, collected_with_id_verified = $3
          WHERE id = $4`,
        [nowIso, scannedNorm, verified, row.id],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Collection failed',
      });
    } finally {
      client.release();
    }
    const updatedQ = await pool.query<VoucherRow>(
      `SELECT * FROM cash_send_vouchers WHERE id = $1`,
      [row.id],
    );
    return res.json({ voucher: toCashSendVoucher(updatedQ.rows[0]) });
  },
);

cashSendRouterPg.post(
  '/cash-send/:id/cancel',
  requireAuth,
  async (req, res) => {
    const pool = getPgPool();
    const voucherQ = await pool.query<{
      id: string;
      sender_user_id: string;
      amount: number;
      fee: number;
      status: string;
    }>(`SELECT * FROM cash_send_vouchers WHERE id = $1`, [req.params.id]);
    const voucher = voucherQ.rows[0];
    if (!voucher || voucher.sender_user_id !== req.auth!.userId) {
      return res.status(404).json({ error: 'Voucher not found' });
    }
    if (voucher.status !== 'active') {
      return res.status(400).json({ error: 'Cannot cancel' });
    }
    const senderWalletQ = await pool.query<{
      id: string;
      pool_id: string | null;
    }>(
      `SELECT * FROM wallets
       WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
      [req.auth!.userId],
    );
    const senderWalletFull = senderWalletQ.rows[0];
    if (!senderWalletFull) {
      return res.status(400).json({ error: 'Wallet missing' });
    }

    const poolId = senderWalletFull.pool_id ?? DEFAULT_POOL_ID;
    const escrowId = await getEscrowWalletIdForPoolPg(pool, poolId);
    if (!escrowId) {
      return res
        .status(503)
        .json({ error: 'Regional escrow float is not available' });
    }

    const refund = voucher.amount + voucher.fee;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await postBetweenWalletsPg(client, {
        fromWalletId: escrowId,
        toWalletId: senderWalletFull.id,
        amount: refund,
        type: 'cash_send_cancel_refund',
        referencePrefix: 'CSX',
        description: `Cash Send cancelled (${voucher.id}) — refund principal + fee from escrow (${poolId})`,
      });
      await client.query(
        `UPDATE cash_send_vouchers SET status = 'cancelled', cancel_reason = $1 WHERE id = $2`,
        ['Cancelled by sender — refunded from escrow', voucher.id],
      );
      await reverseCommissionPostingsPg(client, 'cash_send', voucher.id);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      const err = e as { status?: number; message?: string };
      return res.status(typeof err.status === 'number' ? err.status : 500).json({
        error: err.message ?? 'Cancel failed',
      });
    } finally {
      client.release();
    }

    return res.json({ ok: true });
  },
);
