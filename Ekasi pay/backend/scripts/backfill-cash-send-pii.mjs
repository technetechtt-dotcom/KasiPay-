/**
 * Encrypt any remaining Cash Send plaintext PII into *_encrypted columns,
 * populate blind hashes, then clear plaintext so migration 011 can drop columns.
 *
 * Usage:
 *   DATABASE_URL=... DATA_ENCRYPTION_KEY=... PII_HASH_PEPPER=... npm run cash-send:backfill-pii
 */
import pg from 'pg';

import {
  encryptField,
  hashSensitiveIdentifier,
  isEncryptedField,
  rotateFieldToActiveKey,
} from '../src/security/fieldEncryption.ts';

function normalizeForHash(value) {
  return String(value ?? '').replace(/\D/g, '');
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const pool = new pg.Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let updated = 0;
  try {
    const cols = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'cash_send_vouchers'`,
    );
    const names = new Set(cols.rows.map((r) => r.column_name));
    if (!names.has('sender_id_document_encrypted')) {
      console.log('cash-send encrypted columns missing; run migration 010 first');
      return;
    }
    const hasPlaintext = names.has('sender_id_document');
    const rows = await client.query(`
      SELECT id,
             ${hasPlaintext ? 'sender_id_document, recipient_id_document, sender_address, collector_scanned_id,' : "''::text AS sender_id_document, ''::text AS recipient_id_document, ''::text AS sender_address, ''::text AS collector_scanned_id,"}
             sender_id_document_encrypted, recipient_id_document_encrypted,
             sender_address_encrypted, collector_scanned_id_encrypted,
             sender_id_hash, recipient_id_hash, collector_scanned_id_hash
        FROM cash_send_vouchers
    `);

    for (const row of rows.rows) {
      const senderPlain = row.sender_id_document || '';
      const recipientPlain = row.recipient_id_document || '';
      const addressPlain = row.sender_address || '';
      const collectorPlain = row.collector_scanned_id || '';

      let senderEnc = row.sender_id_document_encrypted || '';
      let recipientEnc = row.recipient_id_document_encrypted || '';
      let addressEnc = row.sender_address_encrypted || '';
      let collectorEnc = row.collector_scanned_id_encrypted || '';

      if (senderPlain && !isEncryptedField(senderEnc)) senderEnc = encryptField(senderPlain);
      else if (isEncryptedField(senderEnc)) senderEnc = rotateFieldToActiveKey(senderEnc);

      if (recipientPlain && !isEncryptedField(recipientEnc)) {
        recipientEnc = encryptField(recipientPlain);
      } else if (isEncryptedField(recipientEnc)) {
        recipientEnc = rotateFieldToActiveKey(recipientEnc);
      }

      if (addressPlain && !isEncryptedField(addressEnc)) addressEnc = encryptField(addressPlain);
      else if (isEncryptedField(addressEnc)) addressEnc = rotateFieldToActiveKey(addressEnc);

      if (collectorPlain && !isEncryptedField(collectorEnc)) {
        collectorEnc = encryptField(collectorPlain);
      } else if (isEncryptedField(collectorEnc)) {
        collectorEnc = rotateFieldToActiveKey(collectorEnc);
      }

      const senderHash =
        row.sender_id_hash ||
        (senderPlain
          ? hashSensitiveIdentifier(normalizeForHash(senderPlain))
          : '');
      const recipientHash =
        row.recipient_id_hash ||
        (recipientPlain
          ? hashSensitiveIdentifier(normalizeForHash(recipientPlain))
          : '');
      const collectorHash =
        row.collector_scanned_id_hash ||
        (collectorPlain
          ? hashSensitiveIdentifier(normalizeForHash(collectorPlain))
          : '');

      const needsClear =
        senderPlain || recipientPlain || addressPlain || collectorPlain;
      const needsWrite =
        needsClear ||
        senderEnc !== (row.sender_id_document_encrypted || '') ||
        recipientEnc !== (row.recipient_id_document_encrypted || '') ||
        addressEnc !== (row.sender_address_encrypted || '') ||
        collectorEnc !== (row.collector_scanned_id_encrypted || '');

      if (!needsWrite) continue;

      if (hasPlaintext) {
        await client.query(
          `UPDATE cash_send_vouchers
              SET sender_id_document_encrypted = $2,
                  recipient_id_document_encrypted = $3,
                  sender_address_encrypted = $4,
                  collector_scanned_id_encrypted = $5,
                  sender_id_hash = NULLIF($6, ''),
                  recipient_id_hash = NULLIF($7, ''),
                  collector_scanned_id_hash = NULLIF($8, ''),
                  sender_id_document = '',
                  recipient_id_document = '',
                  sender_address = '',
                  collector_scanned_id = ''
            WHERE id = $1`,
          [
            row.id,
            senderEnc,
            recipientEnc,
            addressEnc,
            collectorEnc,
            senderHash,
            recipientHash,
            collectorHash,
          ],
        );
      } else {
        await client.query(
          `UPDATE cash_send_vouchers
              SET sender_id_document_encrypted = $2,
                  recipient_id_document_encrypted = $3,
                  sender_address_encrypted = $4,
                  collector_scanned_id_encrypted = $5,
                  sender_id_hash = NULLIF($6, ''),
                  recipient_id_hash = NULLIF($7, ''),
                  collector_scanned_id_hash = NULLIF($8, '')
            WHERE id = $1`,
          [
            row.id,
            senderEnc,
            recipientEnc,
            addressEnc,
            collectorEnc,
            senderHash,
            recipientHash,
            collectorHash,
          ],
        );
      }
      updated += 1;
    }
    console.log(`cash-send PII backfill updated ${updated} row(s)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
