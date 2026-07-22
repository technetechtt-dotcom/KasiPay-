import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  KPButton,
  KPCard,
  KPInput,
  PageTransition,
} from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  Plus,
  Trash2,
  Receipt,
  Package,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Product } from '../../types';
import {
  addMoney,
  canonicalMoney,
  compareMoney,
  formatMoney,
  multiplyMoney,
  type MoneyInput,
} from '../../money';

type SlipLine = {
  key: string;
  productId: string;
  name: string;
  quantity: string;
  costPrice: string;
  isNew: boolean;
  category: string;
  sellingPrice: string;
};

const CATEGORIES = ['Food', 'Drinks', 'Airtime', 'Household'];

function emptyLine(): SlipLine {
  return {
    key: crypto.randomUUID(),
    productId: '',
    name: '',
    quantity: '',
    costPrice: '',
    isNew: false,
    category: 'Food',
    sellingPrice: '',
  };
}

export const RecordPurchaseSlipPage = ({
  products,
  onRecordPurchase,
  navigate,
}: {
  products: Product[];
  onRecordPurchase: (input: {
    supplierName?: string;
    slipReference?: string;
    slipTotal: MoneyInput;
    notes?: string;
    lines: {
      productId?: string;
      name?: string;
      quantity: number;
      costPrice: MoneyInput;
      sellingPrice?: MoneyInput;
      category?: string;
    }[];
  }) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [supplierName, setSupplierName] = useState('');
  const [slipReference, setSlipReference] = useState('');
  const [slipTotal, setSlipTotal] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<SlipLine[]>([emptyLine(), emptyLine()]);
  const [busy, setBusy] = useState(false);

  const computedTotal = useMemo(() => {
    return lines.reduce((sum, line) => {
      const qty = parseInt(line.quantity, 10) || 0;
      const cost = line.costPrice || '0.00';
      return addMoney(sum, multiplyMoney(cost, qty));
    }, '0.00');
  }, [lines]);

  const parsedSlipTotal = slipTotal || '0.00';
  const slipTotalValue =
    compareMoney(parsedSlipTotal, 0) > 0
      ? canonicalMoney(parsedSlipTotal)
      : computedTotal;
  const totalsMatch =
    compareMoney(parsedSlipTotal, 0) <= 0 ||
    compareMoney(parsedSlipTotal, computedTotal) === 0;

  const updateLine = (key: string, patch: Partial<SlipLine>) => {
    setLines((prev) =>
      prev.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  };

  const selectProduct = (key: string, productId: string) => {
    const product = products.find((p) => p.id === productId);
    if (!product) return;
    updateLine(key, {
      productId,
      name: product.name,
      costPrice: product.costPrice.toString(),
      isNew: false,
      category: product.category,
      sellingPrice: product.price.toString(),
    });
  };

  const handleSubmit = async () => {
    const payloadLines = lines
      .map((line) => {
        const quantity = parseInt(line.quantity, 10);
        const costPrice = line.costPrice;
        if (!(quantity > 0) || compareMoney(costPrice || '0.00', 0) < 0)
          return null;
        if (line.isNew) {
          const name = line.name.trim();
          const sellingPrice = line.sellingPrice;
          if (!name || compareMoney(sellingPrice || '0.00', 0) <= 0)
            return null;
          return {
            name,
            quantity,
            costPrice,
            sellingPrice,
            category: line.category,
          };
        }
        if (!line.productId) return null;
        return { productId: line.productId, quantity, costPrice };
      })
      .filter(Boolean) as {
      productId?: string;
      name?: string;
      quantity: number;
      costPrice: MoneyInput;
      sellingPrice?: MoneyInput;
      category?: string;
    }[];

    if (payloadLines.length === 0) {
      toast.error('Add at least one valid line item.');
      return;
    }
    if (!totalsMatch) {
      toast.error(
        `Slip total R${formatMoney(parsedSlipTotal)} must match line items R${formatMoney(computedTotal)}.`,
      );
      return;
    }

    setBusy(true);
    try {
      const ok = await onRecordPurchase({
        supplierName: supplierName.trim() || undefined,
        slipReference: slipReference.trim() || undefined,
        slipTotal: slipTotalValue,
        notes: notes.trim() || undefined,
        lines: payloadLines,
      });
      if (ok) {
        toast.success('Purchase slip recorded — stock and expenses updated.');
        navigate('inventory');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition className="flex flex-col min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => navigate('inventory')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">
            Record Purchase Slip
          </h2>
        </div>
        <p className="text-sm text-slate-500 mt-2">
          Enter wholesaler slip totals to update inventory and balance your books.
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-28 space-y-5">
        <KPCard className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-100 text-blue-700 flex items-center justify-center">
              <Receipt className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900">Slip details</h3>
              <p className="text-xs text-slate-500">Supplier receipt / delivery note</p>
            </div>
          </div>
          <KPInput
            placeholder="Supplier name (e.g. Wholesale National)"
            value={supplierName}
            onChange={(e) => setSupplierName(e.target.value)}
          />
          <KPInput
            placeholder="Slip / invoice number"
            value={slipReference}
            onChange={(e) => setSlipReference(e.target.value)}
          />
          <KPInput
            type="number"
            placeholder="Slip total (R) — must match line items"
            value={slipTotal}
            onChange={(e) => setSlipTotal(e.target.value)}
          />
          {!totalsMatch && compareMoney(parsedSlipTotal, 0) > 0 ? (
            <p className="text-xs text-red-600">
              Slip total differs from line items (R{formatMoney(computedTotal)}).
            </p>
          ) : (
            <p className="text-xs text-slate-500">
              Line items total: R{formatMoney(computedTotal)}
              {compareMoney(parsedSlipTotal, 0) <= 0
                ? ' — leave blank to use this total'
                : ''}
            </p>
          )}
          <KPInput
            placeholder="Notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </KPCard>

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">
              Line items
            </h3>
            <button
              type="button"
              onClick={() => setLines((prev) => [...prev, emptyLine()])}
              className="text-xs font-semibold text-emerald-700 flex items-center gap-1">
              <Plus className="w-4 h-4" /> Add line
            </button>
          </div>

          {lines.map((line, index) => (
            <motion.div key={line.key} layout>
              <KPCard className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-400">
                    Item {index + 1}
                  </span>
                  {lines.length > 1 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setLines((prev) => prev.filter((l) => l.key !== line.key))
                      }
                      className="text-slate-400 hover:text-red-600">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  ) : null}
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => updateLine(line.key, { isNew: false, productId: '', name: '' })}
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold ${
                      !line.isNew
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}>
                    Existing product
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateLine(line.key, {
                        isNew: true,
                        productId: '',
                        name: '',
                      })
                    }
                    className={`flex-1 py-2 rounded-lg text-xs font-semibold ${
                      line.isNew
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-100 text-slate-600'
                    }`}>
                    New product
                  </button>
                </div>

                {!line.isNew ? (
                  <select
                    value={line.productId}
                    onChange={(e) => selectProduct(line.key, e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-3 text-sm">
                    <option value="">Select product…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.stock} in stock)
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <KPInput
                      placeholder="Product name"
                      value={line.name}
                      onChange={(e) => updateLine(line.key, { name: e.target.value })}
                    />
                    <div className="flex flex-wrap gap-2">
                      {CATEGORIES.map((cat) => (
                        <button
                          key={cat}
                          type="button"
                          onClick={() => updateLine(line.key, { category: cat })}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                            line.category === cat
                              ? 'bg-emerald-600 text-white'
                              : 'bg-slate-100 text-slate-600'
                          }`}>
                          {cat}
                        </button>
                      ))}
                    </div>
                    <KPInput
                      type="number"
                      placeholder="Selling price (R)"
                      value={line.sellingPrice}
                      onChange={(e) =>
                        updateLine(line.key, { sellingPrice: e.target.value })
                      }
                    />
                  </>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <KPInput
                    type="number"
                    placeholder="Qty"
                    value={line.quantity}
                    onChange={(e) =>
                      updateLine(line.key, { quantity: e.target.value })
                    }
                  />
                  <KPInput
                    type="number"
                    placeholder="Unit cost (R)"
                    value={line.costPrice}
                    onChange={(e) =>
                      updateLine(line.key, { costPrice: e.target.value })
                    }
                  />
                </div>

                {(parseInt(line.quantity, 10) || 0) > 0 &&
                compareMoney(line.costPrice || '0.00', 0) >= 0 ? (
                  <p className="text-xs text-emerald-700 font-medium">
                    Line total: R
                    {formatMoney(
                      multiplyMoney(
                        line.costPrice || '0.00',
                        parseInt(line.quantity, 10) || 0,
                      ),
                    )}
                  </p>
                ) : null}
              </KPCard>
            </motion.div>
          ))}
        </div>

        <KPCard className="p-4 bg-slate-900 text-white">
          <div className="flex items-center gap-3">
            <Package className="w-5 h-5 text-emerald-400" />
            <div className="flex-1">
              <p className="text-xs text-slate-400 uppercase tracking-wider">
                Books impact
              </p>
              <p className="font-bold text-lg">
                R{formatMoney(slipTotalValue)} supplier expense
              </p>
              <p className="text-xs text-slate-400 mt-1">
                Stock levels update and appear on your expense statement.
              </p>
            </div>
          </div>
        </KPCard>
      </div>

      <div className="shrink-0 bg-white border-t border-slate-200 p-6 pb-safe">
        <KPButton onClick={handleSubmit} disabled={busy || !totalsMatch}>
          {busy ? 'Saving…' : 'Record slip & update books'}
        </KPButton>
      </div>
    </PageTransition>
  );
};
