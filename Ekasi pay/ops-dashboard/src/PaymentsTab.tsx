import { useCallback, useEffect, useState } from 'react';

import {
  apiAdjustMerchantFloat,
  apiCreateApproval,
  apiCreditFloatTopup,
  apiFreezeMerchantFloat,
  apiOpsCommissionLiabilities,
  apiOpsMerchantFloat,
  apiOpsPayoutAgents,
  apiOpsSafeguarding,
  apiOpsSettlementSuspense,
  apiPayoutAgentAction,
  apiRunSafeguarding,
  apiSignOffSafeguarding,
} from './api';

function cell(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function centsLabel(value: unknown): string {
  if (value == null) return '—';
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) return raw;
  const n = Number(raw) / 100;
  return `R${n.toFixed(2)}`;
}

export function PaymentsTab() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [wallets, setWallets] = useState<Array<Record<string, unknown>>>([]);
  const [topups, setTopups] = useState<Array<Record<string, unknown>>>([]);
  const [agents, setAgents] = useState<Array<Record<string, unknown>>>([]);
  const [reports, setReports] = useState<Array<Record<string, unknown>>>([]);
  const [suspense, setSuspense] = useState<Array<Record<string, unknown>>>([]);
  const [liabilities, setLiabilities] = useState<Array<Record<string, unknown>>>([]);

  const load = useCallback(async () => {
    setError('');
    try {
      const [float, agentsRes, safeguarding, suspenseRes, commissions] =
        await Promise.all([
          apiOpsMerchantFloat(),
          apiOpsPayoutAgents(),
          apiOpsSafeguarding(),
          apiOpsSettlementSuspense(),
          apiOpsCommissionLiabilities(),
        ]);
      setWallets(float.wallets ?? []);
      setTopups(float.topups ?? []);
      setAgents(agentsRes.agents ?? []);
      setReports(safeguarding.reports ?? []);
      setSuspense(suspenseRes.cases ?? []);
      setLiabilities(commissions.liabilities ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load payments ops');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setError('');
    try {
      await action();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy('');
    }
  };

  return (
    <section>
      <div className="panel-head">
        <div>
          <h2>Payments &amp; safeguarding</h2>
          <p className="muted">
            Posted money is the journal. Sensitive float credits and adjustments
            require maker-checker. Shortfalls never auto-correct balances.
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={Boolean(busy)}>
          Refresh
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}

      <div className="panel">
        <h3>Merchant float wallets</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Merchant user</th>
                <th>Wallet</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {wallets.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No merchant float wallets.
                  </td>
                </tr>
              ) : (
                wallets.map((w) => {
                  const userId = String(w.user_id ?? '');
                  return (
                    <tr key={String(w.id ?? userId)}>
                      <td className="mono">{userId}</td>
                      <td className="mono">{cell(w.id)}</td>
                      <td>{centsLabel(w.balance_cents)}</td>
                      <td>{cell(w.status)}</td>
                      <td>
                        <div className="filters">
                          <button
                            type="button"
                            disabled={busy === `freeze:${userId}`}
                            onClick={() => {
                              const reason = window.prompt(
                                'Freeze reason (min 10 chars)',
                                'Ops freeze pending investigation',
                              );
                              if (!reason || reason.trim().length < 10) return;
                              void run(`freeze:${userId}`, () =>
                                apiFreezeMerchantFloat(userId, reason.trim()),
                              );
                            }}
                          >
                            Freeze
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy === `adj:${userId}`}
                            onClick={() => {
                              const amount = window.prompt(
                                'Adjustment amount in ZAR (negative allowed)',
                              );
                              const reason = window.prompt(
                                'Adjustment reason (min 10 chars)',
                              );
                              const approvalRequestId = window.prompt(
                                'Approved approval request UUID (from Approvals tab)',
                              );
                              if (!amount || !reason || !approvalRequestId) return;
                              if (reason.trim().length < 10) {
                                setError('Adjustment reason must be at least 10 characters.');
                                return;
                              }
                              void run(`adj:${userId}`, async () => {
                                await apiAdjustMerchantFloat(userId, {
                                  amount,
                                  reason: reason.trim(),
                                  approvalRequestId: approvalRequestId.trim(),
                                });
                              });
                            }}
                          >
                            Adjust…
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy === `reqadj:${userId}`}
                            onClick={() => {
                              const amount = window.prompt(
                                'Proposed adjustment amount in ZAR',
                              );
                              const reason = window.prompt(
                                'Maker reason (min 10 chars)',
                                'Request float adjustment dual-control',
                              );
                              if (!amount || !reason || reason.trim().length < 10) return;
                              void run(`reqadj:${userId}`, () =>
                                apiCreateApproval({
                                  actionType: 'float_adjustment',
                                  resourceType: 'merchant_float',
                                  resourceId: userId,
                                  payload: { amount, merchantUserId: userId },
                                  reason: reason.trim(),
                                }),
                              );
                            }}
                          >
                            Request approval
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Float top-ups</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Merchant</th>
                <th>Amount</th>
                <th>Reference</th>
                <th>State</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {topups.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    No float top-ups.
                  </td>
                </tr>
              ) : (
                topups.map((t) => {
                  const id = String(t.id ?? '');
                  const state = String(t.state ?? '');
                  return (
                    <tr key={id}>
                      <td>{cell(t.created_at)}</td>
                      <td className="mono">{cell(t.merchant_user_id)}</td>
                      <td>{centsLabel(t.amount_cents)}</td>
                      <td className="mono">{cell(t.merchant_reference)}</td>
                      <td>{state}</td>
                      <td>
                        {state === 'matched' || state === 'pending' || state === 'received' ? (
                          <button
                            type="button"
                            disabled={busy === `credit:${id}`}
                            onClick={() =>
                              void run(`credit:${id}`, () => apiCreditFloatTopup(id))
                            }
                          >
                            Credit float
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Payout agents</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Agent</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No payout agents.
                  </td>
                </tr>
              ) : (
                agents.map((a) => {
                  const id = String(a.id ?? a.user_id ?? '');
                  return (
                    <tr key={id}>
                      <td className="mono">
                        {cell(a.user_id ?? a.id)}
                        {a.business_name ? (
                          <div className="muted">{cell(a.business_name)}</div>
                        ) : null}
                      </td>
                      <td>{cell(a.status ?? a.state)}</td>
                      <td>
                        <div className="filters">
                          {(
                            [
                              ['approve', 'Approve'],
                              ['reject', 'Reject'],
                              ['suspend', 'Suspend'],
                              ['reactivate', 'Reactivate'],
                            ] as const
                          ).map(([action, label]) => (
                            <button
                              key={action}
                              type="button"
                              className={action === 'approve' ? undefined : 'ghost'}
                              disabled={busy === `agent:${id}:${action}`}
                              onClick={() => {
                                const needsReason =
                                  action === 'reject' || action === 'suspend';
                                const reason = needsReason
                                  ? window.prompt(`${label} reason`)
                                  : undefined;
                                if (needsReason && !reason) return;
                                void run(`agent:${id}:${action}`, () =>
                                  apiPayoutAgentAction(id, action, reason ?? undefined),
                                );
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Safeguarding reports</h3>
          <button
            type="button"
            disabled={busy === 'safeguarding-run'}
            onClick={() => void run('safeguarding-run', () => apiRunSafeguarding())}
          >
            Run report
          </button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Generated</th>
                <th>Report</th>
                <th>Difference</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {reports.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    No safeguarding reports yet.
                  </td>
                </tr>
              ) : (
                reports.map((r) => {
                  const id = String(r.id ?? '');
                  return (
                    <tr key={id}>
                      <td>{cell(r.generated_at ?? r.created_at)}</td>
                      <td className="mono">{id.slice(0, 8)}…</td>
                      <td>{centsLabel(r.difference_cents ?? r.differenceCents)}</td>
                      <td>
                        <button
                          type="button"
                          disabled={busy === `sign:${id}`}
                          onClick={() => {
                            const note = window.prompt('Sign-off note (optional)') ?? undefined;
                            void run(`sign:${id}`, () =>
                              apiSignOffSafeguarding(id, note || undefined),
                            );
                          }}
                        >
                          Sign off
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Settlement suspense</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Case</th>
                <th>State</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {suspense.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No suspense cases.
                  </td>
                </tr>
              ) : (
                suspense.map((c, i) => (
                  <tr key={String(c.id ?? i)}>
                    <td className="mono">{cell(c.id)}</td>
                    <td>{cell(c.state ?? c.status)}</td>
                    <td className="mono">{JSON.stringify(c).slice(0, 160)}…</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Commission liabilities</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Agent</th>
                <th>Net</th>
              </tr>
            </thead>
            <tbody>
              {liabilities.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No open commission liabilities.
                  </td>
                </tr>
              ) : (
                liabilities.map((l, i) => (
                  <tr key={`${cell(l.source_id)}-${i}`}>
                    <td>
                      {cell(l.source_type)} / <span className="mono">{cell(l.source_id)}</span>
                    </td>
                    <td className="mono">{cell(l.agent_user_id)}</td>
                    <td>{centsLabel(l.net_cents)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
