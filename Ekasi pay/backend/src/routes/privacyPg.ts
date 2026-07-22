import { createHash, randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireCapability } from '../security/authorization.js';

export const privacyRouterPg = Router();

const consentBody = z.object({
  purpose: z.string().trim().min(3).max(100),
  policyVersion: z.string().trim().min(1).max(50),
  decision: z.enum(['granted', 'withdrawn']),
  noticeText: z.string().min(20).max(100_000),
});

privacyRouterPg.post('/privacy/consents', requireAuth, async (req, res) => {
  const parsed = consentBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  await getPgPool().query(
    `INSERT INTO consent_records
      (id, user_id, purpose, policy_version, decision, notice_hash, source)
     VALUES ($1,$2,$3,$4,$5,$6,'authenticated_api')`,
    [
      id, req.auth!.userId, parsed.data.purpose, parsed.data.policyVersion,
      parsed.data.decision,
      createHash('sha256').update(parsed.data.noticeText).digest('hex'),
    ],
  );
  return res.status(201).json({ id, recorded: true });
});

privacyRouterPg.get('/privacy/consents', requireAuth, async (req, res) => {
  const rows = await getPgPool().query(
    `SELECT id, purpose, policy_version, decision, notice_hash, source, occurred_at
       FROM consent_records WHERE user_id = $1 ORDER BY occurred_at DESC`,
    [req.auth!.userId],
  );
  return res.json({ consents: rows.rows });
});

const requestBody = z.object({
  requestType: z.enum(['access', 'correction', 'export', 'deletion']),
  details: z.record(z.unknown()).default({}),
});

privacyRouterPg.post('/privacy/requests', requireAuth, async (req, res) => {
  const parsed = requestBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const id = randomUUID();
  await getPgPool().query(
    `INSERT INTO data_subject_requests
      (id, user_id, request_type, details, due_at)
     VALUES ($1,$2,$3,$4,NOW() + interval '30 days')`,
    [id, req.auth!.userId, parsed.data.requestType, parsed.data.details],
  );
  await getPgPool().query(
    `INSERT INTO data_subject_request_events
      (id, request_id, state, actor_type, actor_id, note)
     VALUES ($1,$2,'submitted','user',$3,'Request submitted by data subject')`,
    [randomUUID(), id, req.auth!.userId],
  );
  return res.status(202).json({ id, state: 'submitted' });
});

privacyRouterPg.get('/privacy/requests', requireAuth, async (req, res) => {
  const rows = await getPgPool().query(
    `SELECT id, request_type, state, due_at, created_at, completed_at
       FROM data_subject_requests WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.auth!.userId],
  );
  return res.json({ requests: rows.rows });
});

privacyRouterPg.get(
  '/ops/privacy/requests',
  ...requireCapability('privacy:read'),
  async (_req, res) => {
    const rows = await getPgPool().query(
      `SELECT * FROM data_subject_requests ORDER BY created_at DESC LIMIT 500`,
    );
    return res.json({ requests: rows.rows });
  },
);

const transitionBody = z.object({
  state: z.enum([
    'identity_verification', 'in_review', 'fulfilled',
    'partially_fulfilled', 'rejected', 'cancelled',
  ]),
  note: z.string().trim().min(10).max(2000),
});

privacyRouterPg.patch(
  '/ops/privacy/requests/:id',
  ...requireCapability('privacy:manage'),
  async (req, res) => {
    const parsed = transitionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const updated = await getPgPool().query(
      `UPDATE data_subject_requests SET state = $1, assigned_operator_id = $2,
         completed_at = CASE WHEN $1 IN ('fulfilled','partially_fulfilled','rejected','cancelled')
           THEN NOW() ELSE completed_at END,
         decision_reason = CASE WHEN $1 IN ('rejected','partially_fulfilled') THEN $3 ELSE decision_reason END
       WHERE id = $4 RETURNING id`,
      [parsed.data.state, req.opsAuth!.operatorId, parsed.data.note, req.params.id],
    );
    if (!updated.rowCount) return res.status(404).json({ error: 'Request not found.' });
    await getPgPool().query(
      `INSERT INTO data_subject_request_events
        (id, request_id, state, actor_type, actor_id, note)
       VALUES ($1,$2,$3,'operator',$4,$5)`,
      [randomUUID(), req.params.id, parsed.data.state, req.opsAuth!.operatorId, parsed.data.note],
    );
    return res.json({ ok: true });
  },
);
