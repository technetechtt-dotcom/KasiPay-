/** In-memory ring buffer for field-test support (paired with toast errors). */

const MAX = 100;
const lines: string[] = [];

/**
 * Redact obvious identifiers from a string so support snapshots don't leak
 * voucher IDs, UUIDs, phone numbers, JWTs etc. Keep enough shape (length / kind)
 * for a developer to recognise what was there.
 */
function redact(input: string): string {
  return (
    input
      // Named secrets and document payloads.
      .replace(
        /\b(pin|otp|code|password|token|refreshToken|idDocument|document|dataBase64)\s*[:=]\s*["']?[^,\s"'}]+/gi,
        '$1=[redacted]',
      )
      // Bearer / JWT tokens.
      .replace(
        /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
        '[jwt]',
      )
      // UUIDs.
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        '[uuid]',
      )
      // Voucher / generic id prefixes (cs_, csv_, ld_, etc.) — anything looking like prefix_<hex/alphanum>.
      .replace(/\b([a-z]{2,6})_[A-Za-z0-9]{6,}\b/g, '$1_[id]')
      // SA-style phone numbers.
      .replace(/\b(\+?27|0)\d{9}\b/g, '[phone]')
      // South African identity numbers.
      .replace(/\b\d{13}\b/g, '[id-document]')
      // Email addresses.
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
  );
}

export function pushClientDiag(message: string): void {
  const row = `[${new Date().toISOString()}] ${redact(message)}`;
  lines.push(row);
  while (lines.length > MAX) lines.shift();
}

export function snapshotClientDiag(): string {
  if (typeof window === 'undefined') return lines.join('\n');
  const safeUrl = redact(
    `${window.location.origin}${window.location.pathname}${window.location.search ? '?[query]' : ''}${window.location.hash ? '#[hash]' : ''}`,
  );
  const base = [`URL: ${safeUrl}`, `Online: ${navigator.onLine}`, ...lines];
  return base.join('\n');
}
