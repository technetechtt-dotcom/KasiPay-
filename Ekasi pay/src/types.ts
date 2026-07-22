import type { Money } from './money';

export type Role = 'customer' | 'merchant' | 'agent' | 'admin';
export type AccountTier = 'Basic' | 'Standard' | 'Premium';
export type KYCStatus = 'pending' | 'verified' | 'rejected';
export type TransactionType =
  | 'transfer'
  | 'deposit'
  | 'withdrawal'
  | 'payment'
  | 'cash_send_hold'
  | 'cash_send_collect'
  | 'cash_send_cancel_refund'
  | 'cash_send_expire_refund';
export type TransactionStatus = 'pending' | 'completed' | 'failed';
export type EntryType = 'debit' | 'credit';

export interface User {
  id: string;
  name: string;
  phone: string;
  /** Present only immediately after register before server round-trip; omit for API-backed sessions. */
  pin?: string;
  role: Role;
  kycStatus: KYCStatus;
  accountTier: AccountTier;
  /** ISO 3166-1 alpha-2; aligns with ledger pool (default ZA). */
  countryCode: string;
  createdAt: string;
  /** Set when an admin has suspended the account. */
  suspendedAt?: string | null;
}

export interface Wallet {
  id: string;
  userId: string;
  balance: Money;
  currency: string;
  status: 'active' | 'frozen';
  /** Regional ledger pool (same as country for now). */
  poolId: string;
  walletKind: 'user' | 'system_escrow';
}

export interface Transaction {
  id: string;
  fromWalletId: string | null;
  toWalletId: string | null;
  amount: Money;
  type: TransactionType;
  status: TransactionStatus;
  reference: string;
  description: string;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  transactionId: string;
  accountId: string;
  entryType: EntryType;
  amount: Money;
  balanceAfter: Money;
  createdAt: string;
}

export interface Merchant {
  id: string;
  userId: string;
  businessName: string;
  location: string;
  category: string;
  /** Compliance onboarding: docs → admin review → approved. */
  approvalStatus?: MerchantApprovalStatus;
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  docsSubmittedAt?: string | null;
}

export type MerchantApprovalStatus =
  | 'pending_docs'
  | 'pending_approval'
  | 'approved'
  | 'rejected';

export type MerchantDocType =
  | 'cipc_14_3'
  | 'beee_certificate'
  | 'municipal_business_reg'
  | 'proof_of_bank';

export interface MerchantDocumentStatus {
  docType: MerchantDocType;
  uploaded: boolean;
  fileName?: string;
  contentType?: string;
  sizeBytes?: number;
  uploadedAt?: string;
}

export interface Product {
  id: string;
  merchantId: string;
  name: string;
  costPrice: Money;
  price: Money;
  stock: number;
  category: string;
  barcode?: string;
}

export interface SaleItem {
  productId: string;
  name: string;
  quantity: number;
  price: Money;
  subtotal: Money;
  costPrice?: Money;
}

export interface Sale {
  id: string;
  merchantId: string;
  items: SaleItem[];
  total: Money;
  paymentMethod: 'cash' | 'wallet';
  createdAt: string;
}

export interface Loan {
  id: string;
  userId: string;
  amount: Money;
  interestRate: number;
  status: 'pending' | 'approved' | 'rejected' | 'disbursed' | 'repaid';
  disbursedAt?: string;
  dueDate?: string;
  repaidAmount: Money;
}

export interface ComplianceFlag {
  id: string;
  userId: string;
  transactionId?: string;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  /**
   * Lifecycle of a compliance flag. `pending` / `reviewed` are legacy values
   * carried over from earlier UI states; the backend currently issues `open`
   * and transitions to `resolved` or `dismissed` via PATCH.
   */
  status: 'pending' | 'reviewed' | 'open' | 'resolved' | 'dismissed';
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  type: 'info' | 'success' | 'warning' | 'error';
  message: string;
  read: boolean;
  createdAt: string;
}

export type ExpenseCategory =
'electricity' |
'paraffin' |
'supplier' |
'rent' |
'transport' |
'other';

export interface Expense {
  id: string;
  merchantId: string;
  category: ExpenseCategory;
  description: string;
  amount: Money;
  createdAt: string;
}

export type Language = 'en' | 'zu' | 'xh';

// Credit Book
export interface CreditCustomer {
  id: string;
  merchantId: string;
  name: string;
  phone: string;
  totalOwed: Money;
  creditLimit: Money;
  lastPaymentDate?: string;
  createdAt: string;
  idVerified?: boolean;
}

export interface CreditTransaction {
  id: string;
  customerId: string;
  type: 'purchase' | 'payment';
  amount: Money;
  description: string;
  createdAt: string;
}

// Supplier Orders
export interface Supplier {
  id: string;
  name: string;
  phone: string;
  category: string;
  deliveryDays: string[];
}

export interface SupplierOrder {
  id: string;
  merchantId: string;
  supplierId: string;
  items: {name: string;quantity: number;unitCost: Money;}[];
  total: Money;
  status: 'pending' | 'confirmed' | 'delivered';
  orderDate: string;
  expectedDelivery?: string;
}

