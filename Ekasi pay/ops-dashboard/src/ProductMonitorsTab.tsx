import { useCallback, useEffect, useState } from 'react';

import { apiProductMonitors, type OpsProductMonitors } from './api';

const SECTIONS: {
  key: keyof OpsProductMonitors;
  title: string;
}[] = [
  { key: 'stokvelAccounts', title: 'Stokvel accounts' },
  { key: 'utilityPurchases', title: 'Utility purchases' },
  { key: 'creditObligations', title: 'Merchant credit obligations' },
  { key: 'insurancePolicies', title: 'Insurance policies' },
  { key: 'reconciliation', title: 'Product reconciliation runs' },
];

function cellValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function MonitorTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<Record<string, unknown>>;
}) {
  const columns =
    rows.length > 0
      ? Object.keys(rows[0]!)
      : [];

  return (
    <div className="panel" style={{ marginTop: '1rem' }}>
      <div className="panel-head">
        <h3>{title}</h3>
        <span className="muted">{rows.length} row{rows.length === 1 ? '' : 's'}</span>
      </div>
      {rows.length === 0 ? (
        <p className="muted">No rows (or table unavailable).</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={String(row.id ?? i)}>
                  {columns.map((col) => (
                    <td key={col}>{cellValue(row[col])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ProductMonitorsTab() {
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<OpsProductMonitors | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await apiProductMonitors());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load product monitors');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <div className="panel-head">
        <h2>Product monitors</h2>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>
      <p className="muted">
        Read-only view of recent regulated product activity: stokvel, utilities,
        merchant credit, insurance, and product reconciliation runs.
      </p>
      {error ? <p className="error">{error}</p> : null}
      {!data && !error ? (
        <p className="muted">Loading product monitors…</p>
      ) : null}
      {data
        ? SECTIONS.map(({ key, title }) => (
            <MonitorTable key={key} title={title} rows={data[key]} />
          ))
        : null}
    </section>
  );
}
