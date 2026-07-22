import { formatCents, parseIntegerCents } from './money.js';

export function toSupplier(row: {
  id: string;
  name: string;
  phone: string;
  category: string;
  delivery_days_json: string;
}) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    category: row.category,
    deliveryDays: JSON.parse(row.delivery_days_json) as string[],
  };
}

export function toSupplierOrder(row: {
  id: string;
  merchant_id: string;
  supplier_id: string;
  items_json: string;
  total: number;
  total_cents?: string;
  status: string;
  order_date: string;
  expected_delivery: string | null;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    supplierId: row.supplier_id,
    items: JSON.parse(row.items_json) as {
      name: string;
      quantity: number;
      unitCost: number;
    }[],
    total:
      row.total_cents === undefined
        ? row.total
        : formatCents(
            parseIntegerCents(row.total_cents, { allowZero: true }),
          ),
    status: row.status,
    orderDate: row.order_date,
    ...(row.expected_delivery ? { expectedDelivery: row.expected_delivery } : {}),
  };
}

export function toSupplierVerification(row: {
  supplier_id: string;
  cipc_registered: number;
  health_dept_approved: number;
  last_inspection_date: string;
  certificate_expiry: string;
  verification_status: string;
  risk_level: string;
}) {
  return {
    supplierId: row.supplier_id,
    cipcRegistered: Boolean(row.cipc_registered),
    healthDeptApproved: Boolean(row.health_dept_approved),
    lastInspectionDate: row.last_inspection_date,
    certificateExpiry: row.certificate_expiry,
    verificationStatus: row.verification_status,
    riskLevel: row.risk_level,
  };
}

export function toStokvel(row: {
  id: string;
  merchant_id: string;
  name: string;
  members_json: string;
  target_amount: number;
  current_amount: number;
  target_amount_cents?: string;
  current_amount_cents?: string;
  frequency: string;
  next_payout_date: string;
  created_at: string;
}) {
  return {
    id: row.id,
    name: row.name,
    members: JSON.parse(row.members_json) as {
      name: string;
      phone: string;
      contributed: number;
    }[],
    targetAmount:
      row.target_amount_cents === undefined
        ? row.target_amount
        : formatCents(parseIntegerCents(row.target_amount_cents)),
    currentAmount:
      row.current_amount_cents === undefined
        ? row.current_amount
        : formatCents(
            parseIntegerCents(row.current_amount_cents, { allowZero: true }),
          ),
    frequency: row.frequency,
    nextPayoutDate: row.next_payout_date,
    createdAt: row.created_at,
  };
}

export function toStokvelLoan(row: {
  id: string;
  stokvel_id: string;
  lender_name: string;
  lender_phone: string;
  borrower_name: string;
  borrower_phone: string;
  amount: number;
  interest_rate_percent: number;
  interest_amount: number;
  total_due: number;
  amount_cents?: string;
  interest_amount_cents?: string;
  total_due_cents?: string;
  from_pool: boolean | number;
  status: string;
  notes: string | null;
  created_at: string;
  repaid_at: string | null;
}) {
  return {
    id: row.id,
    stokvelId: row.stokvel_id,
    lenderName: row.lender_name,
    lenderPhone: row.lender_phone,
    borrowerName: row.borrower_name,
    borrowerPhone: row.borrower_phone,
    amount:
      row.amount_cents === undefined
        ? Number(row.amount)
        : formatCents(parseIntegerCents(row.amount_cents)),
    interestRatePercent: Number(row.interest_rate_percent),
    interestAmount:
      row.interest_amount_cents === undefined
        ? Number(row.interest_amount)
        : formatCents(
            parseIntegerCents(row.interest_amount_cents, { allowZero: true }),
          ),
    totalDue:
      row.total_due_cents === undefined
        ? Number(row.total_due)
        : formatCents(parseIntegerCents(row.total_due_cents)),
    fromPool: Boolean(row.from_pool),
    status: row.status as 'active' | 'repaid',
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    repaidAt: row.repaid_at ?? undefined,
  };
}

/** Interest for every R100 loaned at the chosen percent (e.g. 10% → R10 per R100). */
export function calcStokvelLoanInterest(
  principal: number,
  ratePercent: number,
): { interestAmount: number; totalDue: number } {
  const interestAmount = Number(((principal / 100) * ratePercent).toFixed(2));
  return {
    interestAmount,
    totalDue: Number((principal + interestAmount).toFixed(2)),
  };
}

export function toStokvelContribution(row: {
  id: string;
  stokvel_id: string;
  member_name: string;
  member_phone: string;
  amount: number;
  amount_cents?: string;
  period_month: string;
  notes: string | null;
  created_at: string;
}) {
  return {
    id: row.id,
    stokvelId: row.stokvel_id,
    memberName: row.member_name,
    memberPhone: row.member_phone,
    amount:
      row.amount_cents === undefined
        ? Number(row.amount)
        : formatCents(parseIntegerCents(row.amount_cents)),
    periodMonth: row.period_month,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
  };
}

