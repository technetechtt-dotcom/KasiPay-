import { pushClientDiag } from './clientDiagnostics';
import type { Money, MoneyInput } from '../money';
import {
  clearSecureRefresh,
  readSecureRefresh,
  writeSecureRefresh,
} from './secureAuthStorage';

function readConfiguredApiUrl(): string | undefined {
  if (typeof window !== 'undefined') {
    const runtime = (window as Window & { __KASIPAY_API_URL__?: string })
      .__KASIPAY_API_URL__;
    if (runtime?.trim()) return runtime;
  }
  return typeof import.meta !== 'undefined'
    ? (import.meta.env.VITE_API_URL as string | undefined)
    : undefined;
}

function normalizeApiBaseUrl(raw: string | undefined): string {
  let base = (raw ?? '').trim().replace(/\/$/, '');
  if (!base) return '';

  if (!/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }

  try {
    const url = new URL(base);
    // Render blueprint "host" can resolve to the service slug before DNS exists.
    if (!url.hostname.includes('.')) {
      url.hostname = `${url.hostname}.onrender.com`;
      base = url.origin;
    }
  } catch {
    /* keep best-effort base */
  }

  return base;
}

/** API base URL. Empty string uses same-origin `/api` (Vite proxy in dev). */
export function apiBaseUrl(): string {
  const base = normalizeApiBaseUrl(readConfiguredApiUrl());

  // Capacitor native builds do not use the Vite dev proxy, so an explicit API
  // origin is required to avoid silent same-origin `/api` failures.
  if (base === '' && isNativeCapacitorRuntime()) {
    throw new Error(
      'Missing VITE_API_URL for native mobile runtime. Set VITE_API_URL before building/syncing mobile apps.',
    );
  }
  return base;
}

function isNativeCapacitorRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const cap = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  if (cap?.isNativePlatform && cap.isNativePlatform()) return true;
  const protocol = window.location?.protocol ?? '';
  return protocol === 'capacitor:' || protocol === 'ionic:';
}

/**
 * Legacy localStorage key for the access token. We migrated to an in-memory cache
 * so the JWT is no longer readable from disk (mitigates XSS exfiltration). We
 * still clean up the legacy key on startup / logout so devices upgrading from
 * older builds don't leak a stale token.
 */
const LEGACY_TOKEN_KEY = 'kasiPay.token.v1';

/** In-memory access token cache. Cleared on full page reload — `apiRequest` will
 * silently refresh from the (sessionStorage) refresh token if needed. */
let accessTokenMemory: string | null = null;

if (typeof window !== 'undefined') {
  try {
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* ignore quota / private-mode errors */
  }
}

export function getToken(): string | null {
  return accessTokenMemory;
}

export function setToken(token: string | null): void {
  accessTokenMemory = token && token !== '' ? token : null;
}

export function persistAuth(access: string, refresh?: string): void {
  setToken(access);
  if (refresh) writeSecureRefresh(refresh);
}

export function clearAuthStorage(): void {
  setToken(null);
  if (typeof window === 'undefined') return;
  clearSecureRefresh();
  try {
    window.localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    /* ignore quota / private-mode errors */
  }
}

