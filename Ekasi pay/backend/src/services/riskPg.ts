import { createHash, randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { detectCircularFlow, evaluateRiskRules, exceedsTierLimit, type RiskRule } from '../risk.js';

type Db = Pool | PoolClient;

function subjectHash(type: string, value: string): string {
  return createHash('sha256').update(`${type}:${value}`).digest('hex');
}

export async function evaluateTransactionRiskPg(
  database: Db,
  input: {
    eventType: 'transfer' | 'voucher' | 'cash_out';
    actorUserId: string;
    amountCents: bigint;
    financialReference: string;
    deviceId?: string;
    ip?: string;
    counterparty?: string;
    requestId: string;
    correlationId: string;
  },
): Promise<{ decision: 'allow' | 'review' | 'hold' | 'block'; evaluationId: string }> {
  const actorHash = subjectHash('user', input.actorUserId);
  const deviceHash = input.deviceId ? subjectHash('device', input.deviceId) : null;
  const ipHash = input.ip ? subjectHash('ip', input.ip) : null;
  const counterpartyHash = input.counterparty ? subjectHash('counterparty', input.counterparty) : null;
  for (const [rightType, rightHash] of [
    ['device', deviceHash],
    ['counterparty', counterpartyHash],
  ] as const) {
    if (!rightHash) continue;
    await database.query(
      `INSERT INTO linked_identity_edges
         (id,left_type,left_hash,right_type,right_hash)
       VALUES ($1,'user',$2,$3,$4)
       ON CONFLICT (left_type,left_hash,right_type,right_hash)
       DO UPDATE SET signal_count = linked_identity_edges.signal_count + 1,
                     last_seen_at = clock_timestamp()`,
      [randomUUID(), actorHash, rightType, rightHash],
    );
  }
  const user = await database.query<{ account_tier: string }>(
    `SELECT account_tier FROM users WHERE id = $1`,
    [input.actorUserId],
  );
  if (!user.rows[0]) throw Object.assign(new Error('Risk subject not found.'), { status: 404 });

  const list = await database.query<{ list_type: 'allow' | 'block' }>(
    `SELECT list_type FROM risk_list_entries
      WHERE subject_type = 'user' AND subject_hash = $1
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
    [actorHash],
  );
  const blocked = list.rows.some((entry) => entry.list_type === 'block');
  const allowed = list.rows.some((entry) => entry.list_type === 'allow');

  const limits = await database.query<{
    per_transaction_cents: string; daily_cents: string; monthly_cents: string;
    daily_count: number; monthly_count: number;
  }>(
    `SELECT per_transaction_cents, daily_cents, monthly_cents, daily_count, monthly_count
       FROM risk_tier_limits
      WHERE kyc_tier = $1 AND transaction_type = $2 AND enabled`,
    [user.rows[0].account_tier, input.eventType],
  );
  if (!limits.rows[0]) {
    throw Object.assign(new Error('No active risk limit is configured for this KYC tier.'), {
      status: 503,
      code: 'RISK_LIMIT_UNCONFIGURED',
    });
  }
  const totals = await database.query<{
    daily_cents: string; monthly_cents: string; daily_count: string; monthly_count: string;
  }>(
    `SELECT
       COALESCE(sum(amount_cents) FILTER (WHERE occurred_at >= date_trunc('day', clock_timestamp())),0)::text daily_cents,
       COALESCE(sum(amount_cents) FILTER (WHERE occurred_at >= date_trunc('month', clock_timestamp())),0)::text monthly_cents,
       count(*) FILTER (WHERE occurred_at >= date_trunc('day', clock_timestamp()))::text daily_count,
       count(*) FILTER (WHERE occurred_at >= date_trunc('month', clock_timestamp()))::text monthly_count
     FROM risk_signals WHERE actor_user_id = $1 AND event_type = $2`,
    [input.actorUserId, input.eventType === 'voucher' ? 'voucher_create' : input.eventType],
  );
  const tier = limits.rows[0];
  const aggregate = totals.rows[0];
  const limitReason = exceedsTierLimit(input.amountCents, {
    dailyCents: BigInt(aggregate?.daily_cents ?? 0),
    monthlyCents: BigInt(aggregate?.monthly_cents ?? 0),
    dailyCount: Number(aggregate?.daily_count ?? 0),
    monthlyCount: Number(aggregate?.monthly_count ?? 0),
  }, {
    perTransactionCents: BigInt(tier.per_transaction_cents),
    dailyCents: BigInt(tier.daily_cents),
    monthlyCents: BigInt(tier.monthly_cents),
    dailyCount: tier.daily_count,
    monthlyCount: tier.monthly_count,
  });
  const velocity = await database.query<{ ten_minute: string; day: string; linked: string }>(
    `SELECT
       count(*) FILTER (WHERE occurred_at >= clock_timestamp() - interval '10 minutes')::text ten_minute,
       count(*) FILTER (WHERE occurred_at >= clock_timestamp() - interval '24 hours')::text day,
       (SELECT count(DISTINCT right_hash)::text FROM linked_identity_edges WHERE left_hash = $2) linked
     FROM risk_signals WHERE actor_user_id = $1`,
    [input.actorUserId, actorHash],
  );
  const configured = await database.query<{ code: string; score: number; action: RiskRule['action']; expression: RiskRule['expression'] }>(
    `SELECT code, score, action, expression FROM risk_rules WHERE enabled AND event_type = $1`,
    [input.eventType],
  );
  let circularHops = 0;
  if (input.eventType === 'transfer' && input.counterparty) {
    const edges = await database.query<{ from_user_id: string; to_user_id: string }>(
      `SELECT fw.user_id from_user_id, tw.user_id to_user_id
         FROM transactions t
         JOIN wallets fw ON fw.id = t.from_wallet_id
         JOIN wallets tw ON tw.id = t.to_wallet_id
        WHERE t.type = 'transfer' AND t.status = 'completed'
          AND t.created_at >= clock_timestamp() - interval '30 days'
        LIMIT 10000`,
    );
    const target = await database.query<{ id: string }>(`SELECT id FROM users WHERE phone = $1`, [input.counterparty]);
    const graph = new Map<string, string[]>();
    for (const edge of edges.rows) {
      graph.set(edge.from_user_id, [...(graph.get(edge.from_user_id) ?? []), edge.to_user_id]);
    }
    if (target.rows[0]) {
      graph.set(input.actorUserId, [...(graph.get(input.actorUserId) ?? []), target.rows[0].id]);
      circularHops = detectCircularFlow(graph, input.actorUserId) ? 1 : 0;
    }
  }
  const calculated = evaluateRiskRules(configured.rows, {
    amountCents: Number(input.amountCents),
    events10m: Number(velocity.rows[0]?.ten_minute ?? 0),
    events24h: Number(velocity.rows[0]?.day ?? 0),
    linkedAccounts: Number(velocity.rows[0]?.linked ?? 0),
    circularHops,
  });
  const decision =
    blocked ? 'block'
    : limitReason ? 'block'
    : allowed && calculated.decision !== 'block' ? 'allow'
    : calculated.decision;
  const evaluationId = randomUUID();
  await database.query(
    `INSERT INTO risk_signals
       (id,event_type,actor_user_id,device_hash,ip_hash,counterparty_hash,amount_cents,
        financial_reference,request_id,correlation_id,metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      randomUUID(), input.eventType === 'voucher' ? 'voucher_create' : input.eventType,
      input.actorUserId, deviceHash, ipHash, counterpartyHash, input.amountCents.toString(),
      input.financialReference, input.requestId, input.correlationId,
      JSON.stringify({ limitReason }),
    ],
  );
  await database.query(
    `INSERT INTO risk_evaluations
       (id,event_type,actor_user_id,financial_reference,score,decision,matched_rules,request_id,correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
    [evaluationId, input.eventType, input.actorUserId, input.financialReference,
      calculated.score, decision, JSON.stringify(calculated.matchedRules), input.requestId, input.correlationId],
  );
  if (decision === 'hold') {
    await database.query(
      `INSERT INTO transaction_holds
         (id,financial_reference,actor_user_id,reason_code,risk_evaluation_id,amount_cents)
       VALUES ($1,$2,$3,'risk_score',$4,$5)`,
      [randomUUID(), input.financialReference, input.actorUserId, evaluationId, input.amountCents.toString()],
    );
  }
  return { decision, evaluationId };
}
