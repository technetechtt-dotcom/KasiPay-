import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { parseIntegerCents, type Cents } from '../money.js';

type DbClient = Pool | PoolClient;

export type StatementItem = {
  rowNumber: number;
  providerReference: string;
  bankReference?: string;
  amountCents: Cents;
  currency: string;
  valueDate: string;
  direction: 'credit' | 'debit';
  rowHash: string;
};

const HEADER =
  'provider_reference,bank_reference,amount_cents,currency,value_date,direction';

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalLine(item: Omit<StatementItem, 'rowNumber' | 'rowHash'>): string {
  return [
    item.providerReference,
    item.bankReference ?? '',
    item.amountCents.toString(),
    item.currency,
    item.valueDate,
    item.direction,
  ].join(',');
}

/**
 * Strict provider-neutral CSV contract. Quoting, extra columns, decimals and
 * locale-specific dates are rejected until a certified bank mapping normalizes
 * them into this format.
 */
export function parseSettlementStatement(content: Buffer): {
  contentHash: string;
  canonicalHash: string;
  items: StatementItem[];
} {
  const text = content.toString('utf8').replace(/^\uFEFF/, '');
  if (text.includes('\r')) {
    throw new Error('Statement must use LF line endings');
  }
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines[0] !== HEADER) throw new Error(`Invalid statement header; expected ${HEADER}`);
  if (lines.length < 2) throw new Error('Statement has no items');

  const seen = new Set<string>();
  const items = lines.slice(1).map((line, index) => {
    if (!line || line.includes('"')) throw new Error(`Invalid CSV row ${index + 2}`);
    const fields = line.split(',');
    if (fields.length !== 6) throw new Error(`Invalid column count at row ${index + 2}`);
    const [providerReference, bankReference, rawAmount, currency, valueDate, direction] =
      fields;
    if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(providerReference)) {
      throw new Error(`Invalid provider_reference at row ${index + 2}`);
    }
    if (bankReference && !/^[A-Za-z0-9 ._:/-]{1,128}$/.test(bankReference)) {
      throw new Error(`Invalid bank_reference at row ${index + 2}`);
    }
    if (!/^-?[0-9]+$/.test(rawAmount) || rawAmount === '0') {
      throw new Error(`amount_cents must be a non-zero integer at row ${index + 2}`);
    }
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Invalid currency at row ${index + 2}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(valueDate) || Number.isNaN(Date.parse(`${valueDate}T00:00:00Z`))) {
      throw new Error(`Invalid value_date at row ${index + 2}`);
    }
    if (direction !== 'credit' && direction !== 'debit') {
      throw new Error(`Invalid direction at row ${index + 2}`);
    }
    const amountCents = parseIntegerCents(rawAmount.replace(/^-/, ''));
    const normalized = {
      providerReference,
      bankReference: bankReference || undefined,
      amountCents,
      currency,
      valueDate,
      direction,
    } as const;
    const rowHash = sha256(canonicalLine(normalized));
    if (seen.has(rowHash)) throw new Error(`Duplicate row at ${index + 2}`);
    seen.add(rowHash);
    return { ...normalized, rowNumber: index + 1, rowHash };
  });
  return {
    contentHash: sha256(content),
    canonicalHash: sha256(items.map((item) => canonicalLine(item)).join('\n')),
    items,
  };
}

export type MatchCandidate = {
  id: string;
  providerReference?: string | null;
  amountCents: Cents;
  currency: string;
  settlementDate: string;
  journalTransactionId: string;
};

export type MatchDecision =
  | { state: 'matched'; candidate: MatchCandidate; rule: 'exact_reference_amount_currency'; confidence: 100 }
  | { state: 'partial'; candidate: MatchCandidate; rule: 'exact_reference_partial_amount'; confidence: 90 }
  | { state: 'duplicate'; candidates: MatchCandidate[] }
  | { state: 'unmatched' };

/** Deterministic matching: reference first, then currency, then amount. */
export function matchSettlementItem(
  item: StatementItem,
  candidates: readonly MatchCandidate[],
): MatchDecision {
  const referenceMatches = candidates.filter(
    (candidate) =>
      candidate.providerReference === item.providerReference &&
      candidate.currency === item.currency,
  );
  const exact = referenceMatches.filter(
    (candidate) => candidate.amountCents === item.amountCents,
  );
  if (exact.length > 1) return { state: 'duplicate', candidates: exact };
  if (exact[0]) {
    return {
      state: 'matched',
      candidate: exact[0],
      rule: 'exact_reference_amount_currency',
      confidence: 100,
    };
  }
  if (referenceMatches.length > 1) return { state: 'duplicate', candidates: referenceMatches };
  if (referenceMatches[0]) {
    return {
      state: 'partial',
      candidate: referenceMatches[0],
      rule: 'exact_reference_partial_amount',
      confidence: 90,
    };
  }
  return { state: 'unmatched' };
}

