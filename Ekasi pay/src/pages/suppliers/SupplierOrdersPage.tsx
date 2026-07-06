import { useState } from 'react';
import {
  KPCard,
  KPButton,
  KPInput,
  PageTransition,
  KPBadge,
} from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  Truck,
  Phone,
  Calendar,
  Package,
  CheckCircle2,
  Clock,
  Plus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Supplier, SupplierOrder } from '../../types';

type Line = { name: string; quantity: number; unitCost: number };

export const SupplierOrdersPage = ({
  suppliers,
  orders,
  onCreateOrder,
  onCreateSupplier,
  onUpdateOrderStatus,
  navigate,
}: {
  suppliers: Supplier[];
  orders: SupplierOrder[];
  onCreateOrder: (payload: {
    supplierId: string;
    items: Line[];
    total: number;
    expectedDelivery?: string;
  }) => Promise<boolean>;
  onCreateSupplier: (payload: {
    name: string;
    phone: string;
    category: string;
  }) => Promise<boolean>;
  onUpdateOrderStatus: (
    orderId: string,
    status: 'pending' | 'confirmed' | 'delivered'
  ) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [activeTab, setActiveTab] = useState<'orders' | 'suppliers'>('orders');
  const [showPlaceOrder, setShowPlaceOrder] = useState(false);
  const [showAddSupplier, setShowAddSupplier] = useState(false);

  const [orderSupplierId, setOrderSupplierId] = useState('');
  const [expectedDelivery, setExpectedDelivery] = useState('');
  const [lines, setLines] = useState<Line[]>([{ name: '', quantity: 1, unitCost: 0 }]);
  const [busy, setBusy] = useState(false);

  const [newSupplierName, setNewSupplierName] = useState('');
  const [newSupplierPhone, setNewSupplierPhone] = useState('');
  const [newSupplierCategory, setNewSupplierCategory] = useState('Groceries');

  const pendingOrders = orders.filter(
    (o) => o.status === 'pending' || o.status === 'confirmed'
  );
  const deliveredOrders = orders.filter((o) => o.status === 'delivered');

  const orderTotal =
    lines.reduce((s, l) => s + Math.max(0, l.quantity) * Math.max(0, l.unitCost), 0) ||
    0;

  const submitOrder = async () => {
    if (!orderSupplierId) {
      toast.error('Choose a supplier');
      return;
    }
    const cleanLines = lines.filter((l) => l.name.trim() && l.quantity > 0);
    if (cleanLines.length === 0) {
      toast.error('Add at least one line item');
      return;
    }
    setBusy(true);
    try {
      const ok = await onCreateOrder({
        supplierId: orderSupplierId,
        items: cleanLines.map((l) => ({
          name: l.name.trim(),
          quantity: Math.floor(l.quantity),
          unitCost: l.unitCost,
        })),
        total: orderTotal,
        expectedDelivery: expectedDelivery.trim() || undefined,
      });
      if (ok) {
        toast.success('Order placed');
        setShowPlaceOrder(false);
        setLines([{ name: '', quantity: 1, unitCost: 0 }]);
        setExpectedDelivery('');
        setOrderSupplierId('');
      } else {
        toast.error('Could not place order');
      }
    } finally {
      setBusy(false);
    }
  };

  const submitSupplier = async () => {
    if (!newSupplierName.trim() || newSupplierPhone.replace(/\D/g, '').length < 9) {
      toast.error('Enter name and valid phone');
      return;
    }
    setBusy(true);
    try {
      const ok = await onCreateSupplier({
        name: newSupplierName.trim(),
        phone: newSupplierPhone.trim(),
        category: newSupplierCategory.trim(),
      });
      if (ok) {
        toast.success('Supplier saved');
        setShowAddSupplier(false);
        setNewSupplierName('');
        setNewSupplierPhone('');
        setNewSupplierCategory('Groceries');
      } else {
        toast.error('Could not add supplier');
      }
    } finally {
      setBusy(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'pending':
        return (
          <KPBadge variant="warning">
            <Clock className="w-3 h-3 mr-1" /> Pending
          </KPBadge>
        );
      case 'confirmed':
        return (
          <KPBadge variant="info">
            <Package className="w-3 h-3 mr-1" /> Confirmed
          </KPBadge>
        );
      case 'delivered':
        return (
          <KPBadge variant="success">
            <CheckCircle2 className="w-3 h-3 mr-1" /> Delivered
          </KPBadge>
        );
      default:
        return null;
    }
  };

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50 relative">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors"
              type="button">
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">Supplier Orders</h2>
          </div>
          <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center">
            <Truck className="w-5 h-5" />
          </div>
        </div>

        <div className="flex p-1 bg-slate-100 rounded-xl">
          <button
            type="button"
            onClick={() => setActiveTab('orders')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'orders' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}>
            Active Orders
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('suppliers')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'suppliers' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}>
            My Suppliers
          </button>
        </div>

        <div className="mt-4">
          {activeTab === 'orders' ?
            <KPButton
              className="w-full bg-blue-600 hover:bg-blue-700"
              type="button"
              disabled={suppliers.length === 0}
              onClick={() => setShowPlaceOrder(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Place order
            </KPButton>
          : <KPButton
              className="w-full bg-blue-600 hover:bg-blue-700"
              type="button"
              onClick={() => setShowAddSupplier(true)}>
              <Plus className="w-4 h-4 mr-2" />
              Add supplier
            </KPButton>}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-28">
        {activeTab === 'orders' ?
          <div className="space-y-6">
            {pendingOrders.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
                  Expected Deliveries
                </h3>
                <div className="space-y-3">
                  {pendingOrders.map((order) => {
                    const supplier = suppliers.find((s) => s.id === order.supplierId);
                    return (
                      <KPCard key={order.id} className="p-4">
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <h4 className="font-bold text-slate-900">{supplier?.name ?? 'Supplier'}</h4>
                            <p className="text-xs text-slate-500">
                              Order #{order.id.substring(0, 8).toUpperCase()}
                            </p>
                          </div>
                          {getStatusBadge(order.status)}
                        </div>
                        <div className="bg-slate-50 rounded-lg p-3 mb-3">
                          {order.items.map((item, i) => (
                            <div
                              key={i}
                              className="flex justify-between text-sm mb-1 last:mb-0">
                              <span className="text-slate-600">
                                {item.quantity}x {item.name}
                              </span>
                              <span className="font-medium">
                                R{(item.quantity * item.unitCost).toFixed(2)}
                              </span>
                            </div>
                          ))}
                          <div className="border-t border-slate-200 mt-2 pt-2 flex justify-between font-bold">
                            <span>Total</span>
                            <span className="text-blue-600">
                              R{order.total.toFixed(2)}
                            </span>
                          </div>
                        </div>
                        {order.expectedDelivery && (
                          <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 p-2 rounded-lg mb-3">
                            <Calendar className="w-4 h-4" />
                            <span className="font-medium">
                              Expected: {order.expectedDelivery}
                            </span>
                          </div>
                        )}
                        <div className="flex gap-2">
                          {order.status === 'pending' && (
                            <KPButton
                              type="button"
                              variant="outline"
                              className="flex-1 text-xs"
                              onClick={async () => {
                                const ok = await onUpdateOrderStatus(order.id, 'confirmed');
                                if (ok) toast.success('Marked confirmed'); else toast.error('Update failed');
                              }}>
                              Confirm
                            </KPButton>
                          )}
                          {order.status === 'confirmed' && (
                            <KPButton
                              type="button"
                              className="flex-1 text-xs bg-emerald-600"
                              onClick={async () => {
                                const ok = await onUpdateOrderStatus(order.id, 'delivered');
                                if (ok) toast.success('Delivered'); else toast.error('Update failed');
                              }}>
                              Delivered
                            </KPButton>
                          )}
                        </div>
                      </KPCard>
                    );
                  })}
                </div>
              </div>
            )}

            {deliveredOrders.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
                  Recent Deliveries
                </h3>
                <div className="space-y-3">
                  {deliveredOrders.map((order) => {
                    const supplier = suppliers.find((s) => s.id === order.supplierId);
                    return (
                      <KPCard key={order.id} className="p-4 opacity-75">
                        <div className="flex justify-between items-center mb-2">
                          <h4 className="font-bold text-slate-900">
                            {supplier?.name ?? 'Supplier'}
                          </h4>
                          {getStatusBadge(order.status)}
                        </div>
                        <div className="flex justify-between text-sm">
                          <span className="text-slate-500">{order.items.length} items</span>
                          <span className="font-medium text-slate-700">
                            R{order.total.toFixed(2)}
                          </span>
                        </div>
                      </KPCard>
                    );
                  })}
                </div>
              </div>
            )}

            {pendingOrders.length === 0 && deliveredOrders.length === 0 && (
              <div className="text-center py-16 text-slate-500">
                <Truck className="w-12 h-12 mx-auto mb-3 opacity-40" />
                <p>No orders yet. Tap “Place order”. </p>
              </div>
            )}
          </div>
        : <div className="space-y-3">
            {suppliers.map((supplier) => (
              <KPCard key={supplier.id} className="p-4">
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <h3 className="font-bold text-slate-900">{supplier.name}</h3>
                    <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-medium">
                      {supplier.category}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => window.open(`tel:${supplier.phone}`)}
                    className="w-8 h-8 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center active:bg-blue-100">
                    <Phone className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Truck className="w-4 h-4 text-slate-400" />
                  <span>
                    Delivers on:{' '}
                    <span className="font-medium">
                      {(supplier.deliveryDays ?? []).join(', ') || '—'}
                    </span>
                  </span>
                </div>
              </KPCard>
            ))}
            {suppliers.length === 0 && (
              <p className="text-center text-slate-500 py-12">Add your first supplier</p>
            )}
          </div>
        }
      </div>

      {showPlaceOrder && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl sm:max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg">Place supplier order</h3>
              <button type="button" onClick={() => setShowPlaceOrder(false)} aria-label="Close">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Supplier</label>
            <select
              className="w-full bg-slate-50 border rounded-xl py-3 px-3 mb-4 text-sm"
              value={orderSupplierId}
              onChange={(e) => setOrderSupplierId(e.target.value)}>
              <option value="">Select…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <label className="block text-sm font-medium text-slate-700 mb-1">Expected delivery (optional)</label>
            <KPInput
              className="mb-4"
              value={expectedDelivery}
              onChange={(e) => setExpectedDelivery(e.target.value)}
              placeholder="e.g. 2026-06-01"
            />
            <p className="text-xs font-bold text-slate-500 uppercase mb-2">Lines</p>
            {lines.map((line, idx) => (
              <div key={idx} className="flex gap-2 mb-2">
                <KPInput
                  placeholder="Product"
                  className="flex-1 text-sm"
                  value={line.name}
                  onChange={(e) => {
                    const n = [...lines];
                    n[idx] = { ...n[idx], name: e.target.value };
                    setLines(n);
                  }}
                />
                <KPInput
                  type="number"
                  className="w-16 text-sm"
                  value={line.quantity || ''}
                  onChange={(e) => {
                    const n = [...lines];
                    n[idx] = { ...n[idx], quantity: Number(e.target.value) };
                    setLines(n);
                  }}
                />
                <KPInput
                  type="number"
                  placeholder="Cost"
                  className="w-20 text-sm"
                  value={line.unitCost || ''}
                  onChange={(e) => {
                    const n = [...lines];
                    n[idx] = { ...n[idx], unitCost: Number(e.target.value) };
                    setLines(n);
                  }}
                />
              </div>
            ))}
            <KPButton
              type="button"
              variant="outline"
              className="w-full mb-4"
              onClick={() => setLines([...lines, { name: '', quantity: 1, unitCost: 0 }])}>
              Add line
            </KPButton>
            <p className="text-right font-bold text-slate-900 mb-4">
              Total R{orderTotal.toFixed(2)}
            </p>
            <KPButton
              type="button"
              className="w-full"
              disabled={busy}
              onClick={() => void submitOrder()}>
              {busy ? 'Saving…' : 'Submit order'}
            </KPButton>
          </div>
        </div>
      )}

      {showAddSupplier && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-xl sm:max-w-md">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg">Add supplier</h3>
              <button type="button" onClick={() => setShowAddSupplier(false)} aria-label="Close">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Name</label>
            <KPInput className="mb-3" value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} />
            <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
            <KPInput className="mb-3" value={newSupplierPhone} onChange={(e) => setNewSupplierPhone(e.target.value)} />
            <label className="block text-sm font-medium text-slate-700 mb-1">Category</label>
            <KPInput
              className="mb-4"
              value={newSupplierCategory}
              onChange={(e) => setNewSupplierCategory(e.target.value)}
            />
            <KPButton
              type="button"
              className="w-full"
              disabled={busy}
              onClick={() => void submitSupplier()}>
              {busy ? 'Saving…' : 'Save supplier'}
            </KPButton>
          </div>
        </div>
      )}
    </PageTransition>
  );
};
