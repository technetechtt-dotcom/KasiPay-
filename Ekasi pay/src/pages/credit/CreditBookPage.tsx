import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  KPCard,
  KPAmount,
  PageTransition,
  KPButton,
  KPInput,
} from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  BookOpen,
  Plus,
  MessageCircle,
  ChevronDown,
  ChevronUp,
  CreditCard,
  Banknote,
  Search,
  X,
  Trash2,
  ShoppingBag,
} from 'lucide-react';
import { toast } from 'sonner';
import type { CreditCustomer, CreditTransaction } from '../../types';

/** Common spaza credit categories — emoji-led to make scanning fast. */
type CreditCategoryId =
  | 'Bread'
  | 'Food'
  | 'Drinks'
  | 'Airtime'
  | 'Cleaning'
  | 'Cigarettes'
  | 'Snacks'
  | 'Other';

const CREDIT_CATEGORIES: { id: CreditCategoryId; label: string; emoji: string }[] = [
  { id: 'Bread', label: 'Bread', emoji: '🍞' },
  { id: 'Food', label: 'Food', emoji: '🥫' },
  { id: 'Drinks', label: 'Drinks', emoji: '🥤' },
  { id: 'Airtime', label: 'Airtime', emoji: '📱' },
  { id: 'Snacks', label: 'Snacks', emoji: '🍪' },
  { id: 'Cleaning', label: 'Cleaning', emoji: '🧴' },
  { id: 'Cigarettes', label: 'Cigarettes', emoji: '🚬' },
  { id: 'Other', label: 'Other', emoji: '🛒' },
];

/** Map a free-text description back to a friendly category for display. */
const inferCategory = (
  text: string,
): { emoji: string; label: string } | null => {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const c of CREDIT_CATEGORIES) {
    if (lower.includes(`(${c.label.toLowerCase()})`)) return { emoji: c.emoji, label: c.label };
    if (lower.includes(c.label.toLowerCase())) return { emoji: c.emoji, label: c.label };
  }
  if (/bread|loaf/.test(lower)) return { emoji: '🍞', label: 'Bread' };
  if (/airtime|data|voucher/.test(lower)) return { emoji: '📱', label: 'Airtime' };
  if (/milk|maas|amasi/.test(lower)) return { emoji: '🥛', label: 'Drinks' };
  if (/coke|soda|fanta|stoney|cool ?drink|water|beer/.test(lower))
    return { emoji: '🥤', label: 'Drinks' };
  if (/sugar|salt|rice|maize|mealie|pap|samp|flour/.test(lower))
    return { emoji: '🥫', label: 'Food' };
  if (/cigarette|tobacco|stomp/.test(lower))
    return { emoji: '🚬', label: 'Cigarettes' };
  if (/chips|sweet|chocolate|snack|biscuit/.test(lower))
    return { emoji: '🍪', label: 'Snacks' };
  if (/soap|washing|cleaner|sunlight|domestos|jik/.test(lower))
    return { emoji: '🧴', label: 'Cleaning' };
  return null;
};

type CreditDraftItem = {
  id: string;
  category: CreditCategoryId;
  name: string;
  qty: number;
  unitPrice: number;
};

const formatDraftItemsAsDescription = (items: CreditDraftItem[]): string =>
  items
    .map(
      (i) =>
        `${i.qty}× ${i.name} (${i.category}) @ R${i.unitPrice.toFixed(2)}`,
    )
    .join(' · ');
