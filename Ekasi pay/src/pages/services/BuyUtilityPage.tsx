import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Smartphone,
  Wifi,
  Zap,
  Droplets,
  CheckCircle2,
  Copy,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  compareMoney,
  formatMoney,
  tryCanonicalMoney,
} from '../../money';

import {
  KPCard,
  KPButton,
  KPInput,
  PageTransition,
} from '../../components/shared/UIComponents';
import {
  apiBuyUtility,
  apiGetProductReadiness,
  apiGetUtilityCatalogue,
  apiGetUtilityPurchaseStatus,
  apiListUtilityPurchases,
  type UtilityCatalogueItem,
  type UtilityCategory,
  type UtilityPurchase,
  type UtilityProviderStatus,
} from '../../services/api';
import type { Wallet } from '../../types';

type CategoryDef = {
  id: UtilityCategory;
  label: string;
  hint: string;
  icon: typeof Smartphone;
  beneficiaryLabel: string;
  beneficiaryPattern: RegExp;
  providers: string[];
  presets: number[];
  /** Format the voucher / token line item shown on success. */
  receiptLabel: string;
};

const CATEGORIES: CategoryDef[] = [
  {
    id: 'airtime',
    label: 'Airtime',
    hint: 'Vodacom · MTN · Cell C · Telkom Mobile',
    icon: Smartphone,
    beneficiaryLabel: 'Cellphone number',
    beneficiaryPattern: /^0\d{9}$/,
    providers: ['Vodacom', 'MTN', 'Cell C', 'Telkom Mobile'],
    presets: [10, 20, 30, 50, 100, 200],
    receiptLabel: 'Recharge PIN',
  },
  {
    id: 'data',
    label: 'Data',
    hint: 'Bundles for any SA network',
    icon: Wifi,
    beneficiaryLabel: 'Cellphone number',
    beneficiaryPattern: /^0\d{9}$/,
    providers: ['Vodacom', 'MTN', 'Cell C', 'Telkom Mobile', 'Rain'],
    presets: [29, 49, 99, 149, 299, 499],
    receiptLabel: 'Recharge PIN',
  },
  {
    id: 'electricity',
    label: 'Electricity',
    hint: 'Prepaid Eskom / municipality token',
    icon: Zap,
    beneficiaryLabel: 'Meter number (11 digits)',
    beneficiaryPattern: /^\d{11}$/,
    providers: ['Eskom', 'City Power', 'eThekwini', 'Cape Town'],
    presets: [50, 100, 200, 300, 500],
    receiptLabel: 'STS token',
  },
  {
    id: 'water',
    label: 'Water',
    hint: 'Certified municipal prepaid water products',
    icon: Droplets,
    beneficiaryLabel: 'Meter number',
    beneficiaryPattern: /^\d{8,12}$/,
    providers: [],
    presets: [50, 100, 200, 300, 500],
    receiptLabel: 'Water token',
  },
];

const onlyDigits = (v: string) => v.replace(/\D/g, '');

