/**
 * Ops dashboard client — main Ekasi Pay API.
 * Login: ops username + password (`/api/ops/login`).
 * Data: `/api/admin/*` (same backend as merchant admin).
 */

const TOKEN_KEY = 'ekasi_ops_token';
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

export function setToken(token: string): void {
  inMemoryToken = token;
  const storage = readStorage();
  if (!storage) return;
  storage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  inMemoryToken = null;
  const storage = readStorage();
  if (!storage) return;
  storage.removeItem(TOKEN_KEY);
  storage.removeItem('ekasi_ops_refresh');
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

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20_000);
  let res: Response;
  try {
    res = await fetch(resolveUrl(path), {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error(
        'Request timed out. The API may be waking up — wait a few seconds and try again.',
      );
    }
    throw new Error(
      `Cannot reach API (${apiBaseUrl() || 'same origin'}). Check FRONTEND_ORIGINS on ekasi-pay-api includes this ops URL.`,
    );
  } finally {
    window.clearTimeout(timer);
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

export async function apiLogin(username: string, password: string) {
  const result = await opsFetch<{
    token: string;
    expiresInSec: number;
    user: OpsAdminUser;
  }>('/api/ops/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  setToken(result.token);
  return result;
}

export async function apiMe() {
  return opsFetch<{ user: OpsAdminUser }>('/api/ops/me');
}

export async function apiAdminUsers() {
  return opsFetch<{ users: OpsAdminUser[] }>('/api/ops/admin-users');
}

export async function apiCreateAdminUser(body: {
  username: string;
  password: string;
  role: 'super_admin' | 'operator';
}) {
  return opsFetch<{ user: OpsAdminUser }>('/api/ops/admin-users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiUpdateAdminUser(
  id: string,
  body: { role?: 'super_admin' | 'operator'; isActive?: boolean; password?: string },
) {
  return opsFetch<{ user: OpsAdminUser }>(`/api/ops/admin-users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function apiDeleteAdminUser(id: string) {
  return opsFetch<{ ok: boolean }>(`/api/ops/admin-users/${id}`, {
    method: 'DELETE',
  });
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