export async function importSettlementStatementPg(
  database: DbClient,
  input: {
    provider: string;
    schemaVersion: 'phase6-v1';
    fileName: string;
    content: Buffer;
    operatorId: string;
  },
): Promise<{ fileId: string; rowCount: number }> {
  const parsed = parseSettlementStatement(input.content);
  const fileId = randomUUID();
  await database.query(
    `INSERT INTO settlement_statement_files
       (id, provider, schema_version, file_name, content_sha256, canonical_sha256,
        row_count, imported_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      fileId,
      input.provider,
      input.schemaVersion,
      input.fileName,
      parsed.contentHash,
      parsed.canonicalHash,
      parsed.items.length,
      input.operatorId,
    ],
  );
  for (const item of parsed.items) {
    await database.query(
      `INSERT INTO settlement_statement_items
         (id, statement_file_id, row_number, provider_reference, bank_reference,
          amount_cents, currency, value_date, direction, row_sha256, raw_safe)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        randomUUID(),
        fileId,
        item.rowNumber,
        item.providerReference,
        item.bankReference ?? null,
        item.amountCents.toString(),
        item.currency,
        item.valueDate,
        item.direction,
        item.rowHash,
        JSON.stringify({
          providerReference: item.providerReference,
          bankReference: item.bankReference,
          amountCents: item.amountCents.toString(),
          currency: item.currency,
          valueDate: item.valueDate,
          direction: item.direction,
        }),
      ],
    );
  }
  return { fileId, rowCount: parsed.items.length };
}

async function createSuspensePostingPg(
  database: DbClient,
  item: {
    id: string;
    amount_cents: string;
    currency: string;
    provider_reference: string;
    direction: 'credit' | 'debit';
  },
): Promise<string> {
  const transactionId = randomUUID();
  const batchId = randomUUID();
  const amount = parseIntegerCents(item.amount_cents);
  const suspense = 'phase6-settlement-suspense-zar';
  const contra = 'phase6-merchant-liability-zar';
  await database.query(
    `INSERT INTO posting_batches(id, source, state) VALUES ($1,'settlement_import','authorized')`,
    [batchId],
  );
  await database.query(
    `INSERT INTO journal_transactions
       (id,batch_id,reference,transaction_type,description,currency,pool_id,
        state,effective_at,posted_at,metadata)
     VALUES ($1,$2,$3,'settlement_suspense',$4,$5,'ZA','authorized',
             clock_timestamp(),clock_timestamp(),$6::jsonb)`,
    [
      transactionId,
      batchId,
      `SUS-${item.id}`,
      `Unmatched settlement item ${item.provider_reference}`,
      item.currency,
      JSON.stringify({ statementItemId: item.id, providerReference: item.provider_reference }),
    ],
  );
  await database.query(
    `INSERT INTO journal_entries(id,transaction_id,account_id,side,amount_cents,currency)
     VALUES ($1,$2,$3,$4,$5,$6),($7,$2,$8,$9,$5,$6)`,
    [
      randomUUID(),
      transactionId,
      suspense,
      item.direction === 'credit' ? 'debit' : 'credit',
      amount.toString(),
      item.currency,
      randomUUID(),
      contra,
      item.direction === 'credit' ? 'credit' : 'debit',
    ],
  );
  await database.query(
    `UPDATE journal_transactions SET state = 'posted' WHERE id = $1;
     UPDATE posting_batches SET state = 'posted', posted_at = clock_timestamp() WHERE id = $2`,
    [transactionId, batchId],
  );
  return transactionId;
}

