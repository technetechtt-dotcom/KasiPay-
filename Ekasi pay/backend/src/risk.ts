export type RiskDecision = 'allow' | 'review' | 'hold' | 'block';

export type RiskRule = {
  code: string;
  score: number;
  action: RiskDecision;
  expression: {
    field: 'amountCents' | 'events10m' | 'events24h' | 'linkedAccounts' | 'circularHops';
    operator: 'gt' | 'gte' | 'eq';
    value: number;
  };
};

export type RiskFacts = {
  amountCents: number;
  events10m: number;
  events24h: number;
  linkedAccounts: number;
  circularHops: number;
};

const ORDER: Record<RiskDecision, number> = {
  allow: 0,
  review: 1,
  hold: 2,
  block: 3,
};

function matches(rule: RiskRule, facts: RiskFacts): boolean {
  const actual = facts[rule.expression.field];
  if (rule.expression.operator === 'gt') return actual > rule.expression.value;
  if (rule.expression.operator === 'gte') return actual >= rule.expression.value;
  return actual === rule.expression.value;
}

export function evaluateRiskRules(
  rules: readonly RiskRule[],
  facts: RiskFacts,
  thresholds = { review: 250, hold: 500, block: 800 },
): { score: number; decision: RiskDecision; matchedRules: string[] } {
  const matched = rules.filter((rule) => matches(rule, facts));
  const score = Math.min(1000, matched.reduce((sum, rule) => sum + rule.score, 0));
  let decision: RiskDecision =
    score >= thresholds.block ? 'block'
    : score >= thresholds.hold ? 'hold'
    : score >= thresholds.review ? 'review'
    : 'allow';
  for (const rule of matched) {
    if (ORDER[rule.action] > ORDER[decision]) decision = rule.action;
  }
  return { score, decision, matchedRules: matched.map((rule) => rule.code) };
}

export function exceedsTierLimit(
  amountCents: bigint,
  totals: { dailyCents: bigint; monthlyCents: bigint; dailyCount: number; monthlyCount: number },
  limits: {
    perTransactionCents: bigint;
    dailyCents: bigint;
    monthlyCents: bigint;
    dailyCount: number;
    monthlyCount: number;
  },
): string | null {
  if (amountCents > limits.perTransactionCents) return 'per_transaction_amount';
  if (totals.dailyCents + amountCents > limits.dailyCents) return 'daily_amount';
  if (totals.monthlyCents + amountCents > limits.monthlyCents) return 'monthly_amount';
  if (totals.dailyCount + 1 > limits.dailyCount) return 'daily_count';
  if (totals.monthlyCount + 1 > limits.monthlyCount) return 'monthly_count';
  return null;
}

export function detectCircularFlow(edges: ReadonlyMap<string, readonly string[]>, start: string, maxHops = 6): boolean {
  const visit = (node: string, path: ReadonlySet<string>, hops: number): boolean => {
    if (hops > maxHops) return false;
    for (const next of edges.get(node) ?? []) {
      if (next === start) return true;
      if (!path.has(next) && visit(next, new Set([...path, next]), hops + 1)) return true;
    }
    return false;
  };
  return visit(start, new Set([start]), 1);
}
