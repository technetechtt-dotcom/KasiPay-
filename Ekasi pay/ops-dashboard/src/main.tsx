import './styles.css';

import { Component, Fragment, StrictMode, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  apiAuditEvents,
  apiBaseUrl,
  apiCashSendVouchers,
  apiComplianceFlags,
  apiDisburseLoan,
  apiFetchMerchantDocument,
  apiInsuranceClaims,
  apiLoans,
  apiLogin,
  apiMe,
  apiMerchantDetail,
  apiMerchants,
  apiOverview,
  apiReconciliation,
  apiReviewMerchant,
  apiTransactions,
  apiUpdateComplianceFlag,
  apiUpdateInsuranceClaim,
  apiUserDetail,
  apiUsers,
  clearToken,
  getToken,
  type OpsAdminUser,
  type OpsCashSendVoucher,
  type OpsInsuranceClaim,
  type OpsLoan,
  type OpsMerchant,
  type OpsMerchantDoc,
  type OpsUser,
  type Overview,
} from './api';

type Tab =
  | 'overview'
  | 'users'
  | 'merchants'
  | 'claims'
  | 'loans'
  | 'compliance'
  | 'audit'
  | 'transactions'
  | 'cashsend';

const MERCHANT_DOC_LABELS: Record<string, string> = {
  cipc_14_3: 'CIPC 14.3',
  beee_certificate: 'B-BBEE certificate',
  municipal_business_reg: 'Municipal business registration',
  proof_of_bank: 'Proof of bank account',
};

