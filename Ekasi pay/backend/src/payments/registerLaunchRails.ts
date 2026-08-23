import { PaymentRailRegistry } from './paymentRailRegistry.js';
import { bankDepositRail } from './rails/bankDepositRail.js';
import { bankPayoutRail } from './rails/bankPayoutRail.js';
import { cashRail } from './rails/cashRail.js';
import { cashSendRail } from './rails/cashSendRail.js';
import { internalWalletRail } from './rails/internalWalletRail.js';

let registered = false;

export function registerLaunchPaymentRails(): void {
  if (registered) return;
  PaymentRailRegistry.register(internalWalletRail);
  PaymentRailRegistry.register(cashRail);
  PaymentRailRegistry.register(bankDepositRail);
  PaymentRailRegistry.register(bankPayoutRail);
  PaymentRailRegistry.register(cashSendRail);
  registered = true;
}
