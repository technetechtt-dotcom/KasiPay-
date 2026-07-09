import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

import {
  createOpsUserHandler,
  deleteOpsUserHandler,
  listOpsUsersHandler,
  loginHandler,
  opsMeHandler,
  requireOpsAuth,
  requireOpsSuperAdmin,
  updateOpsUserHandler,
} from './auth.js';
import {
  NODE_ENV,
  OPS_DASHBOARD_ORIGIN,
  OPS_PORT,
  validateOpsConfig,
} from './config.js';
import { closeDataStore, initOpsAuthStore } from './db.js';
import { monitoringRouter } from './routes/monitoring.js';
import { cashSendOpsRouter } from './routes/cashSend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

validateOpsConfig();
await initOpsAuthStore();

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'ekasi-ops-dashboard' });
});

app.use(
  cors({
    origin:
      NODE_ENV === 'development'
        ? true
        : (origin, cb) => {
            if (!origin || origin === OPS_DASHBOARD_ORIGIN) {
              cb(null, true);
              return;
            }
            cb(
              Object.assign(new Error(`Origin ${origin} not allowed`), {
                status: 403,
              }),
            );
          },
  }),
);
app.use(express.json({ limit: '256kb' }));

const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a minute.' },
});

app.post('/ops-api/login', loginLimiter, loginHandler);
app.get('/ops-api/me', requireOpsAuth, opsMeHandler);
app.get('/ops-api/admin-users', requireOpsAuth, requireOpsSuperAdmin, listOpsUsersHandler);
app.post('/ops-api/admin-users', requireOpsAuth, requireOpsSuperAdmin, createOpsUserHandler);
app.patch(
  '/ops-api/admin-users/:id',
  requireOpsAuth,
  requireOpsSuperAdmin,
  updateOpsUserHandler,
);
app.delete(
  '/ops-api/admin-users/:id',
  requireOpsAuth,
  requireOpsSuperAdmin,
  deleteOpsUserHandler,
);

const api = express.Router();
api.use(requireOpsAuth);
api.use(monitoringRouter);
api.use(cashSendOpsRouter);
app.use('/ops-api', api);

const distDir = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

const server = app.listen(OPS_PORT, () => {
  console.info(`Ekasi Ops Dashboard API listening on http://localhost:${OPS_PORT}`);
});

function shutdown() {
  server.close(() => {
    void closeDataStore().finally(() => process.exit(0));
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
