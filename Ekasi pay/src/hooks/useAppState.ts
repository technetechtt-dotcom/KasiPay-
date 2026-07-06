import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  User,
  Wallet,
  Transaction,
  Product,
  Sale,
  LedgerEntry,
  ComplianceFlag,
  Loan,
  Merchant,
  Expense,
  Language,
  CreditCustomer,
  CreditTransaction,
  Supplier,
  SupplierOrder,
  StokvelGroup,
  LaybyOrder,
  LoadSheddingSlot,
  PriceComparison,
  InsurancePolicy,
  VoiceNote,
  SupplierVerification,
  ExpiryItem,
  FoodSafetyAlert,
  CashSendVoucher,
  StockMovement } from '../types';

import { parseCashSendVoucherReference } from '../lib/cashSendReference';

import {
  ApiError,
  apiApplyLoan,
  apiRepayLoan,
  apiCancelCashSend,
  apiCollectCashSend,
  apiCreateCashSend,
  apiCreateCreditTransaction,
  apiCreateExpiryItem,
  apiCreateInsurancePolicy,
  apiAddLaybyPayment,
  apiCreateLaybyOrder,
  apiFileInsuranceClaim,
  apiUpdateStokvelMembers,
  apiCreatePriceComparison,
  apiCreateStokvelGroup,
  apiCreateSupplier,
  apiCreateSupplierOrder,
  apiCreateExpense,
  apiCreateCreditCustomer,
  apiEnsureMerchantProfile,
  apiCreateFoodSafetyAlert,
  apiCreateProduct,
  apiCreateSale,
  apiCreateStockMovement,
  apiCreateVoiceNote,
  apiDeleteVoiceNote,
  apiGetAdminUsers,
  apiAdminListAuditEvents,
  apiGetCashSendMe,
  apiGetComplianceMe,
  apiGetCreditCustomers,
  apiGetCreditTransactions,
  apiGetExpenses,
  apiGetExpiryItems,
  apiGetFoodSafetyAlerts,
  apiGetInsurancePolicies,
  apiGetLaybyOrders,
  apiGetLedger,
  apiGetLoadShedding,
  apiGetLoansMe,
  apiGetMerchantMe,
  apiGetPriceComparisons,
  apiGetProducts,
  apiGetSales,
  apiGetStockMovements,
  apiGetSupplierOrders,
  apiGetSupplierVerifications,
  apiGetSuppliers,
  apiGetStokvelGroups,
  apiGetTransactions,
  apiGetVoiceNotes,
  apiGetWallet,
  apiLogin,
  apiMarkFoodSafetyAlertRead,
  apiPatchSupplierOrder,
  apiPutSupplierVerification,
  apiRegister,
  apiTransfer,
  apiUpdatePin,
  apiUpdateProduct,
  apiGetMe,
  apiLogout,
  clearAuthStorage,
  getToken,
  persistAuth,
  refreshAccessToken,
  type PublicUserDto,
} from '../services/api';
import {
  MERCHANT_PORTAL_PAGE_IDS,
  WALLET_ONLY_PAGE_IDS,
} from '../config/merchantPortalPages';
import { FEATURE_FLAGS } from '../config/featureFlags';
import { toastMutationError } from '../lib/mutationToast';
import { cashSendVoucherPinMessage, isCashSendVoucherPinValid } from '../lib/pinValidation';
import { saIdValidationMessage } from '../lib/saIdValidation';
import {
  enqueueExpense,
  enqueueSale,
  flushOutbox,
  installOutboxAutoFlush,
  outboxSize,
} from '../lib/outbox';
import { clearSenderKycProfile } from '../lib/senderKycProfile';
import { toast } from 'sonner';

export type AuthStep = 'login' | 'register' | 'pin';

const OLD_STATE_KEY = 'kasiPay.state.v1';
const OLD_SESSION_KEY = 'kasiPay.session.v1';
const PREFS_KEY = 'kasiPay.prefs.v1';

export type WorkspaceMode = 'merchant' | 'wallet';

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;

type PersistedPrefs = {
  language?: Language;
  hasSeenOnboarding?: boolean;
  workspaceMode?: WorkspaceMode;
};

type AuditEventType =
  | 'auth.login.request'
  | 'auth.login.success'
  | 'auth.login.failed'
  | 'auth.login.locked'
  | 'auth.register.success'
  | 'auth.register.failed'
  | 'auth.logout'
  | 'auth.pin.updated'
  | 'money.send.success'
  | 'money.send.failed'
  | 'sale.create.success'
  | 'sale.create.failed';

type AuditEvent = {
  id: string;
  type: string;
  message: string;
  actorUserId?: string;
  createdAt: string;
};

function readPrefs(): PersistedPrefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as PersistedPrefs;
  } catch {
    return {};
  }
}

function readInitialPrefsLanguage(): Language {
  const prefs = readPrefs().language;
  return prefs ?? 'en';
}

function readInitialWorkspaceMode(): WorkspaceMode {
  const m = readPrefs().workspaceMode;
  return m === 'wallet' ? 'wallet' : 'merchant';
}

