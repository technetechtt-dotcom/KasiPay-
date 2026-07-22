import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import {
  listFrontendOrigins,
  LOGIN_RATE_LIMIT_PER_MIN,
  NODE_ENV,
  IS_LOCAL_ENV,
  PORT,
} from './config.js';
import { getDb } from './db.js';
import { getPgPool } from './dbPg.js';
import { closeDataStore, initDataStore, isPostgresMode } from './dbRuntime.js';
import { validateProductionConfig } from './validateProductionConfig.js';
import { initMonitoring } from './monitoring.js';
import { activityRouter } from './routes/activity.js';
import { activityRouterPg } from './routes/activityPg.js';
import { adminRouter } from './routes/admin.js';
import { adminRouterPg } from './routes/adminPg.js';
import { adminMonitoringRouterPg } from './routes/adminMonitoringPg.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { adminUsersRouterPg } from './routes/adminUsersPg.js';
import { opsAuthRouterPg } from './routes/opsAuthPg.js';
import { ensureOpsAuthStore } from './opsAuth.js';
import { analyticsRouter } from './routes/analytics.js';
import { analyticsRouterPg } from './routes/analyticsPg.js';
import { authRouter } from './routes/auth.js';
import { authRouterPg } from './routes/authPg.js';
import { cashSendRouter } from './routes/cashSendRoutes.js';
import { cashSendRouterPg } from './routes/cashSendPg.js';
import { commissionsRouter } from './routes/commissions.js';
import { commissionsRouterPg } from './routes/commissionsPg.js';
import { creditRouter } from './routes/credit.js';
import { creditRouterPg } from './routes/creditPg.js';
import { expensesRouter } from './routes/expenses.js';
import { expensesRouterPg } from './routes/expensesPg.js';
import { extensionAccountRouter } from './routes/extensionAccount.js';
import { extensionAccountRouterPg } from './routes/extensionAccountPg.js';
import { extensionProgramsRouter } from './routes/extensionPrograms.js';
import { extensionProgramsRouterPg } from './routes/extensionProgramsPg.js';
import { extensionSuppliersRouter } from './routes/extensionSuppliers.js';
import { extensionSuppliersRouterPg } from './routes/extensionSuppliersPg.js';
import { meRouter } from './routes/me.js';
import { meRouterPg } from './routes/mePg.js';
import { merchantsRouter } from './routes/merchants.js';
import { merchantsRouterPg } from './routes/merchantsPg.js';
import { productsRouter } from './routes/products.js';
import { productsRouterPg } from './routes/productsPg.js';
import { salesRouter } from './routes/sales.js';
import { salesRouterPg } from './routes/salesPg.js';
import { stockIntakeRouter } from './routes/stockIntake.js';
import { stockIntakeRouterPg } from './routes/stockIntakePg.js';
import { transfersRouter } from './routes/transfers.js';
import { transfersRouterPg } from './routes/transfersPg.js';
import { utilitiesRouter } from './routes/utilities.js';
import { utilitiesRouterPg } from './routes/utilitiesPg.js';
import { walletsRouter } from './routes/wallets.js';
import { walletsRouterPg } from './routes/walletsPg.js';
import { recordAuditEvent } from './services/audit.js';
import { recordAuditEventPg } from './services/auditPg.js';
import { enforceProductionControls } from './middleware/productionControls.js';
import { sharedRateLimitStore } from './middleware/sharedRateLimit.js';
import { approvalsRouterPg } from './security/approvalsPg.js';
import { privacyRouterPg } from './routes/privacyPg.js';
import { riskOpsRouterPg } from './routes/riskOpsPg.js';
import { phase6OpsRouterPg } from './routes/phase6OpsPg.js';
import { providerCallbacksRouterPg } from './routes/providerCallbacksPg.js';
import { refundsRouterPg } from './routes/refundsPg.js';
import { hashSensitive, metricsSnapshot, observeMetric, structuredLog } from './observability.js';
import {
  phase7OpsRouterPg,
  phase7ProductsRouterPg,
} from './routes/phase7ProductsPg.js';
import { enforceRegulatedProductReadiness } from './productReadiness.js';
import {
  customerProtectionOpsRouterPg,
  customerProtectionRouterPg,
} from './routes/customerProtectionPg.js';

