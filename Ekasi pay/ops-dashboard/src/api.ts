/**
 * Ops dashboard client — main Ekasi Pay API.
 * Login: ops username + password (`/api/ops/login`).
 * Data: `/api/admin/*` (same backend as merchant admin).
 */
import type { Money } from './money';

const DEFAULT_API = 'https://ekasi-pay-api.onrender.com';
let inMemoryToken: string | null = null;
let inMemoryRefresh: string | null = null;

function normalizeApiBase(raw: string): string {
  let value = raw.trim().replace(/\/$/, '');
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const url = new URL(value);
    // Never use http for Render — redirects strip Authorization headers.
    if (url.protocol === 'http:' && url.hostname.endsWith('.onrender.com')) {
      url.protocol = 'https:';
    }
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') {
      url.hostname = `${url.hostname}.onrender.com`;
    }
    return url.origin;
  } catch {
    return value;
  }
}

export function apiBaseUrl(): string {
  if (typeof window !== 'undefined') {
    const runtime = (window as Window & { __KASIPAY_API_URL__?: string })
      .__KASIPAY_API_URL__;
    if (runtime?.trim()) return normalizeApiBase(runtime);
  }
  const env = import.meta.env.VITE_API_URL as string | undefined;
  const fromEnv = normalizeApiBase(env ?? '');
  if (fromEnv) return fromEnv;
  // Production ops UI must not call same-origin /api (static host has no API).
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('.onrender.com')) {
    return DEFAULT_API;
  }
  return '';
}

function resolveUrl(path: string): string {
  const base = apiBaseUrl();
  const prefix = path.startsWith('/') ? path : `/${path}`;
  if (!base) {
    // Dev: Vite proxies /api → local backend.
    return prefix;
  }
  return `${base}${prefix}`;
}

export function getToken(): string | null {
  const raw = inMemoryToken;
  if (!raw || raw === 'undefined' || raw === 'null') return null;
  return raw;
}

export function setToken(token: string): void {
  if (!token || token === 'undefined') {
    clearToken();
    return;
  }
  inMemoryToken = token;
}

export function clearToken(): void {
  inMemoryToken = null;
  inMemoryRefresh = null;
}

export type OpsProductReadiness = {
  product: 'stokvel' | 'lending' | 'merchant_credit' | 'insurance' | 'utilities';
  environment: 'sandbox' | 'production';
  enabled: boolean;
  databaseApproved: boolean;
  configEnabled: boolean;
  missing: string[];
};

export type OpsReadinessEvidence = {
  id: string;
  product: OpsProductReadiness['product'];
  environment: OpsProductReadiness['environment'];
  control: string;
  decision: 'approved' | 'rejected' | 'withdrawn';
  authority: string;
  authority_reference: string;
  artifact_uri: string;
  artifact_sha256: string;
  evidence_sha256: string;
  notes: string;
  recorded_at: string;
};

export function apiProductReadiness() {
  return opsFetch<{
    statuses: OpsProductReadiness[];
    evidence: OpsReadinessEvidence[];
  }>('/api/ops/product-readiness');
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    throw new Error(
      `API returned non-JSON (${res.status}). Check the API URL is ${DEFAULT_API} (not the ops site).`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('API returned invalid JSON.');
  }
}

