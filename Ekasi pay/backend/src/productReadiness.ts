import { createHash } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';
import type { Pool, PoolClient } from 'pg';

import { IS_LOCAL_ENV } from './config.js';
import { getPgPool } from './dbPg.js';
import { isPostgresMode } from './dbRuntime.js';

export const REGULATED_PRODUCTS = [
  'stokvel',
  'lending',
  'merchant_credit',
  'insurance',
  'utilities',
] as const;

export type RegulatedProduct = (typeof REGULATED_PRODUCTS)[number];
export type ProductEnvironment = 'sandbox' | 'production';

export const REQUIRED_READINESS_CONTROLS = [
  'legal',
  'provider',
  'accounting',
  'customer_journey',
  'reconciliation',
  'testing',
  'runbook',
] as const;

export type ReadinessControl = (typeof REQUIRED_READINESS_CONTROLS)[number];

const PRODUCT_PATHS: ReadonlyArray<[RegExp, RegulatedProduct]> = [
  [/^\/stokvel(?:\/|$)/u, 'stokvel'],
  [/^\/regulated\/stokvel(?:\/|$)/u, 'stokvel'],
  [/^\/lending(?:\/|$)/u, 'lending'],
  [/^\/credit(?:\/|$)/u, 'merchant_credit'],
  [/^\/merchant-credit(?:\/|$)/u, 'merchant_credit'],
  [/^\/insurance(?:\/|$)/u, 'insurance'],
  [/^\/regulated\/insurance(?:\/|$)/u, 'insurance'],
  [/^\/utility-purchases(?:\/|$)/u, 'utilities'],
  [/^\/regulated\/utilities(?:\/|$)/u, 'utilities'],
];

const RETIRED_MUTATION_PATHS = [
  /^\/stokvel(?:\/|$)/u,
  /^\/insurance(?:\/|$)/u,
  /^\/credit\/transactions(?:\/|$)/u,
];

function envEnabled(name: string): boolean {
  return /^(1|true|yes|on)$/iu.test(process.env[name]?.trim() ?? '');
}

export function configuredProductEnvironment(): ProductEnvironment {
  return IS_LOCAL_ENV ? 'sandbox' : 'production';
}

export function productConfigEnabled(
  product: RegulatedProduct,
  environment: ProductEnvironment,
): boolean {
  if (environment === 'sandbox') return envEnabled('PHASE7_SANDBOX_ENABLED');
  return (
    envEnabled('REGULATED_PRODUCTS_PRODUCTION_ENABLED') &&
    envEnabled(`PRODUCT_${product.toUpperCase()}_PRODUCTION_ENABLED`)
  );
}

export function canonicalEvidenceDigest(input: {
  product: RegulatedProduct;
  environment: ProductEnvironment;
  control: ReadinessControl;
  decision: 'approved' | 'rejected' | 'withdrawn';
  authority: string;
  artifactUri: string;
  artifactSha256: string;
  notes: string;
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      artifactSha256: input.artifactSha256.toLowerCase(),
      artifactUri: input.artifactUri,
      authority: input.authority,
      control: input.control,
      decision: input.decision,
      environment: input.environment,
      notes: input.notes,
      product: input.product,
    }))
    .digest('hex');
}

type Queryable = Pick<Pool | PoolClient, 'query'>;

export async function evaluateProductReadinessPg(
  db: Queryable,
  product: RegulatedProduct,
  environment: ProductEnvironment,
) {
  const result = await db.query<{
    control: ReadinessControl;
    decision: string;
    evidence_sha256: string;
    artifact_sha256: string;
    recorded_at: string;
    expires_at: string | null;
  }>(
    `SELECT DISTINCT ON (control)
            control,decision,evidence_sha256,artifact_sha256,recorded_at,expires_at
       FROM product_readiness_evidence
      WHERE product = $1 AND environment = $2
      ORDER BY control,recorded_at DESC,id DESC`,
    [product, environment],
  );
  const latest = new Map(result.rows.map((row) => [row.control, row]));
  const now = Date.now();
  const controls = REQUIRED_READINESS_CONTROLS.map((control) => {
    const row = latest.get(control);
    const current = Boolean(
      row &&
      row.decision === 'approved' &&
      (!row.expires_at || new Date(row.expires_at).getTime() > now),
    );
    return {
      control,
      approved: current,
      evidenceSha256: current ? row!.evidence_sha256 : null,
      artifactSha256: current ? row!.artifact_sha256 : null,
      recordedAt: row?.recorded_at ?? null,
    };
  });
  const databaseApproved = controls.every((item) => item.approved);
  const configEnabled = productConfigEnabled(product, environment);
  return {
    product,
    environment,
    enabled: databaseApproved && configEnabled,
    databaseApproved,
    configEnabled,
    controls,
    missing: controls.filter((item) => !item.approved).map((item) => item.control),
  };
}

export async function assertProductReadyPg(
  db: Queryable,
  product: RegulatedProduct,
  environment = configuredProductEnvironment(),
) {
  const status = await evaluateProductReadinessPg(db, product, environment);
  if (!status.enabled) {
    throw Object.assign(
      new Error(
        `${product} is disabled for ${environment}; immutable readiness evidence and deployment configuration are incomplete.`,
      ),
      { status: 423, code: 'PRODUCT_NOT_READY', readiness: status },
    );
  }
  return status;
}

/**
 * Central enforcement for every legacy and Phase 7 regulated-product mutation.
 * Reads remain available for statements, evidence and migration review.
 */
export async function enforceRegulatedProductReadiness(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (req.path.startsWith('/ops/product-readiness')) return next();
  const match = PRODUCT_PATHS.find(([pattern]) => pattern.test(req.path));
  if (!match) return next();
  const product = match[1];
  if (!isPostgresMode()) {
    return res.status(423).json({
      error: `${product} mutations require PostgreSQL readiness controls.`,
      code: 'PRODUCT_NOT_READY',
    });
  }
  try {
    const readiness = await assertProductReadyPg(getPgPool(), product);
    req.productReadiness = readiness;
    if (RETIRED_MUTATION_PATHS.some((pattern) => pattern.test(req.path))) {
      return res.status(410).json({
        error:
          'This mutable legacy endpoint is retired. Use the append-only Phase 7 regulated API.',
        code: 'PHASE7_API_REQUIRED',
      });
    }
    return next();
  } catch (error) {
    const controlled = error as {
      status?: number;
      code?: string;
      message?: string;
      readiness?: unknown;
    };
    return res.status(controlled.status ?? 423).json({
      error: controlled.message ?? 'Product is not ready.',
      code: controlled.code ?? 'PRODUCT_NOT_READY',
      readiness: controlled.readiness,
    });
  }
}
