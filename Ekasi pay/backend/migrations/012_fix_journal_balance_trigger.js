/**
 * Fix shared journal balance trigger: PL/pgSQL cannot reference
 * NEW.transaction_id when the same function is also attached to
 * journal_transactions (which has no such column).
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION validate_posted_transaction_balanced() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE transaction_uuid uuid;
    DECLARE transaction_state text;
    DECLARE debit_total numeric;
    DECLARE credit_total numeric;
    DECLARE invalid_entries bigint;
    DECLARE payload jsonb;
    BEGIN
      payload := to_jsonb(COALESCE(NEW, OLD));
      IF TG_TABLE_NAME = 'journal_transactions' THEN
        transaction_uuid := (payload->>'id')::uuid;
      ELSE
        transaction_uuid := (payload->>'transaction_id')::uuid;
      END IF;
      SELECT state INTO transaction_state FROM journal_transactions
        WHERE id = transaction_uuid;
      IF transaction_state IN ('posted','settled','reversed') THEN
        SELECT
          COALESCE(sum(amount_cents) FILTER (WHERE side = 'debit'), 0),
          COALESCE(sum(amount_cents) FILTER (WHERE side = 'credit'), 0),
          count(*) FILTER (WHERE e.currency <> t.currency OR a.currency <> t.currency
                            OR a.pool_id <> t.pool_id)
        INTO debit_total, credit_total, invalid_entries
        FROM journal_entries e
        JOIN journal_transactions t ON t.id = e.transaction_id
        JOIN ledger_accounts a ON a.id = e.account_id
        WHERE e.transaction_id = transaction_uuid
        GROUP BY t.id;
        IF debit_total IS NULL OR debit_total = 0 OR debit_total <> credit_total THEN
          RAISE EXCEPTION 'posted transaction % is unbalanced (% debit, % credit)',
            transaction_uuid, COALESCE(debit_total, 0), COALESCE(credit_total, 0)
            USING ERRCODE = '23514';
        END IF;
        IF invalid_entries <> 0 THEN
          RAISE EXCEPTION 'posted transaction % has currency/pool mismatch', transaction_uuid
            USING ERRCODE = '23514';
        END IF;
      END IF;
      RETURN NULL;
    END $$;
  `);
};

export const down = () => {
  // No-op: prior broken function must not be restored.
};
