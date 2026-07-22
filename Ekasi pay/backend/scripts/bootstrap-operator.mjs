/**
 * Audited, one-time PostgreSQL operator bootstrap.
 * This is never invoked by application startup.
 *
 * Required: DATABASE_URL, BOOTSTRAP_OPERATOR_USERNAME,
 * BOOTSTRAP_OPERATOR_PASSWORD, DATA_ENCRYPTION_KEY, BOOTSTRAP_CONFIRM=CREATE_FIRST_OPERATOR
 */
import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
if (required('BOOTSTRAP_CONFIRM') !== 'CREATE_FIRST_OPERATOR') {
  throw new Error('BOOTSTRAP_CONFIRM must equal CREATE_FIRST_OPERATOR');
}
const username = required('BOOTSTRAP_OPERATOR_USERNAME').toLowerCase();
const password = required('BOOTSTRAP_OPERATOR_PASSWORD');
if (password.length < 14) throw new Error('Bootstrap password must be at least 14 characters');

const rawKey = required('DATA_ENCRYPTION_KEY');
const key = /^[a-f0-9]{64}$/iu.test(rawKey) ? Buffer.from(rawKey, 'hex') : Buffer.from(rawKey, 'base64');
if (key.length !== 32) throw new Error('DATA_ENCRYPTION_KEY must encode 32 bytes');

const base32 = (bytes) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};
const encrypt = (plain) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
};

const pool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const count = await client.query(`SELECT count(*)::int AS count FROM ops_admin_users WHERE role = 'admin'`);
  if (count.rows[0].count > 0) throw new Error('An admin operator already exists; bootstrap is permanently closed');
  const id = randomUUID();
  const secret = base32(randomBytes(20));
  const now = new Date();
  await client.query(
    `INSERT INTO ops_admin_users
      (id, username, password_hash, role, is_active, created_at, updated_at,
       token_version, mfa_secret_encrypted, mfa_enabled_at, password_changed_at)
     VALUES ($1,$2,$3,'admin',TRUE,$4,$4,1,$5,$4,$4)`,
    [id, username, await bcrypt.hash(password, 12), now, encrypt(secret)],
  );
  const invocationHash = createHash('sha256')
    .update(`${username}:${now.toISOString()}:${process.pid}`)
    .digest('hex');
  await client.query(
    `INSERT INTO bootstrap_events (id, operator_id, username, invocation_hash)
     VALUES ($1,$2,$3,$4)`,
    [randomUUID(), id, username, invocationHash],
  );
  await client.query('COMMIT');
  console.log(`Operator created: ${username}`);
  console.log(`TOTP secret (displayed once): ${secret}`);
  console.log('Enroll this secret immediately, verify a login, then remove bootstrap environment variables.');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
