import { useEffect, useState } from 'react';
import { PageTransition } from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  Zap,
  ZapOff,
  AlertTriangle,
  Clock,
  RefreshCw,
} from 'lucide-react';
import type { LoadSheddingSlot } from '../../types';

function formatTime(date: Date): string {
  return `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
}

export const LoadSheddingPage = ({
  schedule,
  navigate,
  onRefresh,
}: {
  schedule: LoadSheddingSlot[];
  navigate: (p: string) => void;
  /** Optional re-fetch hook so users can pull the freshest schedule. */
  onRefresh?: () => Promise<void> | void;
}) => {
  // Tick once a minute so the "Now" highlight and active slot stay accurate
  // without the user re-opening the page. Minute precision matches the slot
  // granularity (HH:MM).
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (refreshing || !onRefresh) return;
    setRefreshing(true);
    try {
      await onRefresh();
      setNow(new Date());
    } finally {
      setRefreshing(false);
    }
  };

  const currentTimeStr = formatTime(now);
  // Very simple check for active load shedding
  const activeSlot = schedule.find(
    (slot) =>
    currentTimeStr >= slot.startTime && currentTimeStr <= slot.endTime
  );
  /** Stage label: live stage when in a cut, otherwise the next upcoming slot or "—". */
  const upcomingSlot = schedule
    .filter((s) => s.startTime > currentTimeStr)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
  const currentStageLabel =
    activeSlot ?
      `Stage ${activeSlot.stage}`
    : upcomingSlot ?
      `Next: Stage ${upcomingSlot.stage} at ${upcomingSlot.startTime}`
    : 'No cuts scheduled';
  /** Highest stage in today's schedule (used for the business tip). */
  const maxStageToday = schedule.reduce(
    (max, slot) => Math.max(max, slot.stage),
    0,
  );
  /** Approximate hours-off this stage typically implies (loose mapping). */
  const stageImpactHours: Record<number, string> = {
    1: '2 hours',
    2: '2 hours',
    3: '2 hours',
    4: '2.5 hours',
    5: '4 hours',
    6: '4 hours',
    7: '4+ hours',
    8: '6+ hours',
  };
  const tipHours = stageImpactHours[maxStageToday] ?? 'a few hours';
  return (
    <PageTransition className="flex flex-col h-full bg-slate-900 text-white">
      {/* Header */}
      <div className="px-6 pt-12 pb-4 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-400 hover:text-white transition-colors">
              
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2">Load Shedding</h2>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="tabular-nums">Now {currentTimeStr}</span>
            {onRefresh ?
              <button
                type="button"
                onClick={() => void handleRefresh()}
                disabled={refreshing}
                aria-label="Refresh schedule"
                className="p-2 rounded-full bg-slate-800/60 hover:bg-slate-700 transition-colors">
                <RefreshCw
                  className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`}
                />
              </button>
            : null}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 pb-24">
        {/* Status Card */}
        <div
          className={`rounded-3xl p-6 mb-8 text-center relative overflow-hidden ${activeSlot ? 'bg-red-600' : 'bg-emerald-600'}`}>
          
          <div className="absolute -right-10 -top-10 w-40 h-40 bg-white/10 rounded-full blur-2xl"></div>
          <div className="absolute -left-10 -bottom-10 w-40 h-40 bg-black/20 rounded-full blur-2xl"></div>

          <div className="relative z-10">
            <div className="w-16 h-16 mx-auto bg-white/20 rounded-full flex items-center justify-center mb-4 backdrop-blur-sm">
              {activeSlot ?
              <ZapOff className="w-8 h-8 text-white" /> :

              <Zap className="w-8 h-8 text-white" />
              }
            </div>
            <h3 className="text-2xl font-bold mb-1">
              {activeSlot ? 'Power is OFF' : 'Power is ON'}
            </h3>
            <p className="text-white/80 text-sm mb-4">
              {activeSlot ?
              `Until ${activeSlot.endTime} (Stage ${activeSlot.stage})` :
              'No active load shedding right now'}
            </p>

            <div className="inline-flex items-center gap-2 bg-black/20 px-4 py-2 rounded-full text-sm font-medium">
              <AlertTriangle className="w-4 h-4 text-amber-300" />
              <span>{currentStageLabel}</span>
            </div>
          </div>
        </div>

        <h3 className="text-sm font-bold text-slate-400 mb-4 uppercase tracking-wider">
          Today's Schedule
        </h3>
        <div className="space-y-3">
          {schedule.map((slot, i) => {
            const isActive =
            currentTimeStr >= slot.startTime && currentTimeStr <= slot.endTime;
            const isPast = currentTimeStr > slot.endTime;
            return (
              <div
                key={i}
                className={`p-4 rounded-2xl flex items-center justify-between border ${isActive ? 'bg-red-900/40 border-red-500/50' : isPast ? 'bg-slate-800/50 border-slate-800 opacity-50' : 'bg-slate-800 border-slate-700'}`}>
                
                <div className="flex items-center gap-4">
                  <div
                    className={`w-10 h-10 rounded-full flex items-center justify-center ${isActive ? 'bg-red-500/20 text-red-400' : 'bg-slate-700 text-slate-400'}`}>
                    
                    <Clock className="w-5 h-5" />
                  </div>
                  <div>
                    <p
                      className={`font-bold text-lg ${isActive ? 'text-red-400' : 'text-white'}`}>
                      
                      {slot.startTime} - {slot.endTime}
                    </p>
                    <p className="text-xs text-slate-400">
                      Stage {slot.stage} • {slot.area}
                    </p>
                  </div>
                </div>
                {isActive &&
                <span className="text-xs font-bold text-red-400 bg-red-400/10 px-2 py-1 rounded-md uppercase tracking-wider">
                    Now
                  </span>
                }
              </div>);

          })}
        </div>

        <div className="mt-8 bg-amber-900/30 border border-amber-500/30 rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-200/80 leading-relaxed">
            <strong className="text-amber-400 block mb-1">Business Tip:</strong>
            {maxStageToday > 0 ?
              <>
                {' '}During Stage {maxStageToday}, your fridge will be off for{' '}
                {tipHours}. Consider selling ice cream and highly perishable
                stock before{' '}
                {upcomingSlot?.startTime ||
                  schedule[0]?.startTime ||
                  'the next cut'}
                .
              </>
            : <> No cuts scheduled — a good day to restock and freeze ice.</>}
          </p>
        </div>
      </div>
    </PageTransition>);

};