validateProductionConfig();
initMonitoring();
await initDataStore();
await ensureOpsAuthStore();

const app = express();
app.disable('x-powered-by');

function redactUrlForLog(url: string): string {
  return url
    .replace(/([?&](?:pin|otp|code|token|refreshToken|idDocument|document)=)[^&]*/gi, '$1[REDACTED]')
    .replace(/\b\d{13}\b/g, '[REDACTED_ID]');
}

app.use((req, res, next) => {
  const incoming =
    typeof req.headers['x-request-id'] === 'string' ?
      req.headers['x-request-id']
    : Array.isArray(req.headers['x-request-id']) ?
      req.headers['x-request-id'][0]
    : '';
  const rid = incoming && /^[A-Za-z0-9._-]{1,128}$/.test(incoming) ? incoming : randomUUID();
  const correlationHeader = req.headers['x-correlation-id'];
  const correlation =
    typeof correlationHeader === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(correlationHeader)
      ? correlationHeader
      : rid;
  req.requestId = rid;
  req.correlationId = correlation;
  res.setHeader('X-Request-Id', rid);
  res.setHeader('X-Correlation-Id', correlation);
  next();
});

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const rid = String(res.getHeader('X-Request-Id') ?? '');
    const durationMs = Date.now() - t0;
    observeMetric('http.request.duration_ms', durationMs);
    if (res.statusCode >= 500) observeMetric('http.errors.5xx');
    structuredLog(res.statusCode >= 500 ? 'error' : 'info', 'http.request.completed', {
      requestId: rid,
      correlationId: req.correlationId,
      method: req.method,
      path: redactUrlForLog(req.originalUrl),
      statusCode: res.statusCode,
      durationMs,
    });
    if (!req.originalUrl.startsWith('/api') || req.originalUrl === '/api/refresh') {
      return;
    }
    const auditMessage = `${req.method} ${redactUrlForLog(req.originalUrl)} -> ${res.statusCode} (${durationMs}ms)`;
    const auditType = `http.${req.method.toLowerCase()}`;
    const actorUserId = req.auth?.userId ?? null;
    if (isPostgresMode()) {
      void recordAuditEventPg(getPgPool(), {
        type: auditType,
        message: auditMessage,
        actorUserId,
      }).catch(() => {
        /* audit log failures must not break requests */
      });
      return;
    }
    try {
      recordAuditEvent(getDb(), {
        type: auditType,
        message: auditMessage,
        actorUserId,
      });
    } catch {
      /* audit log failures must not break requests */
    }
  });
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: NODE_ENV === 'development' ? false : { maxAge: 31_536_000, includeSubDomains: true, preload: true },
}));

app.get('/health/live', (_req, res) => {
  res.json({ ok: true, service: 'ekasi-pay-api' });
});
app.get('/health', (_req, res) => res.json({ ok: true, service: 'ekasi-pay-api' }));
app.get('/health/ready', async (_req, res) => {
  if (!isPostgresMode()) {
    return res.status(IS_LOCAL_ENV ? 200 : 503).json({ ok: IS_LOCAL_ENV, database: 'local' });
  }
  try {
    await getPgPool().query('SELECT 1');
    if (!IS_LOCAL_ENV) {
      const backup = await getPgPool().query(
        `SELECT 1 FROM backup_verification_markers
          WHERE encrypted AND verified_at IS NOT NULL AND expires_at > clock_timestamp()
          ORDER BY completed_at DESC LIMIT 1`,
      );
      if (!backup.rows[0]) {
        return res.status(503).json({ ok: false, database: 'ready', backupFreshness: 'stale_or_unverified' });
      }
    }
    return res.json({ ok: true, database: 'ready', backupFreshness: IS_LOCAL_ENV ? 'not_required_local' : 'verified' });
  } catch {
    return res.status(503).json({ ok: false, database: 'unavailable' });
  }
});
app.get('/internal/metrics', (_req, res) => res.json(metricsSnapshot()));

