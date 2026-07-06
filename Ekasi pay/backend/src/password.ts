import bcrypt from 'bcryptjs';

/**
 * Cost factor for PIN hashing. Configurable via BCRYPT_ROUNDS so we can bump
 * it (e.g. to 12) in production without recompiling. Bounded to safe values.
 */
const ROUNDS = (() => {
  const raw = Number(process.env.BCRYPT_ROUNDS);
  if (!Number.isFinite(raw) || raw < 8 || raw > 14) return 12;
  return Math.floor(raw);
})();

export function hashPin(pin: string): string {
  const salt = bcrypt.genSaltSync(ROUNDS);
  return bcrypt.hashSync(pin, salt);
}

export function verifyPin(pin: string, pinHash: string): boolean {
  return bcrypt.compareSync(pin, pinHash);
}