export function toLayby(row: {
  id: string;
  merchant_id: string;
  customer_name: string;
  customer_phone: string;
  item_name: string;
  total_price?: number;
  amount_paid?: number;
  total_price_cents?: string;
  amount_paid_cents?: string;
  installments_json: string;
  status: string;
  created_at: string;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    itemName: row.item_name,
    totalPrice:
      row.total_price_cents === undefined
        ? row.total_price
        : formatCents(parseIntegerCents(row.total_price_cents)),
    amountPaid:
      row.amount_paid_cents === undefined
        ? row.amount_paid
        : formatCents(
            parseIntegerCents(row.amount_paid_cents, { allowZero: true }),
          ),
    installments: JSON.parse(row.installments_json) as {
      amount: string | number;
      date: string;
    }[],
    status: row.status,
    createdAt: row.created_at,
  };
}

export function toLoadShedding(row: {
  id: string;
  stage: number;
  start_time: string;
  end_time: string;
  area: string;
}) {
  return {
    id: row.id,
    stage: row.stage,
    startTime: row.start_time,
    endTime: row.end_time,
    area: row.area,
  };
}

export function toLoan(row: {
  id: string;
  user_id: string;
  amount?: number;
  amount_cents?: string;
  interest_rate: number | string;
  status: string;
  disbursed_at: string | null;
  due_date: string | null;
  repaid_amount?: number;
  repaid_amount_cents?: string;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    amount:
      row.amount_cents === undefined
        ? row.amount
        : formatCents(parseIntegerCents(row.amount_cents)),
    interestRate: row.interest_rate,
    status: row.status,
    ...(row.disbursed_at ? { disbursedAt: row.disbursed_at } : {}),
    ...(row.due_date ? { dueDate: row.due_date } : {}),
    repaidAmount:
      row.repaid_amount_cents === undefined
        ? row.repaid_amount
        : formatCents(
            parseIntegerCents(row.repaid_amount_cents, { allowZero: true }),
          ),
  };
}

export function toComplianceFlag(row: {
  id: string;
  user_id: string;
  transaction_id: string | null;
  reason: string;
  severity: string;
  status: string;
  created_at: string;
}) {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.transaction_id ? { transactionId: row.transaction_id } : {}),
    reason: row.reason,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
  };
}

export function toPriceComparison(row: {
  id: string;
  merchant_id: string;
  product_name: string;
  my_price: number;
  avg_area_price: number;
  lowest_area_price: number;
  highest_area_price: number;
  my_price_cents?: string;
  avg_area_price_cents?: string;
  lowest_area_price_cents?: string;
  highest_area_price_cents?: string;
  competitors: number;
  last_updated: string;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    productName: row.product_name,
    myPrice:
      row.my_price_cents === undefined
        ? row.my_price
        : formatCents(parseIntegerCents(row.my_price_cents, { allowZero: true })),
    avgAreaPrice:
      row.avg_area_price_cents === undefined
        ? row.avg_area_price
        : formatCents(
            parseIntegerCents(row.avg_area_price_cents, { allowZero: true }),
          ),
    lowestAreaPrice:
      row.lowest_area_price_cents === undefined
        ? row.lowest_area_price
        : formatCents(
            parseIntegerCents(row.lowest_area_price_cents, { allowZero: true }),
          ),
    highestAreaPrice:
      row.highest_area_price_cents === undefined
        ? row.highest_area_price
        : formatCents(
            parseIntegerCents(row.highest_area_price_cents, {
              allowZero: true,
            }),
          ),
    competitors: row.competitors,
    lastUpdated: row.last_updated,
  };
}

export function toInsurance(row: {
  id: string;
  merchant_id: string;
  provider: string;
  type: string;
  coverage_amount: number;
  monthly_premium: number;
  coverage_amount_cents?: string;
  monthly_premium_cents?: string;
  status: string;
  next_payment_date: string;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    provider: row.provider,
    type: row.type as 'stock' | 'fire' | 'theft',
    coverageAmount:
      row.coverage_amount_cents === undefined
        ? row.coverage_amount
        : formatCents(parseIntegerCents(row.coverage_amount_cents)),
    monthlyPremium:
      row.monthly_premium_cents === undefined
        ? row.monthly_premium
        : formatCents(parseIntegerCents(row.monthly_premium_cents)),
    status: row.status as 'active' | 'pending' | 'cancelled',
    nextPaymentDate: row.next_payment_date,
  };
}

