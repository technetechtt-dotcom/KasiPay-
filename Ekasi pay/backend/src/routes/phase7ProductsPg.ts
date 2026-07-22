import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import { z } from 'zod';

import { getPgPool } from '../dbPg.js';
import { parseIntegerCents } from '../money.js';
import {
  REGULATED_PRODUCTS,
  REQUIRED_READINESS_CONTROLS,
  canonicalEvidenceDigest,
  configuredProductEnvironment,
  evaluateProductReadinessPg,
  type ReadinessControl,
  type RegulatedProduct,
} from '../productReadiness.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireCapability } from '../security/authorization.js';
import {
  assessAffordability,
  calculateLoanSchedule,
  stableJsonSha256,
} from '../services/regulatedProducts.js';

export const phase7ProductsRouterPg = Router();
export const phase7OpsRouterPg = Router();

phase7ProductsRouterPg.use(requireAuth);

phase7ProductsRouterPg.get('/product-readiness', async (_req, res) => {
  const environment = configuredProductEnvironment();
  const products = await Promise.all(
    REGULATED_PRODUCTS.map((product) =>
      evaluateProductReadinessPg(getPgPool(), product, environment),
    ),
  );
  return res.json({ environment, products });
});

phase7ProductsRouterPg.get('/lending/products', async (_req, res) => {
  const rows = await getPgPool().query(
    `SELECT id,code,version,currency,min_principal_cents,max_principal_cents,
            term_count,term_unit,disclosure,disclosure_sha256,lender_of_record
       FROM lending_product_versions
      WHERE state = 'approved' AND effective_from <= clock_timestamp()
        AND (effective_to IS NULL OR effective_to > clock_timestamp())
      ORDER BY code,version DESC`,
  );
  return res.json({ products: rows.rows });
});

