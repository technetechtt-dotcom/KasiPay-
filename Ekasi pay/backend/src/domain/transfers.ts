import { DEFAULT_POOL_ID } from '../poolConstants.js';
import type { Cents } from '../money.js';

export interface TransferWallet {
  id: string;
  status: string;
  poolId: string | null;
}

export interface TransferRecord {
  id: string;
  from_wallet_id: string | null;
  to_wallet_id: string | null;
  amount_cents: string;
  type: string;
  status: string;
  reference: string;
  description: string;
  created_at: string;
}

export interface TransferRepository {
  findUserWallet(userId: string): Promise<TransferWallet | undefined>;
  findRecipientUserId(phone: string): Promise<string | undefined>;
  postTransfer(input: {
    fromUserId: string;
    fromWalletId: string;
    toWalletId: string;
    toPhone: string;
    amountCents: Cents;
    description: string;
  }): Promise<TransferRecord>;
}

export class TransferDomainError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function createTransfer(
  repository: TransferRepository,
  input: {
    fromUserId: string;
    fromPhone: string;
    toPhone: string;
    amountCents: Cents;
    description: string;
  },
): Promise<TransferRecord> {
  if (input.toPhone === input.fromPhone) {
    throw new TransferDomainError(400, 'Cannot transfer to the same phone');
  }

  const fromWallet = await repository.findUserWallet(input.fromUserId);
  if (!fromWallet) throw new TransferDomainError(404, 'Wallet not found');
  if (fromWallet.status !== 'active') {
    throw new TransferDomainError(400, 'Wallet is not active');
  }

  const recipientId = await repository.findRecipientUserId(input.toPhone);
  if (!recipientId) throw new TransferDomainError(404, 'Recipient not found');
  const toWallet = await repository.findUserWallet(recipientId);
  if (!toWallet) throw new TransferDomainError(404, 'Recipient wallet not found');
  if (toWallet.status !== 'active') {
    throw new TransferDomainError(400, 'Recipient wallet is not active');
  }

  if (
    (fromWallet.poolId ?? DEFAULT_POOL_ID) !==
    (toWallet.poolId ?? DEFAULT_POOL_ID)
  ) {
    throw new TransferDomainError(
      400,
      'Cross-country transfers are not supported yet — recipient must use the same region as you.',
    );
  }

  return repository.postTransfer({
    fromUserId: input.fromUserId,
    fromWalletId: fromWallet.id,
    toWalletId: toWallet.id,
    toPhone: input.toPhone,
    amountCents: input.amountCents,
    description: input.description,
  });
}
