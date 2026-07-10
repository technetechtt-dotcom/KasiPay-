/**
 * Ops dashboard client — talks to the main Ekasi Pay API (`ekasi-pay-api`).
 * Auth is the same admin phone + PIN used in the merchant app.
 */

const TOKEN_KEY = 'ekasi_ops_token';
const REFRESH_KEY = 'ekasi_ops_refresh';
let inMemoryToken: string | null = null;

function readStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function apiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const runtime = (window as Window & { __KASIPAY_API_URL__?: string })
      .__KASIPAY_API_URL__;
    if (runtime?.trim()) return runtime.replace(/\/$/, '');
  }
  const env = import.meta.env.VITE_API_URL as string | undefined;
  return (env ?? '').trim().replace(/\/$/, '');
}

function resolveUrl(path: string): string {
  const base = apiBaseUrl();
  const prefix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${prefix}`;
}

export function getToken(): string | null {
  const storage = readStorage();
  if (!storage) return inMemoryToken;
  return storage.getItem(TOKEN_KEY) ?? inMemoryToken;
}

export function setToken(token: string, refreshToken?: string): void {
  inMemoryToken = token;
  const storage = readStorage();
  if (!storage) return;
  storage.setItem(TOKEN_KEY, token);
  if (refreshToken) storage.setItem(REFRESH_KEY, refreshToken);
}

export function clearToken(): void {
  inMemoryToken = null;
  const storage = readStorage();
  if (!storage) return;
  storage.removeItem(TOKEN_KEY);
  storage.removeItem(REFRESH_KEY);
}

async function refreshAccessToken(): Promise<boolean> {
  const storage = readStorage();
  const refresh = storage?.getItem(REFRESH_KEY);
  if (!refresh) return false;
  try {
    const res = await fetch(resolveUrl('/api/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      token?: string;
      refreshToken?: string;
      error?: string;
    };
    if (!res.ok || !body.token) {
      clearToken();
      return false;
    }
    setToken(body.token, body.refreshToken);
    return true;
  } catch {
    clearToken();
    return false;
  }
}

async function opsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let res = await fetch(resolveUrl(path), { ...init, headers });
  if (res.status === 401 && path !== '/api/login' && path !== '/api/refresh') {
    const ok = await refreshAccessToken();
    if (ok) {
      const t2 = getToken();
      if (t2) headers.Authorization = `Bearer ${t2}`;
      res = await fetch(resolveUrl(path), { ...init, headers });
    }
  }

  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(
      typeof body.error === 'string' ? body.error : `Request failed (${res.status})`,
    );
  }
  return body;
}

export type OpsAdminUser = {
  id: string;
  username: string;
  role: 'super_admin' | 'operator' | 'admin';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  name?: string;
  phone?: string;
};

/** Admin phone + PIN login against the main API. */
export async function apiLogin(phone: string, pin: string) {
  const result = await opsFetch<{
    token: string;
    refreshToken: string;
    user: { id: string; name: string; phone: string; role: string };
  }>('/api/login', {
    method: 'POST',
    body: JSON.stringify({ phone, pin }),
  });
  if (result.user.role !== 'admin') {
    throw new Error('Ops access requires an admin account.');
  }
  setToken(result.token, result.refreshToken);
  return {
    token: result.token,
    expiresInSec: 3600,
    user: {
      id: result.user.id,
      username: result.user.phone,
      role: 'admin' as const,
      isActive: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      name: result.user.name,
      phone: result.user.phone,
    },
  };
}

export async function apiMe() {
  const { user } = await opsFetch<{
    user: { id: string; name: string; phone: string; role: string };
  }>('/api/me');
  if (user.role !== 'admin') {
    throw new Error('Ops access requires an admin account.');
  }
  return {
    user: {
      id: user.id,
      username: user.phone,
      role: 'admin' as const,
      isActive: true,
      createdAt: '',
      updatedAt: '',
      lastLoginAt: null,
      name: user.name,
      phone: user.phone,
    } satisfies OpsAdminUser,
  };
}

/** Ops operator CRUD moved to main-app Admin → User Management. */
export async function apiAdminUsers(): Promise<{ users: OpsAdminUser[] }> {
  return { users: [] };
}
export async function apiCreateAdminUser(_body: {
  username: string;
  password: string;
  role: 'super_admin' | 'operator';
}): Promise<{ user: OpsAdminUser }> {
  throw new Error(
    'Manage admin users in the main app: More → Admin Tools → User Management.',
  );
}
export async function apiUpdateAdminUser(
  _id: string,
  _body: { role?: 'super_admin' | 'operator'; isActive?: boolean; password?: string },
): Promise<{ user: OpsAdminUser }> {
  throw new Error(
    'Manage admin users in the main app: More → Admin Tools → User Management.',
  );
}
export async function apiDeleteAdminUser(_id: string): Promise<{ ok: boolean }> {
  throw new Error(
    'Manage admin users in the main app: More → Admin Tools → User Management.',
  );
}

export type Overview = {
  generatedAt: string;
  dataSource: string;
  users: {
    total: number;
    active: number;
    suspended: number;
    merchants: number;
  };
  wallets: { activeCount: number; totalUserBalance: number };
  compliance: { openFlags: number };
  transactions24h: { count: number; volume: number };
  merchants: number;
};

export type OpsUser = {
  id: string;
  name: string;
  phone: string;
  role: string;
  kycStatus: string;
  accountTier: string;
  createdAt: string;
  countryCode: string;
  suspendedAt: string | null;
  deletedAt?: string | null;
};

export async function apiOverview() {
  return opsFetch<Overview>('/api/admin/overview');
}

export async function apiUsers(params: {
  search?: string;
  role?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const q = new URLSearchParams();
  if (params.search) q.set('search', params.search);
  if (params.role) q.set('role', params.role);
  if (params.status) q.set('status', params.status);
  if (params.limit) q.set('limit', String(params.limit));
  if (params.offset) q.set('offset', String(params.offset));
  return opsFetch<{ total: number; users: OpsUser[]; limit: number; offset: number }>(
    `/api/admin/directory/users?${q}`,
  );
}

export async function apiUserDetail(id: string) {
  return opsFetch<{
    user: OpsUser;
    wallet: {
      id: string;
      balance: number;
      currency: string;
      status: string;
      pool_id?: string;
    } | null;
    merchant: {
      id: string;
      business_name: string;
      location: string;
      category: string;
    } | null;
    complianceFlags: {
      id: string;
      reason: string;
      severity: string;
      status: string;
      createdAt: string;
    }[];
    recentTransactions: {
      id: string;
      type: string;
      amount: number;
      status: string;
      reference: string;
      description: string;
      created_at: string;
    }[];
  }>(`/api/admin/directory/users/${id}`);
}

export async function apiComplianceFlags(status?: string) {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return opsFetch<{
    flags: {
      id: string;
      userId: string;
      userName?: string;
      userPhone?: string;
      reason: string;
      severity: string;
      status: string;
      createdAt: string;
    }[];
  }>(`/api/admin/compliance/flags${q}`);
}

export async function apiAuditEvents() {
  return opsFetch<{
    events: {
      id: string;
      type: string;
      message: string;
      actorUserId?: string;
      createdAt: string;
    }[];
  }>('/api/admin/audit-events');
}

export async function apiTransactions(params?: {
  search?: string;
  type?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const q = new URLSearchParams();
  if (params?.search) q.set('search', params.search);
  if (params?.type) q.set('type', params.type);
  if (params?.status) q.set('status', params.status);
  q.set('limit', String(params?.limit ?? 100));
  if (params?.offset) q.set('offset', String(params.offset));
  return opsFetch<{
    transactions: {
      id: string;
      type: string;
      amount: number;
      status: string;
      reference: string;
      description: string;
      created_at: string;
      from_wallet_id: string | null;
      to_wallet_id: string | null;
      voucherNumber: string | null;
    }[];
    total: number;
    limit: number;
    offset: number;
    types: string[];
    totals: {
      day: { count: number; volume: number };
      week: { count: number; volume: number };
      month: { count: number; volume: number };
      year: { count: number; volume: number };
      filtered: { count: number; volume: number };
    };
  }>(`/api/admin/transactions?${q}`);
}

export async function apiReconciliation() {
  return opsFetch<{
    ranAt: string;
    walletsChecked: number;
    ok: boolean;
    discrepancies: {
      walletId: string;
      userId: string;
      delta: number;
      walletBalance: number;
      ledgerBalance: number;
    }[];
  }>('/api/admin/reconciliation');
}

export type OpsCashSendParty = {
  firstName: string;
  lastName: string;
  phone: string;
  idDocument: string | null;
};

export type OpsCashSendVoucher = {
  id: string;
  referenceNumber: string;
  status: string;
  amount: number;
  fee: number;
  createdAt: string;
  expiresAt: string;
  collectedAt: string | null;
  withdrawnAt: string | null;
  cancelReason: string | null;
  senderUserId: string | null;
  senderAddress: string | null;
  sender: OpsCashSendParty;
  withdrawer: OpsCashSendParty;
  recipientIdOnFile: string | null;
  collectorScannedId: string | null;
  idVerifiedAtWithdrawal: boolean;
};

export async function apiCashSendVouchers(params: {
  status?: 'all' | 'active' | 'collected' | 'expired' | 'cancelled';
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const q = new URLSearchParams();
  if (params.status) q.set('status', params.status);
  if (params.search) q.set('search', params.search);
  if (params.limit) q.set('limit', String(params.limit));
  if (params.offset) q.set('offset', String(params.offset));
  return opsFetch<{
    total: number;
    amountSum: number;
    feeSum: number;
    limit: number;
    offset: number;
    vouchers: OpsCashSendVoucher[];
  }>(`/api/admin/cash-send/vouchers?${q}`);
}
