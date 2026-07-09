import { z } from 'zod';

import { saIdBody } from './cashSendSchemas.js';

export const roleSchema = z.enum(['customer', 'merchant', 'agent']);

/** Normalise to digits only (spaces, +, dashes allowed in input). */
const saPhoneDigits = z
  .string()
  .transform((v) => v.replace(/\D/g, ''))
  .pipe(z.string().min(9).max(20));

/**
 * Reject obviously weak PINs (all same digit, ascending/descending sequence).
 * Used as a Zod refinement on PIN fields for high-value flows (cash send,
 * cash collect). Login/register still allow legacy PINs so existing accounts
 * keep working — strength is enforced at PIN-set time and on new flows.
 */
export function isWeakPin(pin: string): boolean {
  const digits = pin.replace(/\D/g, '');
  if (digits.length < 4) return true;
  if (/^(\d)\1+$/.test(digits)) return true;
  let asc = true;
  let desc = true;
  for (let i = 1; i < digits.length; i++) {
    const d = digits.charCodeAt(i) - digits.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

/** Zod schema for a strong PIN suitable for moving money. 5–8 digits, no trivial patterns. */
export const strongMoneyPin = z
  .string()
  .regex(/^\d+$/, 'PIN must be digits only')
  .min(5, 'PIN must be at least 5 digits')
  .max(8, 'PIN must be at most 8 digits')
  .refine((v) => !isWeakPin(v), {
    message:
      'PIN is too easy to guess (avoid 0000, 1234, repeated or sequential digits).',
  });

/** 4-digit voucher PIN the beneficiary uses at collection (Cash Send create/collect). */
export const cashSendVoucherPin = z
  .string()
  .regex(/^\d{4}$/, 'Voucher PIN must be exactly 4 digits')
  .refine((v) => !isWeakPin(v), {
    message:
      'PIN is too easy to guess (avoid 1234, 0000, repeated or sequential digits).',
  });

export const expenseCategorySchema = z.enum([
  'electricity',
  'paraffin',
  'supplier',
  'rent',
  'transport',
  'other',
]);

/** Account PIN for login/register/change — rejects trivial patterns. */
export const accountPin = z
  .string()
  .regex(/^\d+$/, 'PIN must be digits only')
  .min(4, 'PIN must be at least 4 digits')
  .max(12, 'PIN must be at most 12 digits')
  .refine((v) => !isWeakPin(v), {
    message:
      'PIN is too easy to guess (avoid 0000, 1234, repeated or sequential digits).',
  });

export const registerBodySchema = z.object({
  name: z.string().min(1),
  phone: saPhoneDigits,
  pin: accountPin,
  role: roleSchema.default('merchant'),
  /** ISO 3166-1 alpha-2; pool id mirrors country for ledger isolation. Defaults to ZA. */
  countryCode: z
    .string()
    .length(2)
    .transform((v) => v.toUpperCase())
    .optional(),
  /** Optional — defaults are applied for merchants server-side when omitted. */
  businessName: z.string().optional(),
  location: z.string().optional(),
  category: z.string().optional(),
});

export const updatePinBodySchema = z.object({
  currentPin: z.string().min(4).max(12),
  newPin: accountPin,
});

export const loginBodySchema = z.object({
  phone: saPhoneDigits,
  pin: z.string().min(4).max(12),
});

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(20).max(4096),
});

export const transferBodySchema = z.object({
  toPhone: z
    .string()
    .min(9)
    .max(20)
    .transform((v) => v.replace(/\s+/g, '')),
  amount: z.coerce.number().positive(),
  description: z.string().min(1).max(500),
});

export const productCreateSchema = z.object({
  name: z.string().min(1),
  costPrice: z.coerce.number().nonnegative(),
  price: z.coerce.number().nonnegative(),
  stock: z.coerce.number().int().nonnegative(),
  category: z.string().min(1),
  barcode: z.string().optional(),
});

export const productUpdateSchema = productCreateSchema.partial();

export const saleItemSchema = z.object({
  productId: z.string().min(1),
  quantity: z.coerce.number().int().positive(),
  price: z.coerce.number().nonnegative(),
});