async function opsFetch<T>(
  path: string,
  init?: RequestInit & { auth?: boolean; _retried?: boolean },
): Promise<T> {
  const { auth = true, _retried = false, ...rest } = init ?? {};
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(rest.headers as Record<string, string> | undefined),
  };
  if (auth) {
    const token = getToken();
    if (!token) {
      throw new Error('Not signed in. Please sign in again.');
    }
    headers.Authorization = `Bearer ${token}`;
  }
  if (rest.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(resolveUrl(path), {
      ...rest,
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

  const body = (await readJson(res)) as T & { error?: string };
  if (!res.ok) {
    if (
      res.status === 401 &&
      auth &&
      !_retried &&
      inMemoryRefresh &&
      path !== '/api/ops/refresh'
    ) {
      const refreshed = await opsFetch<{ token: string; refreshToken: string }>(
        '/api/ops/refresh',
        {
          method: 'POST',
          auth: false,
          body: JSON.stringify({ refreshToken: inMemoryRefresh }),
        },
      );
      inMemoryToken = refreshed.token;
      inMemoryRefresh = refreshed.refreshToken;
      return opsFetch<T>(path, { ...rest, auth: true, _retried: true });
    }
    if (res.status === 401) clearToken();
    throw new Error(
      typeof body?.error === 'string' ? body.error : `Request failed (${res.status})`,
    );
  }
  return body;
}

export type OpsAdminUser = {
  id: string;
  username: string;
  role: 'admin' | 'operations' | 'compliance' | 'finance' | 'support';
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  name?: string;
  phone?: string;
};

export async function apiLogin(username: string, password: string, totp: string) {
  clearToken();
  const result = await opsFetch<{
    token: string;
    refreshToken: string;
    expiresInSec: number;
    user: OpsAdminUser;
  }>('/api/ops/login', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({
      username,
      password,
      totp,
      device: { installId: crypto.randomUUID(), label: navigator.userAgent.slice(0, 100), platform: navigator.platform },
    }),
  });
  if (!result.token || typeof result.token !== 'string') {
    throw new Error('Login succeeded but no token was returned by the API.');
  }
  setToken(result.token);
  inMemoryRefresh = result.refreshToken;
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
  role: 'admin' | 'operations' | 'compliance' | 'finance' | 'support';
}) {
  return opsFetch<{ user: OpsAdminUser }>('/api/ops/admin-users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiUpdateAdminUser(
  id: string,
  body: {
    role?: 'admin' | 'operations' | 'compliance' | 'finance' | 'support';
    isActive?: boolean;
    password?: string;
  },
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
  wallets: { activeCount: number; totalUserBalance: Money };
  compliance: { openFlags: number };
  transactions24h: { count: number; volume: Money };
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
      balance: Money;
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
      amount: Money;
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

export async function apiUpdateComplianceFlag(
  id: string,
  status: 'resolved' | 'dismissed' | 'open',
) {
  return opsFetch<{
    flag: {
      id: string;
      userId: string;
      reason: string;
      severity: string;
      status: string;
      createdAt: string;
    };
  }>(`/api/admin/compliance/flags/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

export type OpsInsuranceClaim = {
  id: string;
  policyId: string;
  merchantId: string;
  merchantBusinessName?: string;
  merchantUserId?: string;
  type: string;
  description: string;
  claimedAmount: Money;
  status: 'submitted' | 'approved' | 'rejected' | 'paid' | string;
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  adminNote?: string;
};

export async function apiInsuranceClaims(status?: string) {
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  const qs = q.toString();
  return opsFetch<{ claims: OpsInsuranceClaim[] }>(
    `/api/admin/insurance/claims${qs ? `?${qs}` : ''}`,
  );
}

export async function apiUpdateInsuranceClaim(
  id: string,
  body: { status: 'approved' | 'rejected' | 'paid'; adminNote?: string },
) {
  return opsFetch<{ claim: OpsInsuranceClaim }>(
    `/api/admin/insurance/claims/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    },
  );
}

export type OpsLoan = {
  id: string;
  userId: string;
  amount: Money;
  interestRate: number;
  status: string;
  repaidAmount: Money;
  disbursedAt?: string;
  dueDate?: string;
};

export async function apiLoans(status?: string) {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return opsFetch<{ loans: OpsLoan[] }>(`/api/admin/loans${q}`);
}

export async function apiDisburseLoan(id: string) {
  return opsFetch<{ loan: OpsLoan }>(`/api/admin/loans/${id}/disburse`, {
    method: 'PATCH',
  });
}

export type RuntimeProductControls = {
  financialPosting: boolean;
  lending: boolean;
  insurance: boolean;
  stokvelMoneyMovement: boolean;
  cashSend: boolean;
  liveUtilities: boolean;
};

export async function apiRuntimeControls() {
  return opsFetch<{ controls: RuntimeProductControls }>(
    '/api/admin/runtime-controls',
  );
}

export type OpsMerchant = {
  id: string;
  userId: string;
  businessName: string;
  location: string;
  category: string;
  approvalStatus?: string;
  rejectionReason?: string;
  ownerName?: string;
  ownerPhone?: string;
  documentsUploaded?: number;
  documentsRequired?: number;
  docsSubmittedAt?: string;
  reviewedAt?: string;
};

export type OpsMerchantDoc = {
  docType: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
};

export async function apiMerchants(status?: string) {
  const q = status ? `?status=${encodeURIComponent(status)}` : '';
  return opsFetch<{ merchants: OpsMerchant[] }>(`/api/admin/merchants${q}`);
}

export async function apiMerchantDetail(id: string) {
  return opsFetch<{ merchant: OpsMerchant; documents: OpsMerchantDoc[] }>(
    `/api/admin/merchants/${id}`,
  );
}

export async function apiReviewMerchant(
  id: string,
  body: {
    status: 'approved' | 'rejected';
    reason?: string;
  },
) {
  return opsFetch<{ merchant: OpsMerchant }>(
    `/api/admin/merchants/${id}/approval`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
}

export async function apiFetchMerchantDocument(
  merchantId: string,
  docType: string,
): Promise<{ blob: Blob; fileName: string }> {
  const token = getToken();
  if (!token) throw new Error('Not signed in. Please sign in again.');
  const path = `/api/admin/merchants/${merchantId}/documents/${docType}`;
  const base = apiBaseUrl();
  const url = base ? `${base}${path}` : path;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: '*/*',
    },
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body?.error === 'string') msg = body.error;
    } catch {
      /* ignore */
    }
    if (res.status === 401) clearToken();
    throw new Error(msg);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob, fileName: match?.[1] ?? `${docType}.bin` };
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
      amount: Money;
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
      day: { count: number; volume: Money };
      week: { count: number; volume: Money };
      month: { count: number; volume: Money };
      year: { count: number; volume: Money };
      filtered: { count: number; volume: Money };
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
      delta: Money;
      walletBalance: Money;
      ledgerBalance: Money;
    }[];
  }>('/api/admin/reconciliation');
}

