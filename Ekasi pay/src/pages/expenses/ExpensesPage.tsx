import { useState } from 'react';
import type { ElementType, FormEvent } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  KPCard,
  KPAmount,
  PageTransition,
  KPButton } from
'../../components/shared/UIComponents';
import {
  ArrowLeft,
  Zap,
  Flame,
  Truck,
  Home,
  Package,
  MoreHorizontal,
  Plus,
  Receipt } from
'lucide-react';
import { toast } from 'sonner';
import type { Expense, ExpenseCategory, Sale, Product } from '../../types';
const CATEGORY_ICONS: Record<ExpenseCategory, ElementType> = {
  electricity: Zap,
  paraffin: Flame,
  supplier: Package,
  rent: Home,
  transport: Truck,
  other: MoreHorizontal
};
const CATEGORY_COLORS: Record<ExpenseCategory, string> = {
  electricity: 'bg-amber-100 text-amber-600',
  paraffin: 'bg-orange-100 text-orange-600',
  supplier: 'bg-blue-100 text-blue-600',
  rent: 'bg-purple-100 text-purple-600',
  transport: 'bg-emerald-100 text-emerald-600',
  other: 'bg-slate-100 text-slate-600'
};
export const ExpensesPage = ({
  expenses,
  sales,
  products,
  onAddExpense,
  navigate








}: {expenses: Expense[];sales: Sale[];products: Product[];onAddExpense: (expense: Omit<Expense, 'id' | 'merchantId' | 'createdAt'>) => void | Promise<boolean | void>;navigate: (p: string) => void;}) => {
  const [showForm, setShowForm] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('supplier');
  const [busy, setBusy] = useState(false);
  const totalGrossMargin = sales.reduce((sum, s) => {
    return (
      sum +
      s.items.reduce((itemSum, item) => {
        const product = products.find((p) => p.id === item.productId);
        const costPrice = product?.costPrice ?? item.price * 0.7;
        return itemSum + (item.price - costPrice) * item.quantity;
      }, 0));

  }, 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const netProfit = totalGrossMargin - totalExpenses;
  const resetForm = () => {
    setAmount('');
    setDescription('');
    setCategory('other');
    setShowForm(false);
  };
  const handleSubmit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!amount || !description || busy) return;
    void (async () => {
      setBusy(true);
      try {
        const result = await Promise.resolve(
          onAddExpense({
            amount: Number(amount),
            description,
            category,
          }),
        );
        if (result === false) return;
        resetForm();
        toast.success('Expense recorded');
      } finally {
        setBusy(false);
      }
    })();
  };
  // Group expenses by date
  const groupedExpenses = expenses.reduce(
    (acc, expense) => {
      const date = new Date(expense.createdAt).toLocaleDateString();
      if (!acc[date]) acc[date] = [];
      acc[date].push(expense);
      return acc;
    },
    {} as Record<string, Expense[]>
  );
  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
              
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">
              Expenses & Profit
            </h2>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="w-10 h-10 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center active:scale-95 transition-transform">
            
            {showForm ?
            <ArrowLeft className="w-5 h-5" /> :

            <Plus className="w-5 h-5" />
            }
          </button>
        </div>

        {/* Profit Summary */}
        <div className="bg-slate-900 rounded-2xl p-5 text-white shadow-lg mb-2">
          <p className="text-slate-400 text-sm font-medium mb-1">
            Net Profit (All Time)
          </p>
          <div className="text-3xl font-bold mb-4">
            <KPAmount
              amount={netProfit}
              showSign
              className={netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'} />
            
          </div>
          <div className="flex justify-between items-center text-sm border-t border-slate-800 pt-3">
            <div>
              <p className="text-slate-500">Gross Margin</p>
              <p className="font-medium text-emerald-400">
                <KPAmount amount={totalGrossMargin} />
              </p>
            </div>
            <div className="text-right">
              <p className="text-slate-500">Total Expenses</p>
              <p className="font-medium text-red-400">
                <KPAmount amount={totalExpenses} />
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-nav">
        <AnimatePresence mode="wait">
          {showForm ?
          <motion.div
            key="form"
            initial={{
              opacity: 0,
              y: 20
            }}
            animate={{
              opacity: 1,
              y: 0
            }}
            exit={{
              opacity: 0,
              y: -20
            }}>
            
              <KPCard className="p-5">
                <h3 className="font-bold text-slate-900 mb-4">
                  Log New Expense
                </h3>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">
                      Category
                    </label>
                    <div className="flex flex-wrap gap-2">
                      {(Object.keys(CATEGORY_ICONS) as ExpenseCategory[]).map(
                      (cat) => {
                        const Icon = CATEGORY_ICONS[cat];
                        return (
                          <button
                            key={cat}
                            onClick={() => setCategory(cat)}
                            className={`px-3 py-2 rounded-xl text-sm font-medium flex items-center gap-2 transition-all ${category === cat ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
                            
                              <Icon className="w-4 h-4" />
                              <span className="capitalize">{cat}</span>
                            </button>);

                      }
                    )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Amount
                    </label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 font-medium">
                        R
                      </span>
                      <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-8 pr-4 text-lg font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400" />
                    
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Description
                    </label>
                    <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g. Paid Coca-Cola driver"
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400" />
                  
                  </div>

                  <KPButton
                  onClick={handleSubmit}
                  disabled={busy || !amount || !description}
                  className="mt-2">
                  
                    {busy ? 'Saving…' : 'Save Expense'}
                  </KPButton>
                </div>
              </KPCard>
            </motion.div> :

          <motion.div
            key="list"
            initial={{
              opacity: 0
            }}
            animate={{
              opacity: 1
            }}
            exit={{
              opacity: 0
            }}>
            
              {Object.entries(groupedExpenses).length === 0 ?
            <div className="text-center py-12 text-slate-500">
                  <Receipt className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                  <p>No expenses logged yet</p>
                </div> :

            Object.entries(groupedExpenses).map(([date, dayExpenses]) =>
            <div key={date} className="mb-6">
                    <h3 className="text-xs font-bold text-slate-400 mb-3 uppercase tracking-wider">
                      {date === new Date().toLocaleDateString() ?
                'Today' :
                date}
                    </h3>
                    <div className="space-y-3">
                      {dayExpenses.map((expense) => {
                  const Icon = CATEGORY_ICONS[expense.category];
                  return (
                    <KPCard
                      key={expense.id}
                      className="p-4 flex items-center justify-between">
                      
                            <div className="flex items-center gap-3">
                              <div
                          className={`w-10 h-10 rounded-xl flex items-center justify-center ${CATEGORY_COLORS[expense.category]}`}>
                          
                                <Icon className="w-5 h-5" />
                              </div>
                              <div>
                                <p className="font-medium text-slate-900">
                                  {expense.description}
                                </p>
                                <p className="text-xs text-slate-500 capitalize">
                                  {expense.category}
                                </p>
                              </div>
                            </div>
                            <KPAmount
                        amount={expense.amount}
                        className="text-red-600"
                        showSign />
                      
                          </KPCard>);

                })}
                    </div>
                  </div>
            )
            }
            </motion.div>
          }
        </AnimatePresence>
      </div>
    </PageTransition>);

};