export const saleCreateSchema = z.object({
  items: z.array(saleItemSchema).min(1),
  paymentMethod: z.enum(['cash', 'wallet']),
  customerPhone: z
    .string()
    .min(9)
    .max(20)
    .transform((v) => v.replace(/\s+/g, ''))
    .optional(),
});

export const expenseCreateSchema = z.object({
  category: expenseCategorySchema,
  description: z.string().min(1),
  amount: z.coerce.number().positive(),
});

export const stockIntakeLineSchema = z.object({
  productId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  quantity: z.coerce.number().int().positive(),
  costPrice: z.coerce.number().nonnegative(),
  sellingPrice: z.coerce.number().positive().optional(),
  category: z.string().min(1).optional(),
  barcode: z.string().optional(),
});

export const stockIntakeBodySchema = z
  .object({
    supplierName: z.string().max(120).optional(),
    slipReference: z.string().max(80).optional(),
    slipTotal: z.coerce.number().positive().optional(),
    notes: z.string().max(500).optional(),
    recordExpense: z.boolean().optional().default(true),
    lines: z.array(stockIntakeLineSchema).min(1).max(50),
  })
  .superRefine((data, ctx) => {
    for (let i = 0; i < data.lines.length; i++) {
      const line = data.lines[i];
      if (!line.productId && !line.name) {
        ctx.addIssue({
          code: 'custom',
          message: 'Each line needs productId or name',
          path: ['lines', i],
        });
      }
      if (!line.productId && (!line.sellingPrice || !line.category)) {
        ctx.addIssue({
          code: 'custom',
          message: 'New products need sellingPrice and category',
          path: ['lines', i],
        });
      }
    }
    const computed = data.lines.reduce(
      (s, l) => s + l.quantity * l.costPrice,
      0,
    );
    if (
      data.slipTotal !== undefined &&
      Math.abs(data.slipTotal - computed) > 0.05
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Slip total R${data.slipTotal.toFixed(2)} does not match line items R${computed.toFixed(2)}`,
        path: ['slipTotal'],
      });
    }
  });

export const creditVerifyRequestSchema = z.object({
  phone: saPhoneDigits,
  purpose: z.enum(['onboard', 'purchase']),
  customerId: z.string().min(1).optional(),
});

export const creditVerifyConfirmSchema = z.object({
  phone: saPhoneDigits,
  purpose: z.enum(['onboard', 'purchase']),
  customerId: z.string().min(1).optional(),
  code: z
    .string()
    .regex(/^\d{6}$/u, 'Code must be 6 digits')
    .transform((v) => v.trim()),
  saIdDocument: saIdBody,
});

export const creditCustomerCreateSchema = z.object({
  name: z.string().min(1),
  phone: saPhoneDigits,
  creditLimit: z.coerce.number().positive(),
  saIdDocument: saIdBody,
  verificationToken: z.string().uuid(),
});

export const creditTxnSchema = z
  .object({
    customerId: z.string().min(1),
    type: z.enum(['purchase', 'payment']),
    amount: z.coerce.number().positive(),
    description: z.string().min(1),
    verificationToken: z.string().uuid().optional(),
    saIdDocument: saIdBody.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.type === 'purchase' && !data.verificationToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'OTP verification is required before granting credit',
        path: ['verificationToken'],
      });
    }
  });

export const adminRoleSchema = z.enum(['customer', 'merchant', 'agent', 'admin']);

export const adminUserPatchBodySchema = z
  .object({
    role: adminRoleSchema.optional(),
    suspended: z.boolean().optional(),
  })
  .refine((data) => data.role !== undefined || data.suspended !== undefined, {
    message: 'Provide role and/or suspended',
  });

export const adminClaimPatchBodySchema = z.object({
  status: z.enum(['approved', 'rejected', 'paid']),
  adminNote: z.string().max(2000).optional(),
});

export const adminClaimListQuerySchema = z.object({
  status: z
    .enum(['submitted', 'approved', 'rejected', 'paid'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
