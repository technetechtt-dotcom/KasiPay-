const TOKEN_KEY = 'ekasi_ops_token';
let inMemoryToken: string | null = null;

function readStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getToken(): string | null {
  const storage = readStorage();
  if (!storage) return inMemoryToken;
  return storage.getItem(TOKEN_KEY);
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
}

async function opsFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init?.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(path, { ...init, headers });
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
  role: 'super_admin' | 'operator';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
};

export async function apiLogin(username: string, password: string) {
  return opsFetch<{ token: string; expiresInSec: number; user: OpsAdminUser }>('/ops-api/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export async function apiMe() {
  return opsFetch<{ user: OpsAdminUser }>('/ops-api/me');
}

export async function apiAdminUsers() {
  return opsFetch<{ users: OpsAdminUser[] }>('/ops-api/admin-users');
}

export async function apiCreateAdminUser(body: {
  username: string;
  password: string;
  role: 'super_admin' | 'operator';
}) {
  return opsFetch<{ user: OpsAdminUser }>('/ops-api/admin-users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiUpdateAdminUser(
  id: string,
  body: { role?: 'super_admin' | 'operator'; isActive?: boolean; password?: string },
) {
  return opsFetch<{ user: OpsAdminUser }>(`/ops-api/admin-users/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function apiDeleteAdminUser(id: string) {
  return opsFetch<{ ok: boolean }>(`/ops-api/admin-users/${id}`, {
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
  return opsFetch<Overview>('/ops-api/overview');
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
    `/ops-api/users?${q}`,
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
  }>(`/ops-api/users/${id}`);
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
  }>(`/ops-api/compliance/flags${q}`);
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
  }>('/ops-api/audit-events');
}

export async function apiTransactions() {
  return opsFetch<{
    transactions: {
      id: string;
      type: string;
      amount: number;
      status: string;
      reference: string;
      description: string;
      created_at: string;
    }[];
  }>('/ops-api/transactions?limit=100');
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
  }>('/ops-api/reconciliation');
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
  sender: OpsCashSendParty;
  withdrawer: OpsCashSendParty;
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
    limit: number;
    offset: number;
    vouchers: OpsCashSendVoucher[];
  }>(`/ops-api/cash-send/vouchers?${q}`);
}
