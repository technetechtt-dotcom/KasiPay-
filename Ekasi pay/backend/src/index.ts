import { randomUUID } from 'node:crypto';

import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import {
  listFrontendOrigins,
  LOGIN_RATE_LIMIT_PER_MIN,
  NODE_ENV,
  PORT,
} from './config.js';
import { getDb } from './db.js';
import { getPgPool } from './dbPg.js';
import { closeDataStore, initDataStore, isPostgresMode } from './dbRuntime.js';
import { validateProductionConfig } from './validateProductionConfig.js';
import { activityRouter } from './routes/activity.js';
import { activityRouterPg } from './routes/activityPg.js';
import { adminRouter } from './routes/admin.js';
import { adminRouterPg } from './routes/adminPg.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { adminUsersRouterPg } from './routes/adminUsersPg.js';
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
import { transfersRouter } from './routes/transfers.js';
import { transfersRouterPg } from './routes/transfersPg.js';
import { utilitiesRouter } from './routes/utilities.js';
import { utilitiesRouterPg } from './routes/utilitiesPg.js';
import { walletsRouter } from './routes/wallets.js';
import { walletsRouterPg } from './routes/walletsPg.js';
import { recordAuditEvent } from './services/audit.js';
import { recordAuditEventPg } from './services/auditPg.js';

validateProductionConfig();
await initDataStore();

const app = express();
app.disable('x-powered-by');

function redactUrlForLog(url: string): string {
  return url.replace(/([?&]pin=)[^&]*/gi, '$1[REDACTED]');
}

app.use((req, res, next) => {
  const incoming =
    typeof req.headers['x-request-id'] === 'string' ?
      req.headers['x-request-id']
    : Array.isArray(req.headers['x-request-id']) ?
      req.headers['x-request-id'][0]
    : '';
  const rid = incoming?.length ? incoming : randomUUID();
  res.setHeader('X-Request-Id', rid);
  next();
});

app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const rid = String(res.getHeader('X-Request-Id') ?? '');
    const durationMs = Date.now() - t0;
    console.info(
      `${rid} ${req.method} ${redactUrlForLog(req.originalUrl)} -> ${res.statusCode} (${durationMs}ms)`
    );
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

app.use(helmet());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ekasi-pay-api' });
});

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
            cb(Object.assign(new Error('Origin header required'), { status: 403 }));
            return;
          }
          const allowed = listFrontendOrigins();
          if (allowed.includes(origin)) {
            cb(null, true);
          } else {
            cb(
              Object.assign(new Error(`Origin ${origin} not allowed by CORS`), {
                status: 403,
              }),
            );
          }
        },
    credentials: false,
  })
);
app.use(express.json({ limit: '512kb' }));

/** Per-IP limiter for high-risk auth POSTs (register / login). */
const authBurstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: LOGIN_RATE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
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
    req.path === '/pin-reset/confirm'
  ) {
    return pinResetLimiter(req, res, next);
  }
  if (['/register', '/login'].includes(req.path)) {
    return authBurstLimiter(req, res, next);
  }
  next();
});

if (isPostgresMode()) {
  api.use(authRouterPg);
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
  api.use(extensionSuppliersRouterPg);
  api.use(extensionProgramsRouterPg);
  api.use(extensionAccountRouterPg);
  api.use(cashSendRouterPg);
  api.use(commissionsRouterPg);
  api.use(adminUsersRouterPg);
  api.use(adminRouterPg);
  api.use(utilitiesRouterPg);
  api.use((_req, res) => {
    res.status(501).json({
      error: 'This endpoint is not available in Postgres mode.',
    });
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
  api.use(adminUsersRouter);
  api.use(adminRouter);
  api.use(utilitiesRouter);
}

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
  console.log(`Ekasi Pay API listening on http://localhost:${PORT}`);
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
