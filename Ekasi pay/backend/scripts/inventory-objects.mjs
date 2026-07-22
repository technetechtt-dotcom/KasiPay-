import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const source = process.env.OBJECT_INVENTORY_FILE;
if (!source) throw new Error('OBJECT_INVENTORY_FILE is required (provider export; one object key per line).');
const keys = (await readFile(source, 'utf8')).split(/\r?\n/).map((key) => key.trim()).filter(Boolean).sort();
const result = {
  schemaVersion: 'phase5.object-inventory.v1',
  generatedAt: new Date().toISOString(),
  objectCount: keys.length,
  inventoryHash: createHash('sha256').update(keys.join('\n')).digest('hex'),
};
console.log(JSON.stringify(result));
