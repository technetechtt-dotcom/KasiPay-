import { useEffect, useState } from 'react';

import {
  apiOpsCommissionLiabilities,
  apiOpsMerchantFloat,
  apiOpsPayments,
  apiOpsPayoutAgents,
  apiOpsSafeguarding,
  apiOpsSettlementSuspense,
} from './api';

export function PaymentsTab() {
  const [error, setError] = useState('');
  const [payload, setPayload] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    void Promise.all([
      apiOpsPayments(),
      apiOpsMerchantFloat(),
      apiOpsPayoutAgents(),
      apiOpsSafeguarding(),
      apiOpsSettlementSuspense(),
      apiOpsCommissionLiabilities(),
    ])
      .then(([payments, float, agents, safeguarding, suspense, commissions]) => {
        setPayload({ payments, float, agents, safeguarding, suspense, commissions });
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load payments ops'));
  }, []);

  return (
    <section>
      <h2>Payments &amp; safeguarding</h2>
      <p className="muted">
        PayShap is optional. Sensitive credits require finance/ops maker-checker on the API.
        Shortfalls never auto-correct balances.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {payload ? (
        <pre className="panel">{JSON.stringify(payload, null, 2)}</pre>
      ) : (
        <p className="muted">Loading payment operations views…</p>
      )}
    </section>
  );
}