export async function apiRunReconciliation() {
  return opsFetch<{
    ranAt: string;
    walletsChecked: number;
    ok: boolean;
    discrepancies: {
      walletId: string;
      userId: string;
      poolId?: string;
      kind?: string;
      delta: Money;
      walletBalance: Money;
      ledgerBalance: Money;
    }[];
  }>('/api/admin/reconciliation/run', { method: 'POST' });
}

export async function apiPatchAppUser(
  userId: string,
  body: { role?: string; suspended?: boolean },
) {
  return opsFetch<{
    user: {
      id: string;
      name: string;
      phone: string;
      role: string;
      kycStatus: string;
      accountTier: string;
      createdAt: string;
      suspendedAt?: string | null;
    };
  }>(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
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
  amount: Money;
  fee: Money;
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
    amountSum: Money;
    feeSum: Money;
    limit: number;
    offset: number;
    vouchers: OpsCashSendVoucher[];
  }>(`/api/admin/cash-send/vouchers?${q}`);
}

export type OpsFraudCase = {
  id: string;
  case_number: string;
  state: string;
  priority: string;
  title: string;
  safe_summary: string;
  assigned_operator_id: string | null;
  created_at: string;
};

export type OpsTransactionHold = {
  id: string;
  financial_reference: string;
  reason_code: string;
  state: string;
  amount_cents: string | null;
  held_at: string;
};

export async function apiRiskCases(state?: string) {
  const query = state ? `?state=${encodeURIComponent(state)}` : '';
  return opsFetch<{ cases: OpsFraudCase[] }>(`/api/admin/risk/cases${query}`);
}

export async function apiRiskHolds() {
  return opsFetch<{ holds: OpsTransactionHold[] }>('/api/admin/risk/holds');
}

export async function apiAddFraudCaseNote(caseId: string, note: string) {
  return opsFetch<{ id: string }>(`/api/admin/risk/cases/${caseId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ note, evidenceRefs: [] }),
  });
}

export async function apiDecideRiskHold(
  holdId: string,
  decision: 'released' | 'rejected',
  reason: string,
) {
  return opsFetch<{ ok: boolean }>(`/api/admin/risk/holds/${holdId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision, reason }),
  });
}

export async function apiSetFinancialPosting(enabled: boolean, reason: string) {
  return opsFetch<{ enabled: boolean }>('/api/admin/controls/financial-posting', {
    method: 'POST',
    body: JSON.stringify({ enabled, reason }),
  });
}

export type SettlementOverview = {
  files: Array<{
    id: string;
    provider: string;
    file_name: string;
    row_count: number;
    content_sha256: string;
    imported_at: string;
  }>;
  breaks: Array<{
    id: string;
    state: string;
    reason_code: string;
    opened_at: string;
    provider_reference: string;
    amount_cents: string;
    currency: string;
    match_state: string;
    journal_transaction_id: string;
  }>;
  batches: Array<Record<string, unknown>>;
  closes: Array<Record<string, unknown>>;
};

export async function apiSettlementOverview() {
  return opsFetch<SettlementOverview>('/api/ops/settlement/overview');
}

export async function apiImportSettlementStatement(body: {
  provider: string;
  fileName: string;
  contentBase64: string;
}) {
  return opsFetch<{
    fileId: string;
    rowCount: number;
    matches: Record<string, number>;
  }>('/api/ops/settlement/statements', {
    method: 'POST',
    body: JSON.stringify({ ...body, schemaVersion: 'phase6-v1' }),
  });
}

export async function apiFeeSchedules() {
  return opsFetch<{ schedules: Array<Record<string, unknown>> }>('/api/ops/fees/schedules');
}