export function toVoiceNote(row: {
  id: string;
  merchant_id: string;
  title: string;
  transcript: string;
  duration: number;
  category: string;
  created_at: string;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    title: row.title,
    transcript: row.transcript,
    duration: row.duration,
    createdAt: row.created_at,
    category: row.category as 'reminder' | 'debt' | 'order' | 'general',
  };
}

export function toExpiryItem(row: {
  id: string;
  merchant_id: string;
  product_name: string;
  category: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  supplier_id: string;
  status: string;
}) {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    productName: row.product_name,
    category: row.category,
    batchNumber: row.batch_number,
    expiryDate: row.expiry_date,
    quantity: row.quantity,
    supplierId: row.supplier_id,
    status: row.status as 'safe' | 'expiring-soon' | 'expired',
  };
}

export function toFoodSafetyAlert(row: {
  id: string;
  merchant_id: string | null;
  type: string;
  title: string;
  description: string;
  severity: string;
  created_at: string;
  is_read: number;
}) {
  return {
    id: row.id,
    type: row.type as 'recall' | 'expiry' | 'supplier' | 'inspection',
    title: row.title,
    description: row.description,
    severity: row.severity as 'critical' | 'warning' | 'info',
    createdAt: row.created_at,
    isRead: Boolean(row.is_read),
    ...(row.merchant_id ? {} : {}),
  };
}

export function toCashSendVoucher(
  row: {
    id: string;
    sender_phone: string;
    sender_name: string | null;
    sender_first_name?: string;
    sender_last_name?: string;
    recipient_phone: string;
    recipient_name: string | null;
    recipient_first_name?: string;
    recipient_last_name?: string;
    recipient_id_document?: string;
    amount?: number;
    fee?: number;
    amount_cents?: string;
    fee_cents?: string;
    reference_number: string;
    status: string;
    created_at: string;
    expires_at: string;
    collected_at: string | null;
    cancel_reason: string | null;
    collected_with_id_verified?: number;
  },
  atmPinReveal?: string
) {
  const ridDigits = (row.recipient_id_document ?? '').replace(/\D/g, '');
  const recipientIdLast4 =
    ridDigits.length >= 4 ? ridDigits.slice(-4) : undefined;
  return {
    id: row.id,
    senderPhone: row.sender_phone,
    ...(row.sender_name ? { senderName: row.sender_name } : {}),
    ...(row.sender_first_name ? { senderFirstName: row.sender_first_name } : {}),
    ...(row.sender_last_name ? { senderLastName: row.sender_last_name } : {}),
    recipientPhone: row.recipient_phone,
    ...(row.recipient_name ? { recipientName: row.recipient_name } : {}),
    ...(row.recipient_first_name ?
      { recipientFirstName: row.recipient_first_name }
    : {}),
    ...(row.recipient_last_name ?
      { recipientLastName: row.recipient_last_name }
    : {}),
    ...(recipientIdLast4 ? { recipientIdLast4 } : {}),
    amount:
      row.amount_cents === undefined
        ? row.amount
        : formatCents(parseIntegerCents(row.amount_cents)),
    fee:
      row.fee_cents === undefined
        ? row.fee
        : formatCents(
            parseIntegerCents(row.fee_cents, { allowZero: true }),
          ),
    atmPin: atmPinReveal ?? '****',
    referenceNumber: row.reference_number,
    status: row.status as
      | 'active'
      | 'collected'
      | 'expired'
      | 'cancelled',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.collected_at ? { collectedAt: row.collected_at } : {}),
    ...(row.cancel_reason ? { cancelReason: row.cancel_reason } : {}),
    ...(row.collected_with_id_verified === 1 ?
      { collectIdMatchedOnFile: true }
    : {}),
  };
}

export function toStockMovement(row: {
  id: string;
  merchant_id: string;
  product_id: string;
  product_name: string;
  type: string;
  quantity: number;
  reason: string;
  cost_price_at_time: number | null;
  cost_price_at_time_cents?: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
}) {
  type SMReason =
    | 'sale'
    | 'restock'
    | 'damage'
    | 'expired'
    | 'theft'
    | 'manual'
    | 'initial';
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    type: row.type as 'in' | 'out' | 'adjustment',
    quantity: row.quantity,
    reason: row.reason as SMReason,
    ...(row.cost_price_at_time_cents != null
      ? {
          costPriceAtTime: formatCents(
            parseIntegerCents(row.cost_price_at_time_cents, {
              allowZero: true,
            }),
          ),
        }
      : row.cost_price_at_time != null
        ? { costPriceAtTime: row.cost_price_at_time }
        : {}),
    ...(row.reference ? { reference: row.reference } : {}),
    createdAt: row.created_at,
    ...(row.notes ? { notes: row.notes } : {}),
  };
}
