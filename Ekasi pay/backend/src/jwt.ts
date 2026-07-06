import jwt from 'jsonwebtoken';

import { ACCESS_TOKEN_TTL_SEC, JWT_SECRET } from './config.js';

export type JwtPayload = {
  sub: string;
  phone: string;
  role: string;
  /** Server-side session row id (refresh + revoke). */
  sid: string;
};

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL_SEC,
    issuer: 'ekasi-pay-api',
  });
}

export function verifyToken(token: string): JwtPayload {
  const decoded = jwt.verify(token, JWT_SECRET, {
    issuer: 'ekasi-pay-api',
  });
  if (typeof decoded !== 'object' || decoded === null || !('sub' in decoded)) {
    throw new Error('Invalid token payload');
  }
  const obj = decoded as Record<string, unknown>;
  const sub = String(obj.sub);
  const phone = String(obj.phone);
  const role = String(obj.role);
  const sid =
    typeof obj.sid === 'string' && obj.sid.length > 0 ? obj.sid : '';
  if (!sid) {
    throw new Error('Missing session id in token');
  }
  return { sub, phone, role, sid };
}
