/**
 * Rotate an ops operator password and optionally clear MFA enrollment.
 * Never commit credentials. Required env:
 *   DATABASE_URL
 *   ROTATE_OPERATOR_USERNAME
 *   ROTATE_OPERATOR_PASSWORD  (min 14 chars)
 *   ROTATE_CONFIRM=ROTATE_OPERATOR
 * Optional:
 *   ROTATE_RESET_MFA=1  — forces re-enrollment on next login
 */
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (required('ROTATE_CONFIRM') !== 'ROTATE_OPERATOR') {
  throw new Error('ROTATE_CONFIRM must equal ROTATE_OPERATOR');
}

const username = required('ROTATE_OPERATOR_USERNAME').toLowerCase();
const password = required('ROTATE_OPERATOR_PASSWORD');
if (password.length < 14) {
  throw new Error('ROTATE_OPERATOR_PASSWORD must be at least 14 characters');
}

const resetMfa = process.env.ROTATE_RESET_MFA === '1';
const pool = new pg.Pool({ connectionString: required('DATABASE_URL'), max: 1 });
const passwordHash = await bcrypt.hash(password, 12);

try {
  const updated = await pool.query(
    `UPDATE ops_admin_users
        SET password_hash = $1,
            password_changed_at = NOW(),
            token_version = token_version + 1,
            updated_at = NOW()
            ${resetMfa ? ', mfa_secret_encrypted = NULL, mfa_enabled_at = NULL' : ''}
      WHERE username = $2
      RETURNING id, username, role`,
    [passwordHash, username],
  );
  if (!updated.rowCount) {
    throw new Error(`Operator "${username}" was not found`);
  }
  console.log(`Rotated operator ${updated.rows[0].username} (${updated.rows[0].role})`);
  if (resetMfa) console.log('MFA enrollment was cleared; next login will require setup.');
} finally {
  await pool.end();
}
