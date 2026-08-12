/** Normalize a browser origin from env or Render `fromService` host values. */
export function normalizeFrontendOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;

  let origin = trimmed;
  if (!/^https?:\/\//i.test(origin)) {
    origin = `https://${origin}`;
  }

  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    const isLocalHost =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.localhost');
    if (!host.includes('.') && !isLocalHost) {
      url.hostname = `${url.hostname}.onrender.com`;
    }
    if (url.protocol === 'http:' && url.hostname.endsWith('.onrender.com')) {
      url.protocol = 'https:';
    }
    return url.origin;
  } catch {
    return origin.replace(/\/$/, '');
  }
}
