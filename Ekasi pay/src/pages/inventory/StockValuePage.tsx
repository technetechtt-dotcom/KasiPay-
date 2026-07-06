import { useState } from 'react';
import {
  KPCard,
  KPAmount,
  PageTransition,
  KPBadge } from
'../../components/shared/UIComponents';
import {
  ArrowLeft,
  Package,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Search } from
'lucide-react';
import type { Product, StockMovement } from '../../types';
export const StockValuePage = ({
  products,
  stockMovements,
  navigate




}: {products: Product[];stockMovements: StockMovement[];navigate: (p: string) => void;}) => {
  const [activeTab, setActiveTab] = useState<'products' | 'movements'>(
    'products'
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [movementFilter, setMovementFilter] = useState<
    'all' | 'in' | 'out' | 'adjustment'>(
    'all');
  const movementFilterOptions: Array<'all' | 'in' | 'out' | 'adjustment'> = [
    'all',
    'in',
    'out',
    'adjustment'
  ];
  // Calculations
  const totalCostValue = products.reduce(
    (sum, p) => sum + (p.costPrice || 0) * p.stock,
    0
  );
  const totalPotentialRevenue = products.reduce(
    (sum, p) => sum + p.price * p.stock,
    0
  );
  const potentialProfit = totalPotentialRevenue - totalCostValue;
  // Filter and sort products by value
  const filteredProducts = products.
  filter((p) => p.name.toLowerCase().includes(searchQuery.toLowerCase())).
  sort((a, b) => (b.costPrice || 0) * b.stock - (a.costPrice || 0) * a.stock);
  // Filter movements
  const filteredMovements = stockMovements.filter(
    (m) => movementFilter === 'all' || m.type === movementFilter
  );
  const unitsIn = stockMovements.
  filter((m) => m.type === 'in').
  reduce((sum, m) => sum + m.quantity, 0);
  const unitsOut = stockMovements.
  filter((m) => m.type === 'out').
  reduce((sum, m) => sum + m.quantity, 0);
  return (
    <PageTransition className="flex flex-col h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center mb-6">
          <button
            onClick={() => navigate('inventory')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">
            Stock Value & Movements
          </h2>
        </div>

        <div className="flex p-1 bg-slate-100 rounded-xl">
          <button
            onClick={() => setActiveTab('products')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'products' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>
            
            By Product
          </button>
          <button
            onClick={() => setActiveTab('movements')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'movements' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>
            
            Movements
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 pb-24">
        {/* Hero Stats */}
        <div className="grid grid-cols-1 gap-4 mb-6">
          <KPCard className="p-5 bg-slate-900 text-white relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -mr-10 -mt-10 blur-2xl"></div>
            <div className="relative z-10">
              <div className="flex items-center gap-2 text-slate-400 mb-2">
                <Package className="w-4 h-4" />
                <span className="text-sm font-medium uppercase tracking-wider">
                  Total Stock Value (Cost)
                </span>
              </div>
              <KPAmount
                amount={totalCostValue}
                className="text-4xl font-bold text-white mb-4 block" />
              

              <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-800">
                <div>
                  <p className="text-slate-500 text-xs mb-1">
                    Potential Revenue
                  </p>
                  <KPAmount
                    amount={totalPotentialRevenue}
                    className="text-emerald-400 font-medium" />
                  
                </div>
                <div>
                  <p className="text-slate-500 text-xs mb-1">
                    Potential Profit
                  </p>
                  <KPAmount
                    amount={potentialProfit}
                    className="text-emerald-400 font-medium" />
                  
                </div>
              </div>
            </div>
          </KPCard>
        </div>

        {activeTab === 'products' &&
        <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
              type="text"
              placeholder="Search products..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20" />
            
            </div>

            {filteredProducts.map((p) => {
            const costValue = (p.costPrice || 0) * p.stock;
            const revValue = p.price * p.stock;
            return (
              <KPCard key={p.id} className="p-4">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h4 className="font-bold text-slate-900">{p.name}</h4>
                      <p className="text-xs text-slate-500">
                        {p.category} • {p.stock} units in stock
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-slate-900">
                        <KPAmount amount={costValue} />
                      </p>
                      <p className="text-[10px] text-slate-500 uppercase">
                        Cost Value
                      </p>
                    </div>
                  </div>
                  <div className="bg-slate-50 rounded-lg p-3 grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <span className="text-slate-500 block text-xs">
                        Cost Price
                      </span>
                      <span className="font-medium">
                        R{(p.costPrice || 0).toFixed(2)}
                      </span>
                    </div>
                    <div>
                      <span className="text-slate-500 block text-xs">
                        Sell Price
                      </span>
                      <span className="font-medium">R{p.price.toFixed(2)}</span>
                    </div>
                    <div className="col-span-2 pt-2 border-t border-slate-200 mt-1 flex justify-between">
                      <span className="text-slate-500 text-xs">
                        Potential Revenue
                      </span>
                      <span className="font-bold text-emerald-600">
                        R{revValue.toFixed(2)}
                      </span>
                    </div>
                  </div>
                </KPCard>);

          })}
          </div>
        }

        {activeTab === 'movements' &&
        <div className="space-y-4">
            <div className="bg-white p-4 rounded-xl border border-slate-100 flex justify-between items-center">
              <div className="text-center flex-1 border-r border-slate-100">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">
                  Units In
                </p>
                <p className="text-xl font-bold text-emerald-600">+{unitsIn}</p>
              </div>
              <div className="text-center flex-1">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">
                  Units Out
                </p>
                <p className="text-xl font-bold text-red-600">-{unitsOut}</p>
              </div>
            </div>

            <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
              {movementFilterOptions.map((f) =>
            <button
              key={f}
              onClick={() => setMovementFilter(f)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize whitespace-nowrap transition-colors ${movementFilter === f ? 'bg-slate-800 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>
              
                  {f}
                </button>
            )}
            </div>

            <div className="space-y-3">
              {filteredMovements.map((m) => {
              const isIn = m.type === 'in';
              const isOut = m.type === 'out';
              return (
                <KPCard key={m.id} className="p-4 flex items-center gap-4">
                    <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${isIn ? 'bg-emerald-100 text-emerald-600' : isOut ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-600'}`}>
                    
                      {isIn ?
                    <TrendingUp className="w-5 h-5" /> :
                    isOut ?
                    <TrendingDown className="w-5 h-5" /> :

                    <RefreshCw className="w-5 h-5" />
                    }
                    </div>
                    <div className="flex-1">
                      <div className="flex justify-between items-start">
                        <p className="font-bold text-slate-900 line-clamp-1">
                          {m.productName}
                        </p>
                        <span
                        className={`font-bold whitespace-nowrap ml-2 ${isIn ? 'text-emerald-600' : isOut ? 'text-red-600' : 'text-amber-600'}`}>
                        
                          {isIn ? '+' : isOut ? '-' : '±'}
                          {m.quantity}
                        </span>
                      </div>
                      <div className="flex justify-between items-center mt-1">
                        <KPBadge
                        variant={
                        isIn ? 'success' : isOut ? 'danger' : 'warning'
                        }
                        className="text-[10px] py-0">
                        
                          {m.reason}
                        </KPBadge>
                        <span className="text-[10px] text-slate-400">
                          {new Date(m.createdAt).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </KPCard>);

            })}
            </div>
          </div>
        }
      </div>
    </PageTransition>);

};