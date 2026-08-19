import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  KPCard,
  KPAmount,
  KPButton,
  PageTransition } from
'../../components/shared/UIComponents';
import { ArrowDownLeft, ArrowUpRight, ShoppingCart, Plus, X, MessageCircle, Ban } from 'lucide-react';
import { toast } from 'sonner';
import type { Transaction, Sale, Wallet, TransactionType, Language } from '../../types';
import { useTranslations } from '../../hooks/useTranslations';
import { subtractMoney, formatMoney } from '../../money';

function extractCashSendVoucherNumber(description: string | undefined): string | null {
  const match = (description ?? '').toUpperCase().match(/CS[0-9A-F]{8,}/);
  return match ? match[0] : null;
}

function transactionTitle(tx: Transaction): string {
  const map: Partial<Record<TransactionType, string>> = {
    cash_send_hold: 'Cash Send',
    cash_send_collect: 'Cash collected',
    cash_send_cancel_refund: 'Cash Send cancelled',
    cash_send_expire_refund: 'Cash Send expired',
    transfer: 'Transfer',
    deposit: 'Deposit',
    withdrawal: 'Withdrawal',
    payment: 'Payment',
  };
  return map[tx.type] ?? (tx.description || tx.type);
}

export const HistoryPage = ({
  transactions,
  sales,
  wallet,
  language = 'en',
  voidedSaleIds = [],
  onVoidSale,
}: {
  transactions: Transaction[];
  sales: Sale[];
  wallet: Wallet;
  language?: Language;
  voidedSaleIds?: string[];
  onVoidSale?: (saleId: string) => Promise<boolean>;
}) => {
  const { t } = useTranslations(language);
  const [filter, setFilter] = useState<'all' | 'sales' | 'transfers'>('all');
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [isVoiding, setIsVoiding] = useState(false);
  const filterOptions: Array<'all' | 'sales' | 'transfers'> = [
    'all',
    'sales',
    'transfers'
  ];
  const filterLabel = (f: 'all' | 'sales' | 'transfers') =>
    f === 'all' ? t('history.all') : f === 'sales' ? t('history.sales') : t('history.transfers');
  // Combine and sort all activity
  const allActivity = [
  ...transactions.map((t) => ({
    ...t,
    activityType: 'transaction' as const,
    date: new Date(t.createdAt)
  })),
  ...sales.map((s) => ({
    ...s,
    activityType: 'sale' as const,
    date: new Date(s.createdAt)
  }))].
  sort((a, b) => b.date.getTime() - a.date.getTime());
  const filteredActivity = allActivity.filter((item) => {
    if (filter === 'all') return true;
    if (filter === 'sales') return item.activityType === 'sale';
    if (filter === 'transfers') return item.activityType === 'transaction';
    return true;
  });
  const handleShareReceipt = (sale: Sale) => {
    const date = new Date(sale.createdAt).toLocaleString();
    const itemsList = sale.items
      .map((i) => `${i.quantity}x ${i.name} - R${formatMoney(i.subtotal)}`)
      .join('\n');
    const text = `*KasiPay Spaza Receipt*\n${date}\n\n*Items:*\n${itemsList}\n\n*Total: R${formatMoney(sale.total)}*\nPaid via: ${sale.paymentMethod.toUpperCase()}\n\nThank you for your support!`;
    
    const nav: Navigator & { share?: (data: ShareData) => Promise<void> } = navigator;
    if (typeof nav.share === 'function') {
      nav.share({ title: 'KasiPay Receipt', text }).catch(() => {});
      return;
    }
    if (typeof navigator.clipboard?.writeText === 'function') {
      void navigator.clipboard
        .writeText(text)
        .then(() => toast.success('Receipt copied to clipboard'))
        .catch(() => {
          window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
        });
      return;
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  };

  const handleVoidSale = async (sale: Sale) => {
    if (!onVoidSale) return;
    if (!window.confirm('Are you sure you want to void this sale? This will return the items to stock.')) return;
    
    setIsVoiding(true);
    const success = await onVoidSale(sale.id);
    setIsVoiding(false);
    
    if (success) {
      toast.success('Sale voided successfully');
      setSelectedSale(null);
    } else {
      toast.error('Failed to void sale');
    }
  };

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50 relative">
      {selectedSale && (
        <div className="absolute inset-0 z-50 bg-black/50 flex flex-col justify-end">
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            className="bg-white rounded-t-3xl p-6 max-h-[85vh] overflow-y-auto"
          >
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold">Receipt</h3>
              <button
                onClick={() => setSelectedSale(null)}
                className="w-8 h-8 flex items-center justify-center bg-slate-100 rounded-full text-slate-500"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <KPCard className="w-full p-4 mb-6 text-left bg-slate-50 border-dashed border-2 border-slate-200">
              <div className="text-center border-b border-slate-200 pb-3 mb-3">
                <p className="font-bold text-slate-900">KasiPay Spaza</p>
                <p className="text-xs text-slate-500">
                  {new Date(selectedSale.createdAt).toLocaleString()}
                </p>
                {selectedSale.receiptNumber && (
                  <p className="text-xs font-mono text-slate-500 mt-1">
                    {selectedSale.receiptNumber}
                  </p>
                )}
                {voidedSaleIds.includes(selectedSale.id) && (
                  <div className="mt-2 inline-block px-2 py-1 bg-red-100 text-red-700 text-xs font-bold rounded">
                    VOIDED
                  </div>
                )}
              </div>
              <div className="space-y-2 mb-3">
                {selectedSale.items.map((item, i) => (
                  <div key={i} className="flex justify-between text-sm">
                    <span className="text-slate-600">
                      {item.quantity}x {item.name}
                    </span>
                    <span className="font-medium text-slate-900">
                      R{formatMoney(item.subtotal)}
                    </span>
                  </div>
                ))}
              </div>
              <div className="border-t border-slate-200 pt-3 flex justify-between items-center">
                <span className="font-bold text-slate-900">{t('shop.total') || 'Total'}</span>
                <span className="font-bold text-lg text-slate-900">
                  R{formatMoney(selectedSale.total)}
                </span>
              </div>
              <div className="mt-2 text-xs text-slate-500 text-center uppercase tracking-wider">
                Paid via {selectedSale.paymentMethod}
              </div>
            </KPCard>

            <div className="space-y-3">
              <KPButton
                onClick={() => handleShareReceipt(selectedSale)}
                className="bg-[#25D366] hover:bg-[#128C7E] text-white border-none flex items-center justify-center gap-2"
              >
                <MessageCircle className="w-5 h-5" />
                Share Receipt
              </KPButton>
              
              {!voidedSaleIds.includes(selectedSale.id) && onVoidSale && (
                <KPButton
                  variant="outline"
                  onClick={() => handleVoidSale(selectedSale)}
                  disabled={isVoiding}
                  className="text-red-600 border-red-200 hover:bg-red-50 flex items-center justify-center gap-2"
                >
                  <Ban className="w-5 h-5" />
                  {isVoiding ? 'Voiding...' : 'Void Sale'}
                </KPButton>
              )}
            </div>
          </motion.div>
        </div>
      )}

      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 sticky top-0">
        <h2 className="text-xl font-bold text-slate-900 mb-4">{t('history.title')}</h2>

        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {filterOptions.map((f) =>
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize whitespace-nowrap transition-colors ${filter === f ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
            
              {filterLabel(f)}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-3 pb-nav">
        {filteredActivity.length === 0 ?
        <div className="flex flex-col items-center justify-center h-40 text-slate-500">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-3">
              <ShoppingCart className="w-6 h-6 text-slate-300" />
            </div>
            <p>No history found</p>
          </div> :

        filteredActivity.map((item, i) => {
          if (item.activityType === 'sale') {
            const sale = item as Sale & {
              activityType: 'sale';
            };
            return (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                key={`sale-${sale.id}`}
                onClick={() => setSelectedSale(sale)}
                className="cursor-pointer"
              >
                <KPCard className={`!p-4 flex items-center gap-3 overflow-hidden ${voidedSaleIds.includes(sale.id) ? 'opacity-60' : ''}`}>
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center ${voidedSaleIds.includes(sale.id) ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                      <ShoppingCart className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className={`font-medium truncate ${voidedSaleIds.includes(sale.id) ? 'text-red-900 line-through' : 'text-slate-900'}`}>
                          {t('history.sale')}
                        </p>
                        {voidedSaleIds.includes(sale.id) && (
                          <span className="text-[10px] font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded">VOID</span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 truncate">
                        {sale.items.length} items • {sale.paymentMethod}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <KPAmount
                      amount={sale.total}
                      showSign
                      className={`${voidedSaleIds.includes(sale.id) ? 'text-slate-400 line-through' : 'text-emerald-600'} block tabular-nums`}
                    />
                    <span className="text-[10px] text-slate-400">
                      {item.date.toLocaleDateString()}
                    </span>
                  </div>
                </KPCard>
              </motion.div>
            );

          } else {
            const tx = item as Transaction & {
              activityType: 'transaction';
            };
            const isOutgoing = tx.fromWalletId === wallet.id;
            const isDeposit = tx.type === 'deposit';
            const voucherNumber = extractCashSendVoucherNumber(tx.description);
            let icon = isOutgoing ?
            <ArrowUpRight className="w-5 h-5" /> :

            <ArrowDownLeft className="w-5 h-5" />;

            if (isDeposit) icon = <Plus className="w-5 h-5" />;
            return (
              <motion.div
                initial={{
                  opacity: 0,
                  y: 10
                }}
                animate={{
                  opacity: 1,
                  y: 0
                }}
                transition={{
                  delay: i * 0.05
                }}
                key={`tx-${tx.id}`}>
                
                  <KPCard className="!p-4 flex items-center gap-3 overflow-hidden">
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div
                      className={`w-10 h-10 shrink-0 rounded-full flex items-center justify-center ${isOutgoing ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-600'}`}>
                      
                        {icon}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-slate-900 truncate">
                          {transactionTitle(tx)}
                        </p>
                        <p className="text-xs text-slate-500 truncate">
                          {voucherNumber ?
                            `Voucher ${voucherNumber}`
                          : tx.status === 'pending' ?
                            'Pending'
                          : tx.reference || 'Completed'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <KPAmount
                      amount={isOutgoing ? subtractMoney('0.00', tx.amount) : tx.amount}
                      showSign
                      className={
                      isOutgoing ?
                      'text-slate-900 block tabular-nums' :
                      'text-emerald-600 block tabular-nums'
                      } />
                    
                      <span className="text-[10px] text-slate-400">
                        {item.date.toLocaleDateString()}
                      </span>
                    </div>
                  </KPCard>
                </motion.div>);

          }
        })
        }
      </div>
    </PageTransition>);

};