/**
 * CORS policy. In development we allow any origin so vite dev / Capacitor /
 * adb-reverse all work. In every other environment we require an explicit
 * allowlist (FRONTEND_ORIGIN / FRONTEND_ORIGINS).
 */
const allowAnyOrigin = NODE_ENV === 'development';
app.use(
  cors({
    origin: allowAnyOrigin
      ? true
      : (origin, cb) => {
          if (!origin) {
            cb(null, true);
            return;
          }
          const allowed = listFrontendOrigins();
          if (allowed.includes(origin)) {
            cb(null, true);
          } else {
            console.warn(
              `[cors] blocked origin=${origin} allowed=${allowed.join(',')}`,
            );
            cb(null, false);
          }
        },
    credentials: true,
  })
);
app.use((req, res, next) => {
  // Compliance document uploads are base64 JSON and need a higher limit.
  // Match both /api and /api/v1 mounts (see docs/api-versioning.md).
  if (
    req.method === 'POST' &&
    /\/api(?:\/v1)?\/merchants\/me\/documents(?:\?|$)/u.test(req.originalUrl)
  ) {
    return express.json({ limit: '6mb' })(req, res, next);
  }
  return express.json({ limit: '512kb' })(req, res, next);
});

/** Per-IP limiter for high-risk auth POSTs (register / login). */
const authBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: LOGIN_RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  ...sharedRateLimitStore(),
  message: {
    error: 'Too many attempts from this network. Wait a minute and try again.',
  },
});

/**
 * Refresh is called silently by background tabs, so it gets a higher limit
 * than login. Still per-IP to discourage brute-rotation attempts.
 */
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Math.max(60, LOGIN_RATE_LIMIT_PER_MIN * 6),
  standardHeaders: true,
  legacyHeaders: false,
  ...sharedRateLimitStore(),
  message: {
    error: 'Too many session refreshes — please reload the app.',
  },
});

/** Forgot-PIN endpoints get their own tight limiter (account takeover surface). */
const pinResetLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  ...sharedRateLimitStore(),
  message: {
    error: 'Too many PIN-reset attempts — please wait a minute.',
  },
});

const api = express.Router();
api.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (req.path === '/refresh') return refreshLimiter(req, res, next);
  if (
    req.path === '/pin-reset/request' ||
    req.path === '/pin-reset/confirm' ||
    req.path === '/credit/verify/request' ||
    req.path === '/credit/verify/confirm'
  ) {
    return pinResetLimiter(req, res, next);
  }
  if (
    req.path === '/register' ||
    req.path === '/login' ||
    req.path === '/ops/login'
  ) {
    return authBurstLimiter(req, res, next);
  }
  next();
});
api.use(enforceProductionControls);
api.use(enforceRegulatedProductReadiness);
api.use(async (req, _res, next) => {
  if (!isPostgresMode() || req.method !== 'POST') return next();
  const events: Record<string, string[]> = {
    '/pin-reset/request': ['otp_request'],
    '/pin-reset/confirm': ['otp_verify'],
    '/credit/verify/request': ['otp_request'],
    '/credit/verify/confirm': ['otp_verify'],
    '/cash-send/lookup': ['voucher_lookup'],
    '/cash-send/collect': ['voucher_collect', 'cash_out'],
  };
  const eventTypes = events[req.path];
  if (!eventTypes) return next();
  try {
    for (const eventType of eventTypes) {
      await getPgPool().query(
        `INSERT INTO risk_signals
           (id,event_type,device_hash,ip_hash,request_id,correlation_id,metadata)
         VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb)`,
        [
          randomUUID(),
          eventType,
          typeof req.headers['x-device-id'] === 'string' ? hashSensitive(req.headers['x-device-id']) : null,
          hashSensitive(req.ip ?? ''),
          req.requestId,
          req.correlationId,
        ],
      );
    }
  } catch {
    observeMetric('risk.signal.failure');
    return next(Object.assign(new Error('Risk signal store unavailable.'), { status: 503 }));
  }
  return next();
});

