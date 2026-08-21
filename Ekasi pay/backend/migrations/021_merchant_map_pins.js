export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE merchants
      ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
    ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_lat_lng_check;
    ALTER TABLE merchants ADD CONSTRAINT merchants_lat_lng_check
      CHECK (
        (latitude IS NULL AND longitude IS NULL)
        OR (
          latitude IS NOT NULL AND longitude IS NOT NULL
          AND latitude BETWEEN -90 AND 90
          AND longitude BETWEEN -180 AND 180
        )
      );
    CREATE INDEX IF NOT EXISTS merchants_map_pins_idx
      ON merchants (latitude, longitude)
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS merchants_map_pins_idx;
    ALTER TABLE merchants DROP CONSTRAINT IF EXISTS merchants_lat_lng_check;
    ALTER TABLE merchants
      DROP COLUMN IF EXISTS latitude,
      DROP COLUMN IF EXISTS longitude;
  `);
};
