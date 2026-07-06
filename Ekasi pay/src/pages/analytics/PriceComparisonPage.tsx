import { useState } from 'react';
import { KPCard, KPButton, KPInput, PageTransition } from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  Tags,
  TrendingDown,
  TrendingUp,
  Search,
  MapPin,
  CheckCircle2,
  Plus,
  X,
} from 'lucide-react';
import type { PriceComparison } from '../../types';
import { toast } from 'sonner';

export const PriceComparisonPage = ({
  comparisons,
  onAddComparison,
  navigate,
}: {
  comparisons: PriceComparison[];
  onAddComparison: (payload: {
    productName: string;
    myPrice: number;
    avgAreaPrice: number;
    lowestAreaPrice: number;
    highestAreaPrice: number;
    competitors: number;
  }) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [productName, setProductName] = useState('');
  const [myPrice, setMyPrice] = useState('');
  const [avgAreaPrice, setAvgAreaPrice] = useState('');
  const [lowestAreaPrice, setLowestAreaPrice] = useState('');
  const [highestAreaPrice, setHighestAreaPrice] = useState('');
  const [competitors, setCompetitors] = useState('');

  const filteredComparisons = comparisons.filter((c) =>
    c.productName.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const submit = async () => {
    const my = Number(myPrice);
    const avg = Number(avgAreaPrice);
    const low = Number(lowestAreaPrice);
    const high = Number(highestAreaPrice);
    const comp = Number(competitors);
    if (
      !productName.trim() ||
      !(my >= 0) ||
      !(avg >= 0) ||
      !(low >= 0) ||
      !(high >= 0) ||
      !(comp >= 0)
    ) {
      toast.error('Fill all numeric fields');
      return;
    }
    setBusy(true);
    try {
      const ok = await onAddComparison({
        productName: productName.trim(),
        myPrice: my,
        avgAreaPrice: avg,
        lowestAreaPrice: low,
        highestAreaPrice: high,
        competitors: Math.floor(comp),
      });
      if (ok) {
        toast.success('Tracked');
        setShowForm(false);
        setProductName('');
        setMyPrice('');
        setAvgAreaPrice('');
        setLowestAreaPrice('');
        setHighestAreaPrice('');
        setCompetitors('');
      } else toast.error('Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50 relative">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">Smart Pricing</h2>
          </div>
          <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center">
            <Tags className="w-5 h-5" />
          </div>
        </div>

        <KPButton type="button" className="bg-indigo-600 mb-4" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4 mr-2" /> Track product price
        </KPButton>

        <div className="bg-indigo-50 text-indigo-800 p-4 rounded-2xl mb-4 flex items-start gap-3">
          <MapPin className="w-5 h-5 shrink-0 mt-0.5 text-indigo-600" />
          <p className="text-sm">
            Enter prices you hear from wholesalers and neighbouring shops—the app stores them against your shelf price.
          </p>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search products..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-100 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-28">
        {filteredComparisons.length === 0 && (
          <p className="text-center text-slate-500 py-8 text-sm">
            No tracked products yet—add your first basket item.
          </p>
        )}
        <div className="space-y-4">
          {filteredComparisons.map((item) => {
            const diff = item.myPrice - item.avgAreaPrice;
            const isHigher = diff > 0;
            const isLower = diff < 0;
            const diffPercent =
              item.avgAreaPrice > 0 ? Math.abs(diff / item.avgAreaPrice * 100) : 0;
            let status = 'competitive';
            if (isHigher && diffPercent > 10) status = 'too-high';
            if (isLower && diffPercent > 15) status = 'too-low';
            return (
              <KPCard key={item.id} className="p-5">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-bold text-slate-900 text-lg">{item.productName}</h3>
                    <p className="text-xs text-slate-500">
                      Based on {item.competitors} nearby shops
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">
                      Your Price
                    </p>
                    <p className="font-bold text-xl text-slate-900">
                      R{item.myPrice.toFixed(2)}
                    </p>
                  </div>
                </div>

                <div className="flex justify-between text-xs text-slate-500 mb-4 px-1">
                  <span>Lowest: R{item.lowestAreaPrice.toFixed(2)}</span>
                  <span>Avg: R{item.avgAreaPrice.toFixed(2)}</span>
                  <span>Highest: R{item.highestAreaPrice.toFixed(2)}</span>
                </div>

                {status === 'too-high' && (
                  <div className="bg-red-50 text-red-700 p-3 rounded-xl text-sm flex items-start gap-2">
                    <TrendingDown className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>
                      Your price is <strong>R{Math.abs(diff).toFixed(2)} higher</strong> than average.
                      You might be losing sales.
                    </p>
                  </div>
                )}
                {status === 'too-low' && (
                  <div className="bg-amber-50 text-amber-700 p-3 rounded-xl text-sm flex items-start gap-2">
                    <TrendingUp className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>
                      Your price is <strong>R{Math.abs(diff).toFixed(2)} lower</strong> than average—you could lift margins cautiously.
                    </p>
                  </div>
                )}
                {status === 'competitive' && (
                  <div className="bg-emerald-50 text-emerald-700 p-3 rounded-xl text-sm flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <p>Your tracked price sits in line with neighbours.</p>
                  </div>
                )}
              </KPCard>
            );
          })}
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end justify-center sm:items-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg">Track shelf price</h3>
              <button type="button" onClick={() => setShowForm(false)}>
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <KPInput label="Product" value={productName} onChange={(e) => setProductName(e.target.value)} />
            <KPInput label="Your shelf price (R)" type="number" value={myPrice} onChange={(e) => setMyPrice(e.target.value)} />
            <KPInput label="Avg area (R)" type="number" value={avgAreaPrice} onChange={(e) => setAvgAreaPrice(e.target.value)} />
            <KPInput label="Lowest heard (R)" type="number" value={lowestAreaPrice} onChange={(e) => setLowestAreaPrice(e.target.value)} />
            <KPInput label="Highest heard (R)" type="number" value={highestAreaPrice} onChange={(e) => setHighestAreaPrice(e.target.value)} />
            <KPInput label="How many neighbours?" type="number" value={competitors} onChange={(e) => setCompetitors(e.target.value)} />
            <KPButton type="button" disabled={busy} className="mt-4 bg-indigo-600" onClick={() => void submit()}>
              {busy ? 'Saving…' : 'Save tracking'}
            </KPButton>
          </div>
        </div>
      )}
    </PageTransition>
  );
};
