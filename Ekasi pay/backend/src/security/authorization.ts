import type { NextFunction, Request, Response } from 'express';

import { getPgPool } from '../dbPg.js';
import { isPostgresMode } from '../dbRuntime.js';
import { requireOpsAuth } from '../opsAuth.js';

export const OPERATOR_ROLES = [
  'admin',
  'operations',
  'compliance',
  'finance',
  'support',
] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export const CAPABILITIES = [
  'operators:read',
  'operators:write',
  'users:read',
  'users:write',
  'user-roles:request',
  'monitoring:read',
  'audit:read',
  'reconciliation:run',
  'loans:read',
  'loans:request-disbursement',
  'finance:approve',
  'balance-adjustments:request',
  'refunds:request',
  'limits:request',
  'compliance:read',
  'compliance:write',
  'kyc:assign',
  'kyc:read',
  'kyc:download',
  'merchants:read',
  'merchants:review',
  'merchant-overrides:request',
  'privacy:read',
  'privacy:manage',
  'support:read',
  'fraud:read',
  'fraud:investigate',
  'risk-rules:manage',
  'posting-control:manage',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ROLE_CAPABILITIES: Readonly<Record<OperatorRole, ReadonlySet<Capability>>> = {
  admin: new Set(CAPABILITIES),
  operations: new Set([
    'users:read', 'monitoring:read', 'reconciliation:run', 'loans:read',
    'loans:request-disbursement', 'merchants:read', 'support:read', 'fraud:read',
    'fraud:investigate',
  ]),
  compliance: new Set([
    'users:read', 'audit:read', 'compliance:read', 'compliance:write',
    'kyc:assign', 'kyc:read', 'kyc:download', 'merchants:read',
    'merchants:review', 'merchant-overrides:request', 'privacy:read',
    'privacy:manage',
    'fraud:read', 'fraud:investigate',
  ]),
  finance: new Set([
    'users:read', 'audit:read', 'reconciliation:run', 'loans:read',
    'finance:approve', 'balance-adjustments:request', 'refunds:request', 'limits:request',
  ]),
  support: new Set(['users:read', 'merchants:read', 'support:read']),
};

export function roleHasCapability(role: string, capability: Capability): boolean {
  if (!OPERATOR_ROLES.includes(role as OperatorRole)) return false;
  return ROLE_CAPABILITIES[role as OperatorRole].has(capability);
}

/** Deny by default. Authentication is followed by a live DB role check. */
export function requireCapability(capability: Capability) {
  return [
    requireOpsAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      if (!req.opsAuth || !isPostgresMode()) {
        return res.status(403).json({ error: 'Capability unavailable.' });
      }
      const current = await getPgPool().query<{
        role: string;
        is_active: boolean;
        token_version: number;
      }>(
        `SELECT role, is_active, token_version FROM ops_admin_users WHERE id = $1`,
        [req.opsAuth.operatorId],
      );
      const row = current.rows[0];
      if (
        !row ||
        !row.is_active ||
        row.token_version !== req.opsAuth.tokenVersion
      ) {
        return res.status(401).json({ error: 'Operator session revoked.' });
      }
      if (!roleHasCapability(row.role, capability)) {
        return res.status(403).json({
          error: 'Required capability is not assigned.',
          capability,
        });
      }
      req.opsAuth.role = row.role as OperatorRole;
      return next();
    },
  ] as const;
}

export function assertResourceScope(
  actorId: string,
  ownerId: string,
  hasCrossTenantCapability = false,
): boolean {
  return actorId === ownerId || hasCrossTenantCapability;
}

export const ENDPOINT_CAPABILITIES = Object.freeze({
  'GET /ops/admin-users': 'operators:read',
  'POST /ops/admin-users': 'operators:write',
  'PATCH /ops/admin-users/:id': 'operators:write',
  'DELETE /ops/admin-users/:id': 'operators:write',
  'GET /admin/users': 'users:read',
  'PATCH /admin/users/:id': 'user-roles:request',
  'GET /admin/loans': 'loans:read',
  'PATCH /admin/loans/:id/disburse': 'loans:request-disbursement',
  'GET /admin/compliance/flags': 'compliance:read',
  'PATCH /admin/compliance/flags/:id': 'compliance:write',
  'GET /admin/audit-events': 'audit:read',
  'POST /admin/reconciliation/run': 'reconciliation:run',
  'GET /admin/merchants': 'merchants:read',
  'GET /admin/merchants/:id': 'merchants:read',
  'GET /admin/merchants/:id/documents/:docType': 'kyc:download',
  'PATCH /admin/merchants/:id/approval': 'merchants:review',
} satisfies Record<string, Capability>);