export const CreditBookPage = ({
  customers,
  transactions,
  onAddTransaction,
  onCreateCustomer,
  navigate,






}: {
  customers: CreditCustomer[];
  transactions: CreditTransaction[];
  onAddTransaction: (
    customerId: string,
    type: 'purchase' | 'payment',
    amount: number,
    description: string
  ) => Promise<boolean | void> | void;
  onCreateCustomer: (
    name: string,
    phone: string,
    creditLimit: number
  ) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const [showForm, setShowForm] = useState<'purchase' | 'payment' | null>(null);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [items, setItems] = useState<CreditDraftItem[]>([]);
  const [draftCategory, setDraftCategory] =
    useState<CreditCategoryId>('Bread');
  const [draftName, setDraftName] = useState('');
  const [draftQty, setDraftQty] = useState('1');
  const [draftPrice, setDraftPrice] = useState('');
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [ncName, setNcName] = useState('');
  const [ncPhone, setNcPhone] = useState('');
  const [ncLimit, setNcLimit] = useState('');
  const [ncBusy, setNcBusy] = useState(false);

  const draftQtyNumber = Number(draftQty);
  const draftPriceNumber = Number(draftPrice);
  const canAddDraftItem =
    draftName.trim().length > 0 &&
    Number.isFinite(draftQtyNumber) &&
    draftQtyNumber > 0 &&
    Number.isFinite(draftPriceNumber) &&
    draftPriceNumber > 0;
  const itemsTotal = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);

  const addDraftItem = () => {
    if (!canAddDraftItem) return;
    setItems((prev) => [
      ...prev,
      {
        id: `it_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        category: draftCategory,
        name: draftName.trim(),
        qty: draftQtyNumber,
        unitPrice: draftPriceNumber,
      },
    ]);
    setDraftName('');
    setDraftQty('1');
    setDraftPrice('');
  };

  const removeDraftItem = (id: string) =>
    setItems((prev) => prev.filter((i) => i.id !== id));

  const resetPurchaseDraft = () => {
    setItems([]);
    setDraftCategory('Bread');
    setDraftName('');
    setDraftQty('1');
    setDraftPrice('');
  };
  const totalOutstanding = customers.reduce((sum, c) => sum + c.totalOwed, 0);
  const activeCustomers = customers.filter((c) => c.totalOwed > 0).length;
  const filteredCustomers = customers.filter(
    (c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    c.phone.includes(searchQuery)
  );
  const handleAddTransaction = () => {
    if (!showForm) return;
    if (!selectedCustomerId) {
      toast.error('Pick a customer first.');
      return;
    }
    const customerId = selectedCustomerId;
    if (showForm === 'purchase') {
      if (items.length === 0) {
        toast.error('Add at least one product taken on credit.');
        return;
      }
      const desc = formatDraftItemsAsDescription(items);
      const total = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
      void (async () => {
        await Promise.resolve(
          onAddTransaction(customerId, 'purchase', total, desc),
        );
        toast.success('Credit added');
        setShowForm(null);
        resetPurchaseDraft();
        setSelectedCustomerId('');
      })();
      return;
    }
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter a payment amount.');
      return;
    }
    void (async () => {
      await Promise.resolve(
        onAddTransaction(customerId, 'payment', amt, 'Cash payment'),
      );
      toast.success('Payment recorded');
      setShowForm(null);
      setAmount('');
      setSelectedCustomerId('');
    })();
  };
  const handleWhatsAppReminder = (customer: CreditCustomer) => {
    const text = `Sawubona ${customer.name}, this is a friendly reminder from KasiPay Spaza. Your current credit balance is R${customer.totalOwed.toFixed(2)}. Please arrange payment soon. Ngiyabonga!`;
    window.open(
      `https://wa.me/27${customer.phone.substring(1)}?text=${text}`,
      '_blank'
    );
  };
  return (
    <PageTransition className="flex flex-col h-full bg-slate-50">
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
              Credit Book
            </h2>
          </div>
          <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center">
            <BookOpen className="w-5 h-5" />
          </div>
        </div>

        {/* Summary Card */}
        <div className="bg-slate-900 rounded-2xl p-5 text-white shadow-lg mb-6">
          <p className="text-slate-400 text-sm font-medium mb-1">
            Total Outstanding
          </p>
          <div className="text-3xl font-bold mb-4 text-red-400">
            <KPAmount amount={totalOutstanding} />
          </div>
          <div className="flex justify-between items-center text-sm border-t border-slate-800 pt-3">
            <div>
              <p className="text-slate-500">Active Customers</p>
              <p className="font-medium text-white">{activeCustomers}</p>
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowNewCustomer(true)}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-xs font-medium transition-colors flex items-center gap-1 text-white">
                <Plus className="w-3 h-3" /> New customer
              </button>
              <button
                type="button"
                onClick={() => setShowForm('purchase')}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-xs font-medium transition-colors flex items-center gap-1">
                <Plus className="w-3 h-3" /> Credit
              </button>
              <button
                type="button"
                onClick={() => setShowForm('payment')}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-xs font-medium transition-colors flex items-center gap-1">
                <Banknote className="w-3 h-3" /> Pay
              </button>
            </div>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search customers..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-100 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20" />
          
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 pb-24">
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
                <div className="flex justify-between items-center mb-4">
                  <h3 className="font-bold text-slate-900">
                    {showForm === 'purchase' ?
                      'Take products on credit' :
                      'Record Payment'}
                  </h3>
                  <button
                    onClick={() => {
                      setShowForm(null);
                      resetPurchaseDraft();
                    }}
                    className="text-sm text-slate-500">
                    Cancel
                  </button>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Customer
                    </label>
                    <select
                      value={selectedCustomerId}
                      onChange={(e) => setSelectedCustomerId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30">
                      <option value="">Select a customer...</option>
                      {customers.map((c) =>
                        <option key={c.id} value={c.id}>
                          {c.name} (Owes R{c.totalOwed})
                        </option>
                      )}
                    </select>
                  </div>

                  {showForm === 'payment' ?
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
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-8 pr-4 text-lg font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
                      </div>
                    </div> :
                  null}

                  {showForm === 'purchase' ?
                    <>
                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-2">
                          Pick a category
                        </label>
                        <div className="grid grid-cols-4 gap-2">
                          {CREDIT_CATEGORIES.map((c) => {
                            const active = draftCategory === c.id;
                            return (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => setDraftCategory(c.id)}
                                className={`flex flex-col items-center justify-center gap-1 py-2 rounded-xl text-[11px] font-semibold border ${active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600'}`}>
                                <span className="text-lg leading-none">{c.emoji}</span>
                                {c.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <label className="block text-sm font-medium text-slate-700 mb-1.5">
                          Item name
                        </label>
                        <input
                          type="text"
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          placeholder={
                            draftCategory === 'Airtime' ? 'e.g. Vodacom R10 voucher' :
                            draftCategory === 'Bread' ? 'e.g. Albany brown loaf' :
                            draftCategory === 'Drinks' ? 'e.g. Coke 500ml' :
                            'e.g. Sasko maize meal 5kg'
                          }
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1.5">
                            Qty
                          </label>
                          <input
                            type="number"
                            min="1"
                            value={draftQty}
                            onChange={(e) => setDraftQty(e.target.value)}
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
                        </div>
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1.5">
                            Unit price (R)
                          </label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={draftPrice}
                            onChange={(e) => setDraftPrice(e.target.value)}
                            placeholder="0.00"
                            className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/30" />
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={addDraftItem}
                        disabled={!canAddDraftItem}
                        className="w-full flex items-center justify-center gap-2 py-3 bg-indigo-50 text-indigo-700 rounded-xl text-sm font-bold disabled:opacity-50 active:scale-[0.98] transition-all">
                        <Plus className="w-4 h-4" /> Add item to this credit slip
                      </button>

                      <div>
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                            Items on this slip
                          </span>
                          <span className="text-sm font-bold text-slate-900">
                            R{itemsTotal.toFixed(2)}
                          </span>
                        </div>
                        {items.length === 0 ?
                          <p className="text-xs text-slate-400 italic text-center py-3 border border-dashed border-slate-200 rounded-xl">
                            No products added yet
                          </p>
                        :
                          <ul className="space-y-2">
                            {items.map((it) => {
                              const meta = CREDIT_CATEGORIES.find((c) => c.id === it.category);
                              return (
                                <li
                                  key={it.id}
                                  className="flex items-center justify-between gap-2 p-3 bg-white border border-slate-100 rounded-xl">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-lg shrink-0">{meta?.emoji ?? '🛒'}</span>
                                    <div className="min-w-0">
                                      <p className="text-sm font-medium text-slate-900 truncate">
                                        {it.qty}× {it.name}
                                      </p>
                                      <p className="text-[11px] text-slate-500">
                                        {meta?.label ?? it.category} · R{it.unitPrice.toFixed(2)} each
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2 shrink-0">
                                    <span className="text-sm font-bold text-slate-900">
                                      R{(it.qty * it.unitPrice).toFixed(2)}
                                    </span>
                                    <button
                                      type="button"
                                      aria-label="Remove item"
                                      onClick={() => removeDraftItem(it.id)}
                                      className="p-1.5 text-slate-400 hover:text-red-500 rounded-lg">
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        }
                      </div>
                    </> :
                  null}

                  <KPButton
                    onClick={handleAddTransaction}
                    disabled={
                      !selectedCustomerId ||
                      (showForm === 'purchase' ? items.length === 0 : !amount)
                    }
                    className={`mt-2 ${showForm === 'payment' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                    {showForm === 'purchase' ?
                      `Add to Credit Book${items.length > 0 ? ` · R${itemsTotal.toFixed(2)}` : ''}` :
                      'Record Payment'}
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
            
              <div className="space-y-3">
                {filteredCustomers.map((customer) => {
                const utilization =
                customer.totalOwed / customer.creditLimit * 100;
                const statusColor =
                utilization > 80 ?
                'bg-red-500' :
                utilization > 50 ?
                'bg-amber-500' :
                'bg-emerald-500';
                const isExpanded = expandedCustomer === customer.id;
                const customerTxs = transactions.
                filter((t) => t.customerId === customer.id).
                sort(
                  (a, b) =>
                  new Date(b.createdAt).getTime() -
                  new Date(a.createdAt).getTime()
                );
                const purchases = customerTxs.filter((t) => t.type === 'purchase');
                const categoryChips: { emoji: string; label: string }[] = [];
                for (const tx of purchases) {
                  const cat = inferCategory(tx.description);
                  if (cat && !categoryChips.some((c) => c.label === cat.label)) {
                    categoryChips.push(cat);
                  }
                  if (categoryChips.length >= 4) break;
                }
                return (
                  <KPCard key={customer.id} className="overflow-hidden">
                      <div
                      className="p-4 flex items-center justify-between cursor-pointer active:bg-slate-50"
                      onClick={() =>
                      setExpandedCustomer(isExpanded ? null : customer.id)
                      }>
                      
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-start mb-1 gap-2">
                            <h3 className="font-bold text-slate-900 truncate">
                              {customer.name}
                            </h3>
                            <span
                            className={`font-bold shrink-0 ${customer.totalOwed > 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                            
                              R{customer.totalOwed.toFixed(2)}
                            </span>
                          </div>
                          <p className="text-xs text-slate-500 mb-2">
                            {customer.phone}
                          </p>

                          {categoryChips.length > 0 ?
                            <div className="flex flex-wrap gap-1 mb-3">
                              {categoryChips.map((c) =>
                                <span
                                  key={c.label}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-100 text-slate-700 rounded-full text-[10px] font-medium">
                                  <span>{c.emoji}</span> {c.label}
                                </span>
                              )}
                            </div> :
                          purchases.length > 0 ?
                            <p className="text-[11px] text-slate-400 italic mb-3 flex items-center gap-1">
                              <ShoppingBag className="w-3 h-3" /> Products on credit
                            </p> :
                          null}

                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div
                              className={`h-full rounded-full ${statusColor}`}
                              style={{
                                width: `${Math.min(100, utilization)}%`
                              }} />
                            
                            </div>
                            <span className="text-[10px] text-slate-400 font-medium w-16 text-right">
                              Limit: R{customer.creditLimit}
                            </span>
                          </div>
                        </div>
                        <div className="ml-4 pl-4 border-l border-slate-100 flex items-center">
                          {isExpanded ?
                        <ChevronUp className="w-5 h-5 text-slate-400" /> :

                        <ChevronDown className="w-5 h-5 text-slate-400" />
                        }
                        </div>
                      </div>

                      <AnimatePresence>
                        {isExpanded &&
                      <motion.div
                        initial={{
                          height: 0,
                          opacity: 0
                        }}
                        animate={{
                          height: 'auto',
                          opacity: 1
                        }}
                        exit={{
                          height: 0,
                          opacity: 0
                        }}
                        className="bg-slate-50 border-t border-slate-100">
                        
                            <div className="p-4">
                              <div className="flex gap-2 mb-4">
                                <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedCustomerId(customer.id);
                                setShowForm('payment');
                              }}
                              className="flex-1 py-2 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold flex items-center justify-center gap-1">
                              
                                  <Banknote className="w-4 h-4" /> Pay
                                </button>
                                <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleWhatsAppReminder(customer);
                              }}
                              className="flex-1 py-2 bg-[#25D366]/10 text-[#128C7E] rounded-lg text-xs font-bold flex items-center justify-center gap-1">
                              
                                  <MessageCircle className="w-4 h-4" /> Remind
                                </button>
                              </div>

                              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">
                                Recent History
                              </h4>
                              {customerTxs.length > 0 ?
                          <div className="space-y-3">
                                  {customerTxs.map((tx) => {
                                    const cat =
                                      tx.type === 'purchase' ?
                                        inferCategory(tx.description) :
                                        null;
                                    return (
                                      <div
                                        key={tx.id}
                                        className="flex justify-between items-start gap-3 text-sm">
                                        <div className="flex items-start gap-2 min-w-0 flex-1">
                                          <div
                                            className={`w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm ${tx.type === 'payment' ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'}`}>
                                            {tx.type === 'payment' ?
                                              <Banknote className="w-3.5 h-3.5" /> :
                                              cat ?
                                                <span>{cat.emoji}</span> :
                                                <CreditCard className="w-3.5 h-3.5" />
                                            }
                                          </div>
                                          <div className="min-w-0 flex-1">
                                            <p className="font-medium text-slate-700 leading-snug break-words">
                                              {tx.description}
                                            </p>
                                            <p className="text-[10px] text-slate-400 mt-0.5">
                                              {cat ? `${cat.label} · ` : ''}
                                              {new Date(
                                                tx.createdAt,
                                              ).toLocaleDateString()}
                                            </p>
                                          </div>
                                        </div>
                                        <span
                                          className={`font-medium shrink-0 ${tx.type === 'payment' ? 'text-emerald-600' : 'text-red-600'}`}>
                                          {tx.type === 'payment' ? '-' : '+'}R
                                          {tx.amount.toFixed(2)}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div> :

                          <p className="text-sm text-slate-500 text-center py-2">
                                  No history yet
                                </p>
                          }
                            </div>
                          </motion.div>
                      }
                      </AnimatePresence>
                    </KPCard>);

              })}
              </div>
            </motion.div>
          }
        </AnimatePresence>
      </div>

      {showNewCustomer && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg">New izikweletu customer</h3>
              <button type="button" onClick={() => setShowNewCustomer(false)} aria-label="Close">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <KPInput label="Name" value={ncName} onChange={(e) => setNcName(e.target.value)} />
            <KPInput label="Phone" value={ncPhone} onChange={(e) => setNcPhone(e.target.value)} />
            <KPInput
              label="Credit limit (R)"
              type="number"
              value={ncLimit}
              onChange={(e) => setNcLimit(e.target.value)}
            />
            <KPButton
              type="button"
              className="mt-4"
              disabled={ncBusy}
              onClick={async () => {
                const lim = Number(ncLimit);
                if (!ncName.trim() || ncPhone.replace(/\D/g, '').length < 9 || !(lim > 0)) {
                  toast.error('Check name, phone, and limit');
                  return;
                }
                setNcBusy(true);
                try {
                  const ok = await onCreateCustomer(ncName.trim(), ncPhone.trim(), lim);
                  if (ok) {
                    toast.success('Customer added');
                    setShowNewCustomer(false);
                    setNcName('');
                    setNcPhone('');
                    setNcLimit('');
                  }
                  // Failure toasts are surfaced from useAppState (validation +
                  // API error messages). Avoid a duplicate generic toast here.
                } finally {
                  setNcBusy(false);
                }
              }}>
              {ncBusy ? 'Saving…' : 'Save customer'}
            </KPButton>
          </div>
        </div>
      )}
    </PageTransition>);

};