// Stokvel / Savings Group
export interface StokvelLoan {
  id: string;
  stokvelId: string;
  lenderName: string;
  lenderPhone: string;
  borrowerName: string;
  borrowerPhone: string;
  amount: Money;
  /** Percent charged on every R100 (10 → R10 interest per R100). */
  interestRatePercent: number;
  interestAmount: Money;
  totalDue: Money;
  fromPool: boolean;
  status: 'active' | 'repaid';
  notes?: string;
  createdAt: string;
  repaidAt?: string;
}

export interface StokvelContribution {
  id: string;
  stokvelId: string;
  memberName: string;
  memberPhone: string;
  amount: Money;
  /** YYYY-MM */
  periodMonth: string;
  notes?: string;
  createdAt: string;
}

export interface StokvelGroup {
  id: string;
  name: string;
  members: {name: string;phone: string;contributed: Money;}[];
  targetAmount: Money;
  currentAmount: Money;
  frequency: 'weekly' | 'monthly';
  nextPayoutDate: string;
  createdAt: string;
  loans?: StokvelLoan[];
  contributions?: StokvelContribution[];
}

// Layby
export interface LaybyOrder {
  id: string;
  merchantId: string;
  customerName: string;
  customerPhone: string;
  itemName: string;
  totalPrice: Money;
  amountPaid: Money;
  installments: {amount: Money;date: string;}[];
  status: 'active' | 'completed' | 'cancelled';
  createdAt: string;
}

// Load Shedding
export interface LoadSheddingSlot {
  /** Present when loaded from the API (used for keys). */
  id?: string;
  stage: number;
  startTime: string;
  endTime: string;
  area: string;
}

// Price Comparison
export interface PriceComparison {
  id: string;
  productName: string;
  myPrice: Money;
  avgAreaPrice: Money;
  lowestAreaPrice: Money;
  highestAreaPrice: Money;
  competitors: number;
  lastUpdated: string;
}

// Micro-Insurance
export interface InsurancePolicy {
  id: string;
  merchantId: string;
  provider: string;
  type: 'stock' | 'fire' | 'theft';
  coverageAmount: Money;
  monthlyPremium: Money;
  status: 'active' | 'pending' | 'cancelled';
  nextPaymentDate: string;
}

// Voice Notes
export interface VoiceNote {
  id: string;
  merchantId: string;
  title: string;
  transcript: string;
  duration: number;
  createdAt: string;
  category: 'reminder' | 'debt' | 'order' | 'general';
}

// Food Safety & Compliance
export interface SupplierVerification {
  supplierId: string;
  cipcRegistered: boolean;
  healthDeptApproved: boolean;
  lastInspectionDate: string;
  certificateExpiry: string;
  verificationStatus: 'verified' | 'pending' | 'unverified' | 'flagged';
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ExpiryItem {
  id: string;
  productName: string;
  category: string;
  batchNumber: string;
  expiryDate: string;
  quantity: number;
  supplierId: string;
  status: 'safe' | 'expiring-soon' | 'expired';
}

export interface FoodSafetyAlert {
  id: string;
  type: 'recall' | 'expiry' | 'supplier' | 'inspection';
  title: string;
  description: string;
  severity: 'critical' | 'warning' | 'info';
  createdAt: string;
  isRead: boolean;
}

// Cash Send
export interface CashSendVoucher {
  id: string;
  senderPhone: string;
  senderName?: string;
  senderFirstName?: string;
  senderLastName?: string;
  recipientPhone: string;
  recipientName?: string;
  recipientFirstName?: string;
  recipientLastName?: string;
  /** Last 4 digits of beneficiary SA ID (sender view only; full number never returned). */
  recipientIdLast4?: string;
  /** Payout used a beneficiary ID that matched what was captured at send time. */
  collectIdMatchedOnFile?: boolean;
  amount: Money;
  fee: Money;
  atmPin: string;
  referenceNumber: string;
  status: 'active' | 'collected' | 'expired' | 'cancelled';
  createdAt: string;
  expiresAt: string;
  collectedAt?: string;
  cancelReason?: string;
}

// Stock Movement
export interface StockMovement {
  id: string;
  productId: string;
  productName: string;
  type: 'in' | 'out' | 'adjustment';
  quantity: number;
  reason:
  'sale' |
  'restock' |
  'damage' |
  'expired' |
  'theft' |
  'manual' |
  'initial';
  costPriceAtTime?: Money;
  reference?: string;
  createdAt: string;
  notes?: string;
}

export interface PurchaseSlipLine {
  productId: string;
  name: string;
  quantity: number;
  costPrice: Money;
  lineTotal: Money;
}

export interface PurchaseSlip {
  id: string;
  merchantId: string;
  supplierName?: string;
  slipReference?: string;
  total: Money;
  lineItems: PurchaseSlipLine[];
  notes?: string;
  expenseId?: string;
  createdAt: string;
}