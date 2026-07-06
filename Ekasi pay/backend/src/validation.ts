import { z } from 'zod';

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

export const expenseCategorySchema = z.enum([
  'electricity',
  'paraffin',
  'supplier',
  'rent',
  'transport',
  'other',
]);

export const registerBodySchema = z.object({
  name: z.string().min(1),
  phone: saPhoneDigits,
  pin: z.string().min(4).max(12),
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
  newPin: z.string().min(4).max(12),
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

export const creditCustomerCreateSchema = z.object({
  name: z.string().min(1),
  phone: z
    .string()
    .min(9)
    .max(20)
    .transform((v) => v.replace(/\s+/g, '')),
  creditLimit: z.coerce.number().positive(),
});

export const creditTxnSchema = z.object({
  customerId: z.string().min(1),
  type: z.enum(['purchase', 'payment']),
  amount: z.coerce.number().positive(),
  description: z.string().min(1),
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
