import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  KPButton,
  KPCard,
  KPInput,
  PageTransition } from
'../../components/shared/UIComponents';
import {
  ArrowLeft,
  Package,
  CheckCircle2,
  Tag,
  Hash,
  Layers,
  ScanLine,
  TrendingUp,
  Plus } from
'lucide-react';
import { toast } from 'sonner';
import {
  consumePendingProductCatalogHit,
  writeScannerSession,
} from '../../lib/scannerSession';
import { groceryLookupCode } from '../../lib/productBarcode';
import { apiLookupProductBarcode } from '../../services/api';
import type { Product } from '../../types';
import { findExistingMatch } from './findExistingMatch';

const CATEGORIES = ['Food', 'Drinks', 'Airtime', 'Household'];

export const AddStockPage = ({
  onAddProduct,
  onRestockProduct,
  existingProducts,
  navigate,
  scannedBarcode,
}: {
  onRestockProduct?: (
    productId: string,
    quantity: number,
    options?: {
      costPrice?: number;
      supplierName?: string;
      slipReference?: string;
    },
  ) => void | Promise<void>;
  onAddProduct: (product: {
    name: string;
    costPrice: number;
    price: number;
    stock: number;
    category: string;
    barcode?: string;
    supplierName?: string;
    slipReference?: string;
  }) => void | Promise<void>;
  existingProducts: Product[];
  navigate: (p: string) => void;
  scannedBarcode?: string;
}) => {
  const [name, setName] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [stock, setStock] = useState('');
  const [category, setCategory] = useState('Food');
  const [barcode, setBarcode] = useState('');
  const [success, setSuccess] = useState(false);
  const [addedName, setAddedName] = useState('');
  const [catalogHint, setCatalogHint] = useState<string | null>(null);
  const [scannerPrefillCode, setScannerPrefillCode] = useState<string | null>(null);
  const [supplierName, setSupplierName] = useState('');
  const [slipReference, setSlipReference] = useState('');

  useEffect(() => {
    if (scannedBarcode) {
      setBarcode(scannedBarcode);
    }
    const pending = consumePendingProductCatalogHit();
    if (!pending) return;
    setScannerPrefillCode(pending.code);
    if (pending.found && pending.name) {
      setName((current) => (current.trim() ? current : pending.name ?? ''));
      if (pending.category) {
        setCategory((current) =>
          current === 'Food' ? pending.category ?? current : current,
        );
      }
      setCatalogHint('Found instantly from product database — check name and prices.');
      return;
    }
    setCatalogHint('No product found in live catalog — enter details manually.');
  }, [scannedBarcode]);

  const existingMatch = useMemo(
    () => findExistingMatch(existingProducts, name, barcode),
    [existingProducts, name, barcode],
  );

  useEffect(() => {
    const code = groceryLookupCode(barcode);
    if (code.length < 8 || existingMatch) {
      setCatalogHint(null);
      return;
    }
    if (scannerPrefillCode === code) {
      return;
    }
    let active = true;
    apiLookupProductBarcode(code)
      .then((hit) => {
        if (!active) return;
        if (!hit.found || !hit.name) {
          setCatalogHint(null);
          return;
        }
        setName((current) => (current.trim() ? current : hit.name ?? ''));
        if (hit.category) {
          setCategory((current) =>
            current === 'Food' ? hit.category : current,
          );
        }
        setCatalogHint(`Identified from product database — check name and prices.`);
      })
      .catch(() => {
        if (active) setCatalogHint(null);
      });
    return () => {
      active = false;
    };
  }, [barcode, existingMatch, scannerPrefillCode]);

  // When we detect a matching SKU, prefill price/category fields that the
  // merchant hasn't manually filled in yet — so they only have to type the
  // quantity they just added. Functional setState preserves any value they
  // already typed.
  useEffect(() => {
    if (!existingMatch) return;
    setName((current) =>
      current.trim() ? current : existingMatch.name,
    );
    setCostPrice((current) =>
      current.trim() === '' && existingMatch.costPrice
        ? existingMatch.costPrice.toString()
        : current,
    );
    setSellingPrice((current) =>
      current.trim() === '' && existingMatch.price
        ? existingMatch.price.toString()
        : current,
    );
    setCategory((current) =>
      current === 'Food' ? existingMatch.category : current,
    );
  }, [existingMatch]);

  const costVal = parseFloat(costPrice) || 0;
  const sellVal = parseFloat(sellingPrice) || 0;
  const stockQty = parseInt(stock) || 0;
  const margin = sellVal > 0 && costVal > 0 ? sellVal - costVal : 0;
  const marginPct = costVal > 0 ? (margin / costVal) * 100 : 0;
  const isRestock = existingMatch !== null;
  const newTotal = isRestock ? existingMatch.stock + stockQty : stockQty;

  const isValid = isRestock
    ? stockQty > 0
    : name.trim().length > 0 &&
      costVal > 0 &&
      sellVal > 0 &&
      sellVal >= costVal &&
      stockQty > 0;

  const handleSubmit = async () => {
    if (!isValid) return;
    if (isRestock && existingMatch && onRestockProduct) {
      await onRestockProduct(existingMatch.id, stockQty, {
        costPrice: costVal > 0 ? costVal : existingMatch.costPrice,
        supplierName: supplierName.trim() || undefined,
        slipReference: slipReference.trim() || undefined,
      });
      setAddedName(
        `${existingMatch.name} (+${stockQty}, now ${newTotal} in stock)`,
      );
      setSuccess(true);
      toast.success(
        `Added ${stockQty} to ${existingMatch.name} — new total ${newTotal}`,
      );
      return;
    }
    await onAddProduct({
      name: name.trim(),
      costPrice: costVal,
      price: sellVal,
      stock: stockQty,
      category,
      barcode: barcode.trim() || undefined,
      supplierName: supplierName.trim() || undefined,
      slipReference: slipReference.trim() || undefined,
    });
    setAddedName(name.trim());
    setSuccess(true);
    toast.success('Product added!');
  };

  const handleAddAnother = () => {
    setName('');
    setCostPrice('');
    setSellingPrice('');
    setStock('');
    setBarcode('');
    setCategory('Food');
    setCatalogHint(null);
    setScannerPrefillCode(null);
    setSupplierName('');
    setSlipReference('');
    setSuccess(false);
  };
  if (success) {
    return (
      <PageTransition className="flex flex-col min-h-0 h-full bg-slate-50">
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <motion.div
            initial={{
              scale: 0,
              opacity: 0
            }}
            animate={{
              scale: 1,
              opacity: 1
            }}
            transition={{
              type: 'spring',
              stiffness: 200,
              damping: 15
            }}
            className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mb-6">
            
            <CheckCircle2 className="w-10 h-10 text-emerald-600" />
          </motion.div>
          <motion.h2
            initial={{
              opacity: 0,
              y: 10
            }}
            animate={{
              opacity: 1,
              y: 0
            }}
            transition={{
              delay: 0.15
            }}
            className="text-2xl font-bold text-slate-900 mb-2">
            
            {addedName.includes('(+') ? 'Stock Topped Up!' : 'Product Added!'}
          </motion.h2>
          <motion.p
            initial={{
              opacity: 0,
              y: 10
            }}
            animate={{
              opacity: 1,
              y: 0
            }}
            transition={{
              delay: 0.25
            }}
            className="text-slate-500 mb-8">
            
            <span className="font-medium text-slate-700">{addedName}</span> is
            now in your inventory.
          </motion.p>
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
              delay: 0.35
            }}
            className="w-full space-y-3">
            
            <KPButton onClick={handleAddAnother}>Add Another Product</KPButton>
            <KPButton variant="outline" onClick={() => navigate('inventory')}>
              Back to Inventory
            </KPButton>
          </motion.div>
        </div>
      </PageTransition>);

  }
  return (
    <PageTransition className="flex flex-col min-h-0 h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center">
          <button
            onClick={() => navigate('inventory')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">
            {isRestock ? 'Restock Product' : 'Add New Product'}
          </h2>
        </div>
      </div>

      {/* Form */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-12">
        {/* Existing-stock banner — surfaces when we recognise the SKU so the
            merchant knows we'll add to the current quantity, not duplicate. */}
        <AnimatePresence>
          {isRestock && (
            <motion.div
              key={existingMatch?.id ?? 'match'}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="mb-5"
            >
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
                  <Plus className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-emerald-900">
                    Already in stock — we&apos;ll top it up
                  </p>
                  <p className="text-sm text-emerald-800 mt-0.5">
                    <span className="font-medium">{existingMatch?.name}</span>{' '}
                    currently has{' '}
                    <span className="font-bold">
                      {existingMatch?.stock ?? 0}
                    </span>{' '}
                    {((existingMatch?.stock ?? 0) === 1) ? 'unit' : 'units'}.
                  </p>
                  {stockQty > 0 && (
                    <p className="text-sm text-emerald-900 mt-1">
                      Adding {stockQty} → new total{' '}
                      <span className="font-bold">{newTotal}</span>{' '}
                      {newTotal === 1 ? 'unit' : 'units'}.
                    </p>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <KPCard className="p-5 mb-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
              <Package className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-slate-900">
                {isRestock ? 'Restock Details' : 'Product Details'}
              </h3>
              <p className="text-xs text-slate-500">
                {isRestock
                  ? 'Confirm the quantity you just received'
                  : 'Fill in the info for your new stock item'}
              </p>
            </div>
          </div>

          <div className="space-y-5">
            {/* Product Name */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Product Name <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Tag className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder="e.g. Albany Bread"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all" />
                
              </div>
            </div>

            {/* Buying Price & Selling Price */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Buying Price <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-slate-400">
                    R
                  </span>
                  <input
                    type="number"
                    placeholder="0.00"
                    min="0"
                    step="0.50"
                    value={costPrice}
                    onChange={(e) => setCostPrice(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-8 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all" />
                  
                </div>
                <p className="text-[10px] text-slate-400 mt-1">
                  What you pay the supplier
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Selling Price <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-slate-400">
                    R
                  </span>
                  <input
                    type="number"
                    placeholder="0.00"
                    min="0"
                    step="0.50"
                    value={sellingPrice}
                    onChange={(e) => setSellingPrice(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-8 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all" />
                  
                </div>
                <p className="text-[10px] text-slate-400 mt-1">
                  What the customer pays
                </p>
              </div>
            </div>

            {/* Margin Indicator */}
            {costVal > 0 && sellVal > 0 &&
            <motion.div
              initial={{
                opacity: 0,
                height: 0
              }}
              animate={{
                opacity: 1,
                height: 'auto'
              }}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium ${margin > 0 ? 'bg-emerald-50 text-emerald-700' : margin === 0 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>
              
                <TrendingUp className="w-4 h-4" />
                <span>
                  Margin: R{margin.toFixed(2)} per unit ({marginPct.toFixed(0)}
                  %)
                </span>
                {sellVal < costVal &&
              <span className="text-xs ml-auto">
                    ⚠ Selling below cost!
                  </span>
              }
              </motion.div>
            }

            {/* Stock quantity — wording flips between "Initial Stock"
                (new product) and "Quantity to add" (top-up). */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                {isRestock ? 'Quantity to add' : 'Initial Stock'}{' '}
                <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Hash className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="number"
                  placeholder="0"
                  min="0"
                  value={stock}
                  onChange={(e) => setStock(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all" />
                
              </div>
              {isRestock && stockQty > 0 && (
                <p className="text-[11px] text-emerald-700 mt-1 font-medium">
                  {existingMatch?.stock ?? 0} on hand + {stockQty} new ={' '}
                  <span className="font-bold">{newTotal}</span>
                </p>
              )}
            </div>

            {/* Category */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Category <span className="text-red-500">*</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((cat) =>
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategory(cat)}
                  className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${category === cat ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-600/20' : 'bg-slate-100 text-slate-600 active:bg-slate-200'}`}>
                  
                    {cat}
                  </button>
                )}
              </div>
            </div>

            {/* Barcode (Optional) */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Barcode{' '}
                <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <div className="flex items-stretch gap-2">
                <div className="relative flex-1">
                  <Layers className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Scan or type barcode"
                    value={barcode}
                    onChange={(e) => setBarcode(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400 transition-all" />
                  
                </div>
                <button
                  type="button"
                  aria-label="Scan product barcode with camera"
                  onClick={() => {
                    writeScannerSession({
                      capture: 'product',
                      returnPage: 'add-stock',
                      continuous: false,
                    });
                    navigate('scanner');
                  }}
                  className="h-[46px] w-12 shrink-0 bg-emerald-100 text-emerald-700 rounded-xl flex items-center justify-center active:bg-emerald-200 transition-colors">
                  
                  <ScanLine className="w-5 h-5" />
                </button>
              </div>
              {catalogHint && (
                <p className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 mt-2">
                  {catalogHint}
                </p>
              )}
            </div>
          </div>
        </KPCard>

        <KPCard className="p-5 mb-6 space-y-4">
          <div>
            <h3 className="font-bold text-slate-900">Supplier slip (optional)</h3>
            <p className="text-xs text-slate-500">
              Record slip details to post a supplier expense and balance your books.
            </p>
          </div>
          <KPInput
            placeholder="Supplier name"
            value={supplierName}
            onChange={(e) => setSupplierName(e.target.value)}
          />
          <KPInput
            placeholder="Slip / invoice number"
            value={slipReference}
            onChange={(e) => setSlipReference(e.target.value)}
          />
          {stockQty > 0 && costVal > 0 ? (
            <p className="text-xs text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
              Purchase total for books: R{(stockQty * costVal).toFixed(2)}
            </p>
          ) : null}
        </KPCard>

        {/* Preview */}
        <AnimatePresence>
          {name.trim() &&
          <motion.div
            initial={{
              opacity: 0,
              height: 0
            }}
            animate={{
              opacity: 1,
              height: 'auto'
            }}
            exit={{
              opacity: 0,
              height: 0
            }}>
            
              <h3 className="text-sm font-bold text-slate-500 mb-2 uppercase tracking-wider">
                Preview
              </h3>
              <KPCard className="p-4 border-2 border-dashed border-emerald-200 bg-emerald-50/30">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center">
                    <Package className="w-5 h-5 text-slate-400" />
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-slate-900">{name.trim()}</p>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs text-slate-500">
                        Cost: R{costVal.toFixed(2)}
                      </span>
                      <span className="text-sm text-emerald-600 font-semibold">
                        Sell: R{sellVal.toFixed(2)}
                      </span>
                      <span className="text-xs text-slate-500">
                        {stock || '0'} units
                      </span>
                      <span className="text-xs bg-slate-200 text-slate-600 px-2 py-0.5 rounded-full font-medium">
                        {category}
                      </span>
                    </div>
                    {margin > 0 &&
                  <p className="text-[10px] text-emerald-600 font-medium mt-1">
                        Profit: R{margin.toFixed(2)}/unit × {stock || '0'} = R
                        {(margin * (parseInt(stock) || 0)).toFixed(2)} total
                      </p>
                  }
                  </div>
                </div>
              </KPCard>
            </motion.div>
          }
        </AnimatePresence>
      </div>

      {/* Sticky Submit Button */}
      <div className="shrink-0 bg-white border-t border-slate-200 p-6 pb-safe">
        <KPButton
          onClick={handleSubmit}
          disabled={!isValid}
          className={isValid ? 'bg-emerald-600 hover:bg-emerald-700' : ''}>
          
          {isRestock
            ? stockQty > 0
              ? `Add ${stockQty} to stock (new total ${newTotal})`
              : 'Add to existing stock'
            : 'Add to Inventory'}
        </KPButton>
      </div>
    </PageTransition>);

};