import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { Request, Response } from 'express';

export const refreshCookieEnabled =
  process.env.REFRESH_COOKIE_ENABLED === 'true';

function cookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie ?? '';
  for (const item of raw.split(';')) {
    const [key, ...parts] = item.trim().split('=');
    if (key === name) return decodeURIComponent(parts.join('='));
  }
  return undefined;
}

export function setRefreshCookie(res: Response, refreshToken: string): string | undefined {
  if (!refreshCookieEnabled) return refreshToken;
  const csrf = randomBytes(24).toString('base64url');
  res.append(
    'Set-Cookie',
    `__Host-ekasi_refresh=${encodeURIComponent(refreshToken)}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=604800`,
  );
  res.append(
    'Set-Cookie',
    `ekasi_csrf=${csrf}; Path=/api; Secure; SameSite=Strict; Max-Age=604800`,
  );
  return undefined;
}

export function refreshFromRequest(req: Request): string | undefined {
  const bodyToken =
    typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : undefined;
  if (bodyToken) {
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.BEARER_REFRESH_COMPATIBILITY !== 'true'
    ) return undefined;
    return bodyToken;
  }
  return cookie(req, '__Host-ekasi_refresh');
}

export function verifyCsrfForCookieRefresh(req: Request): boolean {
  if (!cookie(req, '__Host-ekasi_refresh')) return true;
  const cookieValue = cookie(req, 'ekasi_csrf') ?? '';
  const headerValue =
    typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '';
  if (!cookieValue || cookieValue.length !== headerValue.length) return false;
  return timingSafeEqual(Buffer.from(cookieValue), Buffer.from(headerValue));
}

export function clearRefreshCookie(res: Response): void {
  res.append('Set-Cookie', '__Host-ekasi_refresh=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  res.append('Set-Cookie', 'ekasi_csrf=; Path=/api; Secure; SameSite=Strict; Max-Age=0');
}