if (isPostgresMode()) {
  api.use(authRouterPg);
  // Ops/admin must mount before routers that call router.use(requireAuth).
  // Those stacks run for every request that enters them and would 401 /ops/login
  // (and reject ops JWTs) before these routes are reached.
  api.use(opsAuthRouterPg);
  api.use(approvalsRouterPg);
  api.use(phase6OpsRouterPg);
  api.use(phase7OpsRouterPg);
  api.use(customerProtectionOpsRouterPg);
  api.use(providerCallbacksRouterPg);
  api.use(refundsRouterPg);
  api.use(privacyRouterPg);
  api.use(riskOpsRouterPg);
  api.use(adminUsersRouterPg);
  api.use(adminMonitoringRouterPg);
  api.use(adminRouterPg);
  api.use(meRouterPg);
  api.use(walletsRouterPg);
  api.use(merchantsRouterPg);
  api.use(activityRouterPg);
  api.use(productsRouterPg);
  api.use(transfersRouterPg);
  api.use(salesRouterPg);
  api.use(expensesRouterPg);
  api.use(creditRouterPg);
  api.use(analyticsRouterPg);
  api.use(stockIntakeRouterPg);
  api.use(extensionSuppliersRouterPg);
  api.use(extensionProgramsRouterPg);
  api.use(extensionAccountRouterPg);
  api.use(cashSendRouterPg);
  api.use(commissionsRouterPg);
  api.use(utilitiesRouterPg);
  api.use(phase7ProductsRouterPg);
  api.use(customerProtectionRouterPg);
  api.use((_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });
} else {
  api.use(authRouter);
  api.use(meRouter);
  api.use(merchantsRouter);
  api.use(activityRouter);
  api.use(walletsRouter);
  api.use(transfersRouter);
  api.use(productsRouter);
  api.use(salesRouter);
  api.use(expensesRouter);
  api.use(creditRouter);
  api.use(extensionSuppliersRouter);
  api.use(extensionProgramsRouter);
  api.use(extensionAccountRouter);
  api.use(cashSendRouter);
  api.use(commissionsRouter);
  api.use(analyticsRouter);
  api.use(stockIntakeRouter);
  api.use(adminUsersRouter);
  api.use(adminRouter);
  api.use(utilitiesRouter);
}

// Versioned clients use /api/v1. The unversioned mount remains as a
// compatibility alias until the documented deprecation window expires.
app.use('/api/v1', api);
app.use('/api', api);

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const e = err as { status?: number; message?: string };
    let status = typeof e.status === 'number' ? e.status : 500;
    const rawMessage = e.message ?? 'Request failed';
    if (
      status === 500 &&
      (rawMessage.includes('CORS') || rawMessage.includes('Origin header required'))
    ) {
      status = 403;
    }
    const message = status >= 500 ? 'Unexpected server error' : rawMessage;
    res.status(status).json({ error: message });
  }
);

const server = app.listen(PORT, () => {
  console.log(`KasiPay API listening on http://localhost:${PORT}`);
});

/** Graceful shutdown so SQLite has a chance to flush + checkpoint. */
function shutdown(signal: string) {
  console.info(`Received ${signal} — shutting down…`);
  server.close((err) => {
    if (err) {
      console.error('Error closing server', err);
      process.exitCode = 1;
    }
    void closeDataStore()
      .catch((e) => {
        console.error('Error closing DB', e);
        process.exitCode = 1;
      })
      .finally(() => process.exit());
  });
  setTimeout(() => {
    console.warn('Force exit after 8s.');
    process.exit(1);
  }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
