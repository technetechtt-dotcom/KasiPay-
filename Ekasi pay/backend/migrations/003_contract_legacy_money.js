/**
 * Phase 2 contract migration.
 *
 * Apply only after migration 002 reconciliation and application cutover.
 * Clean installs apply this immediately after the exact backfill.
 */
export const up = (pgm) => {
  pgm.sql(String.raw`
    DO $$
    DECLARE
      item record;
      mismatch_count bigint;
    BEGIN
      FOR item IN SELECT * FROM phase2_money_columns() LOOP
        EXECUTE format(
          'SELECT count(*) FROM %I
            WHERE (%I IS NULL) <> (%I IS NULL)
               OR (%I IS NOT NULL AND %I::numeric * 100 <> %I::numeric)',
          item.table_name,
          item.column_name,
          item.column_name || '_cents',
          item.column_name,
          item.column_name,
          item.column_name || '_cents'
        ) INTO mismatch_count;
        IF mismatch_count <> 0 THEN
          RAISE EXCEPTION
            'Phase 2 contract blocked: %.% has % mismatch(es)',
            item.table_name, item.column_name, mismatch_count;
        END IF;
      END LOOP;
    END $$;

    DO $$
    DECLARE
      target record;
    BEGIN
      FOR target IN SELECT DISTINCT table_name FROM phase2_money_columns() LOOP
        EXECUTE format(
          'DROP TRIGGER IF EXISTS phase2_money_sync ON %I',
          target.table_name
        );
      END LOOP;
    END $$;

    DO $$
    DECLARE
      item record;
    BEGIN
      FOR item IN SELECT * FROM phase2_money_columns() LOOP
        EXECUTE format(
          'ALTER TABLE %I DROP COLUMN %I',
          item.table_name, item.column_name
        );
      END LOOP;
    END $$;

    DROP FUNCTION phase2_sync_money_columns();
  `);
};

export const down = false;
