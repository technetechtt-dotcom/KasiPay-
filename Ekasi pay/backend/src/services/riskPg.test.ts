import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

describe('risk engine postgres velocity query', () => {
  it('does not use the reserved PostgreSQL alias day', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'riskPg.ts'),
      'utf8',
    );
    assert.match(src, /AS events_24h/);
    assert.match(src, /AS events_10m/);
    assert.doesNotMatch(src, /::text\s+day\b/);
    assert.doesNotMatch(src, /events24h: Number\(velocity\.rows\[0\]\?\.day/);
  });
});
