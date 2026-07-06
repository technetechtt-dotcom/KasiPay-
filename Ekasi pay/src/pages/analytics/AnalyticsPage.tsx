import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  KPCard,
  KPAmount,
  PageTransition } from
'../../components/shared/UIComponents';
import { ArrowLeft, TrendingUp, AlertTriangle, PackageOpen } from 'lucide-react';
import type { Sale, Product } from '../../types';
import {
  apiGetAnalyticsSummary,
  type AnalyticsSummary,
} from '../../services/api';
export const AnalyticsPage = ({
  sales,
  products,
  navigate





}: {sales: Sale[];products: Product[];navigate: (p: string) => void;}) => {
  const [period, setPeriod] = useState<'7d' | '30d' | 'all'>('7d');
  const [serverSummary, setServerSummary] = useState<AnalyticsSummary | null>(null);
  const periodOptions: Array<'7d' | '30d' | 'all'> = ['7d', '30d', 'all'];

  useEffect(() => {
    const serverPeriod =
      period === '7d' ? 'weekly' : period === '30d' ? 'monthly' : 'all';
    void (async () => {
      try {
        const summary = await apiGetAnalyticsSummary(serverPeriod);
        setServerSummary(summary);
      } catch {
        setServerSummary(null);
      }
    })();
  }, [period]);
  // Calculate 7-day trend
  const last7Days = Array.from(
    {
      length: 7
    },
    (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      return d.toLocaleDateString('en-US', {
        weekday: 'short'
      });
    }
  );
  const localTrendData = last7Days.map((day) => {
    const daySales = sales.filter(
      (s) =>
      new Date(s.createdAt).toLocaleDateString('en-US', {
        weekday: 'short'
      }) === day
    );
    return daySales.reduce((sum, s) => sum + s.total, 0);
  });
  const trendData =
    serverSummary?.trend?.length === 7 ?
      serverSummary.trend.map((t) => t.revenue)
    : localTrendData;
  const maxTrend = Math.max(...trendData, 1);
  // Best sellers
  const productSales = sales.
  flatMap((s) => s.items).
  reduce(
    (acc, item) => {
      if (!acc[item.productId]) {
        acc[item.productId] = {
          name: item.name,
          quantity: 0,
          revenue: 0
        };
      }
      acc[item.productId].quantity += item.quantity;
      acc[item.productId].revenue += item.subtotal;
      return acc;
    },
    {} as Record<
      string,
      {
        name: string;
        quantity: number;
        revenue: number;
      }>

  );
  const localBestSellers = Object.values(productSales).
  sort((a, b) => b.quantity - a.quantity).
  slice(0, 5);
  const bestSellers =
    serverSummary?.bestSellers?.length
      ? serverSummary.bestSellers.map((b) => ({
          name: b.name,
          quantity: b.quantity,
          revenue: b.revenue,
        }))
      : localBestSellers;
  // Stockout predictions (items with < 5 stock)
  const atRiskProducts =
    serverSummary?.atRiskProducts?.length
      ? serverSummary.atRiskProducts.map((p) => {
          const live = products.find((x) => x.id === p.id);
          return {
            name: p.name,
            stock: live?.stock ?? p.stock,
          };
        })
      : products
          .filter((p) => p.stock > 0 && p.stock <= 5)
          .map((p) => ({ name: p.name, stock: p.stock }));
  return (
    <PageTransition className="flex flex-col h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center mb-6">
          <button
            onClick={() => navigate('more')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">Analytics</h2>
        </div>

        <div className="flex gap-2">
          {periodOptions.map((p) =>
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${period === p ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
            
              {p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : 'All Time'}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 pb-24 space-y-6">
        <KPCard className="p-4 bg-slate-100 border-slate-200 text-xs text-slate-600">
          <strong className="text-slate-800">Prototype notice:</strong> charts and
          “days left” hints use simple math on your recorded sales only — not
          forecasts or bankable predictions. Field feedback should treat this as UX
          tooling, not analytics product.
        </KPCard>

        {/* Sales Trend Chart */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider flex items-center gap-2">
            <TrendingUp className="w-4 h-4" /> Sales Trend
          </h3>
          <KPCard className="p-5">
            <div className="flex items-end justify-between gap-2 h-40 mt-4">
              {trendData.map((amount, i) => {
                const height =
                maxTrend > 0 ? `${amount / maxTrend * 100}%` : '0%';
                return (
                  <div
                    key={i}
                    className="flex flex-col items-center flex-1 gap-2">
                    
                    <div className="w-full relative flex-1 flex items-end justify-center group">
                      <motion.div
                        initial={{
                          height: 0
                        }}
                        animate={{
                          height
                        }}
                        transition={{
                          duration: 0.5,
                          delay: i * 0.1
                        }}
                        className="w-full max-w-[24px] bg-emerald-500 rounded-t-md relative">
                        
                        <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-[10px] py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                          R{amount.toFixed(0)}
                        </div>
                      </motion.div>
                    </div>
                    <span className="text-[10px] font-medium text-slate-400">
                      {last7Days[i]}
                    </span>
                  </div>);

              })}
            </div>
          </KPCard>
        </section>

        {/* Best Sellers */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider flex items-center gap-2">
            <PackageOpen className="w-4 h-4" /> Best Sellers
          </h3>
          <div className="space-y-2">
            {bestSellers.map((item, i) =>
            <KPCard key={i} className="p-4 flex items-center gap-4">
                <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-500 font-bold flex items-center justify-center shrink-0">
                  {i + 1}
                </div>
                <div className="flex-1">
                  <p className="font-bold text-slate-900">{item.name}</p>
                  <p className="text-xs text-slate-500">
                    {item.quantity} units sold
                  </p>
                </div>
                <KPAmount amount={item.revenue} className="text-emerald-600" />
              </KPCard>
            )}
          </div>
        </section>

        {/* Stockout Predictions */}
        {atRiskProducts.length > 0 &&
        <section>
            <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-4 h-4" /> Stockout Risk
            </h3>
            <div className="space-y-2">
              {atRiskProducts.map((p, i) => {
              /** Illustrative only: beta heuristic ~2 units/day — adjust for pilot. */
              const daysLeft = Math.floor(p.stock / 2) || 1;
              return (
                <KPCard key={i} className="p-4 border-l-4 border-l-amber-500">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="font-bold text-slate-900">{p.name}</p>
                        <p className="text-sm text-slate-500">
                          Only {p.stock} left in stock
                        </p>
                      </div>
                      <div className="bg-amber-50 text-amber-700 px-3 py-1 rounded-lg text-xs font-bold text-center">
                        <span className="block text-lg">{daysLeft}</span>
                        days left
                      </div>
                    </div>
                  </KPCard>);

            })}
            </div>
          </section>
        }
      </div>
    </PageTransition>);

};