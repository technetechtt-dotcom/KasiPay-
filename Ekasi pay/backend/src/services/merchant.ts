import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { getDb } from '../db.js';

export function getMerchantByUserId(
  database: Database.Database,
  userId: string
): { id: string; user_id: string } | undefined {
  return database
    .prepare('SELECT id, user_id FROM merchants WHERE user_id = ?')
    .get(userId) as { id: string; user_id: string } | undefined;
}

export function requireMerchantId(userId: string): string {
  const database = getDb();
  const row = getMerchantByUserId(database, userId);
  if (!row) {
    throw Object.assign(new Error('Merchant profile required'), { status: 403 });
  }
  return row.id;
}

export function ensureMerchantId(userId: string): string {
  const database = getDb();
  const existing = getMerchantByUserId(database, userId);
  if (existing) return existing.id;

  const user = database
    .prepare('SELECT name FROM users WHERE id = ?')
    .get(userId) as { name: string } | undefined;
  if (!user) {
    throw Object.assign(new Error('User not found'), { status: 404 });
  }
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO merchants (
         id, user_id, business_name, location, category, approval_status
       ) VALUES (?, ?, ?, ?, ?, 'pending_docs')`,
    )
    .run(id, userId, `${user.name}'s Shop`, 'South Africa', 'Retail');
  return id;
}
