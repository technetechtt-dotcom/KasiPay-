import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Banknote, Wallet } from 'lucide-react';

import {
  KPButton,
  KPCard,
  PageTransition,
} from '../../components/shared/UIComponents';
import {
  apiAdjustCashAvailability,
  apiDeclareCashAvailability,
  apiGetCashAvailability,
  apiGetMerchantFloat,
  apiGetMerchantFloatHistory,
  apiRequestMerchantFloatTopup,
  apiRequestMerchantFloatWithdrawal,
  apiSearchPayoutShops,
} from '../../services/api';

const BANDS = [
  { id: 'unavailable', label: 'Unavailable' },
  { id: 'under_500', label: 'Under R500' },
  { id: '500_to_1000', label: 'R500–R1,000' },
  { id: '1000_to_2000', label: 'R1,000–R2,000' },
  { id: '2000_to_5000', label: 'R2,000–R5,000' },
  { id: 'over_5000', label: 'Over R5,000' },
] as const;

export const FloatCashPage = ({
  navigate,
}: {
  navigate: (p: string) => void;
}) => {
  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState('0.00');
  const [alerts, setAlerts] = useState<Array<{ code: string; message: string }>>([]);
  const [pending, setPending] = useState<Array<Record<string, unknown>>>([]);
  const [cleared, setCleared] = useState<Array<Record<string, unknown>>>([]);
  const [rejected, setRejected] = useState<Array<Record<string, unknown>>>([]);
  const [withdrawals, setWithdrawals] = useState<Array<Record<string, unknown>>>([]);
  const [cashBand, setCashBand] = useState('unavailable');
  const [cashCents, setCashCents] = useState('0');
  const [stale, setStale] = useState(false);
  const [topupAmount, setTopupAmount] = useState('500.00');
  const [withdrawAmount, setWithdrawAmount] = useState('100.00');
  const [adjustCents, setAdjustCents] = useState('');
  const [adjustReason, setAdjustReason] = useState('');
  const [shops, setShops] = useState<Array<{ businessName: string; location: string; stale: boolean }>>([]);

  const reload = async () => {
    const [float, history, cash] = await Promise.all([
      apiGetMerchantFloat(),
      apiGetMerchantFloatHistory(),
      apiGetCashAvailability(),
    ]);
    setBalance(float.balance);
    setAlerts(history.alerts ?? []);
    setPending(history.pendingTopups ?? []);
    setCleared(history.clearedTopups ?? []);
    setRejected(history.rejectedTopups ?? []);
    setWithdrawals(history.withdrawals ?? []);
    setCashBand(cash.availabilityBand);
    setCashCents((Number(cash.availableCents) / 100).toFixed(2));
    setStale(cash.stale);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await reload();
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Could not load float');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-12 pb-28">
        <button
          type="button"
          className="flex items-center gap-2 text-slate-500 mb-6"
          onClick={() => navigate('more')}>
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2 className="text-xl font-bold text-slate-900 mb-2">Float &amp; cash</h2>
        <p className="text-sm text-slate-500 mb-6">
          Electronic float is credited only after a settled client-funds bank deposit.
          Physical cash bands are a hint — cents on the server are authoritative.
        </p>
        {loading ? <p className="text-sm text-slate-500">Loading…</p> : null}
        <KPCard className="mb-4 p-4">
          <div className="flex items-center gap-3 mb-2">
            <Wallet className="w-5 h-5 text-emerald-600" />
            <h3 className="font-semibold">Merchant float</h3>
          </div>
          <p className="text-2xl font-bold text-slate-900">R{balance}</p>
          {alerts.map((alert) => (
            <p key={alert.code} className="text-sm text-amber-700 mt-2">{alert.message}</p>
          ))}
        </KPCard>
        <KPCard className="mb-4 p-4 space-y-3">
          <h3 className="font-semibold">Top-up / withdrawal</h3>
          <input
            className="w-full border rounded-lg p-2"
            value={topupAmount}
            onChange={(e) => setTopupAmount(e.target.value)}
            aria-label="Top-up amount"
          />
          <KPButton
            type="button"
            onClick={async () => {
              try {
                const result = await apiRequestMerchantFloatTopup(topupAmount);
                toast.success(`Reference ${result.merchantReference}`);
                await reload();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Top-up failed');
              }
            }}>
            Request top-up
          </KPButton>
          <input
            className="w-full border rounded-lg p-2"
            value={withdrawAmount}
            onChange={(e) => setWithdrawAmount(e.target.value)}
            aria-label="Withdrawal amount"
          />
          <KPButton
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await apiRequestMerchantFloatWithdrawal(withdrawAmount);
                toast.success('Withdrawal requested (external payout still blocked)');
                await reload();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Withdrawal failed');
              }
            }}>
            Request withdrawal
          </KPButton>
        </KPCard>
        <KPCard className="mb-4 p-4">
          <div className="flex items-center gap-3 mb-3">
            <Banknote className="w-5 h-5 text-amber-600" />
            <h3 className="font-semibold">Payout cash on hand</h3>
          </div>
          {stale ? (
            <p className="text-sm text-red-600 mb-2">
              Cash declaration is stale (older than 6 hours). Recipients will not be routed here.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 mb-3">
            {BANDS.map((band) => (
              <button
                key={band.id}
                type="button"
                className={`text-sm border rounded-lg p-2 ${cashBand === band.id ? 'border-emerald-600 bg-emerald-50' : 'border-slate-200'}`}
                onClick={async () => {
                  try {
                    if (band.id === 'over_5000') {
                      toast.message('Over R5,000 requires an exact cash amount below.');
                      setCashBand(band.id);
                      return;
                    }
                    await apiDeclareCashAvailability({ availabilityBand: band.id });
                    await reload();
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : 'Update failed');
                  }
                }}>
                {band.label}
              </button>
            ))}
          </div>
          <input
            className="w-full border rounded-lg p-2 mb-2"
            placeholder="Exact cash on hand (R)"
            value={cashCents}
            onChange={(e) => setCashCents(e.target.value)}
          />
          <KPButton
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await apiDeclareCashAvailability({
                  availabilityBand: cashBand === 'over_5000' ? 'over_5000' : undefined,
                  availableCents: cashCents,
                });
                await reload();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Update failed');
              }
            }}>
            Save exact cash
          </KPButton>
          <input
            className="w-full border rounded-lg p-2 mt-3 mb-2"
            placeholder="Adjustment amount (R)"
            value={adjustCents}
            onChange={(e) => setAdjustCents(e.target.value)}
          />
          <input
            className="w-full border rounded-lg p-2 mb-2"
            placeholder="Adjustment reason"
            value={adjustReason}
            onChange={(e) => setAdjustReason(e.target.value)}
          />
          <KPButton
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await apiAdjustCashAvailability({
                  availableCents: adjustCents,
                  reason: adjustReason,
                });
                toast.success('Cash adjustment recorded');
                await reload();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Adjustment failed');
              }
            }}>
            Record cash adjustment
          </KPButton>
        </KPCard>
        <KPCard className="mb-4 p-4 text-sm space-y-2">
          <h3 className="font-semibold">Pending top-ups</h3>
          {pending.length === 0 ? <p className="text-slate-500">None</p> : pending.map((row) => (
            <p key={String(row.id)}>{String(row.merchant_reference)} · {String(row.state)}</p>
          ))}
          <h3 className="font-semibold pt-2">Cleared top-ups</h3>
          {cleared.length === 0 ? <p className="text-slate-500">None</p> : cleared.map((row) => (
            <p key={String(row.id)}>{String(row.merchant_reference)} · credited</p>
          ))}
          <h3 className="font-semibold pt-2">Rejected / reversed</h3>
          {rejected.length === 0 ? <p className="text-slate-500">None</p> : rejected.map((row) => (
            <p key={String(row.id)}>{String(row.merchant_reference)} · {String(row.state)}</p>
          ))}
          <h3 className="font-semibold pt-2">Withdrawals / settlement</h3>
          {withdrawals.length === 0 ? <p className="text-slate-500">None</p> : withdrawals.map((row) => (
            <p key={String(row.id)}>{String(row.state)} · {String(row.amount_cents)}c</p>
          ))}
        </KPCard>
        <KPCard className="p-4">
          <h3 className="font-semibold mb-2">Nearby payout shops</h3>
          <KPButton
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                const result = await apiSearchPayoutShops({ amount: '100.00' });
                setShops(result.shops);
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Search failed');
              }
            }}>
            Find shops with ≥ R100 cash
          </KPButton>
          <div className="mt-3 space-y-2 text-sm">
            {shops.map((shop) => (
              <p key={shop.businessName}>
                {shop.businessName} · {shop.location}
                {shop.stale ? ' · stale' : ''}
              </p>
            ))}
          </div>
        </KPCard>
      </div>
    </PageTransition>
  );
};