function fmtMoney(n: number) {
  return `R${n.toFixed(2)}`;
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [username, setUsername] = useState('IvanIJ');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const apiUrl = apiBaseUrl() || '(dev proxy)';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      clearToken();
      await apiLogin(username.trim(), password);
      if (!getToken()) {
        throw new Error('Login did not store a session token.');
      }
      onSuccess();
    } catch (err) {
      clearToken();
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Ekasi Pay Ops</h1>
        <p className="muted">
          Sign in with your ops username and password.
        </p>
        <p className="muted" style={{ fontSize: 12 }}>
          API: {apiUrl}
        </p>
        <label>
          Username
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={loading || !password}>
          {loading ? 'Signing in...' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

function OverviewTab({ data }: { data: Overview }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Platform overview</h2>
        <span className="badge">{data.dataSource}</span>
      </div>
      <p className="muted">Generated {fmtDate(data.generatedAt)}</p>
      <div className="stat-grid">
        <StatCard label="Total users" value={String(data.users.total)} sub={`${data.users.active} active`} />
        <StatCard label="Suspended" value={String(data.users.suspended)} />
        <StatCard label="Merchants" value={String(data.users.merchants)} />
        <StatCard label="Open compliance flags" value={String(data.compliance.openFlags)} />
        <StatCard label="Active wallets" value={String(data.wallets.activeCount)} />
        <StatCard label="Wallet balances (sum)" value={fmtMoney(data.wallets.totalUserBalance)} />
        <StatCard
          label="Transactions (24h)"
          value={String(data.transactions24h.count)}
          sub={fmtMoney(data.transactions24h.volume)}
        />
      </div>
    </div>
  );
}

function UsersTab() {
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [users, setUsers] = useState<OpsUser[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof apiUserDetail>> | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await apiUsers({
        search: search || undefined,
        role: role || undefined,
        status: status || undefined,
        limit: 100,
      });
      setUsers(r.users);
      setTotal(r.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    }
  }, [search, role, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void apiUserDetail(selectedId)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load user'));
  }, [selectedId]);

  return (
    <div className="split-panel">
      <div className="panel">
        <div className="panel-head">
          <h2>Users</h2>
          <span className="muted">{total} total</span>
        </div>
        <div className="filters">
          <input
            placeholder="Search name, phone, idâ€¦"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">All roles</option>
            <option value="customer">Customer</option>
            <option value="merchant">Merchant</option>
            <option value="admin">Admin</option>
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="deleted">Deleted</option>
          </select>
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Role</th>
                <th>KYC</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr
                  key={u.id}
                  className={selectedId === u.id ? 'selected' : ''}
                  onClick={() => setSelectedId(u.id)}
                >
                  <td>{u.name}</td>
                  <td>{u.phone}</td>
                  <td>{u.role}</td>
                  <td>{u.kycStatus}</td>
                  <td>
                    {u.deletedAt ? 'deleted' : u.suspendedAt ? 'suspended' : 'active'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="panel detail-panel">
        <h2>User detail</h2>
        {!detail ? (
          <p className="muted">Select a user</p>
        ) : (
          <>
            <dl className="detail-dl">
              <dt>Name</dt>
              <dd>{detail.user.name}</dd>
              <dt>Phone</dt>
              <dd>{detail.user.phone}</dd>
              <dt>Role</dt>
              <dd>{detail.user.role}</dd>
              <dt>KYC / tier</dt>
              <dd>
                {detail.user.kycStatus} / {detail.user.accountTier}
              </dd>
              <dt>Joined</dt>
              <dd>{fmtDate(detail.user.createdAt)}</dd>
              {detail.wallet ? (
                <>
                  <dt>Wallet</dt>
                  <dd>
                    {fmtMoney(detail.wallet.balance)} ({detail.wallet.status})
                  </dd>
                </>
              ) : null}
              {detail.merchant ? (
                <>
                  <dt>Shop</dt>
                  <dd>{detail.merchant.business_name}</dd>
                </>
              ) : null}
            </dl>
            {detail.complianceFlags.length > 0 ? (
              <>
                <h3>Compliance flags</h3>
                <ul className="flag-list">
                  {detail.complianceFlags.map((f) => (
                    <li key={f.id}>
                      <strong>{f.severity}</strong> {f.reason}{' '}
                      <span className="muted">({f.status})</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {detail.recentTransactions.length > 0 ? (
              <>
                <h3>Recent transactions</h3>
                <ul className="txn-list">
                  {detail.recentTransactions.map((t) => (
                    <li key={t.id}>
                      {t.type} {fmtMoney(t.amount)} â€” {t.reference}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function ComplianceTab() {
  const [status, setStatus] = useState('open');
  const [flags, setFlags] = useState<
    Awaited<ReturnType<typeof apiComplianceFlags>>['flags']
  >([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await apiComplianceFlags(status || undefined);
      setFlags(r.flags);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = async (id: string, next: 'resolved' | 'dismissed') => {
    setBusyId(id);
    setError('');
    try {
      await apiUpdateComplianceFlag(id, next);
      setFlags((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Compliance &amp; AML</h2>
        <button type="button" className="ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="resolved">Resolved</option>
          <option value="dismissed">Dismissed</option>
          <option value="">All</option>
        </select>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Severity</th>
              <th>Reason</th>
              <th>Status</th>
              <th>When</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {flags.map((f) => (
              <tr key={f.id}>
                <td>
                  {f.userName ?? f.userId}
                  {f.userPhone ? ` (${f.userPhone})` : ''}
                </td>
                <td>{f.severity}</td>
                <td>{f.reason}</td>
                <td>{f.status}</td>
                <td>{fmtDate(f.createdAt)}</td>
                <td>
                  {f.status === 'open' ? (
                    <div className="row-actions">
                      <button
                        type="button"
                        disabled={busyId === f.id}
                        onClick={() => void update(f.id, 'resolved')}
                      >
                        Resolve
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busyId === f.id}
                        onClick={() => void update(f.id, 'dismissed')}
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {flags.length === 0 ? <p className="muted">No flags in this filter.</p> : null}
    </div>
  );
}

function MerchantsTab() {
  const [status, setStatus] = useState('pending_approval');
  const [merchants, setMerchants] = useState<OpsMerchant[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [docsById, setDocsById] = useState<Record<string, OpsMerchantDoc[]>>({});

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await apiMerchants(status || undefined);
      setMerchants(r.merchants);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load merchants');
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDocs = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (docsById[id]) return;
    try {
      const r = await apiMerchantDetail(id);
      setDocsById((prev) => ({ ...prev, [id]: r.documents }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load documents');
    }
  };

  const viewDoc = async (merchantId: string, docType: string) => {
    try {
      const { blob, fileName } = await apiFetchMerchantDocument(merchantId, docType);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      void fileName;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open document');
    }
  };

  const review = async (id: string, next: 'approved' | 'rejected') => {
    if (next === 'rejected' && !reasons[id]?.trim()) {
      setError('Add a rejection reason first.');
      return;
    }
    setBusyId(id);
    setError('');
    try {
      const { merchant } = await apiReviewMerchant(id, {
        status: next,
        reason: reasons[id]?.trim() || undefined,
      });
      if (status && status !== next && status !== 'all') {
        setMerchants((prev) => prev.filter((m) => m.id !== id));
      } else {
        setMerchants((prev) => prev.map((m) => (m.id === id ? { ...m, ...merchant } : m)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Review failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Merchant approvals</h2>
        <button type="button" className="ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending_approval">Pending approval</option>
          <option value="pending_docs">Pending docs</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="card-list">
        {merchants.map((m) => (
          <div key={m.id} className="action-card">
            <div className="action-card-head">
              <div>
                <strong>{m.businessName}</strong>
                <p className="muted">
                  {m.ownerName ?? 'Owner'} · {m.ownerPhone ?? '—'} · {m.location}
                </p>
              </div>
              <span className="badge">{(m.approvalStatus ?? '—').replace(/_/g, ' ')}</span>
            </div>
            <p className="muted">
              Docs {m.documentsUploaded ?? 0}/{m.documentsRequired ?? 4}
              {m.rejectionReason ? ` · Rejected: ${m.rejectionReason}` : ''}
            </p>
            <button type="button" className="ghost" onClick={() => void openDocs(m.id)}>
              {expandedId === m.id ? 'Hide documents' : 'View documents'}
            </button>
            {expandedId === m.id ? (
              <ul className="doc-list">
                {(docsById[m.id] ?? []).length === 0 ? (
                  <li className="muted">No documents uploaded.</li>
                ) : (
                  (docsById[m.id] ?? []).map((d) => (
                    <li key={d.docType}>
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => void viewDoc(m.id, d.docType)}
                      >
                        {MERCHANT_DOC_LABELS[d.docType] ?? d.docType}
                      </button>
                      <span className="muted"> {d.fileName}</span>
                    </li>
                  ))
                )}
              </ul>
            ) : null}
            {(m.approvalStatus === 'pending_approval' ||
              m.approvalStatus === 'rejected' ||
              m.approvalStatus === 'pending_docs') && (
              <div className="review-box">
                <input
                  placeholder="Rejection reason (required to reject)"
                  value={reasons[m.id] ?? ''}
                  onChange={(e) =>
                    setReasons((prev) => ({ ...prev, [m.id]: e.target.value }))
                  }
                />
                <div className="row-actions">
                  <button
                    type="button"
                    disabled={busyId === m.id}
                    onClick={() => void review(m.id, 'approved')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busyId === m.id}
                    onClick={() => void review(m.id, 'rejected')}
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {merchants.length === 0 ? <p className="muted">No merchants in this queue.</p> : null}
    </div>
  );
}

function ClaimsTab() {
  const [status, setStatus] = useState('submitted');
  const [claims, setClaims] = useState<OpsInsuranceClaim[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await apiInsuranceClaims(status || undefined);
      setClaims(r.claims);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load claims');
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = async (id: string, next: 'approved' | 'rejected' | 'paid') => {
    setBusyId(id);
    setError('');
    try {
      const { claim } = await apiUpdateInsuranceClaim(id, {
        status: next,
        adminNote: notes[id]?.trim() || undefined,
      });
      if (status && status !== next) {
        setClaims((prev) => prev.filter((c) => c.id !== id));
      } else {
        setClaims((prev) => prev.map((c) => (c.id === id ? claim : c)));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Insurance claims</h2>
        <button type="button" className="ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="paid">Paid</option>
          <option value="">All</option>
        </select>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="card-list">
        {claims.map((c) => (
          <div key={c.id} className="action-card">
            <div className="action-card-head">
              <div>
                <strong>
                  {fmtMoney(c.claimedAmount)} · {c.type}
                </strong>
                <p className="muted">
                  {c.merchantBusinessName ?? c.merchantId} · {fmtDate(c.createdAt)}
                </p>
              </div>
              <span className="badge">{c.status}</span>
            </div>
            <p>{c.description}</p>
            {c.adminNote ? <p className="muted">Note: {c.adminNote}</p> : null}
            {(c.status === 'submitted' || c.status === 'approved') && (
              <div className="review-box">
                <input
                  placeholder="Admin note (optional)"
                  value={notes[c.id] ?? ''}
                  onChange={(e) =>
                    setNotes((prev) => ({ ...prev, [c.id]: e.target.value }))
                  }
                />
                <div className="row-actions">
                  {c.status === 'submitted' ? (
                    <>
                      <button
                        type="button"
                        disabled={busyId === c.id}
                        onClick={() => void update(c.id, 'approved')}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busyId === c.id}
                        onClick={() => void update(c.id, 'rejected')}
                      >
                        Reject
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === c.id}
                      onClick={() => void update(c.id, 'paid')}
                    >
                      Mark paid
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      {claims.length === 0 ? <p className="muted">No claims in this filter.</p> : null}
    </div>
  );
}

function LoansTab() {
  const [loans, setLoans] = useState<OpsLoan[]>([]);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await apiLoans('pending');
      setLoans(r.loans);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load loans');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const disburse = async (loan: OpsLoan) => {
    setBusyId(loan.id);
    setError('');
    try {
      await apiDisburseLoan(loan.id);
      setLoans((prev) => prev.filter((l) => l.id !== loan.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Disbursement failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Loan disbursement queue</h2>
        <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Amount</th>
              <th>APR</th>
              <th>Borrower</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loans.map((loan) => (
              <tr key={loan.id}>
                <td>{fmtMoney(loan.amount)}</td>
                <td>{(loan.interestRate * 100).toFixed(1)}%</td>
                <td className="mono">{loan.userId}</td>
                <td>{loan.status}</td>
                <td>
                  <button
                    type="button"
                    disabled={busyId === loan.id}
                    onClick={() => void disburse(loan)}
                  >
                    {busyId === loan.id ? 'Posting…' : 'Disburse'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {loans.length === 0 && !loading ? (
        <p className="muted">No pending loan applications.</p>
      ) : null}
    </div>
  );
}

function AuditTab() {
  const [events, setEvents] = useState<Awaited<ReturnType<typeof apiAuditEvents>>['events']>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void apiAuditEvents()
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, []);

  return (
    <div className="panel">
      <h2>Audit events</h2>
      {error ? <p className="error">{error}</p> : null}
      <ul className="audit-list">
        {events.map((e) => (
          <li key={e.id}>
            <span className="badge">{e.type}</span>
            <span>{e.message}</span>
            <span className="muted">{fmtDate(e.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CashSendTab() {
  const [status, setStatus] = useState<
    'collected' | 'all' | 'active' | 'expired' | 'cancelled'
  >('all');
  const [search, setSearch] = useState('');
  const [vouchers, setVouchers] = useState<OpsCashSendVoucher[]>([]);
  const [total, setTotal] = useState(0);
  const [amountSum, setAmountSum] = useState(0);
  const [feeSum, setFeeSum] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const r = await apiCashSendVouchers({
        status,
        search: search || undefined,
        limit: 200,
      });
      setVouchers(r.vouchers);
      setTotal(r.total);
      setAmountSum(r.amountSum ?? 0);
      setFeeSum(r.feeSum ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vouchers');
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Cash Send vouchers</h2>
        <span className="badge">{total} records</span>
      </div>
      <p className="muted">
        Full voucher details: sender KYC, beneficiary, fees, expiry, collection ID scan, and
        cancel/expire reasons.
      </p>
      <div className="stat-grid" style={{ marginBottom: '1rem' }}>
        <div className="stat-card">
          <div className="stat-label">Filtered amount</div>
          <div className="stat-value">{fmtMoney(amountSum)}</div>
          <div className="stat-sub">{total} vouchers</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Filtered fees</div>
          <div className="stat-value">{fmtMoney(feeSum)}</div>
          <div className="stat-sub">Agent / platform fees</div>
        </div>
      </div>
      <div className="filters">
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">All statuses</option>
          <option value="active">Active (unclaimed)</option>
          <option value="collected">Withdrawn</option>
          <option value="expired">Expired</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <input
          type="search"
          placeholder="Search voucher, sender, withdrawer, ID, addressâ€¦"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loadingâ€¦' : 'Refresh'}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table className="cash-send-table">
          <thead>
            <tr>
              <th rowSpan={2} />
              <th rowSpan={2}>Voucher</th>
              <th rowSpan={2}>Amount</th>
              <th rowSpan={2}>Fee</th>
              <th rowSpan={2}>Status</th>
              <th rowSpan={2}>Created</th>
              <th rowSpan={2}>Expires</th>
              <th rowSpan={2}>Withdrawn</th>
              <th rowSpan={2}>ID verified</th>
              <th colSpan={5} className="th-group">
                Sender (customer who sent)
              </th>
              <th colSpan={4} className="th-group">
                Beneficiary / withdrawer
              </th>
            </tr>
            <tr>
              <th>Name</th>
              <th>Surname</th>
              <th>Phone</th>
              <th>SA ID</th>
              <th>Address</th>
              <th>Name</th>
              <th>Surname</th>
              <th>Phone</th>
              <th>SA ID scanned</th>
            </tr>
          </thead>
          <tbody>
            {vouchers.map((v) => {
              const open = expandedId === v.id;
              return (
                <Fragment key={v.id}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        style={{ padding: '0.25rem 0.5rem' }}
                        onClick={() => setExpandedId(open ? null : v.id)}
                      >
                        {open ? 'Hide' : 'Details'}
                      </button>
                    </td>
                    <td className="mono">{v.referenceNumber}</td>
                    <td>{fmtMoney(v.amount)}</td>
                    <td>{fmtMoney(v.fee)}</td>
                    <td>{v.status}</td>
                    <td>{fmtDate(v.createdAt)}</td>
                    <td>{fmtDate(v.expiresAt)}</td>
                    <td>{v.withdrawnAt ? fmtDate(v.withdrawnAt) : 'â€”'}</td>
                    <td>{v.idVerifiedAtWithdrawal ? 'Yes' : 'â€”'}</td>
                    <td>{v.sender.firstName || 'â€”'}</td>
                    <td>{v.sender.lastName || 'â€”'}</td>
                    <td>{v.sender.phone || 'â€”'}</td>
                    <td className="mono">{v.sender.idDocument ?? 'â€”'}</td>
                    <td>{v.senderAddress || 'â€”'}</td>
                    <td>{v.withdrawer.firstName || 'â€”'}</td>
                    <td>{v.withdrawer.lastName || 'â€”'}</td>
                    <td>{v.withdrawer.phone || 'â€”'}</td>
                    <td className="mono">
                      {v.collectorScannedId ?? v.withdrawer.idDocument ?? 'â€”'}
                    </td>
                  </tr>
                  {open ? (
                    <tr className="detail-row">
                      <td colSpan={18}>
                        <div className="detail-grid">
                          <div>
                            <strong>Voucher ID</strong>
                            <div className="mono muted">{v.id}</div>
                          </div>
                          <div>
                            <strong>Shop user ID (agent)</strong>
                            <div className="mono muted">{v.senderUserId ?? 'â€”'}</div>
                          </div>
                          <div>
                            <strong>Sender address</strong>
                            <div>{v.senderAddress ?? 'â€”'}</div>
                          </div>
                          <div>
                            <strong>Sender SA ID (full)</strong>
                            <div className="mono">{v.sender.idDocument ?? 'â€”'}</div>
                          </div>
                          <div>
                            <strong>Beneficiary ID on file</strong>
                            <div className="mono">{v.recipientIdOnFile ?? 'â€”'}</div>
                          </div>
                          <div>
                            <strong>ID scanned at collection</strong>
                            <div className="mono">{v.collectorScannedId ?? 'â€”'}</div>
                          </div>
                          <div>
                            <strong>ID verified at withdrawal</strong>
                            <div>{v.idVerifiedAtWithdrawal ? 'Yes' : 'No'}</div>
                          </div>
                          <div>
                            <strong>Cancel / expire reason</strong>
                            <div>{v.cancelReason ?? 'â€”'}</div>
                          </div>
                          <div>
                            <strong>Total held (amount + fee)</strong>
                            <div>{fmtMoney(v.amount + v.fee)}</div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {vouchers.length === 0 && !loading ? (
        <p className="muted">No vouchers match this filter.</p>
      ) : null}
    </div>
  );
}

function TransactionsTab() {
  const [txns, setTxns] = useState<
    Awaited<ReturnType<typeof apiTransactions>>['transactions']
  >([]);
  const [totals, setTotals] = useState<
    Awaited<ReturnType<typeof apiTransactions>>['totals'] | null
  >(null);
  const [types, setTypes] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const [status, setStatus] = useState('all');
  const [recon, setRecon] = useState<Awaited<ReturnType<typeof apiReconciliation>> | null>(
    null,
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [t, r] = await Promise.all([
        apiTransactions({
          search: search || undefined,
          type: type === 'all' ? undefined : type,
          status: status === 'all' ? undefined : status,
          limit: 200,
        }),
        apiReconciliation(),
      ]);
      setTxns(t.transactions);
      setTotals(t.totals);
      setTypes(t.types ?? []);
      setTotal(t.total);
      setRecon(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [search, type, status]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Transactions</h2>
        <span className="badge">{total} matching</span>
      </div>
      {recon ? (
        <p className={recon.ok ? 'ok-banner' : 'warn-banner'}>
          Reconciliation: {recon.ok ? 'OK' : `${recon.discrepancies.length} discrepancies`}{' '}
          ({recon.walletsChecked} wallets checked)
        </p>
      ) : null}

      {totals ? (
        <div className="stat-grid" style={{ marginBottom: '1rem' }}>
          <div className="stat-card">
            <div className="stat-label">Today</div>
            <div className="stat-value">{fmtMoney(totals.day.volume)}</div>
            <div className="stat-sub">{totals.day.count} txns</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">This week</div>
            <div className="stat-value">{fmtMoney(totals.week.volume)}</div>
            <div className="stat-sub">{totals.week.count} txns</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">This month</div>
            <div className="stat-value">{fmtMoney(totals.month.volume)}</div>
            <div className="stat-sub">{totals.month.count} txns</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">This year</div>
            <div className="stat-value">{fmtMoney(totals.year.volume)}</div>
            <div className="stat-sub">{totals.year.count} txns</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Filtered total</div>
            <div className="stat-value">{fmtMoney(totals.filtered.volume)}</div>
            <div className="stat-sub">{totals.filtered.count} matching</div>
          </div>
        </div>
      ) : null}

      <div className="filters">
        <input
          type="search"
          placeholder="Search voucher, reference, description, typeâ€¦"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="completed">Completed</option>
          <option value="pending">Pending</option>
          <option value="failed">Failed</option>
        </select>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loadingâ€¦' : 'Refresh'}
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Voucher</th>
              <th>Reference</th>
              <th>Description</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td>{t.type}</td>
                <td>{fmtMoney(t.amount)}</td>
                <td>{t.status}</td>
                <td className="mono">{t.voucherNumber ?? 'â€”'}</td>
                <td className="mono">{t.reference}</td>
                <td>{t.description || 'â€”'}</td>
                <td>{fmtDate(t.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {txns.length === 0 && !loading ? (
        <p className="muted">No transactions match this filter.</p>
      ) : null}
    </div>
  );
}

function Dashboard({ me }: { me: OpsAdminUser }) {
  const [tab, setTab] = useState<Tab>('overview');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  const refreshOverview = useCallback(() => {
    void apiOverview()
      .then(setOverview)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load overview'));
  }, []);

  useEffect(() => {
    if (tab === 'overview') refreshOverview();
  }, [tab, refreshOverview]);

  const logout = () => {
    clearToken();
    window.location.reload();
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'users', label: 'Users' },
    { id: 'merchants', label: 'Merchants' },
    { id: 'claims', label: 'Claims' },
    { id: 'loans', label: 'Loans' },
    { id: 'cashsend', label: 'Cash Send' },
    { id: 'compliance', label: 'Compliance' },
    { id: 'audit', label: 'Audit' },
    { id: 'transactions', label: 'Transactions' },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <strong>Ekasi Pay Ops</strong>
          <span className="muted">
            {' '}
            signed in as {me.name ?? me.username}
            {me.phone ? ` (${me.phone})` : ''}
          </span>
        </div>
        <button type="button" className="ghost" onClick={logout}>
          Sign out
        </button>
      </header>
      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="main">
        {error && tab === 'overview' ? <p className="error">{error}</p> : null}
        {tab === 'overview' && overview ? <OverviewTab data={overview} /> : null}
        {tab === 'users' ? <UsersTab /> : null}
        {tab === 'merchants' ? <MerchantsTab /> : null}
        {tab === 'claims' ? <ClaimsTab /> : null}
        {tab === 'loans' ? <LoansTab /> : null}
        {tab === 'cashsend' ? <CashSendTab /> : null}
        {tab === 'compliance' ? <ComplianceTab /> : null}
        {tab === 'audit' ? <AuditTab /> : null}
        {tab === 'transactions' ? <TransactionsTab /> : null}
      </main>
    </div>
  );
}

function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));
  const [me, setMe] = useState<OpsAdminUser | null>(null);
  const [bootError, setBootError] = useState('');

  useEffect(() => {
    if (!authed) return;
    setBootError('');
    void apiMe()
      .then((r) => setMe(r.user))
      .catch((e) => {
        clearToken();
        setMe(null);
        setAuthed(false);
        setBootError(e instanceof Error ? e.message : 'Session expired');
      });
  }, [authed]);

  if (!authed) {
    return (
      <>
        {bootError ? (
          <div className="login-wrap" style={{ paddingBottom: 0 }}>
            <p className="error" style={{ textAlign: 'center' }}>
              {bootError}
            </p>
          </div>
        ) : null}
        <LoginScreen onSuccess={() => setAuthed(true)} />
      </>
    );
  }
  if (!me) {
    return (
      <div className="login-wrap">
        <div className="login-card">
          <h1>Ekasi Pay Ops</h1>
          <p className="muted">Loading account...</p>
        </div>
      </div>
    );
  }
  return <Dashboard me={me} />;
}

class RootErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('Ops dashboard render error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="login-wrap">
          <div className="login-card">
            <h1>Ekasi Pay Ops</h1>
            <p className="error">The dashboard failed to load in this browser.</p>
            <p className="muted">
              Refresh the page. If it still fails, clear site data and try again.
            </p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </StrictMode>,
);
