import { useCallback, useEffect, useState } from 'react';

import {
  apiDecideApproval,
  apiListApprovals,
  type OpsApprovalRequest,
} from './api';

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export function ApprovalsTab() {
  const [approvals, setApprovals] = useState<OpsApprovalRequest[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'pending' | 'all'>('pending');

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await apiListApprovals();
      setApprovals(result.approvals ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load approvals');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (row: OpsApprovalRequest, decision: 'approved' | 'rejected') => {
    const reason = window.prompt(
      `Reason for ${decision} (min 10 chars)`,
      decision === 'approved' ? 'Checker approved after dual-control review' : '',
    );
    if (!reason || reason.trim().length < 10) {
      setError('Decision reason must be at least 10 characters.');
      return;
    }
    setBusyId(row.id);
    setError('');
    try {
      await apiDecideApproval(row.id, decision, reason.trim());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decision failed');
    } finally {
      setBusyId(null);
    }
  };

  const rows = approvals.filter((a) =>
    filter === 'pending' ? a.state === 'pending' : true,
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>Maker-checker approvals</h2>
          <p className="muted">
            Pending dual-control requests. Maker and checker must be different operators.
            Use an approval id from Ledger / Risk resume flows when applying gated actions.
          </p>
        </div>
        <div className="filters">
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as 'pending' | 'all')}
          >
            <option value="pending">Pending</option>
            <option value="all">All</option>
          </select>
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Created</th>
              <th>Action</th>
              <th>Resource</th>
              <th>State</th>
              <th>Maker</th>
              <th>Expires</th>
              <th>Reason</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="muted">
                  No {filter === 'pending' ? 'pending ' : ''}approvals.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td>{fmtDate(row.created_at)}</td>
                  <td className="mono">{row.action_type}</td>
                  <td>
                    <div className="mono">{row.resource_type}</div>
                    <div className="muted mono">{row.resource_id}</div>
                  </td>
                  <td>
                    <strong>{row.state}</strong>
                    {row.state === 'pending' ? (
                      <div className="muted mono" title={row.id}>
                        {row.id.slice(0, 8)}…
                      </div>
                    ) : null}
                  </td>
                  <td className="mono">{row.maker_operator_id.slice(0, 8)}…</td>
                  <td>{fmtDate(row.expires_at)}</td>
                  <td>{row.reason}</td>
                  <td>
                    {row.state === 'pending' ? (
                      <div className="filters">
                        <button
                          type="button"
                          disabled={busyId === row.id}
                          onClick={() => void decide(row, 'approved')}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          disabled={busyId === row.id}
                          onClick={() => void decide(row, 'rejected')}
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => void navigator.clipboard.writeText(row.id)}
                        >
                          Copy id
                        </button>
                      </div>
                    ) : (
                      <span className="muted">
                        {row.decision_reason ?? '—'}
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