export async function reconcileSettlementFilePg(
  database: DbClient,
  fileId: string,
): Promise<Record<'matched' | 'partial' | 'duplicate' | 'unmatched', number>> {
  const items = await database.query<{
    id: string;
    row_number: number;
    provider_reference: string;
    amount_cents: string;
    currency: string;
    value_date: string;
    direction: 'credit' | 'debit';
    row_sha256: string;
  }>(
    `SELECT * FROM settlement_statement_items
      WHERE statement_file_id = $1 ORDER BY row_number FOR UPDATE`,
    [fileId],
  );
  const counts = { matched: 0, partial: 0, duplicate: 0, unmatched: 0 };
  for (const row of items.rows) {
    const candidates = await database.query<{
      id: string;
      provider_reference: string | null;
      amount_cents: string;
      currency: string;
      settlement_date: string;
      journal_transaction_id: string;
    }>(
      `SELECT p.id, p.provider_reference, p.amount_cents, p.currency,
              b.settlement_date::text, p.journal_transaction_id
         FROM payout_instructions p
         JOIN settlement_batches b ON b.id = p.batch_id
        WHERE p.provider_reference = $1 AND p.currency = $2
          AND p.state IN ('submitted','accepted','fulfilled','unknown')`,
      [row.provider_reference, row.currency],
    );
    const item: StatementItem = {
      rowNumber: row.row_number,
      providerReference: row.provider_reference,
      amountCents: BigInt(row.amount_cents) as Cents,
      currency: row.currency,
      valueDate: row.value_date,
      direction: row.direction,
      rowHash: row.row_sha256,
    };
    const decision = matchSettlementItem(
      item,
      candidates.rows.map((candidate) => ({
        id: candidate.id,
        providerReference: candidate.provider_reference,
        amountCents: BigInt(candidate.amount_cents) as Cents,
        currency: candidate.currency,
        settlementDate: candidate.settlement_date,
        journalTransactionId: candidate.journal_transaction_id,
      })),
    );
    counts[decision.state] += 1;
    if (decision.state === 'matched' || decision.state === 'partial') {
      await database.query(
        `INSERT INTO settlement_matches
           (id,statement_item_id,payout_instruction_id,journal_transaction_id,
            matched_cents,match_rule,confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          randomUUID(),
          row.id,
          decision.candidate.id,
          decision.candidate.journalTransactionId,
          (decision.state === 'matched'
            ? item.amountCents
            : item.amountCents < decision.candidate.amountCents
              ? item.amountCents
              : decision.candidate.amountCents
          ).toString(),
          decision.rule,
          decision.confidence,
        ],
      );
      await database.query(
        `UPDATE settlement_statement_items
            SET match_state = $2, journal_transaction_id = $3 WHERE id = $1`,
        [row.id, decision.state, decision.candidate.journalTransactionId],
      );
      if (decision.state === 'partial') {
        const difference =
          item.amountCents > decision.candidate.amountCents
            ? item.amountCents - decision.candidate.amountCents
            : decision.candidate.amountCents - item.amountCents;
        const suspenseTransactionId = await createSuspensePostingPg(database, {
          ...row,
          amount_cents: difference.toString(),
        });
        await database.query(
          `INSERT INTO settlement_suspense_cases
             (id,statement_item_id,suspense_journal_transaction_id,reason_code)
           VALUES ($1,$2,$3,'partial')`,
          [randomUUID(), row.id, suspenseTransactionId],
        );
        await database.query(
          `INSERT INTO settlement_alerts
             (id,alert_type,severity,statement_item_id,financial_reference,safe_details)
           VALUES ($1,'partial','warning',$2,$3,$4::jsonb)`,
          [
            randomUUID(),
            row.id,
            row.provider_reference,
            JSON.stringify({ statementFileId: fileId, differenceCents: difference.toString() }),
          ],
        );
      }
      continue;
    }
    const suspenseTransactionId = await createSuspensePostingPg(database, row);
    await database.query(
      `UPDATE settlement_statement_items
          SET match_state = $2, journal_transaction_id = $3 WHERE id = $1`,
      [row.id, decision.state === 'duplicate' ? 'duplicate' : 'suspense', suspenseTransactionId],
    );
    await database.query(
      `INSERT INTO settlement_suspense_cases
         (id, statement_item_id, suspense_journal_transaction_id, reason_code)
       VALUES ($1,$2,$3,$4)`,
      [randomUUID(), row.id, suspenseTransactionId, decision.state],
    );
    await database.query(
      `INSERT INTO settlement_alerts
         (id,alert_type,severity,statement_item_id,financial_reference,safe_details)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        randomUUID(),
        decision.state,
        decision.state === 'duplicate' ? 'high' : 'warning',
        row.id,
        row.provider_reference,
        JSON.stringify({ statementFileId: fileId, rowNumber: row.row_number }),
      ],
    );
  }
  return counts;
}
