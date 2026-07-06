import './styles.css';

import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  apiAuditEvents,
  apiComplianceFlags,
  apiLogin,
  apiOverview,
  apiReconciliation,
  apiTransactions,
  apiUserDetail,
  apiUsers,
  clearToken,
  getToken,
  setToken,
  type OpsUser,
  type Overview,
} from './api';

type Tab = 'overview' | 'users' | 'compliance' | 'audit' | 'transactions';

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
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const { token } = await apiLogin(password);
      setToken(token);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>Ekasi Pay Ops</h1>
        <p className="muted">Separate monitoring console — not the merchant app.</p>
        <label>
          Operator password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button type="submit" disabled={loading}>
          {loading ? 'Signing in…' : 'Sign in'}
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
            placeholder="Search name, phone, id…"
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
                      {t.type} {fmtMoney(t.amount)} — {t.reference}
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
  const [flags, setFlags] = useState<Awaited<ReturnType<typeof apiComplianceFlags>>['flags']>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    void apiComplianceFlags()
      .then((r) => setFlags(r.flags))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, []);

  return (
    <div className="panel">
      <h2>Compliance flags</h2>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

function TransactionsTab() {
  const [txns, setTxns] = useState<Awaited<ReturnType<typeof apiTransactions>>['transactions']>([]);
  const [recon, setRecon] = useState<Awaited<ReturnType<typeof apiReconciliation>> | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([apiTransactions(), apiReconciliation()])
      .then(([t, r]) => {
        setTxns(t.transactions);
        setRecon(r);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, []);

  return (
    <div className="panel">
      <h2>Transactions</h2>
      {recon ? (
        <p className={recon.ok ? 'ok-banner' : 'warn-banner'}>
          Reconciliation: {recon.ok ? 'OK' : `${recon.discrepancies.length} discrepancies`}{' '}
          ({recon.walletsChecked} wallets checked)
        </p>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Reference</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {txns.map((t) => (
              <tr key={t.id}>
                <td>{t.type}</td>
                <td>{fmtMoney(t.amount)}</td>
                <td>{t.status}</td>
                <td>{t.reference}</td>
                <td>{fmtDate(t.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Dashboard() {
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
    { id: 'compliance', label: 'Compliance' },
    { id: 'audit', label: 'Audit' },
    { id: 'transactions', label: 'Transactions' },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <strong>Ekasi Pay Ops</strong>
          <span className="muted"> read-only monitor</span>
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
        {tab === 'compliance' ? <ComplianceTab /> : null}
        {tab === 'audit' ? <AuditTab /> : null}
        {tab === 'transactions' ? <TransactionsTab /> : null}
      </main>
    </div>
  );
}

function App() {
  const [authed, setAuthed] = useState(Boolean(getToken()));

  if (!authed) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />;
  }
  return <Dashboard />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
