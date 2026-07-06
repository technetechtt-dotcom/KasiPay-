import { useState } from 'react';
import {
  KPCard,
  PageTransition,
  KPBadge,
  KPButton,
  KPInput,
} from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  ShoppingBag,
  Clock,
  CheckCircle2,
  Search,
  Plus,
  X,
} from 'lucide-react';
import type { LaybyOrder } from '../../types';
import { toast } from 'sonner';

export const LaybyPage = ({
  orders,
  onCreateLayby,
  onAddPayment,
  navigate,
}: {
  orders: LaybyOrder[];
  onCreateLayby: (payload: {
    customerName: string;
    customerPhone: string;
    itemName: string;
    totalPrice: number;
    amountPaid: number;
  }) => Promise<boolean>;
  /** Record an installment payment against an existing layby. */
  onAddPayment?: (id: string, amount: number) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  /** Inline "record payment" controls per layby card. */
  const [paymentDrafts, setPaymentDrafts] = useState<Record<string, string>>({});
  const [payingId, setPayingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'active' | 'completed'>('active');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [itemName, setItemName] = useState('');
  const [totalPrice, setTotalPrice] = useState('');
  const [amountPaid, setAmountPaid] = useState('');

  const filteredOrders = orders.filter(
    (o) =>
      o.status === activeTab &&
      (o.customerName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        o.itemName.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const submit = async () => {
    const total = Number(totalPrice);
    const paid = Number(amountPaid);
    if (
      !customerName.trim() ||
      customerPhone.replace(/\D/g, '').length < 9 ||
      !itemName.trim() ||
      !(total > 0) ||
      paid < 0 ||
      paid > total
    ) {
      toast.error('Check customer, item and amounts');
      return;
    }
    setBusy(true);
    try {
      const ok = await onCreateLayby({
        customerName: customerName.trim(),
        customerPhone: customerPhone.replace(/\s/g, ''),
        itemName: itemName.trim(),
        totalPrice: total,
        amountPaid: paid,
      });
      if (ok) {
        toast.success('Layby saved');
        setShowForm(false);
        setCustomerName('');
        setCustomerPhone('');
        setItemName('');
        setTotalPrice('');
        setAmountPaid('');
      } else toast.error('Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition className="flex flex-col h-full bg-slate-50 relative">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">Layby Orders</h2>
          </div>
          <div className="w-10 h-10 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center">
            <ShoppingBag className="w-5 h-5" />
          </div>
        </div>

        <KPButton
          type="button"
          className="bg-amber-600 hover:bg-amber-700 mb-4"
          onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4 mr-2" /> New layby
        </KPButton>

        <div className="flex p-1 bg-slate-100 rounded-xl mb-4">
          <button
            type="button"
            onClick={() => setActiveTab('active')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'active' ? 'bg-white text-amber-700 shadow-sm' : 'text-slate-500'}`}>
            Active Laybys
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('completed')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'completed' ? 'bg-white text-amber-700 shadow-sm' : 'text-slate-500'}`}>
            Completed
          </button>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search customer or item..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-100 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 pb-28">
        {filteredOrders.length === 0 ?
          <div className="text-center py-12 text-slate-500">
            <ShoppingBag className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p>No {activeTab} layby orders found</p>
          </div>
        : <div className="space-y-4">
            {filteredOrders.map((order) => {
              const progress =
                order.totalPrice > 0 ?
                  (order.amountPaid / order.totalPrice) * 100 :
                  0;
              const remaining = order.totalPrice - order.amountPaid;
              return (
                <KPCard key={order.id} className="p-4">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h3 className="font-bold text-slate-900">{order.customerName}</h3>
                      <p className="text-xs text-slate-500">{order.customerPhone}</p>
                    </div>
                    {order.status === 'completed' ?
                      <KPBadge variant="success">
                        <CheckCircle2 className="w-3 h-3 mr-1" /> Paid Full
                      </KPBadge>
                    : <KPBadge variant="warning">
                        <Clock className="w-3 h-3 mr-1" /> Active
                      </KPBadge>}
                  </div>

                  <div className="bg-slate-50 rounded-xl p-3 mb-4 border border-slate-100">
                    <p className="font-medium text-slate-800 mb-2">{order.itemName}</p>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-slate-500">Total Price</span>
                      <span className="font-bold">R{order.totalPrice.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500">Amount Paid</span>
                      <span className="font-bold text-emerald-600">
                        R{order.amountPaid.toFixed(2)}
                      </span>
                    </div>
                  </div>

                  {order.status === 'active' && (
                    <div>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-slate-500">Progress</span>
                        <span className="font-bold text-amber-600">
                          {progress.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-2 bg-slate-100 rounded-full overflow-hidden mb-2">
                        <div
                          className="h-full bg-amber-500 rounded-full"
                          style={{ width: `${Math.min(100, progress)}%` }}
                        />
                      </div>
                      <p className="text-xs text-center text-slate-500 mb-3">
                        R{remaining.toFixed(2)} remaining to collect item
                      </p>
                      {onAddPayment ?
                        <div className="flex gap-2">
                          <input
                            type="number"
                            inputMode="decimal"
                            placeholder="Amount (R)"
                            value={paymentDrafts[order.id] ?? ''}
                            onChange={(e) =>
                              setPaymentDrafts((prev) => ({
                                ...prev,
                                [order.id]: e.target.value,
                              }))
                            }
                            className="flex-1 bg-slate-50 rounded-lg px-3 py-2 text-sm border border-slate-200 focus:outline-none focus:ring-2 focus:ring-amber-500/30"
                          />
                          <button
                            type="button"
                            disabled={payingId === order.id}
                            onClick={async () => {
                              const amt = Number(paymentDrafts[order.id] ?? '');
                              if (!(amt > 0)) {
                                toast.error('Enter a positive amount');
                                return;
                              }
                              if (amt > remaining + 0.01) {
                                toast.error(
                                  `Max R${remaining.toFixed(2)} remaining`,
                                );
                                return;
                              }
                              setPayingId(order.id);
                              try {
                                const ok = await onAddPayment(order.id, amt);
                                if (ok) {
                                  toast.success('Payment recorded');
                                  setPaymentDrafts((prev) => ({
                                    ...prev,
                                    [order.id]: '',
                                  }));
                                }
                              } finally {
                                setPayingId(null);
                              }
                            }}
                            className="px-3 py-2 rounded-lg bg-amber-600 text-white text-sm font-medium disabled:bg-amber-300">
                            {payingId === order.id ? '…' : 'Record'}
                          </button>
                        </div>
                      : null}
                    </div>
                  )}
                </KPCard>
              );
            })}
          </div>
        }
      </div>

      {showForm && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end justify-center sm:items-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg">New layby</h3>
              <button type="button" onClick={() => setShowForm(false)} aria-label="Close">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <KPInput label="Customer name" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            <KPInput label="Phone" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
            <KPInput label="Item description" value={itemName} onChange={(e) => setItemName(e.target.value)} />
            <KPInput label="Total price (R)" type="number" value={totalPrice} onChange={(e) => setTotalPrice(e.target.value)} />
            <KPInput label="Deposit paid (R)" type="number" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
            <KPButton
              type="button"
              disabled={busy}
              className="mt-4 bg-amber-600"
              onClick={() => void submit()}>
              {busy ? 'Saving…' : 'Save layby'}
            </KPButton>
          </div>
        </div>
      )}
    </PageTransition>
  );
};