function clientInstallId(): string {
  if (typeof window === 'undefined') return '';
  const k = 'kasiPay.install.v1';
  let id = window.localStorage.getItem(k);
  if (!id) {
    id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto ?
        crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;
    window.localStorage.setItem(k, id);
  }
  return id;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function resolveUrl(path: string): string {
  const base = apiBaseUrl();
  const prefix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${prefix}`;
}

async function parseMaybeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Zod `flatten()` shape returned as `{ error: { formErrors, fieldErrors } }` from the API. */
function summarizeZodFlatten(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const o = err as {
    formErrors?: unknown;
    fieldErrors?: Record<string, string[] | undefined>;
  };
  const parts: string[] = [];
  if (Array.isArray(o.formErrors)) {
    for (const fe of o.formErrors) {
      if (typeof fe === 'string' && fe.trim()) parts.push(fe.trim());
    }
  }
  if (o.fieldErrors && typeof o.fieldErrors === 'object') {
    for (const [key, val] of Object.entries(o.fieldErrors)) {
      if (Array.isArray(val) && val.length) {
        parts.push(`${key}: ${val.join(', ')}`);
      }
    }
  }
  return parts.length ? parts.join(' · ') : null;
}

function errorMessageFromPayload(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;
  if (!('error' in payload)) return fallback;
  const err = (payload as { error: unknown }).error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err === 'object') {
    const flat = summarizeZodFlatten(err);
    if (flat) return flat;
  }
  return fallback;
}

let refreshFlight: Promise<boolean> | null = null;

export async function refreshAccessToken(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const raw = await readSecureRefresh();
  const cookieMode = import.meta.env.VITE_REFRESH_COOKIE === 'true';
  if (!raw && !cookieMode) return false;
  if (refreshFlight) return refreshFlight;
  refreshFlight = (async () => {
    try {
      const payload = await apiRequestSilent<{ token: string; refreshToken: string }>(
        '/api/refresh',
        {
          method: 'POST',
          auth: false,
          body: JSON.stringify(raw ? { refreshToken: raw } : {}),
        },
      );
      persistAuth(payload.token, payload.refreshToken);
      return true;
    } catch {
      clearAuthStorage();
      return false;
    } finally {
      refreshFlight = null;
    }
  })();
  return refreshFlight;
}

/** Fetch without refresh-on-401 (prevents recursion from refresh endpoint). */
async function apiRequestSilent<T>(
  path: string,
  options: Omit<RequestInit, 'headers'> & {
    auth?: boolean;
    headers?: Record<string, string>;
  },
): Promise<T> {
  const { auth = true, headers: hdr, ...rest } = options;
  const headers: Record<string, string> = { ...hdr };
  const body = options.body;
  if (body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const rid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ?
      crypto.randomUUID()
    : String(Date.now());
  headers['X-Request-Id'] = rid;
  const cid = clientInstallId();
  if (cid) headers['X-Client-Install-Id'] = cid;
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (import.meta.env.VITE_REFRESH_COOKIE === 'true') {
    const csrf = document.cookie
      .split('; ')
      .find((item) => item.startsWith('ekasi_csrf='))
      ?.split('=')[1];
    if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
  }
  const res = await fetch(resolveUrl(path), {
    ...rest,
    headers,
    credentials: import.meta.env.VITE_REFRESH_COOKIE === 'true' ? 'include' : rest.credentials,
  });
  const payload = await parseMaybeJson(res);
  if (!res.ok) {
    const msg = errorMessageFromPayload(payload, res.statusText);
    pushClientDiag(`${path} → ${res.status} ${msg}`);
    throw new ApiError(res.status, msg, payload);
  }
  return payload as T;
}

type ApiRequestOptions = Omit<RequestInit, 'headers'> & {
  auth?: boolean;
  headers?: Record<string, string>;
  /**
   * Opt-in idempotency: when set, `apiRequest` adds an `Idempotency-Key`
   * header. Caller supplies the key so retries from the offline outbox can
   * reuse it. If `true` is passed instead of a string, we generate a UUID.
   */
  idempotencyKey?: string | true;
  _retried401?: boolean;
};

function generateIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const { _retried401 = false, idempotencyKey, headers: hdr, ...fetchOpts } = options;
  const composedHeaders: Record<string, string> = { ...hdr };
  if (idempotencyKey) {
    composedHeaders['Idempotency-Key'] =
      idempotencyKey === true ? generateIdempotencyKey() : idempotencyKey;
  }
  const optionsWithHeaders = { ...fetchOpts, headers: composedHeaders };
  const skipRefresh =
    path === '/api/refresh' ||
    path === '/api/login' ||
    path === '/api/register';

  try {
    return await apiRequestSilent<T>(path, optionsWithHeaders);
  } catch (e) {
    if (
      !(e instanceof ApiError) ||
      e.status !== 401 ||
      optionsWithHeaders.auth === false ||
      _retried401 ||
      skipRefresh
    ) {
      throw e;
    }
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw e;
    return apiRequest<T>(path, {
      ...fetchOpts,
      headers: composedHeaders,
      _retried401: true,
    });
  }
}

export async function apiLogout(): Promise<void> {
  try {
    if (getToken()) {
      await apiRequestSilent<{ ok: boolean }>('/api/logout', { method: 'POST' });
    }
  } catch {
    /* still clear locally */
  } finally {
    clearAuthStorage();
  }
}

export type PublicUserDto = {
  id: string;
  name: string;
  phone: string;
  role: string;
  kycStatus: string;
  accountTier: string;
  countryCode?: string;
  createdAt: string;
  suspendedAt?: string | null;
};

export async function apiLogin(phone: string, pin: string) {
  return apiRequest<{
    token: string;
    refreshToken?: string;
    user: PublicUserDto;
  }>('/api/login', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ phone, pin }),
  });
}

export async function apiRegister(body: {
  name: string;
  phone: string;
  pin: string;
  role: 'customer' | 'merchant' | 'agent';
  countryCode?: string;
  businessName?: string;
  location?: string;
  category?: string;
}) {
  return apiRequest<{
    token: string;
    refreshToken?: string;
    user: PublicUserDto;
  }>('/api/register', {
    method: 'POST',
    auth: false,
    body: JSON.stringify(body),
  });
}

export async function apiGetMe() {
  return apiRequest<{ user: PublicUserDto }>('/api/me');
}

export async function apiUpdatePin(currentPin: string, newPin: string) {
  return apiRequest<{ ok: boolean }>('/api/me/pin', {
    method: 'PATCH',
    body: JSON.stringify({ currentPin, newPin }),
  });
}

/**
 * Request a 6-digit PIN-reset code for the given phone. Backend always
 * returns 200 to avoid phone-enumeration; in non-prod environments the
 * code is echoed back as `devCode` for testing.
 */
export async function apiRequestPinReset(phone: string) {
  return apiRequest<{ ok: boolean; message: string; devCode?: string }>(
    '/api/pin-reset/request',
    {
      method: 'POST',
      auth: false,
      body: JSON.stringify({ phone }),
    }
  );
}

export async function apiConfirmPinReset(body: {
  phone: string;
  code: string;
  newPin: string;
}) {
  return apiRequest<{ ok: boolean }>('/api/pin-reset/confirm', {
    method: 'POST',
    auth: false,
    body: JSON.stringify(body),
  });
}

/**
 * Close the authenticated user's account. Requires the current PIN and the
 * exact phrase "DELETE MY ACCOUNT". Backend soft-deletes, revokes sessions,
 * and refuses if the wallet has any remaining balance.
 */
export async function apiDeleteMyAccount(body: {
  pin: string;
  confirmPhrase: string;
}) {
  return apiRequest<{ ok: boolean }>('/api/me', {
    method: 'DELETE',
    body: JSON.stringify(body),
  });
}

export async function apiGetWallet() {
  return apiRequest<{ wallet: import('../types').Wallet }>('/api/wallets/me');
}

export async function apiGetTransactions() {
  return apiRequest<{ transactions: import('../types').Transaction[] }>(
    '/api/transactions/me'
  );
}

export async function apiGetLedger() {
  return apiRequest<{ ledger: import('../types').LedgerEntry[] }>('/api/ledger/me');
}

export async function apiGetMerchantMe() {
  return apiRequest<{ merchant: import('../types').Merchant | null }>(
    '/api/merchants/me'
  );
}

/** Idempotently ensure the current user has a merchant profile and return it. */
export async function apiEnsureMerchantProfile(body?: {
  businessName?: string;
  location?: string;
  category?: string;
}) {
  return apiRequest<{ merchant: import('../types').Merchant }>(
    '/api/merchants/me',
    {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    }
  );
}

/** Update the user's own merchant profile (business name, location, category). */
export async function apiUpdateMerchantProfile(body: {
  businessName?: string;
  location?: string;
  category?: string;
}) {
  return apiRequest<{ merchant: import('../types').Merchant }>(
    '/api/merchants/me',
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    }
  );
}

export async function apiGetMerchantDocuments() {
  return apiRequest<{
    merchant: import('../types').Merchant;
    required: import('../types').MerchantDocType[];
    documents: import('../types').MerchantDocumentStatus[];
  }>('/api/merchants/me/documents');
}

export async function apiUploadMerchantDocument(body: {
  docType: import('../types').MerchantDocType;
  fileName: string;
  contentType: string;
  dataBase64: string;
}) {
  return apiRequest<{
    merchant: import('../types').Merchant;
    document: import('../types').MerchantDocumentStatus;
  }>('/api/merchants/me/documents', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiSubmitMerchantDocuments() {
  return apiRequest<{ merchant: import('../types').Merchant }>(
    '/api/merchants/me/documents/submit',
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export type AdminMerchantRow = import('../types').Merchant & {
  ownerName?: string;
  ownerPhone?: string;
  documentsUploaded?: number;
  documentsRequired?: number;
};

export async function apiAdminListMerchants(
  status?: import('../types').MerchantApprovalStatus,
) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiRequest<{ merchants: AdminMerchantRow[] }>(
    `/api/admin/merchants${qs}`,
  );
}

export async function apiAdminGetMerchant(merchantId: string) {
  return apiRequest<{
    merchant: AdminMerchantRow;
    documents: import('../types').MerchantDocumentStatus[];
  }>(`/api/admin/merchants/${merchantId}`);
}

export async function apiAdminFetchMerchantDocument(
  merchantId: string,
  docType: import('../types').MerchantDocType,
): Promise<{ blob: Blob; fileName: string }> {
  const path = `/api/admin/merchants/${merchantId}/documents/${docType}`;
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let res = await fetch(resolveUrl(path), { headers });
  if (res.status === 401) {
    const ok = await refreshAccessToken();
    if (ok) {
      const t2 = getToken();
      if (t2) headers.Authorization = `Bearer ${t2}`;
      res = await fetch(resolveUrl(path), { headers });
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, 'Could not download document');
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  return { blob, fileName: match?.[1] ?? `${docType}.bin` };
}

export async function apiAdminReviewMerchant(
  merchantId: string,
  body: {
    status: 'approved' | 'rejected';
    reason?: string;
  },
) {
  return apiRequest<{ merchant: AdminMerchantRow }>(
    `/api/admin/merchants/${merchantId}/approval`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      idempotencyKey: true,
    },
  );
}

export async function apiGetProducts(merchantId: string) {
  const q = new URLSearchParams({ merchantId });
  return apiRequest<{ products: import('../types').Product[] }>(
    `/api/products?${q.toString()}`
  );
}

export type BarcodeCatalogHit = {
  found: boolean;
  name?: string;
  brand?: string;
  imageUrl?: string;
  category?: 'Food' | 'Drinks' | 'Household' | 'Airtime';
  source: 'openfoodfacts' | 'none';
};

export async function apiLookupProductBarcode(code: string) {
  const q = new URLSearchParams({ code });
  return apiRequest<BarcodeCatalogHit>(
    `/api/products/barcode-lookup?${q.toString()}`,
  );
}

export async function apiCreateProduct(body: {
  name: string;
  costPrice: MoneyInput;
  price: MoneyInput;
  stock: number;
  category: string;
  barcode?: string;
}) {
  return apiRequest<{ product: import('../types').Product }>('/api/products', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiUpdateProduct(
  id: string,
  body: Partial<{
    name: string;
    costPrice: MoneyInput;
    price: MoneyInput;
    stock: number;
    category: string;
    barcode: string;
  }>
) {
  return apiRequest<{ product: import('../types').Product }>(`/api/products/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function apiTransfer(
  toPhone: string,
  amount: MoneyInput,
  description: string,
  idempotencyKey?: string,
) {
  return apiRequest<{ transaction: import('../types').Transaction }>('/api/transfers', {
    method: 'POST',
    body: JSON.stringify({ toPhone, amount, description }),
    idempotencyKey: idempotencyKey ?? true,
  });
}

export async function apiGetSales() {
  return apiRequest<{ sales: import('../types').Sale[] }>('/api/sales');
}

export async function apiCreateSale(
  body: {
    items: { productId: string; quantity: number; price: MoneyInput }[];
    paymentMethod: 'cash' | 'wallet';
    customerPhone?: string;
  },
  idempotencyKey?: string,
) {
  return apiRequest<{ sale: import('../types').Sale }>('/api/sales', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: idempotencyKey ?? true,
  });
}

export async function apiGetExpenses() {
  return apiRequest<{ expenses: import('../types').Expense[] }>('/api/expenses');
}

export async function apiCreateExpense(
  expense: Omit<import('../types').Expense, 'id' | 'merchantId' | 'createdAt'>,
  idempotencyKey?: string,
) {
  return apiRequest<{ expense: import('../types').Expense }>('/api/expenses', {
    method: 'POST',
    body: JSON.stringify(expense),
    idempotencyKey: idempotencyKey ?? true,
  });
}

export async function apiGetCreditCustomers() {
  return apiRequest<{ customers: import('../types').CreditCustomer[] }>(
    '/api/credit/customers'
  );
}

export async function apiRequestCreditOtp(body: {
  phone: string;
  purpose: 'onboard' | 'purchase';
  customerId?: string;
}) {
  return apiRequest<{ ok: boolean; message: string; devCode?: string }>(
    '/api/credit/verify/request',
    {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: true,
    },
  );
}

export async function apiConfirmCreditOtp(body: {
  phone: string;
  purpose: 'onboard' | 'purchase';
  code: string;
  saIdDocument: string;
  customerId?: string;
}) {
  return apiRequest<{
    ok: boolean;
    verificationToken: string;
    expiresInSec: number;
  }>('/api/credit/verify/confirm', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiCreateCreditCustomer(body: {
  name: string;
  phone: string;
  creditLimit: MoneyInput;
  saIdDocument: string;
  verificationToken: string;
}) {
  return apiRequest<{ customer: import('../types').CreditCustomer }>(
    '/api/credit/customers',
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  );
}

export async function apiGetCreditTransactions() {
  return apiRequest<{ transactions: import('../types').CreditTransaction[] }>(
    '/api/credit/transactions'
  );
}

export async function apiCreateCreditTransaction(body: {
  customerId: string;
  type: 'purchase' | 'payment';
  amount: MoneyInput;
  description: string;
  verificationToken?: string;
}) {
  return apiRequest<{
    transaction: import('../types').CreditTransaction;
    customer: import('../types').CreditCustomer;
  }>('/api/credit/transactions', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: true,
  });
}

/* --- Extensions: programs, suppliers, account, cash send, admin --- */

export async function apiGetLoadShedding() {
  return apiRequest<{ slots: import('../types').LoadSheddingSlot[] }>(
    '/api/loadshedding'
  );
}

export async function apiGetSuppliers() {
  return apiRequest<{ suppliers: import('../types').Supplier[] }>('/api/suppliers');
}

export async function apiCreateSupplier(body: {
  name: string;
  phone: string;
  category: string;
  deliveryDays?: string[];
}) {
  return apiRequest<{ supplier: import('../types').Supplier }>('/api/suppliers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiGetSupplierOrders() {
  return apiRequest<{ orders: import('../types').SupplierOrder[] }>(
    '/api/supplier-orders'
  );
}

export async function apiCreateSupplierOrder(body: {
  supplierId: string;
  items: { name: string; quantity: number; unitCost: MoneyInput }[];
  total: MoneyInput;
  expectedDelivery?: string;
}) {
  return apiRequest<{ order: import('../types').SupplierOrder }>(
    '/api/supplier-orders',
    { method: 'POST', body: JSON.stringify(body) }
  );
}

export async function apiPatchSupplierOrder(
  id: string,
  body: { status: 'pending' | 'confirmed' | 'delivered' }
) {
  return apiRequest<{ order: import('../types').SupplierOrder }>(
    `/api/supplier-orders/${id}`,
    { method: 'PATCH', body: JSON.stringify(body) }
  );
}

export async function apiGetSupplierVerifications() {
  return apiRequest<{ verifications: import('../types').SupplierVerification[] }>(
    '/api/supplier-verifications'
  );
}

export async function apiPutSupplierVerification(
  supplierId: string,
  body: {
    cipcRegistered: boolean;
    healthDeptApproved: boolean;
    lastInspectionDate: string;
    certificateExpiry: string;
    verificationStatus: 'verified' | 'pending' | 'unverified' | 'flagged';
    riskLevel: 'low' | 'medium' | 'high';
  }
) {
  return apiRequest<{ verification: import('../types').SupplierVerification }>(
    `/api/supplier-verifications/${supplierId}`,
    { method: 'PUT', body: JSON.stringify(body) }
  );
}

export async function apiGetStokvelGroups() {
  return apiRequest<{ groups: import('../types').StokvelGroup[] }>('/api/stokvel');
}

export async function apiCreateStokvelGroup(body: {
  name: string;
  members: { name: string; phone: string; contributed: MoneyInput }[];
  targetAmount: MoneyInput;
  currentAmount: MoneyInput;
  frequency: 'weekly' | 'monthly';
  nextPayoutDate: string;
}) {
  return apiRequest<{ group: import('../types').StokvelGroup }>('/api/stokvel', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: true,
  });
}

/** Replace the members on a stokvel group (UI is single-source-of-truth). */
export async function apiUpdateStokvelMembers(
  id: string,
  members: { name: string; phone: string; contributed: MoneyInput }[],
) {
  return apiRequest<{ group: import('../types').StokvelGroup }>(
    `/api/stokvel/${id}/members`,
    {
      method: 'PATCH',
      body: JSON.stringify({ members }),
    },
  );
}

export async function apiCreateStokvelLoan(
  stokvelId: string,
  body: {
    lenderName: string;
    lenderPhone: string;
    borrowerName: string;
    borrowerPhone: string;
    amount: MoneyInput;
    interestRatePercent: number;
    fromPool?: boolean;
    notes?: string;
  },
) {
  return apiRequest<{
    loan: import('../types').StokvelLoan;
    group: import('../types').StokvelGroup;
  }>(`/api/stokvel/${stokvelId}/loans`, {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: true,
  });
}

export async function apiRepayStokvelLoan(stokvelId: string, loanId: string) {
  return apiRequest<{
    loan: import('../types').StokvelLoan;
    group: import('../types').StokvelGroup;
  }>(`/api/stokvel/${stokvelId}/loans/${loanId}/repay`, {
    method: 'PATCH',
    idempotencyKey: true,
  });
}

export async function apiRecordStokvelContribution(
  stokvelId: string,
  body: {
    memberPhone: string;
    amount: MoneyInput;
    periodMonth: string;
    notes?: string;
  },
) {
  return apiRequest<{
    contribution: import('../types').StokvelContribution;
    group: import('../types').StokvelGroup;
  }>(`/api/stokvel/${stokvelId}/contributions`, {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: true,
  });
}

export async function apiGetLaybyOrders() {
  return apiRequest<{ orders: import('../types').LaybyOrder[] }>('/api/layby');
}

export async function apiCreateLaybyOrder(body: {
  customerName: string;
  customerPhone: string;
  itemName: string;
  totalPrice: MoneyInput;
  amountPaid: MoneyInput;
  installments?: { amount: MoneyInput; date: string }[];
  status?: 'active' | 'completed' | 'cancelled';
}) {
  return apiRequest<{ order: import('../types').LaybyOrder }>('/api/layby', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: true,
  });
}

/** Record a customer installment on a layby. Auto-completes on full payment. */
export async function apiAddLaybyPayment(
  id: string,
  amount: MoneyInput,
  date?: string,
) {
  return apiRequest<{
    order: import('../types').LaybyOrder;
    applied: Money;
    outstanding: Money;
  }>(`/api/layby/${id}/payments`, {
    method: 'POST',
    body: JSON.stringify({ amount, date }),
    idempotencyKey: true,
  });
}

export async function apiGetPriceComparisons(merchantId: string) {
  const q = new URLSearchParams({ merchantId });
  return apiRequest<{ comparisons: import('../types').PriceComparison[] }>(
    `/api/price-comparisons?${q.toString()}`
  );
}

export async function apiCreatePriceComparison(body: {
  productName: string;
  myPrice: MoneyInput;
  avgAreaPrice: MoneyInput;
  lowestAreaPrice: MoneyInput;
  highestAreaPrice: MoneyInput;
  competitors: number;
}) {
  return apiRequest<{ comparison: import('../types').PriceComparison }>(
    '/api/price-comparisons',
    { method: 'POST', body: JSON.stringify(body) }
  );
}

export async function apiGetInsurancePolicies() {
  return apiRequest<{ policies: import('../types').InsurancePolicy[] }>(
    '/api/insurance'
  );
}

export async function apiCreateInsurancePolicy(body: {
  provider: string;
  type: 'stock' | 'fire' | 'theft';
  coverageAmount: MoneyInput;
  monthlyPremium: MoneyInput;
  status?: 'active' | 'pending' | 'cancelled';
  nextPaymentDate: string;
}) {
  return apiRequest<{ policy: import('../types').InsurancePolicy }>(
    '/api/insurance',
    { method: 'POST', body: JSON.stringify(body), idempotencyKey: true }
  );
}

export type InsuranceClaim = {
  id: string;
  policyId: string;
  merchantId: string;
  type: 'stock' | 'fire' | 'theft';
  description: string;
  claimedAmount: Money;
  status: 'submitted' | 'approved' | 'rejected' | 'paid';
  createdAt: string;
  reviewedAt?: string;
  adminNote?: string;
};

export async function apiListInsuranceClaims(policyId: string) {
  return apiRequest<{ claims: InsuranceClaim[] }>(
    `/api/insurance/${policyId}/claims`,
  );
}

export async function apiFileInsuranceClaim(
  policyId: string,
  body: {
    type: 'stock' | 'fire' | 'theft';
    description: string;
    claimedAmount: MoneyInput;
  },
) {
  return apiRequest<{ claim: InsuranceClaim }>(
    `/api/insurance/${policyId}/claims`,
    {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: true,
    },
  );
}

export type AnalyticsSummary = {
  period: 'daily' | 'weekly' | 'monthly' | 'yearly' | 'all';
  rangeStart: string | null;
  totalRevenue: Money;
  transactionCount: number;
  avgOrder: Money;
  bestSellers: {
    productId: string;
    name: string;
    quantity: number;
    revenue: Money;
  }[];
  trend: { day: string; revenue: Money }[];
  atRiskProducts: { id: string; name: string; stock: number }[];
};

export async function apiGetAnalyticsSummary(
  period: AnalyticsSummary['period'] = 'monthly',
) {
  return apiRequest<AnalyticsSummary>(
    `/api/analytics/summary?period=${encodeURIComponent(period)}`,
  );
}

export type IncomeStatement = {
  period: AnalyticsSummary['period'];
  rangeStart: string | null;
  totalRevenue: Money;
  totalCOGS: Money;
  grossProfit: Money;
  grossMarginPct: number;
  totalExpenses: Money;
  expensesByCategory: { category: string; amount: Money }[];
  netProfit: Money;
  netMarginPct: number;
  saleCount: number;
  expenseCount: number;
};

export async function apiGetIncomeStatement(
  period: IncomeStatement['period'] = 'monthly',
) {
  return apiRequest<IncomeStatement>(
    `/api/reports/income-statement?period=${encodeURIComponent(period)}`,
  );
}

export type ExpenseStatement = {
  period: IncomeStatement['period'];
  rangeStart: string | null;
  totalExpenses: Money;
  expensesByCategory: { category: string; amount: Money }[];
  expenses: {
    id: string;
    category: string;
    description: string;
    amount: Money;
    createdAt: string;
  }[];
  expenseCount: number;
};

export async function apiGetExpenseStatement(
  period: ExpenseStatement['period'] = 'monthly',
) {
  return apiRequest<ExpenseStatement>(
    `/api/reports/expense-statement?period=${encodeURIComponent(period)}`,
  );
}

export type InventoryReport = {
  generatedAt: string;
  totalSkus: number;
  totalUnits: number;
  totalCostValue: Money;
  totalRetailValue: Money;
  lowStockCount: number;
  outOfStockCount: number;
  items: {
    id: string;
    name: string;
    category: string;
    barcode?: string;
    stock: number;
    costPrice: Money;
    sellingPrice: Money;
    costValue: Money;
    retailValue: Money;
    marginPerUnit: Money;
  }[];
};

export async function apiGetInventoryReport() {
  return apiRequest<InventoryReport>('/api/reports/inventory');
}

export type StockIntakeLine = {
  productId?: string;
  name?: string;
  quantity: number;
  costPrice: MoneyInput;
  sellingPrice?: MoneyInput;
  category?: string;
  barcode?: string;
};

export async function apiStockIntake(body: {
  supplierName?: string;
  slipReference?: string;
  slipTotal?: MoneyInput;
  notes?: string;
  recordExpense?: boolean;
  lines: StockIntakeLine[];
}) {
  return apiRequest<{
    slip: import('../types').PurchaseSlip;
    products: import('../types').Product[];
    movementIds: string[];
  }>('/api/stock-intake', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiGetPurchaseSlips() {
  return apiRequest<{ slips: import('../types').PurchaseSlip[] }>(
    '/api/purchase-slips',
  );
}

export type CommissionPosting = {
  id: string;
  agentUserId: string;
  sourceType: string;
  sourceId: string;
  amount: Money;
  description: string;
  createdAt: string;
};

export async function apiGetMyCommissions() {
  return apiRequest<{
    postings: CommissionPosting[];
    totals: { lifetime: Money; thisMonth: Money };
  }>('/api/commissions/me');
}

export async function apiGetVoiceNotes() {
  return apiRequest<{ notes: import('../types').VoiceNote[] }>('/api/voice-notes');
}

export async function apiCreateVoiceNote(body: {
  title: string;
  transcript?: string;
  duration?: number;
  category?: 'reminder' | 'debt' | 'order' | 'general';
}) {
  return apiRequest<{ note: import('../types').VoiceNote }>('/api/voice-notes', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiDeleteVoiceNote(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/voice-notes/${id}`, {
    method: 'DELETE',
  });
}

export async function apiGetExpiryItems() {
  return apiRequest<{ items: import('../types').ExpiryItem[] }>('/api/expiry-items');
}

export async function apiCreateExpiryItem(body: {
  productName: string;
  category: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  supplierId: string;
  status?: 'safe' | 'expiring-soon' | 'expired';
}) {
  return apiRequest<{ item: import('../types').ExpiryItem }>('/api/expiry-items', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiGetFoodSafetyAlerts() {
  return apiRequest<{ alerts: import('../types').FoodSafetyAlert[] }>(
    '/api/food-safety-alerts'
  );
}

export async function apiCreateFoodSafetyAlert(body: {
  type: 'recall' | 'expiry' | 'supplier' | 'inspection';
  title: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
  merchantScope?: boolean;
}) {
  return apiRequest<{ alert: import('../types').FoodSafetyAlert }>(
    '/api/food-safety-alerts',
    { method: 'POST', body: JSON.stringify(body) }
  );
}

export async function apiMarkFoodSafetyAlertRead(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/food-safety-alerts/${id}/read`, {
    method: 'PATCH',
  });
}

export async function apiGetStockMovements() {
  return apiRequest<{ movements: import('../types').StockMovement[] }>(
    '/api/stock-movements'
  );
}

export async function apiCreateStockMovement(body: {
  productId: string;
  productName: string;
  type: 'in' | 'out' | 'adjustment';
  quantity: number;
  reason:
    | 'sale'
    | 'restock'
    | 'damage'
    | 'expired'
    | 'theft'
    | 'manual'
    | 'initial';
  costPriceAtTime?: MoneyInput;
  reference?: string;
  notes?: string;
}) {
  return apiRequest<{ movement: import('../types').StockMovement }>(
    '/api/stock-movements',
    { method: 'POST', body: JSON.stringify(body) }
  );
}

export async function apiGetLoansMe() {
  return apiRequest<{ loans: import('../types').Loan[] }>('/api/loans/me');
}

export async function apiApplyLoan(body: { amount: MoneyInput; interestRate: number }) {
  return apiRequest<{ loan: import('../types').Loan }>('/api/loans', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: true,
  });
}

export async function apiDisburseLoan(id: string) {
  return apiRequest<{ loan: import('../types').Loan }>(
    `/api/loans/${id}/disburse`,
    { method: 'PATCH', idempotencyKey: true },
  );
}

export async function apiRepayLoan(id: string, amount: MoneyInput) {
  return apiRequest<{
    loan: import('../types').Loan;
    outstanding: Money;
  }>(`/api/loans/${id}/repayments`, {
    method: 'POST',
    body: JSON.stringify({ amount }),
    idempotencyKey: true,
  });
}

export async function apiGetComplianceMe() {
  return apiRequest<{ flags: import('../types').ComplianceFlag[] }>(
    '/api/compliance/me'
  );
}

export async function apiGetCashSendMe() {
  return apiRequest<{ vouchers: import('../types').CashSendVoucher[] }>(
    '/api/cash-send/me'
  );
}

export async function apiCreateCashSend(
  body: {
    senderFirstName: string;
    senderLastName: string;
    senderIdDocument: string;
    senderPhone: string;
    senderAddress: string;
    recipientFirstName: string;
    recipientLastName: string;
    recipientPhone: string;
  recipientIdDocument?: string;
    amount: MoneyInput;
    atmPin: string;
  },
  idempotencyKey?: string,
) {
  return apiRequest<{ voucher: import('../types').CashSendVoucher; smsSent?: boolean }>(
    '/api/cash-send',
    {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: idempotencyKey ?? true,
    },
  );
}

export async function apiLookupCashSend(input: { reference: string; pin: string }) {
  return apiRequest<{
    referenceNumber: string;
    status: string;
    amount: Money;
    recipientPhone: string;
    expiresAt: string;
  }>('/api/cash-send/lookup', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function apiCollectCashSend(
  body: {
    referenceNumber: string;
    pin: string;
    scannedIdDocument: string;
  },
  idempotencyKey?: string,
) {
  return apiRequest<{ voucher: import('../types').CashSendVoucher }>(
    '/api/cash-send/collect',
    {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: idempotencyKey ?? true,
    },
  );
}

export async function apiCancelCashSend(id: string) {
  return apiRequest<{ ok: boolean }>(`/api/cash-send/${id}/cancel`, {
    method: 'POST',
    idempotencyKey: true,
  });
}

export async function apiGetAdminUsers() {
  return apiRequest<{ users: PublicUserDto[] }>('/api/admin/users');
}

export async function apiAdminPatchUser(
  userId: string,
  body: { role?: PublicUserDto['role']; suspended?: boolean },
) {
  return apiRequest<{ user: PublicUserDto }>(`/api/admin/users/${userId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export type AdminInsuranceClaim = InsuranceClaim & {
  merchantBusinessName?: string;
  merchantUserId?: string;
  reviewedBy?: string;
};

export async function apiAdminListInsuranceClaims(status?: InsuranceClaim['status']) {
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  return apiRequest<{ claims: AdminInsuranceClaim[] }>(
    `/api/admin/insurance/claims${qs}`,
  );
}

export async function apiAdminUpdateInsuranceClaim(
  claimId: string,
  body: { status: 'approved' | 'rejected' | 'paid'; adminNote?: string },
) {
  return apiRequest<{ claim: AdminInsuranceClaim }>(
    `/api/admin/insurance/claims/${claimId}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      idempotencyKey: true,
    },
  );
}

export type UtilityCategory = 'airtime' | 'data' | 'electricity' | 'water';

export type ProductReadinessStatus = {
  product: 'stokvel' | 'lending' | 'merchant_credit' | 'insurance' | 'utilities';
  environment: 'sandbox' | 'production';
  enabled: boolean;
  databaseApproved: boolean;
  configEnabled: boolean;
  missing: Array<
    | 'legal'
    | 'provider'
    | 'accounting'
    | 'customer_journey'
    | 'reconciliation'
    | 'testing'
    | 'runbook'
  >;
};

export async function apiGetProductReadiness() {
  return apiRequest<{
    environment: 'sandbox' | 'production';
    products: ProductReadinessStatus[];
  }>('/api/product-readiness');
}

export type RuntimeProductControls = {
  financialPosting: boolean;
  lending: boolean;
  insurance: boolean;
  stokvelMoneyMovement: boolean;
  cashSend: boolean;
  liveUtilities: boolean;
};

export async function apiGetRuntimeControls() {
  return apiRequest<{ controls: RuntimeProductControls }>(
    '/api/runtime-controls',
  );
}

export type UtilityCatalogueItem = {
  id: string;
  provider_product_ref: string;
  version: number;
  category: UtilityCategory;
  name: string;
  cost_cents: string;
  fee_cents: string;
  min_cents: string;
  max_cents: string;
  finality_disclosure: string;
  finality_sha256: string;
  provider: string;
};

export async function apiGetUtilityCatalogue() {
  return apiRequest<{ products: UtilityCatalogueItem[] }>(
    '/api/regulated/utilities/catalogue',
  );
}

export type UtilityPurchase = {
  id: string;
  category: UtilityCategory;
  provider: string;
  beneficiary: string;
  amount: Money;
  reference: string;
  voucherCode: string | null;
  status: 'completed' | 'pending' | 'failed';
  createdAt: string;
  mocked: boolean;
};

export type UtilityProviderStatus = {
  available: boolean;
  mode: 'mock' | 'http' | 'disabled';
  maxAmount: Money;
  mocked: boolean;
};

export async function apiGetUtilityPurchaseStatus() {
  return apiRequest<UtilityProviderStatus>('/api/utility-purchases/status');
}

export async function apiBuyUtility(body: {
  catalogueVersionId: string;
  beneficiary: string;
  amount: MoneyInput;
}) {
  return apiRequest<{
    purchase: UtilityPurchase;
    transaction: import('../types').Transaction;
  }>('/api/utility-purchases', {
    method: 'POST',
    body: JSON.stringify(body),
    idempotencyKey: true,
  });
}

export async function apiListUtilityPurchases() {
  return apiRequest<{
    purchases: UtilityPurchase[];
    provider?: UtilityProviderStatus;
  }>('/api/utility-purchases');
}

export async function apiAdminListLoans(
  status?: 'pending' | 'approved' | 'rejected' | 'disbursed' | 'repaid',
) {
  const q = new URLSearchParams();
  if (status) q.set('status', status);
  const qs = q.toString();
  return apiRequest<{ loans: import('../types').Loan[] }>(
    `/api/admin/loans${qs ? `?${qs}` : ''}`,
  );
}

/* ------------------------------------------------------------------ */
/* Admin helpers                                                       */
/* ------------------------------------------------------------------ */

export async function apiAdminListComplianceFlags() {
  return apiRequest<{ flags: import('../types').ComplianceFlag[] }>(
    '/api/admin/compliance/flags',
  );
}

export type AdminAuditEvent = {
  id: string;
  type: string;
  message: string;
  actorUserId?: string;
  createdAt: string;
};

export async function apiAdminListAuditEvents() {
  return apiRequest<{ events: AdminAuditEvent[] }>('/api/admin/audit-events');
}

export async function apiAdminUpdateComplianceFlag(
  id: string,
  status: 'open' | 'resolved' | 'dismissed',
) {
  return apiRequest<{ flag: import('../types').ComplianceFlag }>(
    `/api/admin/compliance/flags/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    },
  );
}

export type ReconciliationReport = {
  ranAt: string;
  walletsChecked: number;
  ok: boolean;
  discrepancies: Array<{
    walletId: string;
    userId: string;
    poolId: string;
    kind: string;
    walletBalance: Money;
    ledgerBalance: Money;
    delta: Money;
  }>;
};

export async function apiAdminRunReconciliation() {
  return apiRequest<ReconciliationReport>('/api/admin/reconciliation/run', {
    method: 'POST',
  });
}

export type CustomerStatementItem = {
  id: string;
  amount_cents: string;
  type: string;
  status: string;
  reference: string;
  description: string;
  created_at: string;
  direction: 'debit' | 'credit';
};

export type CustomerCase = {
  id: string;
  case_number: string;
  case_type: string;
  subject: string;
  description: string;
  priority: string;
  state: string;
  acknowledged_due_at: string;
  resolution_due_at: string;
  created_at: string;
};

export async function apiSearchCustomerStatements(query = '') {
  const params = new URLSearchParams({ limit: '200' });
  if (query.trim()) params.set('q', query.trim());
  return apiRequest<{ statement: CustomerStatementItem[] }>(
    `/api/v1/customer/statements?${params.toString()}`,
  );
}

export async function apiListCustomerCases() {
  return apiRequest<{ cases: CustomerCase[] }>('/api/v1/customer/cases');
}

export async function apiCreateCustomerCase(body: {
  caseType:
    | 'incorrect_payment'
    | 'suspected_fraud'
    | 'complaint'
    | 'dispute'
    | 'account_recovery'
    | 'refund_query';
  subject: string;
  description: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  resourceId?: string;
  resourceType?: string;
}) {
  return apiRequest<{ case: CustomerCase }>('/api/v1/customer/cases', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiFreezeMyAccount(reason: string) {
  return apiRequest<{ actionId: string; state: string; message: string }>(
    '/api/v1/customer/account/freeze',
    {
      method: 'POST',
      body: JSON.stringify({ reason }),
    },
  );
}

export async function apiGetDurableReceipt(transactionId: string) {
  return apiRequest<{ receipt: { receipt_number: string; content: unknown } }>(
    `/api/v1/customer/receipts/transaction/${encodeURIComponent(transactionId)}`,
  );
}