const lendingApplicationBody = z.object({
  productVersionId: z.string().uuid(),
  requestedPrincipalCents: z.string().regex(/^[1-9]\d*$/u),
  affordability: z.object({
    incomeCents: z.string().regex(/^\d+$/u),
    expenseCents: z.string().regex(/^\d+$/u),
    existingDebtCents: z.string().regex(/^\d+$/u),
    minimumBufferCents: z.string().regex(/^\d+$/u),
    evidence: z.array(z.object({
      type: z.string().min(1).max(80),
      artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    })).min(1).max(20),
  }),
  firstDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

phase7ProductsRouterPg.post('/lending/applications', async (req, res) => {
  const parsed = lendingApplicationBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const pool = getPgPool();
  const product = await pool.query<{
    id: string;
    min_principal_cents: string;
    max_principal_cents: string;
    interest_bps: number;
    initiation_fee_cents: string;
    service_fee_cents: string;
    term_count: number;
    term_unit: 'week' | 'month';
  }>(
    `SELECT * FROM lending_product_versions
      WHERE id = $1 AND state = 'approved' AND effective_from <= clock_timestamp()
        AND (effective_to IS NULL OR effective_to > clock_timestamp())`,
    [parsed.data.productVersionId],
  );
  const selected = product.rows[0];
  if (!selected) return res.status(409).json({ error: 'Approved lending product not found.' });
  const principal = parseIntegerCents(parsed.data.requestedPrincipalCents);
  if (
    principal < BigInt(selected.min_principal_cents) ||
    principal > BigInt(selected.max_principal_cents)
  ) {
    return res.status(400).json({ error: 'Principal is outside the server product limits.' });
  }
  const schedule = calculateLoanSchedule({
    principalCents: principal,
    interestBps: selected.interest_bps,
    initiationFeeCents: BigInt(selected.initiation_fee_cents),
    serviceFeeCents: BigInt(selected.service_fee_cents),
    termCount: selected.term_count,
    firstDueDate: parsed.data.firstDueDate,
    termUnit: selected.term_unit,
  });
  const firstInstallment = schedule.items[0]?.totalCents ?? schedule.totalCents;
  const affordability = assessAffordability({
    incomeCents: BigInt(parsed.data.affordability.incomeCents),
    expenseCents: BigInt(parsed.data.affordability.expenseCents),
    existingDebtCents: BigInt(parsed.data.affordability.existingDebtCents),
    proposedInstallmentCents: firstInstallment,
    minimumBufferCents: BigInt(parsed.data.affordability.minimumBufferCents),
  });
  const applicationId = randomUUID();
  const assessmentId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO lending_applications
         (id,user_id,product_version_id,requested_principal_cents,state)
       VALUES ($1,$2,$3,$4,'assessed')`,
      [applicationId, req.auth!.userId, selected.id, principal.toString()],
    );
    await client.query(
      `INSERT INTO lending_affordability_assessments
         (id,application_id,income_cents,expense_cents,existing_debt_cents,
          disposable_cents,eligible,rules_version,inputs,evidence,assessed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'phase7-v1',$8,$9,'server:phase7-v1')`,
      [
        assessmentId,
        applicationId,
        parsed.data.affordability.incomeCents,
        parsed.data.affordability.expenseCents,
        parsed.data.affordability.existingDebtCents,
        affordability.disposableCents.toString(),
        affordability.eligible,
        {
          requestedPrincipalCents: principal.toString(),
          proposedInstallmentCents: firstInstallment.toString(),
          minimumBufferCents: parsed.data.affordability.minimumBufferCents,
        },
        parsed.data.affordability.evidence,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return res.status(201).json({
    applicationId,
    assessmentId,
    eligible: affordability.eligible,
    state: 'assessed',
    quote: {
      principalCents: principal.toString(),
      interestCents: schedule.interestCents.toString(),
      feeCents: schedule.feeCents.toString(),
      totalCents: schedule.totalCents.toString(),
      schedule: schedule.items.map((item) => ({
        ...item,
        principalCents: item.principalCents.toString(),
        interestCents: item.interestCents.toString(),
        feeCents: item.feeCents.toString(),
        totalCents: item.totalCents.toString(),
      })),
    },
  });
});

phase7ProductsRouterPg.get('/lending/loans/:id/statement', async (req, res) => {
  const loan = await getPgPool().query(
    `SELECT l.*,a.user_id,p.code,p.version
       FROM loans l JOIN lending_applications a ON a.id = l.application_id
       JOIN lending_product_versions p ON p.id = a.product_version_id
      WHERE l.id = $1 AND a.user_id = $2`,
    [req.params.id, req.auth!.userId],
  );
  if (!loan.rows[0]) return res.status(404).json({ error: 'Loan not found.' });
  const [schedule, repayments, events, quotes] = await Promise.all([
    getPgPool().query(`SELECT * FROM loan_schedule_items WHERE loan_id = $1 ORDER BY sequence`, [req.params.id]),
    getPgPool().query(
      `SELECT r.*,COALESCE(jsonb_agg(a ORDER BY a.sequence)
        FILTER (WHERE a.id IS NOT NULL),'[]'::jsonb) allocations
         FROM loan_repayments r LEFT JOIN loan_repayment_allocations a ON a.repayment_id = r.id
        WHERE r.loan_id = $1 GROUP BY r.id ORDER BY r.received_at`,
      [req.params.id],
    ),
    getPgPool().query(`SELECT * FROM loan_state_events WHERE loan_id = $1 ORDER BY created_at`, [req.params.id]),
    getPgPool().query(`SELECT * FROM loan_settlement_quotes WHERE loan_id = $1 ORDER BY created_at DESC`, [req.params.id]),
  ]);
  return res.json({ loan: loan.rows[0], schedule: schedule.rows, repayments: repayments.rows, events: events.rows, settlementQuotes: quotes.rows });
});

phase7ProductsRouterPg.get('/regulated/stokvel/:id/statement', async (req, res) => {
  const membership = await getPgPool().query(
    `SELECT m.*,a.name,a.state account_state
       FROM stokvel_memberships m JOIN stokvel_accounts a ON a.id = m.stokvel_account_id
      WHERE a.id = $1 AND m.user_id = $2 AND m.state IN ('active','suspended','removed','resigned')`,
    [req.params.id, req.auth!.userId],
  );
  if (!membership.rows[0]) return res.status(404).json({ error: 'Membership not found.' });
  const [contributions, withdrawals, disputes, events] = await Promise.all([
    getPgPool().query(`SELECT * FROM stokvel_contribution_records WHERE stokvel_account_id = $1 ORDER BY period_start,id`, [req.params.id]),
    getPgPool().query(
      `SELECT w.*,COALESCE(jsonb_agg(a ORDER BY a.decided_at)
        FILTER (WHERE a.id IS NOT NULL),'[]'::jsonb) approvals
         FROM stokvel_withdrawal_requests w
         LEFT JOIN stokvel_withdrawal_approvals a ON a.withdrawal_request_id = w.id
        WHERE w.stokvel_account_id = $1 GROUP BY w.id ORDER BY w.created_at`,
      [req.params.id],
    ),
    getPgPool().query(`SELECT * FROM stokvel_disputes WHERE stokvel_account_id = $1 ORDER BY opened_at`, [req.params.id]),
    getPgPool().query(`SELECT * FROM stokvel_state_events WHERE stokvel_account_id = $1 ORDER BY created_at`, [req.params.id]),
  ]);
  return res.json({ membership: membership.rows[0], contributions: contributions.rows, withdrawals: withdrawals.rows, disputes: disputes.rows, events: events.rows });
});

phase7ProductsRouterPg.get('/merchant-credit/obligations/:id/statement', async (req, res) => {
  const obligation = await getPgPool().query(
    `SELECT o.*,c.name customer_name,c.phone customer_phone,c.merchant_id
       FROM merchant_credit_obligations o
       JOIN credit_customers c ON c.id = o.customer_id
       JOIN merchants m ON m.id = c.merchant_id
      WHERE o.id = $1 AND m.user_id = $2`,
    [req.params.id, req.auth!.userId],
  );
  if (!obligation.rows[0]) return res.status(404).json({ error: 'Credit obligation not found.' });
  const [events, disputes, consent] = await Promise.all([
    getPgPool().query(`SELECT * FROM merchant_credit_events WHERE obligation_id = $1 ORDER BY created_at,id`, [req.params.id]),
    getPgPool().query(`SELECT * FROM merchant_credit_disputes WHERE obligation_id = $1 ORDER BY created_at,id`, [req.params.id]),
    getPgPool().query(`SELECT * FROM merchant_credit_consents WHERE obligation_id = $1`, [req.params.id]),
  ]);
  return res.json({ obligation: obligation.rows[0], consent: consent.rows[0], events: events.rows, disputes: disputes.rows });
});

phase7ProductsRouterPg.get('/regulated/insurance/catalogue', async (_req, res) => {
  const products = await getPgPool().query(
    `SELECT p.id,p.code,p.version,p.premium_cents,p.cover_cents,p.grace_days,
            p.cooling_off_days,p.wording,p.wording_sha256,p.disclosure,
            p.disclosure_sha256,v.legal_name provider
       FROM insurance_product_versions p
       JOIN insurance_providers v ON v.id = p.provider_id
      WHERE p.state = 'published' AND v.state = 'certified'
      ORDER BY p.code,p.version DESC`,
  );
  return res.json({ products: products.rows });
});

phase7ProductsRouterPg.get('/regulated/utilities/catalogue', async (_req, res) => {
  const products = await getPgPool().query(
    `SELECT c.id,c.provider_product_ref,c.version,c.category,c.name,c.cost_cents,
            c.fee_cents,c.min_cents,c.max_cents,c.finality_disclosure,
            c.finality_sha256,e.provider
       FROM utility_catalogue_versions c
       JOIN provider_endpoints e ON e.id = c.endpoint_id
      WHERE c.state = 'published' AND e.environment = $1 AND e.enabled
      ORDER BY c.category,c.name,c.version DESC`,
    [configuredProductEnvironment()],
  );
  return res.json({ products: products.rows });
});

const stokvelAccountBody = z.object({
  name: z.string().trim().min(2).max(200),
  legalCustodianName: z.string().trim().min(2).max(200),
  legalCustodianReference: z.string().trim().min(2).max(500),
  legalEvidenceId: z.string().uuid(),
  constitution: z.record(z.unknown()),
  votingThresholdBps: z.number().int().min(1).max(10_000),
  withdrawalApprovalCount: z.number().int().min(2).max(20),
});

phase7ProductsRouterPg.post('/regulated/stokvel/accounts', async (req, res) => {
  const parsed = stokvelAccountBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const pool = getPgPool();
  const legal = await pool.query(
    `SELECT 1 FROM product_readiness_evidence
      WHERE id = $1 AND product = 'stokvel' AND environment = $2
        AND control = 'legal' AND decision = 'approved'
        AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
    [parsed.data.legalEvidenceId, configuredProductEnvironment()],
  );
  if (!legal.rowCount) return res.status(409).json({ error: 'Current Stokvel legal-custodian evidence is required.' });
  const accountId = randomUUID();
  const constitutionId = randomUUID();
  const membershipId = randomUUID();
  const custodyAccountId = `p7-stokvel-custody-${accountId}`;
  const liabilityAccountId = `p7-stokvel-liability-${accountId}`;
  const contentSha256 = stableJsonSha256(parsed.data.constitution);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO ledger_accounts
         (id,code,name,account_class,normal_side,currency,pool_id,allow_negative)
       VALUES ($1,$2,$3,'asset','debit','ZAR','ZA',FALSE),
              ($4,$5,$6,'liability','credit','ZAR','ZA',FALSE);
       INSERT INTO account_balance_projections(account_id) VALUES ($1),($4)`,
      [
        custodyAccountId,
        `P7-STK-C-${accountId.slice(0, 8)}`,
        `${parsed.data.name} custody`,
        liabilityAccountId,
        `P7-STK-L-${accountId.slice(0, 8)}`,
        `${parsed.data.name} member liability`,
      ],
    );
    await client.query(
      `INSERT INTO stokvel_accounts
         (id,name,custody_account_id,member_liability_account_id,
          legal_custodian_name,legal_custodian_reference,
          legal_custodian_evidence_id,state,created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
      [
        accountId,
        parsed.data.name,
        custodyAccountId,
        liabilityAccountId,
        parsed.data.legalCustodianName,
        parsed.data.legalCustodianReference,
        parsed.data.legalEvidenceId,
        req.auth!.userId,
      ],
    );
    await client.query(
      `INSERT INTO stokvel_constitution_versions
         (id,stokvel_account_id,version,content,content_sha256,
          voting_threshold_bps,withdrawal_approval_count,effective_at)
       VALUES ($1,$2,1,$3,$4,$5,$6,clock_timestamp());
       INSERT INTO stokvel_memberships
         (id,stokvel_account_id,user_id,role,state,joined_at)
       VALUES ($7,$2,$8,'chair','active',clock_timestamp());
       INSERT INTO stokvel_state_events
         (id,stokvel_account_id,event_type,actor_type,actor_id,payload)
       VALUES ($9,$2,'account_created','member',$8,$10)`,
      [
        constitutionId,
        accountId,
        parsed.data.constitution,
        contentSha256,
        parsed.data.votingThresholdBps,
        parsed.data.withdrawalApprovalCount,
        membershipId,
        req.auth!.userId,
        randomUUID(),
        { constitutionId, contentSha256 },
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return res.status(201).json({ accountId, constitutionId, membershipId, state: 'active' });
});

const stokvelConsentBody = z.object({
  constitutionVersionId: z.string().uuid(),
  acceptanceText: z.string().trim().min(20).max(4000),
});

phase7ProductsRouterPg.post('/regulated/stokvel/:id/consents', async (req, res) => {
  const parsed = stokvelConsentBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const membership = await getPgPool().query<{ id: string }>(
    `SELECT m.id FROM stokvel_memberships m
       JOIN stokvel_constitution_versions c ON c.stokvel_account_id = m.stokvel_account_id
      WHERE m.stokvel_account_id = $1 AND m.user_id = $2 AND m.state = 'active'
        AND c.id = $3`,
    [req.params.id, req.auth!.userId, parsed.data.constitutionVersionId],
  );
  if (!membership.rows[0]) return res.status(403).json({ error: 'Active authenticated membership is required.' });
  const id = randomUUID();
  await getPgPool().query(
    `INSERT INTO stokvel_member_consents
       (id,membership_id,constitution_version_id,acceptance_text,
        acceptance_sha256,authenticated_session_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      id,
      membership.rows[0].id,
      parsed.data.constitutionVersionId,
      parsed.data.acceptanceText,
      stableJsonSha256({ text: parsed.data.acceptanceText, constitutionVersionId: parsed.data.constitutionVersionId }),
      req.auth!.sessionId,
    ],
  );
  return res.status(201).json({ id });
});

const stokvelContributionBody = z.object({
  membershipId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  dueCents: z.string().regex(/^[1-9]\d*$/u),
  paidCents: z.string().regex(/^\d+$/u),
  state: z.enum(['due', 'partial', 'paid', 'missed', 'waived']),
  sourceJournalTransactionId: z.string().uuid().optional(),
  adjustmentOfId: z.string().uuid().optional(),
  reason: z.string().trim().min(10).max(1000),
});

phase7ProductsRouterPg.post('/regulated/stokvel/:id/contributions', async (req, res) => {
  const parsed = stokvelContributionBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const actor = await getPgPool().query(
    `SELECT 1 FROM stokvel_memberships
      WHERE stokvel_account_id = $1 AND user_id = $2 AND state = 'active'
        AND role IN ('chair','treasurer')`,
    [req.params.id, req.auth!.userId],
  );
  if (!actor.rowCount) return res.status(403).json({ error: 'Chair or treasurer membership required.' });
  if (parsed.data.adjustmentOfId && !parsed.data.sourceJournalTransactionId) {
    return res.status(400).json({ error: 'Adjustments require a compensating journal transaction.' });
  }
  const id = randomUUID();
  await getPgPool().query(
    `INSERT INTO stokvel_contribution_records
       (id,stokvel_account_id,membership_id,period_start,period_end,due_cents,
        paid_cents,state,source_journal_transaction_id,adjustment_of_id,reason)
     SELECT $1,$2,m.id,$3,$4,$5,$6,$7,$8,$9,$10
       FROM stokvel_memberships m
      WHERE m.id = $11 AND m.stokvel_account_id = $2`,
    [
      id, req.params.id, parsed.data.periodStart, parsed.data.periodEnd,
      parsed.data.dueCents, parsed.data.paidCents, parsed.data.state,
      parsed.data.sourceJournalTransactionId ?? null, parsed.data.adjustmentOfId ?? null,
      parsed.data.reason, parsed.data.membershipId,
    ],
  );
  return res.status(201).json({ id });
});

const stokvelWithdrawalBody = z.object({
  amountCents: z.string().regex(/^[1-9]\d*$/u),
  purpose: z.string().trim().min(10).max(1000),
});

phase7ProductsRouterPg.post('/regulated/stokvel/:id/withdrawals', async (req, res) => {
  const parsed = stokvelWithdrawalBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const eligible = await getPgPool().query<{
    membership_id: string;
    withdrawal_approval_count: number;
  }>(
    `SELECT m.id membership_id,c.withdrawal_approval_count
       FROM stokvel_memberships m
       JOIN stokvel_constitution_versions c ON c.stokvel_account_id = m.stokvel_account_id
      WHERE m.stokvel_account_id = $1 AND m.user_id = $2 AND m.state = 'active'
        AND EXISTS (
          SELECT 1 FROM stokvel_member_consents x
           WHERE x.membership_id = m.id AND x.constitution_version_id = c.id
        )
      ORDER BY c.version DESC LIMIT 1`,
    [req.params.id, req.auth!.userId],
  );
  if (!eligible.rows[0]) return res.status(403).json({ error: 'Current constitution consent and active membership are required.' });
  const id = randomUUID();
  await getPgPool().query(
    `INSERT INTO stokvel_withdrawal_requests
       (id,stokvel_account_id,requested_by_membership_id,amount_cents,purpose,
        required_approvals)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      id, req.params.id, eligible.rows[0].membership_id, parsed.data.amountCents,
      parsed.data.purpose, eligible.rows[0].withdrawal_approval_count,
    ],
  );
  return res.status(201).json({ id, state: 'pending', requiredApprovals: eligible.rows[0].withdrawal_approval_count });
});

const stokvelWithdrawalDecisionBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(10).max(1000),
});

