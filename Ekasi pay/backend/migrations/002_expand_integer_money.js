/**
 * Phase 2 expand/backfill migration.
 *
 * Every conversion is preflighted before schema changes. Values with more than
 * two decimal places abort the transaction; no ROUND() is used.
 */
export const up = (pgm) => {
  pgm.sql(String.raw`
    CREATE OR REPLACE FUNCTION phase2_money_columns()
    RETURNS TABLE(table_name text, column_name text)
    LANGUAGE sql IMMUTABLE AS $$
      SELECT * FROM (VALUES
        ('wallets','balance'),
        ('products','cost_price'), ('products','price'),
        ('transactions','amount'),
        ('ledger_entries','amount'), ('ledger_entries','balance_after'),
        ('sales','total'),
        ('expenses','amount'),
        ('credit_customers','total_owed'), ('credit_customers','credit_limit'),
        ('credit_transactions','amount'),
        ('supplier_orders','total'),
        ('stokvel_groups','target_amount'), ('stokvel_groups','current_amount'),
        ('stokvel_loans','amount'), ('stokvel_loans','interest_amount'),
        ('stokvel_loans','total_due'),
        ('stokvel_contributions','amount'),
        ('layby_orders','total_price'), ('layby_orders','amount_paid'),
        ('loans','amount'), ('loans','repaid_amount'),
        ('price_comparisons','my_price'), ('price_comparisons','avg_area_price'),
        ('price_comparisons','lowest_area_price'),
        ('price_comparisons','highest_area_price'),
        ('insurance_policies','coverage_amount'),
        ('insurance_policies','monthly_premium'),
        ('insurance_claims','claimed_amount'),
        ('cash_send_vouchers','amount'), ('cash_send_vouchers','fee'),
        ('stock_movements','cost_price_at_time'),
        ('purchase_slips','total'),
        ('commission_postings','amount'),
        ('utility_purchases','amount')
      ) AS columns(table_name, column_name)
    $$;

    DO $$
    DECLARE
      item record;
      invalid_count bigint;
    BEGIN
      FOR item IN SELECT * FROM phase2_money_columns() LOOP
        EXECUTE format(
          'SELECT count(*) FROM %I WHERE %I IS NOT NULL AND
             (%I::text IN (''NaN'',''Infinity'',''-Infinity'')
              OR trunc(%I::numeric * 100) <> %I::numeric * 100)',
          item.table_name, item.column_name, item.column_name,
          item.column_name, item.column_name
        ) INTO invalid_count;
        IF invalid_count <> 0 THEN
          RAISE EXCEPTION
            'Phase 2 preflight failed: %.% has % unsupported value(s)',
            item.table_name, item.column_name, invalid_count;
        END IF;
      END LOOP;
    END $$;

    DO $$
    DECLARE
      item record;
      required boolean;
    BEGIN
      FOR item IN SELECT * FROM phase2_money_columns() LOOP
        SELECT is_nullable = 'NO' INTO required
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = item.table_name
           AND column_name = item.column_name;

        EXECUTE format(
          'ALTER TABLE %I ADD COLUMN IF NOT EXISTS %I BIGINT',
          item.table_name, item.column_name || '_cents'
        );
        EXECUTE format(
          'UPDATE %I SET %I = (%I::numeric * 100)::bigint
            WHERE %I IS NULL AND %I IS NOT NULL',
          item.table_name, item.column_name || '_cents', item.column_name,
          item.column_name || '_cents', item.column_name
        );
        EXECUTE format(
          'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
          item.table_name,
          item.table_name || '_' || item.column_name || '_cents_nonnegative'
        );
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I >= 0)',
          item.table_name,
          item.table_name || '_' || item.column_name || '_cents_nonnegative',
          item.column_name || '_cents', item.column_name || '_cents'
        );
        IF required THEN
          EXECUTE format(
            'ALTER TABLE %I ALTER COLUMN %I SET NOT NULL',
            item.table_name, item.column_name || '_cents'
          );
        END IF;
      END LOOP;
    END $$;

    /*
     * Compatibility is intentionally one-way for new code: when *_cents is
     * supplied it derives the legacy value. A legacy-only write is accepted
     * during the deployment window only when it has exact cent precision.
     */
    CREATE OR REPLACE FUNCTION phase2_sync_money_columns()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      i integer;
      legacy_name text;
      cents_name text;
      old_doc jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
      new_doc jsonb := to_jsonb(NEW);
      legacy_value numeric;
      cents_value bigint;
      patch jsonb := '{}'::jsonb;
    BEGIN
      i := 0;
      WHILE i < TG_NARGS LOOP
        legacy_name := TG_ARGV[i];
        cents_name := legacy_name || '_cents';
        legacy_value := NULLIF(new_doc ->> legacy_name, '')::numeric;
        cents_value := NULLIF(new_doc ->> cents_name, '')::bigint;

        IF cents_value IS NOT NULL AND (
          TG_OP = 'INSERT'
          OR (new_doc ->> cents_name) IS DISTINCT FROM (old_doc ->> cents_name)
        ) THEN
          patch := patch || jsonb_build_object(legacy_name, cents_value::numeric / 100);
        ELSIF legacy_value IS NOT NULL AND (
          TG_OP = 'INSERT'
          OR (new_doc ->> legacy_name) IS DISTINCT FROM (old_doc ->> legacy_name)
        ) THEN
          IF trunc(legacy_value * 100) <> legacy_value * 100 THEN
            RAISE EXCEPTION 'Unsupported precision for %.%', TG_TABLE_NAME, legacy_name;
          END IF;
          patch := patch || jsonb_build_object(cents_name, (legacy_value * 100)::bigint);
        END IF;
        i := i + 1;
      END LOOP;
      RETURN jsonb_populate_record(NEW, patch);
    END $$;

    DO $$
    DECLARE
      target record;
      args text;
    BEGIN
      FOR target IN
        SELECT table_name,
               string_agg(quote_literal(column_name), ', ' ORDER BY column_name) AS args
          FROM phase2_money_columns()
         GROUP BY table_name
      LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS phase2_money_sync ON %I', target.table_name);
        args := target.args;
        EXECUTE format(
          'CREATE TRIGGER phase2_money_sync
             BEFORE INSERT OR UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION phase2_sync_money_columns(%s)',
          target.table_name, args
        );
      END LOOP;
    END $$;

    DO $$
    DECLARE
      invalid_count bigint;
    BEGIN
      SELECT count(*) INTO invalid_count FROM stokvel_loans
       WHERE interest_rate_percent::text IN ('NaN','Infinity','-Infinity')
          OR trunc(interest_rate_percent::numeric * 1000000)
             <> interest_rate_percent::numeric * 1000000;
      IF invalid_count <> 0 THEN
        RAISE EXCEPTION 'Unsupported stokvel interest rate precision';
      END IF;
      SELECT count(*) INTO invalid_count FROM loans
       WHERE interest_rate::text IN ('NaN','Infinity','-Infinity')
          OR trunc(interest_rate::numeric * 1000000)
             <> interest_rate::numeric * 1000000;
      IF invalid_count <> 0 THEN
        RAISE EXCEPTION 'Unsupported loan interest rate precision';
      END IF;
    END $$;

    ALTER TABLE stokvel_loans
      ALTER COLUMN interest_rate_percent TYPE NUMERIC(18,6)
      USING interest_rate_percent::text::numeric;
    ALTER TABLE loans
      ALTER COLUMN interest_rate TYPE NUMERIC(18,6)
      USING interest_rate::text::numeric;
  `);
};

// Expand migrations are contracted only after production reconciliation/sign-off.
export const down = false;
