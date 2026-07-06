import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  KPCard,
  KPAmount,
  PageTransition } from
'../../components/shared/UIComponents';
import { ArrowDownLeft, ArrowUpRight, ShoppingCart, Plus } from 'lucide-react';
import type { Transaction, Sale, Wallet } from '../../types';
export const HistoryPage = ({
  transactions,
  sales,
  wallet




}: {transactions: Transaction[];sales: Sale[];wallet: Wallet;}) => {
  const [filter, setFilter] = useState<'all' | 'sales' | 'transfers'>('all');
  const filterOptions: Array<'all' | 'sales' | 'transfers'> = [
    'all',
    'sales',
    'transfers'
  ];
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
  return (
    <PageTransition className="flex flex-col h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 sticky top-0">
        <h2 className="text-xl font-bold text-slate-900 mb-4">History</h2>

        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {filterOptions.map((f) =>
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize whitespace-nowrap transition-colors ${filter === f ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
            
              {f}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-3 pb-24">
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
                key={`sale-${sale.id}`}>
                
                  <KPCard className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full flex items-center justify-center bg-blue-50 text-blue-600">
                        <ShoppingCart className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">Shop Sale</p>
                        <p className="text-xs text-slate-500">
                          {sale.items.length} items • {sale.paymentMethod}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <KPAmount
                      amount={sale.total}
                      showSign
                      className="text-emerald-600 block" />
                    
                      <span className="text-[10px] text-slate-400">
                        {item.date.toLocaleDateString()}
                      </span>
                    </div>
                  </KPCard>
                </motion.div>);

          } else {
            const tx = item as Transaction & {
              activityType: 'transaction';
            };
            const isOutgoing = tx.fromWalletId === wallet.id;
            const isDeposit = tx.type === 'deposit';
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
                
                  <KPCard className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center ${isOutgoing ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-600'}`}>
                      
                        {icon}
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">
                          {tx.description}
                        </p>
                        <p className="text-xs text-slate-500">
                          {tx.status === 'pending' ? 'Pending' : 'Transfer'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <KPAmount
                      amount={tx.amount}
                      showSign
                      className={
                      isOutgoing ?
                      'text-slate-900 block' :
                      'text-emerald-600 block'
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