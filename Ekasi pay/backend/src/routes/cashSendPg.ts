import { createHash, randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import {
  isSaCellphoneInput,
  normalizeCashSendId,
  parseCashSendVoucherReference,
  validateSaIdDigits,
  generateCashSendReference,
} from '../cashSendKyc.js';
import { optionalSaIdBody, saIdBody } from '../cashSendSchemas.js';
import { getPgPool } from '../dbPg.js';
import { toCashSendVoucher } from '../extraMappers.js';
import { idempotentPg } from '../middleware/idempotencyPg.js';
import {
  encryptField,
  hashSensitiveIdentifier,
  hashesEqual,
} from '../security/fieldEncryption.js';
import { requireApprovedMerchant } from '../middleware/requireApprovedMerchant.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { hashPin, verifyPin } from '../password.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import {
  formatCents,
  parseIntegerCents,
  parseZarToCents,
  type Cents,
} from '../money.js';
import {
  recordCommissionPostingPg,
  reverseCommissionPostingsPg,
} from '../services/commissionsPg.js';
import { createComplianceFlagPg } from '../services/compliancePg.js';
import { notifySenderCashSendVoucher } from '../services/cashSendSms.js';
import { getEscrowWalletIdForPoolPg } from '../services/escrowPg.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';
import { evaluateTransactionRiskPg } from '../services/riskPg.js';
import {
  calculateFeeCents,
  postFeeAccrualPg,
  recordFeeAssessmentPg,
  reverseFeeAccrualPg,
  resolveFeeSchedulePg,
} from '../services/feeEnginePg.js';
import { cashSendVoucherPin } from '../validation.js';
import {
  clearCollectPinFailuresPg,
  ensureCollectNotLockedPg,
  recordCollectPinFailurePg,
} from '../security/collectPinAttemptsPg.js';

export const cashSendRouterPg = Router();

cashSendRouterPg.use(requireAuth, requireApprovedMerchant);

const DAYS_VALID = 14;

type VoucherRow = {
  id: string;
  sender_user_id: string;
  sender_phone: string;
  sender_name: string | null;
  recipient_phone: string;
  recipient_name: string | null;
  amount_cents: string;
  fee_cents: string;
  pin_hash: string;
  reference_number: string;
  status: string;
  created_at: string;
  expires_at: string;
  collected_at: string | null;
  cancel_reason: string | null;
  recipient_id_document?: string;
  sender_id_document?: string;
  recipient_id_document_encrypted?: string | null;
  sender_id_document_encrypted?: string | null;
  sender_id_hash?: string | null;
  recipient_id_hash?: string | null;
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

async function findVoucherByReferencePg(
  pool: ReturnType<typeof getPgPool>,
  rawReference: string,
): Promise<VoucherRow | undefined> {
  const ref = parseCashSendVoucherReference(rawReference);
  if (!ref) return undefined;
  const byRef = await pool.query<VoucherRow>(
    `SELECT * FROM cash_send_vouchers WHERE reference_number = $1`,
    [ref],
  );
  return byRef.rows[0];
}

const COLLECT_REFERENCE_MSG =
  'Cash can only be collected with the voucher number (starts with CS…) and 4-digit PIN from the sender.';

const lookupBody = z.object({
  reference: z.string().min(1),
  pin: cashSendVoucherPin,
});

cashSendRouterPg.post('/cash-send/lookup', requireAuth, async (req, res) => {
  const parsed = lookupBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const rawRef = parsed.data.reference.trim();
  const ref = parseCashSendVoucherReference(rawRef);
  if (!ref) {
    return res.status(400).json({
      error: isSaCellphoneInput(rawRef) ?
        'Use the voucher number (CS…) from the sender — not a cellphone number.'
      : COLLECT_REFERENCE_MSG,
    });
  }

  const pool = getPgPool();
  const row = await findVoucherByReferencePg(pool, ref);
  if (!row) {
    return res.status(404).json({
      error:
        'Voucher not found — ask the beneficiary for the unique CS… reference they received from the sender.',
    });
  }

  try {
    await ensureCollectNotLockedPg(pool, row.reference_number);
  } catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return res.status(err.status ?? 423).json({
      error: err.message ?? 'Too many wrong PINs for this voucher.',
    });
  }

  if (!verifyPin(parsed.data.pin, row.pin_hash)) {
    await recordCollectPinFailurePg(pool, row.reference_number);
    return res.status(401).json({ error: 'Incorrect PIN for this voucher.' });
  }

  await clearCollectPinFailuresPg(pool, row.reference_number);
  return res.json({
    referenceNumber: row.reference_number,
    status: row.status,
    amount: formatCents(parseIntegerCents(row.amount_cents)),
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
  amount: z.union([z.string(), z.number()]),
  atmPin: cashSendVoucherPin,
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
    let amountCents: Cents;
    try {
      amountCents = parseZarToCents(parsed.data.amount);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : 'Invalid amount',
      });
    }
    if (
      digitsOnlyPhoneSame(parsed.data.recipientPhone, parsed.data.senderPhone)
    ) {
      return res.status(400).json({
        error: 'Beneficiary cellphone must differ from the sender’s.',
      });
    }
    // Agent model: sender phone is the walk-in customer's number, not the shop login.
    if (digitsOnlyPhoneSame(parsed.data.senderPhone, req.auth!.phone)) {
      return res.status(400).json({
        error:
          'Enter the customer’s cellphone — not your shop account number. The voucher SMS is sent to the customer.',
      });
    }
    const pool = getPgPool();
    const userId = req.auth!.userId;
    const customerSenderPhone = parsed.data.senderPhone;
    const walletQ = await pool.query<{
      id: string;
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
    const feePolicy = await resolveFeeSchedulePg(pool, {
      product: 'cash_send',
      currency: 'ZAR',
      principalCents: amountCents,
    });
    const feeCalculation = calculateFeeCents(amountCents, feePolicy.tier);
    const feeCents = feeCalculation.totalFeeCents;
    const totalCents = (amountCents + feeCents) as Cents;
    const poolId = wallet.pool_id ?? DEFAULT_POOL_ID;
    const escrowId = await getEscrowWalletIdForPoolPg(pool, poolId);
    if (!escrowId) {
      return res
        .status(503)
        .json({ error: 'Regional escrow float is not available' });
    }
    const id = randomUUID();
    const pinHash = hashPin(parsed.data.atmPin);
    const ref = generateCashSendReference();
    const risk = await evaluateTransactionRiskPg(pool, {
      eventType: 'voucher',
      actorUserId: userId,
      amountCents: totalCents,
      financialReference: ref,
      deviceId: typeof req.headers['x-device-id'] === 'string' ? req.headers['x-device-id'] : undefined,
      ip: req.ip,
      counterparty: parsed.data.recipientPhone,
      requestId: req.requestId,
      correlationId: req.correlationId,
    });
    if (risk.decision === 'block') {
      return res.status(403).json({ error: 'Transaction declined by configured risk controls.', code: 'RISK_BLOCKED' });
    }
    if (risk.decision === 'hold') {
      return res.status(202).json({ status: 'held_for_review', referenceNumber: ref });
    }
    const now = new Date();
    const expires = new Date(
      now.getTime() + DAYS_VALID * 86400000,
    ).toISOString();
    const nowIso = now.toISOString();
    const beneficiaryBindingHash = createHash('sha256')
      .update(`${normalizeCashSendId(parsed.data.recipientIdDocument ?? '')}|${parsed.data.recipientPhone.replace(/\D/g, '')}`)
      .digest('hex');
    const senderIdNorm = normalizeCashSendId(parsed.data.senderIdDocument);
    const recipientIdNorm = normalizeCashSendId(
      parsed.data.recipientIdDocument ?? '',
    );
    const senderIdEncrypted = encryptField(senderIdNorm);
    const recipientIdEncrypted = recipientIdNorm
      ? encryptField(recipientIdNorm)
      : '';
    const senderAddressEncrypted = encryptField(parsed.data.senderAddress);
    const senderIdHash = hashSensitiveIdentifier(senderIdNorm);
    const recipientIdHash = recipientIdNorm
      ? hashSensitiveIdentifier(recipientIdNorm)
      : '';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const holdPosting = await postBetweenWalletsPg(client, {
        fromWalletId: wallet.id,
        toWalletId: escrowId,
        amountCents: totalCents,
        type: 'cash_send_hold',
        referencePrefix: 'CSH',
        description: `Cash Send hold (${ref}) — principal ${formatCents(amountCents)} ZAR + fee ${formatCents(feeCents)} → escrow pool ${poolId}`,
      });
      const senderDisplay =
        `${parsed.data.senderFirstName} ${parsed.data.senderLastName}`.trim();
      const recipientDisplay =
        `${parsed.data.recipientFirstName} ${parsed.data.recipientLastName}`.trim();
      await client.query(
        `INSERT INTO cash_send_vouchers (
          id, sender_user_id, sender_phone, sender_name,
          sender_first_name, sender_last_name,
          recipient_phone, recipient_name,
          recipient_first_name, recipient_last_name,
          amount_cents, fee_cents, pin_hash, reference_number, status, created_at, expires_at,
          collected_with_id_verified,
          beneficiary_binding_hash, hold_transaction_id,
          sender_id_hash, recipient_id_hash,
          sender_id_document_encrypted, recipient_id_document_encrypted,
          sender_address_encrypted
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6,
          $7, $8,
          $9, $10,
          $11, $12, $13, $14, 'active', $15, $16,
          0, $17, $18,
          $19, $20,
          $21, $22,
          $23
        )`,
        [
          id,
          userId,
          customerSenderPhone,
          senderDisplay,
          parsed.data.senderFirstName,
          parsed.data.senderLastName,
          parsed.data.recipientPhone,
          recipientDisplay || null,
          parsed.data.recipientFirstName,
          parsed.data.recipientLastName,
          amountCents.toString(),
          feeCents.toString(),
          pinHash,
          ref,
          nowIso,
          expires,
          beneficiaryBindingHash,
          holdPosting.transactionId,
          senderIdHash,
          recipientIdHash || null,
          senderIdEncrypted,
          recipientIdEncrypted || null,
          senderAddressEncrypted,
        ],
      );
      await client.query(
        `INSERT INTO cash_send_outbox
           (id, voucher_id, event_type, channel, destination_hash, template, safe_payload, request_id, correlation_id)
         VALUES
           ($1,$2,'voucher_created','sms',$3,'cash_send_reference',$4::jsonb,$5,$5),
           ($6,$2,'voucher_pin_created','sms',$3,'cash_send_pin_separate','{}'::jsonb,$5,$5)`,
        [
          randomUUID(),
          id,
          createHash('sha256').update(customerSenderPhone).digest('hex'),
          JSON.stringify({ referenceNumber: ref, expiresAt: expires }),
          req.requestId,
          randomUUID(),
        ],
      );
      const feeAccrual = await postFeeAccrualPg(client, {
        sourceWalletId: escrowId,
        sourceReference: ref,
        currency: 'ZAR',
        components: feeCalculation.components,
        actorId: userId,
      });
      const assessment = await recordFeeAssessmentPg(client, {
        scheduleId: feePolicy.scheduleId,
        tier: feePolicy.tier,
        sourceType: 'cash_send',
        sourceId: id,
        principalCents: amountCents,
        currency: 'ZAR',
        journalTransactionId: feeAccrual.transactionId,
        beneficiaries: { agent: userId },
      });
      const agentCommission = feeCalculation.components.agent;
      if (agentCommission > 0n) {
        await recordCommissionPostingPg(client, {
          agentUserId: userId,
          sourceType: 'cash_send',
          sourceId: id,
          amountCents: agentCommission,
          description: `Cash Send fee share for voucher ${ref}`,
          feeAssessmentId: assessment.assessmentId,
          journalTransactionId: feeAccrual.transactionId,
        });
      }
      if (amountCents >= 300_000n) {
        await createComplianceFlagPg(client, {
          userId,
          severity: amountCents >= 700_000n ? 'high' : 'medium',
          reason: `Large Cash Send created (R${formatCents(amountCents)})`,
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
    const merchantQ = await pool.query<{
      business_name: string;
      location: string;
    }>(`SELECT business_name, location FROM merchants WHERE user_id = $1`, [
      userId,
    ]);
    const merchant = merchantQ.rows[0];
    const beneficiaryName =
      `${parsed.data.recipientFirstName} ${parsed.data.recipientLastName}`.trim();
    const smsSent = await notifySenderCashSendVoucher({
      senderPhone: customerSenderPhone,
      amount: formatCents(amountCents),
      beneficiaryName,
      referenceNumber: ref,
      pin: parsed.data.atmPin,
      expiresAt: expires,
      shopName: merchant?.business_name,
      shopLocation: merchant?.location,
    });
    return res.status(201).json({
      voucher: toCashSendVoucher(row),
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
    const row = await findVoucherByReferencePg(
      pool,
      parsed.data.referenceNumber,
    );
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

    const senderWalletQ = await pool.query<{
      id: string;
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
      const refundTotalCents = (parseIntegerCents(row.amount_cents) +
        parseIntegerCents(row.fee_cents, { allowZero: true })) as Cents;
      if (!escrowId) {
        return res
          .status(503)
          .json({ error: 'Regional escrow float is not available' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lockedVoucher = await client.query<{ status: string }>(
          `SELECT status FROM cash_send_vouchers WHERE id = $1 FOR UPDATE`,
          [row.id],
        );
        if (lockedVoucher.rows[0]?.status !== 'active') {
          throw Object.assign(new Error('Voucher is no longer active'), { status: 409 });
        }
        await reverseFeeAccrualPg(client, { sourceType: 'cash_send', sourceId: row.id });
        const refundPosting = await postBetweenWalletsPg(client, {
          fromWalletId: escrowId,
          toWalletId: senderWalletRow.id,
          amountCents: refundTotalCents,
          type: 'cash_send_expire_refund',
          referencePrefix: 'CSE',
          description: `Cash Send expired (${row.reference_number}) — refund principal + fee from escrow (${poolId})`,
        });
        await client.query(
          `UPDATE cash_send_vouchers
              SET status = $1, cancel_reason = $2, refund_transaction_id = $4,
                  expiry_processed_at = clock_timestamp(), lifecycle_version = lifecycle_version + 1
            WHERE id = $3`,
          ['expired', 'Expired — refunded to sender from escrow', row.id, refundPosting.transactionId],
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

    try {
      await ensureCollectNotLockedPg(pool, voucherRef);
    } catch (e: unknown) {
      const err = e as { status?: number; message?: string };
      return res.status(err.status ?? 423).json({
        error: err.message ?? 'Too many wrong PINs for this voucher.',
      });
    }

    if (!verifyPin(parsed.data.pin, row.pin_hash)) {
      await recordCollectPinFailurePg(pool, voucherRef);
      return res.status(401).json({ error: 'Incorrect PIN' });
    }

    await clearCollectPinFailuresPg(pool, voucherRef);

    const storedRecipientHash = row.recipient_id_hash || '';
    const storedSenderHash = row.sender_id_hash || '';
    const scannedNorm = normalizeCashSendId(parsed.data.scannedIdDocument);
    if (!validateSaIdDigits(scannedNorm)) {
      return res.status(400).json({
        error:
          'Capture the beneficiary’s SA ID number in full (13 digits — use the barcode scanner pointed at their ID, or enter the number carefully).',
      });
    }
    const scannedHash = hashSensitiveIdentifier(scannedNorm);
    if (
      storedSenderHash &&
      hashesEqual(storedSenderHash, scannedHash)
    ) {
      return res.status(400).json({
        error:
          'The sender cannot collect this cash. The beneficiary must present their own SA ID.',
      });
    }
    if (
      storedRecipientHash &&
      !hashesEqual(storedRecipientHash, scannedHash)
    ) {
      return res.status(400).json({
        error:
          'The ID scanned does not match the beneficiary on file for this voucher. Confirm the beneficiary and try again.',
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
      const lockedVoucher = await client.query<{ status: string }>(
        `SELECT status FROM cash_send_vouchers WHERE id = $1 FOR UPDATE`,
        [row.id],
      );
      if (lockedVoucher.rows[0]?.status !== 'active') {
        throw Object.assign(new Error('Voucher is no longer active'), { status: 409 });
      }
      const principalPosting = await postBetweenWalletsPg(client, {
        fromWalletId: escrowId,
        toWalletId: collectorWallet.id,
        amountCents: parseIntegerCents(row.amount_cents),
        type: 'cash_send_collect',
        referencePrefix: 'CSC',
        description: `Cash Send payout (${row.reference_number}) principal ${formatCents(parseIntegerCents(row.amount_cents))} from escrow (${poolId}) to collector wallet`,
      });
      await client.query(
        `UPDATE cash_send_vouchers SET settlement_transaction_ids = $1::jsonb WHERE id = $2`,
        [JSON.stringify([principalPosting.transactionId]), row.id],
      );
      await client.query(
        `UPDATE cash_send_vouchers
            SET status = 'collected', collected_at = $1,
                collector_scanned_id_encrypted = $2,
                collector_scanned_id_hash = $3,
                collected_with_id_verified = 1,
                lifecycle_version = lifecycle_version + 1,
                recipient_id_document_encrypted = COALESCE(
                  NULLIF(recipient_id_document_encrypted, ''),
                  $2
                ),
                recipient_id_hash = COALESCE(
                  NULLIF(recipient_id_hash, ''),
                  $3
                )
          WHERE id = $4`,
        [nowIso, encryptField(scannedNorm), scannedHash, row.id],
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
  idempotentPg('POST /cash-send/:id/cancel'),
  async (req, res) => {
    const pool = getPgPool();
    const voucherQ = await pool.query<{
      id: string;
      sender_user_id: string;
      amount_cents: string;
      fee_cents: string;
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

    const refundCents = (parseIntegerCents(voucher.amount_cents) +
      parseIntegerCents(voucher.fee_cents, { allowZero: true })) as Cents;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const lockedVoucher = await client.query<{ status: string }>(
        `SELECT status FROM cash_send_vouchers WHERE id = $1 FOR UPDATE`,
        [voucher.id],
      );
      if (lockedVoucher.rows[0]?.status !== 'active') {
        throw Object.assign(new Error('Voucher is no longer active'), { status: 409 });
      }
      await reverseFeeAccrualPg(client, { sourceType: 'cash_send', sourceId: voucher.id });
      const refundPosting = await postBetweenWalletsPg(client, {
        fromWalletId: escrowId,
        toWalletId: senderWalletFull.id,
        amountCents: refundCents,
        type: 'cash_send_cancel_refund',
        referencePrefix: 'CSX',
        description: `Cash Send cancelled (${voucher.id}) — refund principal + fee from escrow (${poolId})`,
      });
      await client.query(
        `UPDATE cash_send_vouchers
            SET status = 'cancelled', cancel_reason = $1, refund_transaction_id = $3,
                lifecycle_version = lifecycle_version + 1
          WHERE id = $2`,
        ['Cancelled by sender — refunded from escrow', voucher.id, refundPosting.transactionId],
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
