import { useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { toast } from 'sonner';
import {
  KPButton,
  KPCard,
  KPInput,
  KPAmount,
  PageTransition,
} from '../../components/shared/UIComponents';
import type { Language, Wallet } from '../../types';
import { useTranslations } from '../../hooks/useTranslations';
import {
  compareMoney,
  tryCanonicalMoney,
  type MoneyInput,
} from '../../money';

export const TransferMoneyPage = ({
  wallet,
  onSendMoney,
  navigate,
  language = 'en',
}: {
  wallet: Wallet;
  onSendMoney: (
    toPhone: string,
    amount: MoneyInput,
    description: string,
  ) => Promise<boolean>;
  navigate: (p: string) => void;
  language?: Language;
}) => {
  const { t } = useTranslations(language);
  const [toPhone, setToPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('Wallet transfer');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const amt = tryCanonicalMoney(amount);
    if (amt === null || compareMoney(amt, 0) <= 0) {
      toast.error(t('transfer.invalidAmount'));
      return;
    }
    if (toPhone.replace(/\D/g, '').length < 10) {
      toast.error(t('transfer.invalidPhone'));
      return;
    }
    setBusy(true);
    try {
      const ok = await onSendMoney(toPhone, amt, description.trim() || 'Wallet transfer');
      if (ok) {
        toast.success(t('transfer.done'));
        setAmount('');
        setToPhone('');
        setDescription('Wallet transfer');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10">
        <h2 className="text-xl font-bold text-slate-900">{t('transfer.title')}</h2>
        <p className="text-sm text-slate-500 mt-1">{t('transfer.subtitle')}</p>
      </div>

      <div className="flex-1 p-6 pb-nav space-y-4 overflow-y-auto">
        <KPCard className="p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center">
              <ArrowLeftRight className="w-5 h-5" />
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">
                {t('transfer.available')}
              </p>
              <p className="font-bold text-slate-900">
                <KPAmount amount={wallet.balance} />
              </p>
            </div>
          </div>

          <KPInput
            label={t('transfer.recipient')}
            type="tel"
            placeholder="082 123 4567"
            value={toPhone}
            onChange={(e) => setToPhone(e.target.value)}
          />
          <KPInput
            label={t('transfer.amount')}
            type="number"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <KPInput
            label={t('transfer.reference')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div className="grid grid-cols-2 gap-3 mt-4">
            <KPButton variant="outline" onClick={() => navigate('home')}>
              {t('common.back')}
            </KPButton>
            <KPButton onClick={() => void submit()} disabled={busy}>
              {busy ? t('transfer.sending') : t('transfer.send')}
            </KPButton>
          </div>
        </KPCard>
      </div>
    </PageTransition>
  );
};
