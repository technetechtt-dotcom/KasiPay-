import './styles.css';

import { Component, Fragment, StrictMode, useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import {
  apiAdminUsers,
  apiAuditEvents,
  apiBaseUrl,
  apiCashSendVouchers,
  apiComplianceFlags,
  apiCreateAdminUser,
  apiDeleteAdminUser,
  apiDisburseLoan,
  apiFetchMerchantDocument,
  apiInsuranceClaims,
  apiLoans,
  apiLogin,
  apiMe,
  apiMerchantDetail,
  apiMerchants,
  apiOverview,
  apiPatchAppUser,
  apiProductReadiness,
  apiRuntimeControls,
  apiRiskCases,
  apiRiskHolds,
  apiAddFraudCaseNote,
  apiDecideRiskHold,
  apiSetFinancialPosting,
  apiSettlementOverview,
  apiImportSettlementStatement,
  apiFeeSchedules,
  apiReconciliation,
  apiReviewMerchant,
  apiRunReconciliation,
  apiTransactions,
  apiUpdateAdminUser,
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
  type OpsFraudCase,
  type OpsTransactionHold,
  type RuntimeProductControls,
} from './api';
import { addMoney, formatMoney as fmtMoney } from './money';

function ProductGateNotice({ title, detail }: { title: string; detail: string }) {
  return (
    <p className="error" role="status">
      <strong>{title}</strong> — {detail}
    </p>
  );
}

type Tab =
  | 'overview'
  | 'users'
  | 'merchants'
  | 'claims'
  | 'loans'
  | 'ledger'
  | 'operators'
  | 'compliance'
  | 'audit'
  | 'transactions'
  | 'cashsend'
  | 'risk'
  | 'settlement'
  | 'readiness';

const MERCHANT_DOC_LABELS: Record<string, string> = {
  cipc_14_3: 'CIPC 14.3',
  beee_certificate: 'B-BBEE certificate',
  municipal_business_reg: 'Municipal business registration',
  proof_of_bank: 'Proof of bank account',
};

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
  const [totp, setTotp] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const apiUrl = apiBaseUrl() || '(dev proxy)';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      clearToken();
      await apiLogin(username.trim(), password, totp);
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
          Sign in with your ops username, password, and authenticator code.
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
          Authenticator code
          <input
            type="text"
            inputMode="numeric"
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoComplete="one-time-code"
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
        <button type="submit" disabled={loading || !password || totp.length !== 6}>
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
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const patchUser = async (body: { role?: string; suspended?: boolean }) => {
    if (!detail) return;
    setBusyId(detail.user.id);
    setError('');
    try {
      const { user } = await apiPatchAppUser(detail.user.id, body);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              user: {
                ...prev.user,
                role: user.role,
                suspendedAt: user.suspendedAt ?? null,
              },
            }
          : prev,
      );
      setUsers((prev) =>
        prev.map((u) =>
          u.id === user.id
            ? {
                ...u,
                role: user.role,
                suspendedAt: user.suspendedAt ?? null,
              }
            : u,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update user');
    } finally {
      setBusyId(null);
    }
  };

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
            <div className="review-box">
              <label className="muted">
                Change role
                <select
                  value={detail.user.role}
                  disabled={busyId === detail.user.id}
                  onChange={(e) => void patchUser({ role: e.target.value })}
                >
                  {['customer', 'merchant', 'agent', 'admin'].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={detail.user.suspendedAt ? '' : 'danger'}
                disabled={busyId === detail.user.id}
                onClick={() =>
                  void patchUser({ suspended: !detail.user.suspendedAt })
                }
              >
                {busyId === detail.user.id
                  ? 'Saving…'
                  : detail.user.suspendedAt
                    ? 'Reactivate account'
                    : 'Suspend account'}
              </button>
            </div>
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

  const review = async (
    id: string,
    next: 'approved' | 'rejected',
  ) => {
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
                    disabled={
                      busyId === m.id ||
                      (m.documentsUploaded ?? 0) < (m.documentsRequired ?? 4)
                    }
                    title={
                      (m.documentsUploaded ?? 0) < (m.documentsRequired ?? 4)
                        ? 'All required documents must be uploaded'
                        : undefined
                    }
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
  const [controls, setControls] = useState<RuntimeProductControls | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [r, runtime] = await Promise.all([
        apiInsuranceClaims(status || undefined),
        apiRuntimeControls().catch(() => ({
          controls: {
            financialPosting: false,
            lending: false,
            insurance: false,
            stokvelMoneyMovement: false,
            cashSend: false,
            liveUtilities: false,
          } satisfies RuntimeProductControls,
        })),
      ]);
      setClaims(r.claims);
      setControls(runtime.controls);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load claims');
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const insuranceEnabled = controls?.insurance === true;

  const update = async (id: string, next: 'approved' | 'rejected' | 'paid') => {
    if (!insuranceEnabled) {
      setError('Insurance is disabled on this deployment.');
      return;
    }
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
      {!insuranceEnabled ? (
        <ProductGateNotice
          title="Insurance is disabled"
          detail="Claim decisions are blocked until INSURANCE_ENABLED is approved for this environment."
        />
      ) : null}
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
                        disabled={!insuranceEnabled || busyId === c.id}
                        onClick={() => void update(c.id, 'approved')}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={!insuranceEnabled || busyId === c.id}
                        onClick={() => void update(c.id, 'rejected')}
                      >
                        Reject
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={!insuranceEnabled || busyId === c.id}
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
  const [controls, setControls] = useState<RuntimeProductControls | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [r, runtime] = await Promise.all([
        apiLoans('pending'),
        apiRuntimeControls().catch(() => ({
          controls: {
            financialPosting: false,
            lending: false,
            insurance: false,
            stokvelMoneyMovement: false,
            cashSend: false,
            liveUtilities: false,
          } satisfies RuntimeProductControls,
        })),
      ]);
      setLoans(r.loans);
      setControls(runtime.controls);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load loans');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const lendingEnabled = controls?.lending === true;

  const disburse = async (loan: OpsLoan) => {
    if (!lendingEnabled) {
      setError('Lending is disabled on this deployment.');
      return;
    }
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
      {!lendingEnabled ? (
        <ProductGateNotice
          title="Lending is disabled"
          detail="Loan disbursement is blocked until LENDING_ENABLED is approved for this environment."
        />
      ) : null}
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
                <td>{loan.interestRate} fractional rate</td>
                <td className="mono">{loan.userId}</td>
                <td>{loan.status}</td>
                <td>
                  <button
                    type="button"
                    disabled={!lendingEnabled || busyId === loan.id}
                    onClick={() => void disburse(loan)}
                  >
                    {!lendingEnabled
                      ? 'Disabled'
                      : busyId === loan.id
                        ? 'Posting…'
                        : 'Disburse'}
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

function LedgerTab() {
  const [report, setReport] = useState<Awaited<
    ReturnType<typeof apiRunReconciliation>
  > | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await apiReconciliation();
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load reconciliation');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await apiRunReconciliation();
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reconciliation failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Ledger &amp; reconciliation</h2>
        <div className="row-actions">
          <button type="button" className="ghost" onClick={() => void load()}>
            Refresh
          </button>
          <button type="button" disabled={busy} onClick={() => void run()}>
            {busy ? 'Running…' : 'Run reconciliation'}
          </button>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {report ? (
        <>
          <p className={report.ok ? 'ok-banner' : 'warn-banner'}>
            {report.ok
              ? `OK — ${report.walletsChecked} wallets balanced`
              : `${report.discrepancies.length} discrepancy(ies) across ${report.walletsChecked} wallets`}
            <span className="muted"> · {fmtDate(report.ranAt)}</span>
          </p>
          {!report.ok ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Wallet</th>
                    <th>User</th>
                    <th>Wallet bal</th>
                    <th>Ledger bal</th>
                    <th>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {report.discrepancies.map((d) => (
                    <tr key={d.walletId}>
                      <td className="mono">{d.walletId.slice(0, 10)}…</td>
                      <td className="mono">{d.userId.slice(0, 10)}…</td>
                      <td>{fmtMoney(d.walletBalance)}</td>
                      <td>{fmtMoney(d.ledgerBalance)}</td>
                      <td>{fmtMoney(d.delta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : (
        <p className="muted">Loading reconciliation…</p>
      )}
    </div>
  );
}

function SettlementTab() {
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof apiSettlementOverview>> | null>(null);
  const [feeCount, setFeeCount] = useState<number | null>(null);
  const [provider, setProvider] = useState('simulator');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const [settlement, fees] = await Promise.all([
        apiSettlementOverview(),
        apiFeeSchedules(),
      ]);
      setOverview(settlement);
      setFeeCount(fees.schedules.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load settlement controls');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const importFile = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const contentBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      const result = await apiImportSettlementStatement({
        provider,
        fileName: file.name,
        contentBase64,
      });
      setMessage(
        `Imported ${result.rowCount} rows: ${result.matches.matched ?? 0} matched, ` +
        `${result.matches.partial ?? 0} partial, ${result.matches.unmatched ?? 0} unmatched.`,
      );
      setFile(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Statement import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Settlement & fee control</h2>
        <span className="badge">{feeCount ?? '—'} fee schedules</span>
      </div>
      <p className="muted">
        Imports require the Phase 6 canonical CSV schema. Hash duplicates are rejected
        and every break is journaled to suspense.
      </p>
      <form onSubmit={importFile} className="filters">
        <label>
          Provider
          <input value={provider} onChange={(e) => setProvider(e.target.value)} required />
        </label>
        <label>
          Statement CSV
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </label>
        <button type="submit" disabled={busy || !file}>
          {busy ? 'Reconciling…' : 'Import & reconcile'}
        </button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="success">{message}</p> : null}
      <div className="stat-grid">
        <StatCard label="Imported files" value={String(overview?.files.length ?? 0)} />
        <StatCard label="Open breaks" value={String(overview?.breaks.length ?? 0)} />
        <StatCard label="Settlement batches" value={String(overview?.batches.length ?? 0)} />
        <StatCard label="Daily closes" value={String(overview?.closes.length ?? 0)} />
      </div>
      {overview?.breaks.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Reference</th><th>Amount</th><th>Break</th><th>Journal</th><th>Opened</th></tr>
            </thead>
            <tbody>
              {overview.breaks.map((item) => (
                <tr key={item.id}>
                  <td>{item.provider_reference}</td>
                  <td>{item.currency} {(Number(item.amount_cents) / 100).toFixed(2)}</td>
                  <td><span className="badge">{item.reason_code}</span></td>
                  <td className="mono">{item.journal_transaction_id}</td>
                  <td>{fmtDate(item.opened_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="muted">No open settlement breaks.</p>}
    </div>
  );
}

function OperatorsTab({ me }: { me: OpsAdminUser }) {
  type OperatorRole = 'admin' | 'operations' | 'compliance' | 'finance' | 'support';
  const [users, setUsers] = useState<OpsAdminUser[]>([]);
  const [error, setError] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<OperatorRole>('support');
  const [busy, setBusy] = useState(false);
  const [resetPw, setResetPw] = useState<Record<string, string>>({});

  const canManage = String(me.role).toLowerCase() === 'admin';

  const load = useCallback(async () => {
    if (!canManage) return;
    setError('');
    try {
      const r = await apiAdminUsers();
      setUsers(r.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load operators');
    }
  }, [canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setOkMsg('');
    try {
      const { user } = await apiCreateAdminUser({
        username: username.trim(),
        password,
        role,
      });
      setUsername('');
      setPassword('');
      setRole('support');
      setOkMsg(`Created ${user.username} as ${user.role.replace(/_/g, ' ')}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  };

  const setUserRole = async (
    u: OpsAdminUser,
    nextRole: OperatorRole,
  ) => {
    if (u.id === me.id) {
      setError('You cannot change your own role.');
      return;
    }
    if (nextRole === u.role) return;
    setBusy(true);
    setError('');
    setOkMsg('');
    try {
      await apiUpdateAdminUser(u.id, { role: nextRole });
      setOkMsg(`Updated ${u.username} → ${nextRole.replace(/_/g, ' ')}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Role update failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (u: OpsAdminUser) => {
    if (u.id === me.id) {
      setError('You cannot deactivate your own account.');
      return;
    }
    setBusy(true);
    setError('');
    setOkMsg('');
    try {
      await apiUpdateAdminUser(u.id, { isActive: !u.isActive });
      setOkMsg(
        `${u.username} ${u.isActive ? 'deactivated' : 'activated'}.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async (u: OpsAdminUser) => {
    const pw = resetPw[u.id]?.trim() ?? '';
    if (pw.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    setError('');
    setOkMsg('');
    try {
      await apiUpdateAdminUser(u.id, { password: pw });
      setResetPw((prev) => ({ ...prev, [u.id]: '' }));
      setOkMsg(`Password updated for ${u.username}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password reset failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (u: OpsAdminUser) => {
    if (u.id === me.id) {
      setError('You cannot delete your own account.');
      return;
    }
    if (!window.confirm(`Delete ops user ${u.username}?`)) return;
    setBusy(true);
    setError('');
    setOkMsg('');
    try {
      await apiDeleteAdminUser(u.id);
      setOkMsg(`Deleted ${u.username}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <div className="panel">
        <h2>Ops users</h2>
        <p className="muted">
          Signed in as <strong>{me.username}</strong> ({me.role}). Only the
          admin role can create ops accounts and assign capabilities.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Ops users</h2>
        <button type="button" className="ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="muted">
        Admin <strong>{me.username}</strong> can create ops logins and assign
        deny-by-default operational roles.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {okMsg ? <p className="ok-banner">{okMsg}</p> : null}

      <form
        className="review-box"
        onSubmit={create}
        style={{ marginBottom: '1.25rem' }}
      >
        <h3 style={{ margin: 0 }}>Create ops account</h3>
        <label className="muted">
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            autoComplete="off"
          />
        </label>
        <label className="muted">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
        <label className="muted">
          Role
          <select
            value={role}
            onChange={(e) =>
              setRole(e.target.value as OperatorRole)
            }
          >
            {(['support', 'operations', 'compliance', 'finance', 'admin'] as const).map((value) =>
              <option key={value} value={value}>{value}</option>
            )}
          </select>
        </label>
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Create account'}
        </button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Username</th>
              <th>Role</th>
              <th>Active</th>
              <th>Last login</th>
              <th>Reset password</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.username}
                  {u.id === me.id ? (
                    <span className="muted"> (you)</span>
                  ) : null}
                </td>
                <td>
                  <select
                    value={u.role}
                    disabled={busy || u.id === me.id}
                    onChange={(e) =>
                      void setUserRole(
                        u,
                        e.target.value as OperatorRole,
                      )
                    }
                  >
                    {(['support', 'operations', 'compliance', 'finance', 'admin'] as const).map((value) =>
                      <option key={value} value={value}>{value}</option>
                    )}
                  </select>
                </td>
                <td>{u.isActive ? 'yes' : 'no'}</td>
                <td>{u.lastLoginAt ? fmtDate(u.lastLoginAt) : '—'}</td>
                <td>
                  <div className="row-actions">
                    <input
                      type="password"
                      placeholder="New password"
                      value={resetPw[u.id] ?? ''}
                      disabled={busy}
                      onChange={(e) =>
                        setResetPw((prev) => ({
                          ...prev,
                          [u.id]: e.target.value,
                        }))
                      }
                      style={{ minWidth: 120 }}
                    />
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || !(resetPw[u.id]?.trim().length >= 8)}
                      onClick={() => void resetPassword(u)}
                    >
                      Set
                    </button>
                  </div>
                </td>
                <td>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || u.id === me.id}
                      onClick={() => void toggleActive(u)}
                    >
                      {u.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy || u.id === me.id}
                      onClick={() => void remove(u)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {users.length === 0 ? (
        <p className="muted">No ops users loaded yet.</p>
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
  const [amountSum, setAmountSum] = useState('0.00');
  const [feeSum, setFeeSum] = useState('0.00');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [controls, setControls] = useState<RuntimeProductControls | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [r, runtime] = await Promise.all([
        apiCashSendVouchers({
          status,
          search: search || undefined,
          limit: 200,
        }),
        apiRuntimeControls().catch(() => ({
          controls: {
            financialPosting: false,
            lending: false,
            insurance: false,
            stokvelMoneyMovement: false,
            cashSend: false,
            liveUtilities: false,
          } satisfies RuntimeProductControls,
        })),
      ]);
      setVouchers(r.vouchers);
      setTotal(r.total);
      setAmountSum(r.amountSum ?? '0.00');
      setFeeSum(r.feeSum ?? '0.00');
      setControls(runtime.controls);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load vouchers');
    } finally {
      setLoading(false);
    }
  }, [status, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const cashSendEnabled = controls?.cashSend === true;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Cash Send vouchers</h2>
        <span className="badge">{total} records</span>
      </div>
      {!cashSendEnabled ? (
        <ProductGateNotice
          title="Cash Send is disabled"
          detail="Create, collect, and cancel are blocked until CASH_SEND_ENABLED is approved. This list remains available for investigation."
        />
      ) : null}
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
                            <div>{fmtMoney(addMoney(v.amount, v.fee))}</div>
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

function RiskReviewTab() {
  const [cases, setCases] = useState<OpsFraudCase[]>([]);
  const [holds, setHolds] = useState<OpsTransactionHold[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [caseResult, holdResult] = await Promise.all([apiRiskCases(), apiRiskHolds()]);
      setCases(caseResult.cases);
      setHolds(holdResult.holds);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load risk queue');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const decide = async (id: string, decision: 'released' | 'rejected') => {
    const reason = window.prompt('Decision reason (minimum 10 characters)');
    if (!reason) return;
    await apiDecideRiskHold(id, decision, reason);
    await load();
  };
  return (
    <div className="panel">
      <div className="panel-head"><h2>Fraud and risk review</h2><button onClick={() => void load()}>Refresh</button></div>
      {error ? <p className="error">{error}</p> : null}
      <h3>Transaction holds</h3>
      <div className="table-wrap"><table><thead><tr><th>Reference</th><th>Reason</th><th>State</th><th>Actions</th></tr></thead>
        <tbody>{holds.map((hold) => <tr key={hold.id}><td className="mono">{hold.financial_reference}</td><td>{hold.reason_code}</td><td>{hold.state}</td>
          <td>{hold.state === 'held' ? <><button onClick={() => void decide(hold.id, 'released')}>Release</button>{' '}<button onClick={() => void decide(hold.id, 'rejected')}>Reject</button></> : '—'}</td></tr>)}</tbody>
      </table></div>
      <h3>Fraud cases</h3>
      <div className="table-wrap"><table><thead><tr><th>Case</th><th>Priority</th><th>State</th><th>Summary</th><th>Investigation</th></tr></thead>
        <tbody>{cases.map((item) => <tr key={item.id}><td className="mono">{item.case_number}</td><td>{item.priority}</td><td>{item.state}</td><td>{item.safe_summary}</td>
          <td><button onClick={() => { const note = window.prompt('Immutable investigation note'); if (note) void apiAddFraudCaseNote(item.id, note).then(load); }}>Add note</button></td></tr>)}</tbody>
      </table></div>
      <h3>Emergency posting control</h3>
      <p className="muted">Pausing postings preserves reads, authentication, and investigations. Admin capability required.</p>
      <button onClick={() => { const reason = window.prompt('Incident reason (minimum 15 characters)'); if (reason) void apiSetFinancialPosting(false, reason).catch((e) => setError(String(e))); }}>Pause new postings</button>{' '}
      <button onClick={() => { const reason = window.prompt('Recovery reason (minimum 15 characters)'); if (reason) void apiSetFinancialPosting(true, reason).catch((e) => setError(String(e))); }}>Resume postings</button>
    </div>
  );
}

function ProductReadinessTab() {
  const [data, setData] = useState<Awaited<ReturnType<typeof apiProductReadiness>> | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    void apiProductReadiness()
      .then((result) => {
        setData(result);
        setError('');
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load readiness'));
  }, []);
  useEffect(() => load(), [load]);
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>Regulated product readiness</h2>
          <p className="muted">
            Evidence shown here is append-only. It records external decisions; it does not create legal or provider approval.
          </p>
        </div>
        <button onClick={load}>Refresh</button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>Product</th><th>Environment</th><th>DB evidence</th><th>Config</th><th>Enabled</th><th>Missing</th></tr></thead>
          <tbody>
            {(data?.statuses ?? []).map((status) => (
              <tr key={`${status.product}-${status.environment}`}>
                <td>{status.product}</td><td>{status.environment}</td>
                <td>{status.databaseApproved ? 'approved' : 'blocked'}</td>
                <td>{status.configEnabled ? 'enabled' : 'off'}</td>
                <td><strong>{status.enabled ? 'YES' : 'NO'}</strong></td>
                <td>{status.missing.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Immutable evidence register</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Recorded</th><th>Product</th><th>Control</th><th>Decision</th><th>Authority</th><th>Digest</th></tr></thead>
          <tbody>
            {(data?.evidence ?? []).map((item) => (
              <tr key={item.id}>
                <td>{fmtDate(item.recorded_at)}</td><td>{item.product} / {item.environment}</td>
                <td>{item.control}</td><td>{item.decision}</td><td>{item.authority}</td>
                <td className="mono">{item.evidence_sha256.slice(0, 16)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
    { id: 'operators', label: 'Ops Users' },
    { id: 'users', label: 'App Users' },
    { id: 'merchants', label: 'Merchants' },
    { id: 'claims', label: 'Claims' },
    { id: 'loans', label: 'Loans' },
    { id: 'ledger', label: 'Ledger' },
    { id: 'settlement', label: 'Settlement' },
    { id: 'readiness', label: 'Product Readiness' },
    { id: 'cashsend', label: 'Cash Send' },
    { id: 'risk', label: 'Risk Review' },
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
        {tab === 'ledger' ? <LedgerTab /> : null}
        {tab === 'settlement' ? <SettlementTab /> : null}
        {tab === 'readiness' ? <ProductReadinessTab /> : null}
        {tab === 'cashsend' ? <CashSendTab /> : null}
        {tab === 'risk' ? <RiskReviewTab /> : null}
        {tab === 'compliance' ? <ComplianceTab /> : null}
        {tab === 'operators' ? <OperatorsTab me={me} /> : null}
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
