export type ProductionFeatureFlags = {
  financialPosting: boolean;
  lending: boolean;
  /** @deprecated alias of lending */
  lendingDisbursement: boolean;
  insurance: boolean;
  stokvelMoneyMovement: boolean;
  cashSend: boolean;
  liveUtilities: boolean;
};

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; code: string; message: string };

const MONEY_POSTING_ROUTES: RegExp[] = [
  /^\/transfers$/,
  /^\/sales$/,
  /^\/expenses$/,
  /^\/credit\/transactions$/,
  /^\/cash-send$/,
  /^\/cash-send\/collect$/,
  /^\/cash-send\/[^/]+\/cancel$/,
  /^\/loans$/,
  /^\/loans\/[^/]+\/(?:disburse|repayments)$/,
  /^\/utility-purchases$/,
  /^\/stokvel\/[^/]+\/(?:loans|contributions)$/,
  /^\/stokvel\/[^/]+\/loans\/[^/]+\/repay$/,
  /^\/regulated\/stokvel\/(?:accounts|[^/]+\/(?:contributions|withdrawals))$/,
  /^\/regulated\/stokvel\/[^/]+\/withdrawals\/[^/]+\/decisions$/,
];

function mutates(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}

export function isFinancialPostingMutation(method: string, path: string): boolean {
  return mutates(method) && MONEY_POSTING_ROUTES.some((pattern) => pattern.test(path));
}

export function evaluateMutationPolicy(
  method: string,
  path: string,
  flags: ProductionFeatureFlags,
  body?: unknown,
): PolicyDecision {
  if (!mutates(method)) return { allowed: true };

  const lendingOn = flags.lending && flags.lendingDisbursement;
  if (
    !lendingOn &&
    (/^\/loans$/.test(path) ||
      /^\/loans\/[^/]+\/(?:disburse|repayments)$/.test(path) ||
      /^\/admin\/loans\/[^/]+\/disburse$/.test(path))
  ) {
    return {
      allowed: false,
      code: 'LENDING_DISABLED',
      message: 'Lending is disabled on this deployment.',
    };
  }

  const isInsuranceMutation =
    path === '/insurance' ||
    /^\/insurance\/[^/]+\/claims$/.test(path) ||
    (path.startsWith('/admin/insurance/claims/') &&
      typeof body === 'object' &&
      body !== null &&
      ['approved', 'paid', 'rejected'].includes(
        String((body as { status?: unknown }).status ?? ''),
      ));
  if (!flags.insurance && isInsuranceMutation) {
    return {
      allowed: false,
      code: 'INSURANCE_DISABLED',
      message: 'Insurance products are disabled on this deployment.',
    };
  }

  if (
    !flags.stokvelMoneyMovement &&
    (/^\/stokvel\/[^/]+\/(?:loans|contributions)$/.test(path) ||
      /^\/stokvel\/[^/]+\/loans\/[^/]+\/repay$/.test(path) ||
      /^\/regulated\/stokvel\/(?:accounts|[^/]+\/(?:contributions|withdrawals))$/.test(
        path,
      ) ||
      /^\/regulated\/stokvel\/[^/]+\/withdrawals\/[^/]+\/decisions$/.test(path))
  ) {
    return {
      allowed: false,
      code: 'STOKVEL_MONEY_MOVEMENT_DISABLED',
      message: 'Custodial stokvel money movement is disabled.',
    };
  }

  if (
    !flags.cashSend &&
    (/^\/cash-send$/.test(path) ||
      /^\/cash-send\/collect$/.test(path) ||
      /^\/cash-send\/[^/]+\/cancel$/.test(path))
  ) {
    return {
      allowed: false,
      code: 'CASH_SEND_DISABLED',
      message: 'Cash Send is disabled on this deployment.',
    };
  }

  if (!flags.liveUtilities && path === '/utility-purchases') {
    return {
      allowed: false,
      code: 'LIVE_UTILITIES_DISABLED',
      message: 'Live utility purchases are disabled.',
    };
  }

  if (
    !flags.financialPosting &&
    isFinancialPostingMutation(method, path)
  ) {
    return {
      allowed: false,
      code: 'FINANCIAL_POSTING_DISABLED',
      message:
        'New financial postings are temporarily disabled. Existing records remain available.',
    };
  }

  return { allowed: true };
}