phase7ProductsRouterPg.post(
  '/regulated/stokvel/:id/withdrawals/:withdrawalId/decisions',
  async (req, res) => {
    const parsed = stokvelWithdrawalDecisionBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const membership = await getPgPool().query<{ id: string }>(
      `SELECT m.id FROM stokvel_memberships m
        JOIN stokvel_withdrawal_requests w ON w.stokvel_account_id = m.stokvel_account_id
       WHERE w.id = $1 AND w.stokvel_account_id = $2 AND w.state = 'pending'
         AND m.user_id = $3 AND m.state = 'active'`,
      [req.params.withdrawalId, req.params.id, req.auth!.userId],
    );
    if (!membership.rows[0]) return res.status(403).json({ error: 'Active membership and pending withdrawal required.' });
    const client = await getPgPool().connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO stokvel_withdrawal_approvals
           (id,withdrawal_request_id,membership_id,decision,reason)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          randomUUID(), req.params.withdrawalId, membership.rows[0].id,
          parsed.data.decision, parsed.data.reason,
        ],
      );
      if (parsed.data.decision === 'rejected') {
        await client.query(
          `UPDATE stokvel_withdrawal_requests SET state = 'rejected' WHERE id = $1`,
          [req.params.withdrawalId],
        );
      } else {
        const request = await client.query<{ required_approvals: number }>(
          `SELECT required_approvals FROM stokvel_withdrawal_requests WHERE id = $1 FOR UPDATE`,
          [req.params.withdrawalId],
        );
        const approvals = await client.query<{ count: string }>(
          `SELECT count(*)::text count FROM stokvel_withdrawal_approvals
            WHERE withdrawal_request_id = $1 AND decision = 'approved'`,
          [req.params.withdrawalId],
        );
        if (
          Number(approvals.rows[0]?.count ?? 0) >=
          (request.rows[0]?.required_approvals ?? Number.MAX_SAFE_INTEGER)
        ) {
          await client.query(
            `UPDATE stokvel_withdrawal_requests SET state = 'approved' WHERE id = $1`,
            [req.params.withdrawalId],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return res.status(201).json({ decision: parsed.data.decision });
  },
);

const merchantCreditBody = z.object({
  customerId: z.string().min(1).max(200),
  saleId: z.string().min(1).max(200),
  termsVersionId: z.string().uuid(),
  principalCents: z.string().regex(/^[1-9]\d*$/u),
  otpVerificationId: z.string().min(1).max(200),
  acceptanceText: z.string().trim().min(20).max(4000),
});

phase7ProductsRouterPg.post('/merchant-credit/obligations', async (req, res) => {
  const parsed = merchantCreditBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const eligible = await getPgPool().query<{ customer_id: string }>(
    `SELECT c.id customer_id
       FROM credit_customers c JOIN merchants m ON m.id = c.merchant_id
       JOIN sales s ON s.id = $2 AND s.merchant_id = m.id
       JOIN merchant_credit_term_versions t ON t.id = $3 AND t.merchant_id = m.id
       JOIN credit_otp_codes o ON o.id = $4 AND o.customer_id = c.id
      WHERE c.id = $1 AND m.user_id = $5 AND t.state = 'approved'
        AND o.token_used_at IS NOT NULL`,
    [
      parsed.data.customerId,
      parsed.data.saleId,
      parsed.data.termsVersionId,
      parsed.data.otpVerificationId,
      req.auth!.userId,
    ],
  );
  if (!eligible.rows[0]) return res.status(409).json({ error: 'Sale, approved terms and customer consent verification are required.' });
  const obligationId = randomUUID();
  const eventId = randomUUID();
  const consentId = randomUUID();
  const client = await getPgPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO merchant_credit_obligations
         (id,customer_id,sale_id,terms_version_id,principal_cents,outstanding_cents)
       VALUES ($1,$2,$3,$4,$5,$5);
       INSERT INTO merchant_credit_consents
         (id,obligation_id,acceptance_text,acceptance_sha256,otp_verification_id)
       VALUES ($6,$1,$7,$8,$9);
       INSERT INTO merchant_credit_events
         (id,obligation_id,event_type,amount_cents,effective_cents,reason,actor_user_id)
       VALUES ($10,$1,'purchase',$5,$5,'Credit sale linked to accepted terms',$11)`,
      [
        obligationId, parsed.data.customerId, parsed.data.saleId,
        parsed.data.termsVersionId, parsed.data.principalCents, consentId,
        parsed.data.acceptanceText,
        stableJsonSha256({
          text: parsed.data.acceptanceText,
          saleId: parsed.data.saleId,
          termsVersionId: parsed.data.termsVersionId,
        }),
        parsed.data.otpVerificationId, eventId, req.auth!.userId,
      ],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return res.status(201).json({ obligationId, purchaseEventId: eventId });
});

const insuranceAcceptanceBody = z.object({
  productVersionId: z.string().uuid(),
  acceptanceText: z.string().trim().min(20).max(4000),
});

phase7ProductsRouterPg.post('/regulated/insurance/policies', async (req, res) => {
  const parsed = insuranceAcceptanceBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const product = await getPgPool().query<{
    wording_sha256: string;
    disclosure_sha256: string;
    cooling_off_days: number;
  }>(
    `SELECT p.wording_sha256,p.disclosure_sha256,p.cooling_off_days
       FROM insurance_product_versions p JOIN insurance_providers v ON v.id = p.provider_id
      WHERE p.id = $1 AND p.state = 'published' AND v.state = 'certified'`,
    [parsed.data.productVersionId],
  );
  if (!product.rows[0]) return res.status(409).json({ error: 'Certified published policy version not found.' });
  const acceptanceId = randomUUID();
  const policyId = randomUUID();
  await getPgPool().query(
    `WITH accepted AS (
       INSERT INTO insurance_policy_acceptances
         (id,product_version_id,user_id,wording_sha256,disclosure_sha256,
          acceptance_text,acceptance_sha256,authenticated_session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id
     )
     INSERT INTO regulated_insurance_policies
       (id,acceptance_id,state,cooling_off_ends_at)
     SELECT $9,id,'cooling_off',clock_timestamp() + ($10 * interval '1 day')
       FROM accepted`,
    [
      acceptanceId, parsed.data.productVersionId, req.auth!.userId,
      product.rows[0].wording_sha256, product.rows[0].disclosure_sha256,
      parsed.data.acceptanceText,
      stableJsonSha256({
        text: parsed.data.acceptanceText,
        wordingSha256: product.rows[0].wording_sha256,
        disclosureSha256: product.rows[0].disclosure_sha256,
      }),
      req.auth!.sessionId, policyId, product.rows[0].cooling_off_days,
    ],
  );
  return res.status(201).json({ policyId, acceptanceId, state: 'cooling_off' });
});

const evidenceBody = z.object({
  product: z.enum(REGULATED_PRODUCTS),
  environment: z.enum(['sandbox', 'production']),
  control: z.enum(REQUIRED_READINESS_CONTROLS),
  decision: z.enum(['approved', 'rejected', 'withdrawn']),
  authority: z.string().trim().min(2).max(200),
  authorityReference: z.string().trim().min(2).max(500),
  artifactUri: z.string().trim().min(3).max(1000),
  artifactSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  notes: z.string().trim().min(20).max(4000),
  expiresAt: z.string().datetime().optional(),
});

phase7OpsRouterPg.post(
  '/ops/product-readiness/evidence',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = evidenceBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const evidenceSha256 = canonicalEvidenceDigest({
      ...parsed.data,
      control: parsed.data.control as ReadinessControl,
      product: parsed.data.product as RegulatedProduct,
    });
    const id = randomUUID();
    await getPgPool().query(
      `INSERT INTO product_readiness_evidence
         (id,product,environment,control,decision,authority,authority_reference,
          artifact_uri,artifact_sha256,evidence_sha256,notes,recorded_by,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        parsed.data.product,
        parsed.data.environment,
        parsed.data.control,
        parsed.data.decision,
        parsed.data.authority,
        parsed.data.authorityReference,
        parsed.data.artifactUri,
        parsed.data.artifactSha256,
        evidenceSha256,
        parsed.data.notes,
        req.opsAuth!.operatorId,
        parsed.data.expiresAt ?? null,
      ],
    );
    return res.status(201).json({ id, evidenceSha256 });
  },
);

phase7OpsRouterPg.get(
  '/ops/product-readiness',
  ...requireCapability('finance:approve'),
  async (_req, res) => {
    const statuses = await Promise.all(
      (['sandbox', 'production'] as const).flatMap((environment) =>
        REGULATED_PRODUCTS.map((product) =>
          evaluateProductReadinessPg(getPgPool(), product, environment),
        ),
      ),
    );
    const evidence = await getPgPool().query(
      `SELECT * FROM product_readiness_evidence ORDER BY recorded_at DESC LIMIT 1000`,
    );
    return res.json({ statuses, evidence: evidence.rows });
  },
);

const checkBody = z.object({
  product: z.enum(REGULATED_PRODUCTS),
  environment: z.enum(['sandbox', 'production']),
});

phase7OpsRouterPg.post(
  '/ops/product-readiness/checks',
  ...requireCapability('finance:approve'),
  async (req, res) => {
    const parsed = checkBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const status = await evaluateProductReadinessPg(
      getPgPool(),
      parsed.data.product,
      parsed.data.environment,
    );
    const snapshotSha256 = stableJsonSha256(status);
    const id = randomUUID();
    await getPgPool().query(
      `INSERT INTO product_readiness_checks
         (id,product,environment,database_approved,config_enabled,enabled,
          evidence_snapshot,snapshot_sha256,checked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        status.product,
        status.environment,
        status.databaseApproved,
        status.configEnabled,
        status.enabled,
        status,
        snapshotSha256,
        req.opsAuth!.operatorId,
      ],
    );
    return res.status(201).json({ id, snapshotSha256, status });
  },
);

phase7OpsRouterPg.get(
  '/ops/product-reconciliation',
  ...requireCapability('reconciliation:run'),
  async (req, res) => {
    const product =
      typeof req.query.product === 'string' &&
      REGULATED_PRODUCTS.includes(req.query.product as RegulatedProduct)
        ? req.query.product
        : null;
    const rows = await getPgPool().query(
      `SELECT * FROM product_reconciliation_runs
        WHERE ($1::regulated_product IS NULL OR product = $1)
        ORDER BY created_at DESC LIMIT 500`,
      [product],
    );
    return res.json({ reports: rows.rows });
  },
);
