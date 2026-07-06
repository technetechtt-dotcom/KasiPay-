import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

import {
  NODE_ENV,
  OPS_DASHBOARD_PASSWORD,
  OPS_JWT_SECRET,
  OPS_TOKEN_TTL_SEC,
} from './config.js';

export type OpsAuth = { operator: string };

declare global {
  namespace Express {
    interface Request {
      opsAuth?: OpsAuth;
    }
  }
}

function passwordMatches(candidate: string): boolean {
  const stored = OPS_DASHBOARD_PASSWORD;
  if (!stored) return false;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$')) {
    return bcrypt.compareSync(candidate, stored);
  }
  if (NODE_ENV === 'production') {
    throw new Error(
      'OPS_DASHBOARD_PASSWORD must be a bcrypt hash in production.',
    );
  }
  return candidate === stored;
}

export function issueOpsToken(): string {
  return jwt.sign({ sub: 'ops-operator', role: 'ops' }, OPS_JWT_SECRET, {
    expiresIn: OPS_TOKEN_TTL_SEC,
  });
}

export function loginHandler(req: Request, res: Response) {
  const password =
    typeof req.body?.password === 'string' ? req.body.password : '';
  if (!password || !passwordMatches(password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = issueOpsToken();
  return res.json({
    token,
    expiresInSec: OPS_TOKEN_TTL_SEC,
  });
}

export function requireOpsAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const payload = jwt.verify(token, OPS_JWT_SECRET) as { sub?: string };
    if (payload.sub !== 'ops-operator') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.opsAuth = { operator: payload.sub };
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
