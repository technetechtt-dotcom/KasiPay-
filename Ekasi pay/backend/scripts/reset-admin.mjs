import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';

dotenv.config();

// We need to run Node with the loaders or just import the compiled JS
import { encryptSensitive } from '../dist/security/totp.js';

const base32 = (bytes) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = [...bytes].map((b) => b.toString(2).padStart(8, '0')).join('');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};

async function run() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const username = 'ivanij';
    const password = 'SuperSecretPassword123!';
    const password_hash = await bcrypt.hash(password, 12);
    const secret = base32(randomBytes(20));
    const mfa_secret_encrypted = encryptSensitive(secret);

    const res = await pool.query(
      `UPDATE ops_admin_users
       SET password_hash = $1,
           mfa_secret_encrypted = $2,
           mfa_enabled_at = NOW(),
           updated_at = NOW()
       WHERE username = $3
       RETURNING id`,
      [password_hash, mfa_secret_encrypted, username]
    );

    if (res.rowCount === 0) {
      console.log('User ivanij not found');
    } else {
      console.log('--- ADMIN RESET SUCCESS ---');
      console.log('Username:', username);
      console.log('Password:', password);
      console.log('TOTP Secret:', secret);
      console.log('Enter the TOTP Secret manually into Google Authenticator.');
    }
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
}

run();
