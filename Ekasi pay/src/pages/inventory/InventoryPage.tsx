import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  KPCard,
  KPAmount,
  PageTransition } from
'../../components/shared/UIComponents';
import {
  ArrowLeft,
  Search,
  Plus,
  Minus,
  Package,
  PackagePlus,
  Download,
  Receipt } from
'lucide-react';
import { toast } from 'sonner';
import { openProductScanner } from '../../lib/scannerSession';
import type { Product } from '../../types';
import { FloatingScanButton } from '../../components/shared/FloatingScanButton';
import { apiGetInventoryReport } from '../../services/api';
export const InventoryPage = ({
  products,
  onRestock,
  navigate




}: {products: Product[];onRestock: (productId: string, quantity: number) => void;navigate: (p: string) => void;}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const lowStockCount = products.filter(
    (p) => p.stock > 0 && p.stock < 10
  ).length;
  const outOfStockCount = products.filter((p) => p.stock === 0).length;
  const filteredProducts = products.filter((p) =>
  p.name.toLowerCase().includes(searchQuery.toLowerCase())
  );
  // Group products by category
  const groupedProducts = filteredProducts.reduce(
    (acc, product) => {
      if (!acc[product.category]) {
        acc[product.category] = [];
      }
      acc[product.category].push(product);
      return acc;
    },
    {} as Record<string, Product[]>
  );
  const getStockColor = (stock: number) => {
    if (stock === 0) return 'bg-slate-200 text-slate-600';
    if (stock < 10) return 'bg-red-100 text-red-700';
    if (stock < 20) return 'bg-amber-100 text-amber-700';
    return 'bg-emerald-100 text-emerald-700';
  };
  const getStockBarColor = (stock: number) => {
    if (stock === 0) return 'bg-slate-200';
    if (stock < 10) return 'bg-red-500';
    if (stock < 20) return 'bg-amber-500';
    return 'bg-emerald-500';
  };
  const handleRestock = (productId: string, quantity: number) => {
    onRestock(productId, quantity);
    toast.success('Stock updated');
  };

  const handleDownloadInventory = async () => {
    try {
      const report = await apiGetInventoryReport();
      const rows = [
        ['INVENTORY REPORT'],
        ['Generated', new Date(report.generatedAt).toLocaleString()],
        ['Total SKUs', String(report.totalSkus)],
        ['Total units', String(report.totalUnits)],
        ['Stock value (cost)', report.totalCostValue.toFixed(2)],
        ['Potential revenue', report.totalRetailValue.toFixed(2)],
        [],
        ['Name', 'Category', 'Barcode', 'Stock', 'Cost', 'Sell', 'Cost value', 'Retail value'],
        ...report.items.map((i) => [
          i.name,
          i.category,
          i.barcode ?? '',
          String(i.stock),
          i.costPrice.toFixed(2),
          i.sellingPrice.toFixed(2),
          i.costValue.toFixed(2),
          i.retailValue.toFixed(2),
        ]),
      ];
      const csv = rows.map((r) => r.join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `inventory_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.success('Inventory list downloaded');
    } catch {
      const rows = [
        ['INVENTORY REPORT (local)'],
        ['Generated', new Date().toLocaleString()],
        [],
        ['Name', 'Category', 'Barcode', 'Stock', 'Cost', 'Sell', 'Cost value'],
        ...products.map((p) => [
          p.name,
          p.category,
          p.barcode ?? '',
          String(p.stock),
          (p.costPrice || 0).toFixed(2),
          p.price.toFixed(2),
          ((p.costPrice || 0) * p.stock).toFixed(2),
        ]),
      ];
      const csv = rows.map((r) => r.join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `inventory_${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      toast.success('Inventory list downloaded (local data)');
    }
  };
  const totalCostValue = products.reduce(
    (sum, p) => sum + (p.costPrice || 0) * p.stock,
    0
  );
  const totalPotentialRevenue = products.reduce(
    (sum, p) => sum + p.price * p.stock,
    0
  );
  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between mb-6 gap-2">
          <div className="flex items-center min-w-0">
            <button
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors shrink-0">
              
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900 truncate">
              Inventory
            </h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => navigate('record-purchase-slip')}
              className="p-2 bg-blue-50 text-blue-700 rounded-full hover:bg-blue-100"
              title="Record purchase slip">
              <Receipt className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={handleDownloadInventory}
              className="p-2 bg-emerald-50 text-emerald-600 rounded-full hover:bg-emerald-100"
              title="Download inventory CSV">
              <Download className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Stock Value Banner */}
        <div
          onClick={() => navigate('stock-value')}
          className="bg-slate-900 rounded-2xl p-4 mb-4 text-white cursor-pointer active:scale-[0.98] transition-transform relative overflow-hidden">
          
          <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -mr-8 -mt-8 blur-xl"></div>
          <div className="relative z-10 flex justify-between items-center">
            <div>
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-1">
                Total Stock Value
              </p>
              <KPAmount
                amount={totalCostValue}
                className="text-2xl font-bold" />
              
            </div>
            <div className="text-right">
              <p className="text-slate-400 text-xs font-medium uppercase tracking-wider mb-1">
                Potential Rev
              </p>
              <KPAmount
                amount={totalPotentialRevenue}
                className="text-emerald-400 font-bold" />
              
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-slate-800 text-xs text-emerald-400 font-medium flex items-center justify-between">
            <span>View detailed movements & value</span>
            <ArrowLeft className="w-4 h-4 rotate-180" />
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-slate-100 rounded-xl p-3 text-center">
            <p className="text-xs text-slate-500 mb-1 font-medium">
              Total Items
            </p>
            <p className="text-xl font-bold text-slate-900">
              {products.length}
            </p>
          </div>
          <div className="bg-amber-50 rounded-xl p-3 text-center border border-amber-100">
            <p className="text-xs text-amber-600 mb-1 font-medium">Low Stock</p>
            <p className="text-xl font-bold text-amber-700">{lowStockCount}</p>
          </div>
          <div className="bg-red-50 rounded-xl p-3 text-center border border-red-100">
            <p className="text-xs text-red-600 mb-1 font-medium">
              Out of Stock
            </p>
            <p className="text-xl font-bold text-red-700">{outOfStockCount}</p>
          </div>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search inventory..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-100 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20" />
          
        </div>
      </div>

      {/* Product List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 relative">
        {Object.entries(groupedProducts).length === 0 ?
        <div className="text-center py-12 text-slate-500">
            <Package className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p>No products found</p>
          </div> :

        Object.entries(groupedProducts).map(
          ([category, items], groupIndex) =>
          <div key={category} className="mb-8">
                <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
                  {category}
                </h3>
                <div className="space-y-3">
                  {items.map((product, i) =>
              <motion.div
                key={product.id}
                initial={{
                  opacity: 0,
                  y: 10
                }}
                animate={{
                  opacity: 1,
                  y: 0
                }}
                transition={{
                  delay: (groupIndex * items.length + i) * 0.05
                }}>
                
                      <KPCard className="p-4">
                        <div className="flex justify-between items-start mb-3">
                          <div>
                            <p className="font-medium text-slate-900 leading-tight mb-1">
                              {product.name}
                            </p>
                            <div className="flex items-center gap-2">
                              <KPAmount
                          amount={product.price}
                          className="text-slate-500 text-sm" />
                        
                              {product.costPrice != null &&
                        <span className="text-[10px] text-emerald-600 font-medium bg-emerald-50 px-1.5 py-0.5 rounded">
                                  +R
                                  {(product.price - product.costPrice).toFixed(
                            2
                          )}
                                </span>
                        }
                            </div>
                          </div>
                          <div
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold flex flex-col items-center justify-center min-w-[3rem] ${getStockColor(product.stock)}`}>
                      
                            <span>{product.stock}</span>
                            <span className="text-[9px] font-medium opacity-80 uppercase tracking-wider">
                              Left
                            </span>
                          </div>
                        </div>

                        {/* Stock Bar */}
                        <div className="w-full h-1.5 bg-slate-100 rounded-full mb-4 overflow-hidden">
                          <div
                      className={`h-full rounded-full transition-all duration-500 ${getStockBarColor(product.stock)}`}
                      style={{
                        width: `${Math.min(100, product.stock / 50 * 100)}%`
                      }} />
                    
                        </div>

                        {/* Controls */}
                        <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                          <span className="text-xs text-slate-500 font-medium">
                            Adjust Stock
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                        onClick={() => handleRestock(product.id, -1)}
                        disabled={product.stock === 0}
                        className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center active:bg-slate-200 disabled:opacity-50 transition-colors">
                        
                              <Minus className="w-4 h-4" />
                            </button>
                            <button
                        onClick={() => handleRestock(product.id, 1)}
                        className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center active:bg-emerald-100 transition-colors">
                        
                              <Plus className="w-4 h-4" />
                            </button>
                            <button
                        onClick={() => handleRestock(product.id, 10)}
                        className="px-3 h-8 rounded-full bg-emerald-100 text-emerald-700 text-xs font-bold active:bg-emerald-200 transition-colors ml-1">
                        
                              +10
                            </button>
                          </div>
                        </div>
                      </KPCard>
                    </motion.div>
              )}
                </div>
              </div>

        )
        }
      </div>

      {/* Floating Add Button */}
      <button
        onClick={() => navigate('add-stock')}
        className="absolute right-[clamp(0.75rem,3vw,1.25rem)] bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] w-12 h-12 bg-emerald-600 text-white rounded-xl shadow-lg shadow-emerald-600/30 flex items-center justify-center active:scale-95 transition-transform z-20">
        
        <PackagePlus className="w-5 h-5" />
      </button>
      <FloatingScanButton
        accent="emerald"
        label="Scan"
        className="bottom-[calc(env(safe-area-inset-bottom)+9.5rem)]"
        onClick={() => openProductScanner(navigate, { returnPage: 'inventory' })}
      />
    </PageTransition>);

};