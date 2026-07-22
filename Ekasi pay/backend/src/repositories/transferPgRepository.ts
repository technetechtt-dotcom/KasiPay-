import type { Pool } from 'pg';

import type {
  TransferRecord,
  TransferRepository,
  TransferWallet,
} from '../domain/transfers.js';
import { formatCents, type Cents } from '../money.js';
import { createComplianceFlagPg } from '../services/compliancePg.js';
import { postBetweenWalletsPg } from '../services/walletPostingPg.js';

export class PgTransferRepository implements TransferRepository {
  constructor(private readonly pool: Pool) {}

  async findUserWallet(userId: string): Promise<TransferWallet | undefined> {
    const result = await this.pool.query<{
      id: string;
      status: string;
      pool_id: string | null;
    }>(
      `SELECT id, status, pool_id FROM wallets
       WHERE user_id = $1 AND COALESCE(wallet_kind, 'user') = 'user'`,
      [userId],
    );
    const wallet = result.rows[0];
    return wallet
      ? { id: wallet.id, status: wallet.status, poolId: wallet.pool_id }
      : undefined;
  }

  async findRecipientUserId(phone: string): Promise<string | undefined> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM users WHERE phone = $1 AND COALESCE(is_system, 0) = 0`,
      [phone],
    );
    return result.rows[0]?.id;
  }

  async postTransfer(input: {
    fromUserId: string;
    fromWalletId: string;
    toWalletId: string;
    toPhone: string;
    amountCents: Cents;
    description: string;
  }): Promise<TransferRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const posted = await postBetweenWalletsPg(client, {
        fromWalletId: input.fromWalletId,
        toWalletId: input.toWalletId,
        amountCents: input.amountCents,
        type: 'transfer',
        referencePrefix: 'TRF',
        description: input.description,
      });
      if (input.amountCents >= 500_000n) {
        await createComplianceFlagPg(client, {
          userId: input.fromUserId,
          transactionId: posted.transactionId,
          severity: input.amountCents >= 1_000_000n ? 'high' : 'medium',
          reason: `Large wallet transfer (R${formatCents(input.amountCents)}) to ${input.toPhone}`,
        });
      }
      const transaction = await client.query<TransferRecord>(
        `SELECT id, from_wallet_id, to_wallet_id, amount_cents, type, status,
                reference, description, created_at
           FROM transactions WHERE id = $1`,
        [posted.transactionId],
      );
      await client.query('COMMIT');
      return transaction.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