export const BuyUtilityPage = ({
  wallet,
  navigate,
  onRefresh,
}: {
  wallet: Wallet;
  navigate: (page: string) => void;
  /** Reload wallet + activity after a successful purchase. */
  onRefresh?: () => Promise<void>;
}) => {
  const [activeId, setActiveId] = useState<UtilityCategory>('airtime');
  const [provider, setProvider] = useState(CATEGORIES[0].providers[0]);
  const [beneficiary, setBeneficiary] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<UtilityPurchase | null>(null);
  const [history, setHistory] = useState<UtilityPurchase[]>([]);
  const [catalogue, setCatalogue] = useState<UtilityCatalogueItem[]>([]);
  const [readinessEnabled, setReadinessEnabled] = useState(false);
  const [providerStatus, setProviderStatus] = useState<UtilityProviderStatus | null>(
    null,
  );

  const def = useMemo(
    () => CATEGORIES.find((c) => c.id === activeId) ?? CATEGORIES[0],
    [activeId],
  );

  useEffect(() => {
    const first = catalogue.find((item) => item.category === def.id);
    setProvider(first?.id ?? '');
    setBeneficiary('');
    setAmount('');
  }, [catalogue, def]);

  useEffect(() => {
    let active = true;
    apiGetUtilityPurchaseStatus()
      .then((status) => {
        if (active) setProviderStatus(status);
      })
      .catch(() => {
        if (active) {
          setProviderStatus({
            available: false,
            mode: 'disabled',
            maxAmount: '500.00',
            mocked: false,
          });
        }
      });
    apiListUtilityPurchases()
      .then((r) => {
        if (active) {
          setHistory(r.purchases);
          if (r.provider) setProviderStatus(r.provider);
        }
      })
      .catch(() => {
        /* ignore — page still works without history */
      });
    apiGetUtilityCatalogue()
      .then((result) => {
        if (active) setCatalogue(result.products);
      })
      .catch(() => {
        if (active) setCatalogue([]);
      });
    apiGetProductReadiness()
      .then((result) => {
        if (active) {
          setReadinessEnabled(
            result.products.find((item) => item.product === 'utilities')?.enabled ?? false,
          );
        }
      })
      .catch(() => {
        if (active) setReadinessEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const categoryCatalogue = catalogue.filter((item) => item.category === activeId);
  const selectedCatalogue = categoryCatalogue.find((item) => item.id === provider);
  const maxAmount = selectedCatalogue
    ? (Number(selectedCatalogue.max_cents) / 100).toFixed(2)
    : (providerStatus?.maxAmount ?? '500.00');
  const purchasesAvailable =
    Boolean(providerStatus?.available) && readinessEnabled && categoryCatalogue.length > 0;

  const submit = async () => {
    if (!purchasesAvailable) {
      toast.error('Utility purchases are not available on this deployment.');
      return;
    }
    const amt = tryCanonicalMoney(amount);
    if (amt === null || compareMoney(amt, 0) <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (compareMoney(amt, maxAmount) > 0) {
      toast.error(`Maximum purchase amount is R${formatMoney(maxAmount)}.`);
      return;
    }
    if (compareMoney(amt, wallet.balance) > 0) {
      toast.error('Insufficient wallet balance');
      return;
    }
    const benef =
      activeId === 'airtime' || activeId === 'data'
        ? onlyDigits(beneficiary)
        : beneficiary.trim();
    if (!def.beneficiaryPattern.test(benef)) {
      toast.error(`Enter a valid ${def.beneficiaryLabel.toLowerCase()}.`);
      return;
    }
    setBusy(true);
    try {
      if (!selectedCatalogue) {
        toast.error('Choose a published provider catalogue item.');
        return;
      }
      const { purchase } = await apiBuyUtility({
        catalogueVersionId: selectedCatalogue.id,
        beneficiary: benef,
        amount: amt,
      });
      setLastReceipt(purchase);
      setHistory((prev) => [purchase, ...prev]);
      setAmount('');
      setBeneficiary('');
      toast.success(`${def.label} purchased — voucher ready below.`);
      if (onRefresh) await onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Purchase failed';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  const copyVoucher = () => {
    if (!lastReceipt?.voucherCode) return;
    void navigator.clipboard
      .writeText(lastReceipt.voucherCode)
      .then(() => toast.success('Voucher copied'));
  };

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center">
          <button
            onClick={() => navigate('home')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">Buy</h2>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-nav space-y-5">
        <div className="grid grid-cols-4 gap-2">
          {CATEGORIES.map((c) => {
            const Icon = c.icon;
            const isActive = c.id === activeId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setActiveId(c.id)}
                className={`flex flex-col items-center gap-1 py-3 rounded-2xl border transition-colors ${
                  isActive
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}>
                <Icon className="w-5 h-5" />
                <span className="text-[11px] font-semibold">{c.label}</span>
              </button>
            );
          })}
        </div>

        {providerStatus && !purchasesAvailable && (
          <KPCard className="p-4 bg-slate-100 border border-slate-200">
            <p className="text-sm font-semibold text-slate-800 mb-1">
              Utilities unavailable
            </p>
            <p className="text-xs text-slate-600 leading-relaxed">
              Airtime, data, electricity, and water remain disabled until all
              readiness evidence and sandbox configuration gates are complete.
            </p>
          </KPCard>
        )}

        {providerStatus?.mocked && purchasesAvailable && (
          <KPCard className="p-4 bg-amber-50/40 border border-amber-100">
            <p className="text-[11px] font-semibold text-amber-900 mb-0.5">
              Development / pilot mode
            </p>
            <p className="text-[11px] text-amber-800/80 leading-relaxed">
              Simulator purchases are restricted to controlled sandbox use.
              Production remains blocked pending provider certification.
            </p>
          </KPCard>
        )}

        {purchasesAvailable && (
        <KPCard className="p-5 space-y-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
              Provider
            </p>
            <div className="flex flex-wrap gap-2">
              {categoryCatalogue.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setProvider(p.id)}
                  className={`text-xs font-medium px-3 py-1.5 rounded-full border ${
                    provider === p.id
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-600 border-slate-200'
                  }`}>
                  {p.provider} · {p.name}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-slate-400 mt-2">{def.hint}</p>
            {selectedCatalogue && (
              <p className="text-[11px] text-slate-500 mt-2">
                Fee: R{(Number(selectedCatalogue.fee_cents) / 100).toFixed(2)} ·{' '}
                {selectedCatalogue.finality_disclosure}
              </p>
            )}
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
              {def.beneficiaryLabel}
            </p>
            <KPInput
              value={beneficiary}
              inputMode="numeric"
              onChange={(e) =>
                setBeneficiary(
                  activeId === 'airtime' || activeId === 'data'
                    ? onlyDigits(e.target.value).slice(0, 10)
                    : onlyDigits(e.target.value).slice(0, 12),
                )
              }
              placeholder={
                activeId === 'airtime' || activeId === 'data'
                  ? '082xxxxxxx'
                  : activeId === 'electricity'
                    ? '12345678901'
                    : '12345678'
              }
            />
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
              Amount (R)
            </p>
            <div className="grid grid-cols-3 gap-2 mb-2">
              {def.presets.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setAmount(p.toString())}
                  className={`text-sm font-bold py-2 rounded-xl border ${
                    compareMoney(amount || '0.00', p) === 0
                      ? 'bg-emerald-600 text-white border-emerald-600'
                      : 'bg-white text-slate-700 border-slate-200'
                  }`}>
                  R{p}
                </button>
              ))}
            </div>
            <KPInput
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Custom amount"
            />
          </div>

          <KPButton type="button" disabled={busy} onClick={() => void submit()}>
            {busy ? 'Processing…' : `Buy ${def.label}`}
          </KPButton>
        </KPCard>
        )}

        {lastReceipt ?
          <KPCard className="p-5 bg-emerald-50/60 border border-emerald-100">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              <p className="font-semibold text-emerald-900">
                {lastReceipt.category} purchase complete
              </p>
            </div>
            <p className="text-xs text-emerald-900/80 mb-3">
              R{formatMoney(lastReceipt.amount)} to {lastReceipt.beneficiary} ·{' '}
              ref {lastReceipt.reference}
            </p>
            {lastReceipt.voucherCode ?
              <div className="bg-white border border-emerald-100 rounded-xl p-3 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    {def.receiptLabel}
                  </p>
                  <p className="font-mono font-bold text-slate-900 truncate">
                    {lastReceipt.voucherCode}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={copyVoucher}
                  className="text-emerald-700">
                  <Copy className="w-5 h-5" />
                </button>
              </div>
            : null}
          </KPCard>
        : null}

        {history.length > 0 ?
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              Recent purchases
            </p>
            {history.slice(0, 6).map((p) => (
              <KPCard key={p.id} className="p-3 flex items-center justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900 truncate">
                    {p.category} · {p.provider}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {p.beneficiary} · {new Date(p.createdAt).toLocaleString('en-ZA')}
                  </p>
                </div>
                <p className="text-sm font-bold text-slate-900">
                  R{formatMoney(p.amount)}
                </p>
              </KPCard>
            ))}
          </div>
        : null}
      </div>
    </PageTransition>
  );
};
