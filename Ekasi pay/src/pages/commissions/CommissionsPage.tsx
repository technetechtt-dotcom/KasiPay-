import { motion } from 'framer-motion';
import {
  ArrowLeft,
  Coins,
  Calendar,
  ArrowUpRight,
  ArrowDownLeft,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { compareMoney, type Money } from '../../money';

import {
  KPCard,
  KPAmount,
  PageTransition,
  KPBadge,
} from '../../components/shared/UIComponents';
import {
  apiGetMyCommissions,
  type CommissionPosting,
} from '../../services/api';

export const CommissionsPage = ({
  navigate,
}: {
  navigate: (p: string) => void;
}) => {
  const [postings, setPostings] = useState<CommissionPosting[]>([]);
  const [totals, setTotals] = useState<{ lifetime: Money; thisMonth: Money }>({
    lifetime: '0.00',
    thisMonth: '0.00',
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGetMyCommissions();
        if (cancelled) return;
        setPostings(res.postings);
        setTotals(res.totals);
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : 'Could not load commissions';
        // Non-agents simply get an empty page — only surface real failures.
        if (!/forbidden|admin only|401|403/i.test(msg)) {
          toast.error(msg);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center mb-6">
          <button
            onClick={() => navigate('more')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">
            Agent Commissions
          </h2>
        </div>

        <motion.div
          className="bg-amber-500 rounded-3xl p-6 text-white shadow-xl shadow-amber-500/20 mb-2 relative overflow-hidden"
          whileTap={{ scale: 0.98 }}>
          <div className="absolute -right-10 -top-10 w-40 h-40 bg-white/20 rounded-full blur-2xl"></div>
          <div className="absolute -left-10 -bottom-10 w-40 h-40 bg-amber-700/20 rounded-full blur-2xl"></div>

          <div className="relative z-10">
            <div className="flex justify-between items-center mb-2">
              <span className="text-amber-50 font-medium flex items-center gap-2">
                <Coins className="w-5 h-5" /> Total Earned
              </span>
            </div>
            <div className="text-4xl font-bold tracking-tight mb-6">
              <KPAmount amount={totals.lifetime} />
            </div>
            <div className="flex justify-between items-end">
              <div>
                <p className="text-xs text-amber-200 mb-1">This Month</p>
                <p className="font-medium">
                  <KPAmount amount={totals.thisMonth} />
                </p>
              </div>
              <KPBadge
                variant="warning"
                className="bg-white/20 text-white border-white/10 backdrop-blur-sm">
                {postings.length} Postings
              </KPBadge>
            </div>
          </div>
        </motion.div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8">
        <h3 className="text-sm font-bold text-slate-500 mb-4 uppercase tracking-wider flex items-center gap-2">
          <Calendar className="w-4 h-4" /> Commission History
        </h3>

        {loading ? (
          <div className="text-center py-12 text-slate-500">Loading…</div>
        ) : postings.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <Coins className="w-12 h-12 mx-auto mb-3 text-slate-300" />
            <p>No commissions earned yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {postings.map((p, i) => {
              const incoming = compareMoney(p.amount, 0) >= 0;
              return (
                <motion.div
                  key={p.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.05 }}>
                  <KPCard className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center ${
                          incoming
                            ? 'bg-emerald-50 text-emerald-600'
                            : 'bg-slate-100 text-slate-600'
                        }`}>
                        {incoming ? (
                          <ArrowDownLeft className="w-5 h-5" />
                        ) : (
                          <ArrowUpRight className="w-5 h-5" />
                        )}
                      </div>
                      <div>
                        <p className="font-medium text-slate-900">
                          {p.description}
                        </p>
                        <p className="text-xs text-slate-500">
                          {new Date(p.createdAt).toLocaleDateString()} ·{' '}
                          {p.sourceType.replace('_', ' ')}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-amber-600">
                        +<KPAmount amount={p.amount} />
                      </p>
                      <p className="text-[10px] text-slate-400">Fee share</p>
                    </div>
                  </KPCard>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </PageTransition>
  );
};
