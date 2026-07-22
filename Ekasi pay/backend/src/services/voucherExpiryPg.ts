import type { Pool } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';
import { DEFAULT_POOL_ID } from '../poolConstants.js';
import { reverseCommissionPostingsPg } from './commissionsPg.js';
import { reverseFeeAccrualPg } from './feeEnginePg.js';
import { getEscrowWalletIdForPoolPg } from './escrowPg.js';
import { postBetweenWalletsPg } from './walletPostingPg.js';

export async function processExpiredVouchersPg(
  pool: Pool,
  limit = 100,
): Promise<{ processed: number; skipped: number }> {
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM cash_send_vouchers
      WHERE status = 'active' AND expires_at <= clock_timestamp()
      ORDER BY expires_at ASC LIMIT $1`,
    [limit],
  );
  let processed = 0;
  let skipped = 0;
  for (const candidate of candidates.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<{
        id: string;
        sender_user_id: string;
        reference_number: string;
        amount_cents: string;
        fee_cents: string;
      }>(
        `SELECT id, sender_user_id, reference_number, amount_cents, fee_cents
           FROM cash_send_vouchers
          WHERE id = $1 AND status = 'active' AND expires_at <= clock_timestamp()
          FOR UPDATE SKIP LOCKED`,
        [candidate.id],
      );
      const voucher = locked.rows[0];
      if (!voucher) {
        skipped += 1;
        await client.query('ROLLBACK');
        continue;
      }
      const wallet = await client.query<{ id: string; pool_id: string | null }>(
        `SELECT id, pool_id FROM wallets
          WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
        [voucher.sender_user_id],
      );
      if (!wallet.rows[0]) throw new Error(`Sender wallet missing for voucher ${voucher.id}`);
      const poolId = wallet.rows[0].pool_id ?? DEFAULT_POOL_ID;
      const escrowId = await getEscrowWalletIdForPoolPg(client, poolId);
      if (!escrowId) throw new Error(`Escrow wallet missing for pool ${poolId}`);
      const amount = (parseIntegerCents(voucher.amount_cents) +
        parseIntegerCents(voucher.fee_cents, { allowZero: true })) as Cents;
      await reverseFeeAccrualPg(client, { sourceType: 'cash_send', sourceId: voucher.id });
      const refund = await postBetweenWalletsPg(client, {
        fromWalletId: escrowId,
        toWalletId: wallet.rows[0].id,
        amountCents: amount,
        type: 'cash_send_expire_refund',
        referencePrefix: 'CSE',
        description: `Scheduled expiry refund (${voucher.reference_number})`,
      });
      await reverseCommissionPostingsPg(client, 'cash_send', voucher.id);
      await client.query(
        `UPDATE cash_send_vouchers
            SET status = 'expired', cancel_reason = 'Scheduled expiry refund',
                refund_transaction_id = $2, expiry_processed_at = clock_timestamp(),
                lifecycle_version = lifecycle_version + 1
          WHERE id = $1`,
        [voucher.id, refund.transactionId],
      );
      await client.query(
        `INSERT INTO cash_send_outbox(id, voucher_id, event_type, channel, template, safe_payload)
         VALUES (gen_random_uuid(), $1, 'voucher_expired', 'internal', 'cash_send_expired',
                 jsonb_build_object('referenceNumber', $2))`,
        [voucher.id, voucher.reference_number],
      );
      await client.query('COMMIT');
      processed += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  return { processed, skipped };
}