function migrateLegacyStorage(setLanguage_: (v: Language) => void, setSeen: (v: boolean) => void) {
  if (typeof window === 'undefined') return;
  try {
    const rawOld = window.localStorage.getItem(OLD_STATE_KEY);
    if (rawOld) {
      const p = JSON.parse(rawOld) as {
        language?: Language;
        hasSeenOnboarding?: boolean;
      };
      if (p.language) setLanguage_(p.language);
      if (typeof p.hasSeenOnboarding === 'boolean') setSeen(p.hasSeenOnboarding);
      window.localStorage.removeItem(OLD_STATE_KEY);
    }
    window.localStorage.removeItem(OLD_SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function mapDtoToUser(u: PublicUserDto): User {
  return {
    id: u.id,
    name: u.name,
    phone: u.phone,
    role: u.role as User['role'],
    kycStatus: u.kycStatus as User['kycStatus'],
    accountTier: u.accountTier as User['accountTier'],
    countryCode: u.countryCode ?? 'ZA',
    createdAt: u.createdAt,
    suspendedAt: u.suspendedAt ?? null,
  };
}

const isBrowser = typeof window !== 'undefined';

export function useAppState() {
  const didMigrate = useRef(false);

  const [language, setLanguage] = useState<Language>(readInitialPrefsLanguage);
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(
    () => readPrefs().hasSeenOnboarding ?? false
  );
  const [workspaceMode, setWorkspaceModeState] = useState<WorkspaceMode>(
    readInitialWorkspaceMode
  );
  const [isReady, setIsReady] = useState(false);

  const [merchantProfile, setMerchantProfile] = useState<Merchant | null>(null);

  const [users, setUsers] = useState<User[]>([]);
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [flags, setFlags] = useState<ComplianceFlag[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);

  const [creditCustomers, setCreditCustomers] = useState<CreditCustomer[]>(
    []
  );
  const [creditTransactions, setCreditTransactions] = useState<
    CreditTransaction[]>([]);

  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierOrders, setSupplierOrders] = useState<SupplierOrder[]>([]);
  const [stokvelGroups, setStokvelGroups] = useState<StokvelGroup[]>([]);
  const [laybyOrders, setLaybyOrders] = useState<LaybyOrder[]>([]);
  const [loadSheddingSchedule, setLoadSheddingSchedule] = useState<
    LoadSheddingSlot[]
  >([]);
  const [priceComparisons, setPriceComparisons] = useState<
    PriceComparison[]
  >([]);
  const [insurancePolicies, setInsurancePolicies] = useState<
    InsurancePolicy[]
  >([]);
  const [voiceNotes, setVoiceNotes] = useState<VoiceNote[]>([]);
  const [supplierVerifications, setSupplierVerifications] = useState<
    SupplierVerification[]
  >([]);
  const [expiryItems, setExpiryItems] = useState<ExpiryItem[]>([]);
  const [foodSafetyAlerts, setFoodSafetyAlerts] = useState<FoodSafetyAlert[]>(
    []
  );
  const [cashSendVouchers, setCashSendVouchers] = useState<CashSendVoucher[]>(
    []
  );
  const [stockMovements, setStockMovements] = useState<StockMovement[]>([]);

  const [isOffline, setIsOffline] = useState(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );

  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);

  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authStep, setAuthStep] = useState<AuthStep>('login');
  const [tempPhone, setTempPhone] = useState('');
  const [failedPinAttempts, setFailedPinAttempts] = useState(0);
  const [pinLockedUntil, setPinLockedUntil] = useState<number | null>(null);

  const [currentPage, setCurrentPage] = useState<string>('home');

  useEffect(() => {
    if (didMigrate.current || !isBrowser) return;
    didMigrate.current = true;
    migrateLegacyStorage(setLanguage, setHasSeenOnboarding);
  }, []);

  useEffect(() => {
    if (!isBrowser) return;
    window.localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ language, hasSeenOnboarding, workspaceMode })
    );
  }, [language, hasSeenOnboarding, workspaceMode]);

  const [pendingOutbox, setPendingOutbox] = useState(() => outboxSize());

  useEffect(() => {
    const handleOnline = () => {
      setIsOffline(false);
      void flushOutbox().then(() => setPendingOutbox(outboxSize()));
    };
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const cleanup = installOutboxAutoFlush();
    const tick = window.setInterval(() => setPendingOutbox(outboxSize()), 1500);
    return () => {
      cleanup();
      window.clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      /**
       * Access tokens live in memory only, so a refresh wipes them. If we don't
       * have one but a refresh token is in sessionStorage, try to mint a fresh
       * access token before giving up — this keeps the user signed in across
       * page reloads without leaking the JWT to localStorage.
       */
      if (!getToken()) {
        const refreshed = await refreshAccessToken();
        if (!refreshed) {
          if (!cancelled) {
            clearAuthStorage();
            setIsReady(true);
          }
          return;
        }
      }
      try {
        const { user } = await apiGetMe();
        if (cancelled) return;
        const mapped = mapDtoToUser(user);
        setCurrentUser(mapped);
        setIsAuthenticated(true);
        await loadRemoteSnapshot(mapped);
      } catch {
        if (!cancelled) {
          const recovered = await refreshAccessToken();
          if (recovered && !cancelled) {
            try {
              const { user } = await apiGetMe();
              const mapped = mapDtoToUser(user);
              setCurrentUser(mapped);
              setIsAuthenticated(true);
              await loadRemoteSnapshot(mapped);
            } catch {
              clearAuthStorage();
              setCurrentUser(null);
              setIsAuthenticated(false);
              resetDomainState();
            }
          } else {
            clearAuthStorage();
            setCurrentUser(null);
            setIsAuthenticated(false);
            resetDomainState();
          }
        }
      } finally {
        if (!cancelled) setIsReady(true);
      }
    }
    hydrate();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot bootstrap from token only
  }, []);

  function resetDomainState() {
    setMerchantProfile(null);
    setUsers([]);
    setWallets([]);
    setTransactions([]);
    setProducts([]);
    setSales([]);
    setLedger([]);
    setFlags([]);
    setLoans([]);
    setExpenses([]);
    setCreditCustomers([]);
    setCreditTransactions([]);
    setSuppliers([]);
    setSupplierOrders([]);
    setStokvelGroups([]);
    setLaybyOrders([]);
    setLoadSheddingSchedule([]);
    setPriceComparisons([]);
    setInsurancePolicies([]);
    setVoiceNotes([]);
    setSupplierVerifications([]);
    setExpiryItems([]);
    setFoodSafetyAlerts([]);
    setCashSendVouchers([]);
    setStockMovements([]);
  }

  const pushAudit = useCallback((
    type: AuditEventType,
    message: string,
    actorUserId?: string
  ) => {
    setAuditEvents((prev) => {
      const next: AuditEvent = {
        id: `audit_${Math.random().toString(36).slice(2, 11)}`,
        type,
        message,
        actorUserId,
        createdAt: new Date().toISOString(),
      };
      return [next, ...prev].slice(0, FEATURE_FLAGS.maxAuditEvents);
    });
  }, []);

  const normalizePhone = (phone: string) => phone.replace(/\D/g, '');
  const normalizePin = (pin: string) => pin.replace(/\D/g, '').slice(0, 4);
  const normalizeAtmPin = (pin: string) => pin.replace(/\D/g, '').slice(0, 8);

  const isPinLocked = () =>
    pinLockedUntil !== null && Date.now() < pinLockedUntil;
  const isPositiveAmount = (amount: number) =>
    Number.isFinite(amount) && amount > 0;
  const isWalletUsable = (wallet: Wallet | undefined): wallet is Wallet =>
    Boolean(wallet && wallet.status === 'active');

  async function loadRemoteSnapshot(forUser: User) {
    async function fetchOr403<T>(promise: Promise<T>, empty: T): Promise<T> {
      try {
        return await promise;
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) return empty;
        throw e;
      }
    }

    const [walletRes, txRes, ledRes] = await Promise.all([
      apiGetWallet(),
      apiGetTransactions(),
      apiGetLedger(),
    ]);

    setWallets(walletRes.wallet ? [walletRes.wallet] : []);
    setTransactions(txRes.transactions);
    setLedger(ledRes.ledger);

    const merchantRes = await apiGetMerchantMe();
    setMerchantProfile(merchantRes.merchant);

    const [
      sheds,
      supplierRes,
      verifyRes,
      loanRes,
      compRes,
      cashSendRes,
    ] = await Promise.all([
      apiGetLoadShedding(),
      apiGetSuppliers(),
      apiGetSupplierVerifications(),
      apiGetLoansMe(),
      apiGetComplianceMe(),
      apiGetCashSendMe(),
    ]);

    setLoadSheddingSchedule(sheds.slots);
    setSuppliers(supplierRes.suppliers);
    setSupplierVerifications(verifyRes.verifications);
    setLoans(loanRes.loans);
    setFlags(compRes.flags);
    setCashSendVouchers(cashSendRes.vouchers);

    if (forUser.role === 'admin') {
      try {
        const [{ users: adminRows }, { events }] = await Promise.all([
          apiGetAdminUsers(),
          apiAdminListAuditEvents(),
        ]);
        setUsers(adminRows.map(mapDtoToUser));
        setAuditEvents(events);
      } catch {
        setUsers([]);
        setAuditEvents([]);
      }
    } else {
      setUsers([]);
      setAuditEvents([]);
    }

    if (forUser.role !== 'merchant' || !merchantRes.merchant) {
      setProducts([]);
      setSales([]);
      setExpenses([]);
      setCreditCustomers([]);
      setCreditTransactions([]);
      setSupplierOrders([]);
      setStokvelGroups([]);
      setLaybyOrders([]);
      setPriceComparisons([]);
      setInsurancePolicies([]);
      setVoiceNotes([]);
      setExpiryItems([]);
      setFoodSafetyAlerts([]);
      setStockMovements([]);
      return;
    }

    const mid = merchantRes.merchant.id;
    const [
      p,
      s,
      e,
      cc,
      ord,
      stok,
      lay,
      price,
      ins,
      voice,
      exp,
      food,
      mov,
    ] = await Promise.all([
      apiGetProducts(mid),
      apiGetSales(),
      apiGetExpenses(),
      apiGetCreditCustomers(),
      fetchOr403(apiGetSupplierOrders(), { orders: [] }),
      fetchOr403(apiGetStokvelGroups(), { groups: [] }),
      fetchOr403(apiGetLaybyOrders(), { orders: [] }),
      fetchOr403(apiGetPriceComparisons(mid), { comparisons: [] }),
      fetchOr403(apiGetInsurancePolicies(), { policies: [] }),
      fetchOr403(apiGetVoiceNotes(), { notes: [] }),
      fetchOr403(apiGetExpiryItems(), { items: [] }),
      fetchOr403(apiGetFoodSafetyAlerts(), { alerts: [] }),
      fetchOr403(apiGetStockMovements(), { movements: [] }),
    ]);

    let ct: CreditTransaction[] = [];
    try {
      const ctr = await apiGetCreditTransactions();
      ct = ctr.transactions;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 403) throw err;
    }

    setProducts(p.products);
    setSales(s.sales);
    setExpenses(e.expenses);
    setCreditCustomers(cc.customers);
    setCreditTransactions(ct);
    setSupplierOrders(ord.orders);
    setStokvelGroups(stok.groups);
    setLaybyOrders(lay.orders);
    setPriceComparisons(price.comparisons);
    setInsurancePolicies(ins.policies);
    setVoiceNotes(voice.notes);
    setExpiryItems(exp.items);
    setFoodSafetyAlerts(food.alerts);
    setStockMovements(mov.movements);
  }

  const refreshAfterMutation = useCallback(
    async (forUser?: User | null) => {
      const u = forUser ?? currentUser;
      if (!u || !getToken()) return;
      await loadRemoteSnapshot(u);
    },
    [currentUser]
  );

  const logout = () => {
    pushAudit('auth.logout', 'User logged out', currentUser?.id);
    void (async () => {
      await apiLogout();
      // Drop persisted sender KYC so shared devices don't leak ID/address.
      clearSenderKycProfile();
      resetDomainState();
      setCurrentUser(null);
      setIsAuthenticated(false);
      setAuthStep('login');
      setTempPhone('');
      setFailedPinAttempts(0);
      setPinLockedUntil(null);
      setMerchantProfile(null);
    })();
  };

  /**
   * UI-only transition: cache the phone number and advance to the PIN step.
   * We deliberately do NOT call the server here — that would let an attacker
   * enumerate registered numbers via response-time differences. Real validation
   * happens in `loginStep2` against `/api/login`.
   */
  const loginStep1 = (phone: string) => {
    const cleanedPhone = normalizePhone(phone);
    pushAudit(
      'auth.login.request',
      'Login PIN step opened',
      currentUser?.id
    );
    if (cleanedPhone.length < 10) return false;
    setTempPhone(cleanedPhone);
    setAuthStep('pin');
    setFailedPinAttempts(0);
    return true;
  };

  const loginStep2 = async (pin: string): Promise<boolean> => {
    if (FEATURE_FLAGS.enableAuthLockout && isPinLocked()) {
      pushAudit('auth.login.locked', 'PIN entry rejected: auth lockout active');
      return false;
    }
    const cleanedPin = normalizePin(pin);
    if (cleanedPin.length !== 4) return false;

    try {
      const { token, refreshToken, user } = await apiLogin(tempPhone, cleanedPin);
      persistAuth(token, refreshToken);
      const mapped = mapDtoToUser(user);
      await loadRemoteSnapshot(mapped);
      setCurrentUser(mapped);
      setIsAuthenticated(true);
      setAuthStep('login');
      setCurrentPage('home');
      setTempPhone('');
      setFailedPinAttempts(0);
      setPinLockedUntil(null);
      pushAudit('auth.login.success', 'Login successful', mapped.id);
      return true;
    } catch (e) {
      clearAuthStorage();
      setCurrentUser(null);
      setIsAuthenticated(false);
      setFailedPinAttempts((prev) => {
        const next = prev + 1;
        if (FEATURE_FLAGS.enableAuthLockout && next >= MAX_PIN_ATTEMPTS) {
          setPinLockedUntil(Date.now() + PIN_LOCK_MS);
          pushAudit(
            'auth.login.locked',
            'PIN attempts exceeded: lockout applied'
          );
          return 0;
        }
        return next;
      });
      pushAudit('auth.login.failed', 'Login failed: invalid credentials');
      toastMutationError('Sign in', e);
      return false;
    }
  };

  const register = async (
    name: string,
    phone: string,
    pin: string,
    role: 'customer' | 'merchant' | 'agent'
  ): Promise<boolean> => {
    const cleanedPhone = normalizePhone(phone);
    const cleanedPin = normalizePin(pin);
    if (cleanedPhone.length < 10 || cleanedPin.length !== 4) {
      toast.error(
        'Enter at least 10 digits for your mobile number and a 4-digit PIN.'
      );
      return false;
    }

    try {
      const displayName = name.trim();
      const { token, refreshToken, user } = await apiRegister({
        name: displayName,
        phone: cleanedPhone,
        pin: cleanedPin,
        role,
        ...(role === 'merchant' ?
          {
            businessName: `${displayName}'s Shop`,
            location: 'South Africa',
            category: 'Retail',
          }
        : {}),
      });
      persistAuth(token, refreshToken);
      const mapped = mapDtoToUser(user);
      await loadRemoteSnapshot(mapped);
      setCurrentUser(mapped);
      setIsAuthenticated(true);
      setAuthStep('login');
      setCurrentPage('home');
      pushAudit('auth.register.success', 'Registration successful', mapped.id);
      return true;
    } catch (e) {
      clearAuthStorage();
      setCurrentUser(null);
      setIsAuthenticated(false);
      pushAudit('auth.register.failed', 'Registration failed');
      toastMutationError('Create account', e);
      return false;
    }
  };

  const updateUserPin = async (
    currentPin: string,
    newPin: string
  ): Promise<boolean> => {
    if (!currentUser || normalizePin(newPin).length !== 4) return false;
    try {
      await apiUpdatePin(normalizePin(currentPin), normalizePin(newPin));
      pushAudit('auth.pin.updated', 'PIN updated', currentUser.id);
      return true;
    } catch (e) {
      toastMutationError('Update PIN', e);
      return false;
    }
  };

  const navigate = (page: string) => setCurrentPage(page);

  const setWorkspaceMode = useCallback((mode: WorkspaceMode) => {
    setWorkspaceModeState(mode);
    setCurrentPage((prev) => {
      if (mode === 'wallet' && MERCHANT_PORTAL_PAGE_IDS.has(prev)) {
        return 'home';
      }
      if (mode === 'merchant' && WALLET_ONLY_PAGE_IDS.has(prev)) {
        return 'home';
      }
      return prev;
    });
  }, []);

  const completeOnboarding = () => setHasSeenOnboarding(true);

  const getMyWallet = () => wallets.find((w) => w.userId === currentUser?.id);

  const sendMoney = async (
    toPhone: string,
    amount: number,
    description: string
  ): Promise<boolean> => {
    const cleanedPhone = normalizePhone(toPhone);
    const fromWallet = getMyWallet();
    if (
      !isPositiveAmount(amount) ||
      !isWalletUsable(fromWallet) ||
      cleanedPhone === currentUser?.phone
    ) {
      pushAudit('money.send.failed', 'Send money failed validation');
      return false;
    }
    try {
      await apiTransfer(cleanedPhone, amount, description);
      pushAudit('money.send.success', 'Money sent successfully', currentUser?.id);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      pushAudit('money.send.failed', 'Send money failed');
      toastMutationError('Send money', e);
      return false;
    }
  };

  const getMyProducts = () =>
    merchantProfile ?
      products.filter((p) => p.merchantId === merchantProfile.id) :
      [];

  const addStockMovement = useCallback(
    async (movement: Omit<StockMovement, 'id' | 'createdAt'>) => {
      if (!merchantProfile) return;
      try {
        const { movement: created } = await apiCreateStockMovement({
          productId: movement.productId,
          productName: movement.productName,
          type: movement.type,
          quantity: movement.quantity,
          reason: movement.reason,
          costPriceAtTime: movement.costPriceAtTime,
        });
        setStockMovements((prev) => [created, ...prev]);
      } catch (e) {
        toastMutationError('Stock movement', e);
        await refreshAfterMutation();
      }
    },
    [merchantProfile, refreshAfterMutation]
  );

  const addProduct = async (productData: {
    name: string;
    costPrice: number;
    price: number;
    stock: number;
    category: string;
    barcode?: string;
  }): Promise<void> => {
    if (!currentUser || merchantProfile === null) return;
    try {
      const { product } = await apiCreateProduct(productData);
      setProducts((prev) => [...prev, product]);

      if (productData.stock > 0) {
        await addStockMovement({
          productId: product.id,
          productName: product.name,
          type: 'in',
          quantity: productData.stock,
          reason: 'initial',
          costPriceAtTime: productData.costPrice,
        });
      }
    } catch (e) {
      toastMutationError('Add product', e);
      await refreshAfterMutation();
    }
  };

  const restockProduct = async (productId: string, quantity: number) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    const nextStock = Math.max(0, product.stock + quantity);
    try {
      const { product: updated } = await apiUpdateProduct(productId, {
        stock: nextStock,
      });
      setProducts((prev) => prev.map((p) => (p.id === productId ? updated : p)));

      if (quantity !== 0) {
        await addStockMovement({
          productId: product.id,
          productName: product.name,
          type: quantity > 0 ? 'in' : 'out',
          quantity: Math.abs(quantity),
          reason: quantity > 0 ? 'restock' : 'manual',
          costPriceAtTime: product.costPrice,
        });
      }
    } catch (e) {
      toastMutationError('Update stock', e);
      await refreshAfterMutation();
    }
  };

  const makeSale = async (
    rawItems:
      | {productId: string;quantity: number;price: number;}[]
      | {product: Product;quantity: number;}[],
    paymentMethod: 'cash' | 'wallet',
    customerPhone?: string
  ): Promise<boolean> => {
    if (!currentUser || merchantProfile === null) {
      pushAudit('sale.create.failed', 'Sale failed: no merchant context');
      return false;
    }
    const items = rawItems.map((item) => {
      if ('product' in item) {
        return {
          productId: item.product.id,
          quantity: item.quantity,
          price: item.product.price,
        };
      }
      return item;
    });
    if (items.length === 0) return false;
    if (items.some((item) => !isPositiveAmount(item.price) || item.quantity <= 0)) {
      pushAudit('sale.create.failed', 'Sale failed: invalid item payload');
      return false;
    }
    let walletCustomerPhone: string | undefined;
    if (paymentMethod === 'wallet') {
      const cleaned = normalizePhone(customerPhone ?? '');
      if (cleaned.length < 10) return false;
      walletCustomerPhone = cleaned;
    }

    const salePayload = {
      items,
      paymentMethod,
      customerPhone: walletCustomerPhone,
    };
    // Cash sales are safe to queue offline (they only adjust local stock +
    // ledger). Wallet-paid sales need the live wallet check so we refuse
    // to enqueue them and surface a hard error instead.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (paymentMethod === 'wallet') {
        toast.error('Wallet sales need internet — wait for connectivity.');
        return false;
      }
      enqueueSale(salePayload);
      pushAudit('sale.create.success', 'Sale queued offline', currentUser.id);
      toast.message('Offline — cash sale queued and will sync when online.');
      return true;
    }
    try {
      await apiCreateSale(salePayload);
      pushAudit(
        'sale.create.success',
        'Sale recorded on server',
        currentUser.id
      );
      await refreshAfterMutation();
      return true;
    } catch (e) {
      const queueable =
        paymentMethod === 'cash' &&
        ((e instanceof ApiError && (e.status === 0 || e.status >= 500)) ||
          e instanceof TypeError);
      if (queueable) {
        enqueueSale(salePayload);
        pushAudit('sale.create.success', 'Sale queued after network error', currentUser.id);
        toast.message('Network hiccup — cash sale queued for retry.');
        return true;
      }
      pushAudit('sale.create.failed', 'Sale failed on server');
      toastMutationError('Record sale', e);
      return false;
    }
  };

  const createCashSend = async (input: {
    senderPhone: string;
    senderFirstName: string;
    senderLastName: string;
    senderIdDocument: string;
    senderAddress: string;
    recipientFirstName: string;
    recipientLastName: string;
    recipientPhone: string;
    recipientIdDocument?: string;
    amount: number;
    pin: string;
  }): Promise<CashSendVoucher | null> => {
    if (!currentUser) {
      toast.error('Sign in to create a Cash Send.');
      return null;
    }
    const cleanedSender = normalizePhone(input.senderPhone);
    if (cleanedSender.length < 10) {
      toast.error('Enter a valid sender cellphone (10 digits).');
      return null;
    }
    const atmPin = normalizeAtmPin(input.pin);
    if (!isCashSendVoucherPinValid(atmPin)) {
      toast.error(cashSendVoucherPinMessage(atmPin) ?? 'Enter a valid 4-digit PIN.');
      return null;
    }
    const cleanedRecipient = normalizePhone(input.recipientPhone);
    if (cleanedRecipient.length < 10) {
      toast.error('Enter a valid beneficiary cellphone (10 digits).');
      return null;
    }
    if (cleanedRecipient === cleanedSender) {
      toast.error('Beneficiary cellphone must differ from the sender’s.');
      return null;
    }
    const senderId = input.senderIdDocument.replace(/\D/g, '');
    const recipientId = (input.recipientIdDocument ?? '').replace(/\D/g, '');
    const senderIdMsg = saIdValidationMessage(senderId);
    if (senderIdMsg) {
      toast.error(`Sender: ${senderIdMsg}`);
      return null;
    }
    const recipientIdMsg =
      recipientId.length > 0 ? saIdValidationMessage(recipientId) : null;
    if (recipientIdMsg) {
      toast.error(`Beneficiary: ${recipientIdMsg}`);
      return null;
    }
    if (!isPositiveAmount(input.amount)) {
      toast.error('Enter a valid amount greater than R0.');
      return null;
    }
    const fromWallet = getMyWallet();
    if (!isWalletUsable(fromWallet)) {
      toast.error('Wallet unavailable — try again after refreshing.');
      return null;
    }
    const total = input.amount + 10;
    if (fromWallet.balance < total) {
      toast.error('Insufficient wallet balance (including R10 fee).');
      return null;
    }
    try {
      const { voucher } = await apiCreateCashSend({
        senderFirstName: input.senderFirstName.trim(),
        senderLastName: input.senderLastName.trim(),
        senderIdDocument: senderId,
        senderPhone: cleanedSender,
        senderAddress: input.senderAddress.trim(),
        recipientFirstName: input.recipientFirstName.trim(),
        recipientLastName: input.recipientLastName.trim(),
        recipientPhone: cleanedRecipient,
        recipientIdDocument: recipientId || '',
        amount: input.amount,
        atmPin,
      });
      setCashSendVouchers((prev) => [voucher, ...prev]);
      await refreshAfterMutation();
      return voucher;
    } catch (e) {
      toastMutationError('Cash Send', e);
      await refreshAfterMutation();
      return null;
    }
  };

  const collectCashSend = async (
    referenceNumber: string,
    pin: string,
    scannedIdDocument: string
  ): Promise<{
    success: boolean;
    reason?: string;
    voucher?: CashSendVoucher;
  }> => {
    const atm = normalizeAtmPin(pin);
    if (!isCashSendVoucherPinValid(atm)) {
      return {
        success: false,
        reason: cashSendVoucherPinMessage(atm) ?? 'PIN must be exactly 4 digits',
      };
    }
    const idDigits = scannedIdDocument.replace(/\D/g, '');
    const idMsg = saIdValidationMessage(idDigits);
    if (idMsg) {
      return { success: false, reason: idMsg };
    }
    const voucherRef = parseCashSendVoucherReference(referenceNumber);
    if (!voucherRef) {
      return { success: false, reason: 'Enter a valid voucher number (CS…) and PIN.' };
    }
    try {
      const { voucher } = await apiCollectCashSend({
        referenceNumber: voucherRef,
        pin: atm,
        scannedIdDocument: idDigits,
      });
      await refreshAfterMutation();
      return { success: true, voucher };
    } catch (e) {
      const reason =
        e instanceof ApiError ? e.message : 'Verification failed';
      return { success: false, reason };
    }
  };

  const cancelCashSend = async (voucherId: string): Promise<boolean> => {
    if (!currentUser) return false;
    try {
      await apiCancelCashSend(voucherId);
      setCashSendVouchers((prev) =>
        prev.map((v) =>
          v.id === voucherId ?
            {
              ...v,
              status: 'cancelled',
              cancelReason: 'Cancelled by sender',
            } :
            v
        )
      );
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Cancel Cash Send', e);
      return false;
    }
  };

  const addExpense = async (
    expense: Omit<Expense, 'id' | 'merchantId' | 'createdAt'>
  ): Promise<void> => {
    if (!merchantProfile || !isPositiveAmount(expense.amount)) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      enqueueExpense(expense);
      toast.message('Offline — expense queued and will sync when online.');
      return;
    }
    try {
      const { expense: created } = await apiCreateExpense(expense);
      setExpenses((prev) => [created, ...prev]);
      await refreshAfterMutation();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500)) {
        enqueueExpense(expense);
        toast.message('Network hiccup — expense queued for retry.');
        return;
      }
      // TypeError = network unreachable in fetch
      if (e instanceof TypeError) {
        enqueueExpense(expense);
        toast.message('Network unreachable — expense queued for retry.');
        return;
      }
      toastMutationError('Add expense', e);
      await refreshAfterMutation();
    }
  };

  /**
   * Returns the user's merchant profile, lazily creating one on the server when
   * missing. Used by merchant-only mutations so users in merchant mode without
   * an onboarded profile (e.g. legacy or customer-role accounts) don't fail
   * silently when they try to save.
   */
  const ensureMerchantProfile = useCallback(async (): Promise<Merchant | null> => {
    if (merchantProfile) return merchantProfile;
    try {
      const { merchant } = await apiEnsureMerchantProfile();
      setMerchantProfile(merchant);
      return merchant;
    } catch (e) {
      toastMutationError('Set up shop profile', e);
      return null;
    }
  }, [merchantProfile]);

  const addCreditTransaction = async (
    customerId: string,
    type: 'purchase' | 'payment',
    amount: number,
    description: string
  ): Promise<boolean> => {
    const mp = await ensureMerchantProfile();
    if (!mp) return false;
    if (!isPositiveAmount(amount)) {
      toast.error('Enter an amount greater than R0.');
      return false;
    }
    try {
      await apiCreateCreditTransaction({
        customerId,
        type,
        amount,
        description,
      });
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Credit book', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const addVoiceNote = (
    note: Omit<VoiceNote, 'id' | 'merchantId' | 'createdAt'>
  ) => {
    if (!merchantProfile) return;
    void (async () => {
      try {
        const { note: created } = await apiCreateVoiceNote({
          title: note.title,
          transcript: note.transcript,
          duration: note.duration,
          category: note.category,
        });
        setVoiceNotes((prev) => [created, ...prev]);
      } catch (e) {
        toastMutationError('Voice note', e);
        await refreshAfterMutation();
      }
    })();
  };

  const deleteVoiceNote = (id: string) => {
    void (async () => {
      try {
        await apiDeleteVoiceNote(id);
        setVoiceNotes((prev) => prev.filter((n) => n.id !== id));
      } catch (e) {
        toastMutationError('Delete voice note', e);
        await refreshAfterMutation();
      }
    })();
  };

  const markAlertRead = (id: string) => {
    setFoodSafetyAlerts((prev) =>
      prev.map((alert) => (alert.id === id ? { ...alert, isRead: true } : alert))
    );
    void (async () => {
      try {
        await apiMarkFoodSafetyAlertRead(id);
      } catch (e) {
        toastMutationError('Mark alert read', e);
        await refreshAfterMutation();
      }
    })();
  };

  const createCreditCustomerRecord = async (
    name: string,
    phone: string,
    creditLimit: number
  ): Promise<boolean> => {
    const trimmedName = name.trim();
    const cleaned = normalizePhone(phone);
    if (!trimmedName) {
      toast.error('Enter the customer name.');
      return false;
    }
    if (cleaned.length < 9) {
      toast.error('Enter a phone number with at least 9 digits.');
      return false;
    }
    if (!Number.isFinite(creditLimit) || creditLimit <= 0) {
      toast.error('Set a credit limit greater than R0.');
      return false;
    }
    const mp = await ensureMerchantProfile();
    if (!mp) return false;
    try {
      await apiCreateCreditCustomer({
        name: trimmedName,
        phone: cleaned,
        creditLimit,
      });
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Credit customer', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const addSupplierRecord = async (input: {
    name: string;
    phone: string;
    category: string;
    deliveryDays?: string[];
  }): Promise<boolean> => {
    try {
      await apiCreateSupplier({
        name: input.name.trim(),
        phone: normalizePhone(input.phone),
        category: input.category.trim(),
        deliveryDays: input.deliveryDays?.length ?
          input.deliveryDays :
          ['Mon', 'Wed', 'Fri'],
      });
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Supplier', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const createSupplierOrderRecord = async (input: {
    supplierId: string;
    items: { name: string; quantity: number; unitCost: number }[];
    total: number;
    expectedDelivery?: string;
  }): Promise<boolean> => {
    if (!merchantProfile) return false;
    try {
      await apiCreateSupplierOrder(input);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Supplier order', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const updateSupplierOrderStatusRecord = async (
    orderId: string,
    status: 'pending' | 'confirmed' | 'delivered'
  ): Promise<boolean> => {
    try {
      await apiPatchSupplierOrder(orderId, { status });
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Supplier order status', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const upsertSupplierVerificationRecord = async (
    supplierId: string,
    body: {
      cipcRegistered: boolean;
      healthDeptApproved: boolean;
      lastInspectionDate: string;
      certificateExpiry: string;
      verificationStatus:
        | 'verified'
        | 'pending'
        | 'unverified'
        | 'flagged';
      riskLevel: 'low' | 'medium' | 'high';
    }
  ): Promise<boolean> => {
    try {
      await apiPutSupplierVerification(supplierId, body);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Supplier verification', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const addStokvelGroupRecord = async (input: {
    name: string;
    members: { name: string; phone: string; contributed: number }[];
    targetAmount: number;
    currentAmount: number;
    frequency: 'weekly' | 'monthly';
    nextPayoutDate: string;
  }): Promise<boolean> => {
    const mp = await ensureMerchantProfile();
    if (!mp) return false;
    try {
      await apiCreateStokvelGroup(input);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Stokvel group', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const updateStokvelMembers = async (
    id: string,
    members: { name: string; phone: string; contributed: number }[],
  ): Promise<boolean> => {
    try {
      await apiUpdateStokvelMembers(id, members);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Stokvel members', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const fileInsuranceClaim = async (
    policyId: string,
    body: {
      type: 'stock' | 'fire' | 'theft';
      description: string;
      claimedAmount: number;
    },
  ): Promise<boolean> => {
    try {
      await apiFileInsuranceClaim(policyId, body);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Insurance claim', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const addLaybyOrderRecord = async (input: {
    customerName: string;
    customerPhone: string;
    itemName: string;
    totalPrice: number;
    amountPaid: number;
    installments?: { amount: number; date: string }[];
    status?: 'active' | 'completed' | 'cancelled';
  }): Promise<boolean> => {
    if (!merchantProfile) return false;
    try {
      await apiCreateLaybyOrder(input);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Lay-by order', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const recordLaybyInstallment = async (
    id: string,
    amount: number,
  ): Promise<boolean> => {
    try {
      await apiAddLaybyPayment(id, amount);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Layby payment', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const addTrackedPriceComparison = async (input: {
    productName: string;
    myPrice: number;
    avgAreaPrice: number;
    lowestAreaPrice: number;
    highestAreaPrice: number;
    competitors: number;
  }): Promise<boolean> => {
    if (!merchantProfile) return false;
    try {
      await apiCreatePriceComparison(input);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Price comparison', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const subscribeMicroInsurancePlan = async (
    plan: 'basic' | 'comprehensive'
  ): Promise<boolean> => {
    const mp = await ensureMerchantProfile();
    if (!mp) return false;
    const due = () =>
      new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    try {
      if (plan === 'basic') {
        await apiCreateInsurancePolicy({
          provider: 'EkasiShield Basic',
          type: 'stock',
          coverageAmount: 10000,
          monthlyPremium: 50,
          status: 'active',
          nextPaymentDate: due(),
        });
      } else {
        await apiCreateInsurancePolicy({
          provider: 'EkasiShield Comprehensive',
          type: 'theft',
          coverageAmount: 20000,
          monthlyPremium: 85,
          status: 'pending',
          nextPaymentDate: due(),
        });
      }
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Insurance', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const addTrackedExpiryItem = async (input: {
    productName: string;
    category: string;
    batchNumber: string;
    expiryDate: string;
    quantity: number;
    supplierId: string;
    status?: ExpiryItem['status'];
  }): Promise<boolean> => {
    if (!merchantProfile) return false;
    try {
      await apiCreateExpiryItem({
        ...input,
        status: input.status ?? 'safe',
      });
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Expiry tracking', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const publishFoodSafetyNotice = async (input: {
    type: 'recall' | 'expiry' | 'supplier' | 'inspection';
    title: string;
    description: string;
    severity: 'critical' | 'warning' | 'info';
    shopWideOnly?: boolean;
  }): Promise<boolean> => {
    if (!merchantProfile) return false;
    try {
      await apiCreateFoodSafetyAlert({
        type: input.type,
        title: input.title,
        description: input.description,
        severity: input.severity,
        merchantScope: input.shopWideOnly !== false,
      });
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Food safety alert', e);
      await refreshAfterMutation();
      return false;
    }
  };

  /** Default APR for new working-capital loans until pricing is per-user. */
  const DEFAULT_LOAN_APR = 0.12;
  const requestWorkingCapitalLoan = async (
    amount: number,
    interestRate: number = DEFAULT_LOAN_APR,
  ): Promise<boolean> => {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    if (!Number.isFinite(interestRate) || interestRate < 0) return false;
    try {
      await apiApplyLoan({ amount, interestRate });
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Loan request', e);
      await refreshAfterMutation();
      return false;
    }
  };

  const repayLoan = async (
    loanId: string,
    amount: number,
  ): Promise<boolean> => {
    if (!Number.isFinite(amount) || amount <= 0) return false;
    try {
      await apiRepayLoan(loanId, amount);
      await refreshAfterMutation();
      return true;
    } catch (e) {
      toastMutationError('Loan repayment', e);
      await refreshAfterMutation();
      return false;
    }
  };

  return {
    isReady,

    /** Merchant profile when `role === 'merchant'` — used instead of embedded mock merchants. */
    merchantProfile,
    setMerchantProfile,

    users,
    wallets,
    transactions,
    products,
    sales,
    ledger,
    flags,
    loans,
    expenses,
    creditCustomers,
    creditTransactions,
    suppliers,
    supplierOrders,
    stokvelGroups,
    laybyOrders,
    loadSheddingSchedule,
    priceComparisons,
    insurancePolicies,
    voiceNotes,
    supplierVerifications,
    expiryItems,
    foodSafetyAlerts,
    cashSendVouchers,
    stockMovements,
    language,
    isOffline,
    pendingOutbox,
    auditEvents,
    currentUser,
    isAuthenticated,
    authStep,
    tempPhone,
    failedPinAttempts,
    pinLockedUntil,
    currentPage,
    setAuthStep,
    workspaceMode,
    setWorkspaceMode,
    loginStep1,
    loginStep2,
    register,
    logout,
    updateUserPin,
    navigate,
    setLanguage,
    hasSeenOnboarding,
    completeOnboarding,
    getMyWallet,
    sendMoney,
    getMyProducts,
    addProduct,
    restockProduct,
    makeSale,
    addExpense,
    addCreditTransaction,
    addVoiceNote,
    deleteVoiceNote,
    markAlertRead,
    addStockMovement,
    createCashSend,
    collectCashSend,
    cancelCashSend,
    createCreditCustomerRecord,
    addSupplierRecord,
    createSupplierOrderRecord,
    updateSupplierOrderStatusRecord,
    upsertSupplierVerificationRecord,
    addStokvelGroupRecord,
    updateStokvelMembers,
    fileInsuranceClaim,
    recordLaybyInstallment,
    addLaybyOrderRecord,
    addTrackedPriceComparison,
    subscribeMicroInsurancePlan,
    addTrackedExpiryItem,
    publishFoodSafetyNotice,
    requestWorkingCapitalLoan,
    repayLoan,

    reloadRemoteData: refreshAfterMutation,
  };
}
