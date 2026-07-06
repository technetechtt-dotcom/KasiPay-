import { KPCard, PageTransition } from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  Activity,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  AlertCircle,
  Award } from
'lucide-react';
import type { Sale, Expense } from '../../types';
export const BusinessHealthPage = ({
  sales,
  expenses,
  navigate




}: {sales: Sale[];expenses: Expense[];navigate: (p: string) => void;}) => {
  // Calculate some basic metrics for the score
  const totalSales = sales.reduce((sum, s) => sum + s.total, 0);
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
  const profitMargin =
  totalSales > 0 ? (totalSales - totalExpenses) / totalSales * 100 : 0;
  // Fake a score based on profit margin (just for prototype)
  let score = 65;
  if (profitMargin > 30) score = 92;else
  if (profitMargin > 15) score = 78;else
  if (profitMargin < 0) score = 45;
  const getScoreColor = (s: number) => {
    if (s >= 80) return 'text-emerald-500';
    if (s >= 60) return 'text-amber-500';
    return 'text-red-500';
  };
  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
              
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">
              Business Health
            </h2>
          </div>
          <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center">
            <Activity className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8">
        {/* Score Circle */}
        <div className="flex flex-col items-center justify-center py-8 mb-4">
          <div className="relative w-48 h-48 flex items-center justify-center">
            {/* Background Circle */}
            <svg className="absolute inset-0 w-full h-full transform -rotate-90">
              <circle
                cx="96"
                cy="96"
                r="88"
                stroke="currentColor"
                strokeWidth="12"
                fill="transparent"
                className="text-slate-200" />
              
              {/* Progress Circle */}
              <circle
                cx="96"
                cy="96"
                r="88"
                stroke="currentColor"
                strokeWidth="12"
                fill="transparent"
                strokeDasharray={2 * Math.PI * 88}
                strokeDashoffset={2 * Math.PI * 88 * (1 - score / 100)}
                className={`${getScoreColor(score)} transition-all duration-1000 ease-out`}
                strokeLinecap="round" />
              
            </svg>
            <div className="text-center z-10">
              <span
                className={`text-6xl font-black tracking-tighter ${getScoreColor(score)}`}>
                
                {score}
              </span>
              <span className="text-slate-400 text-xl font-bold">/100</span>
              <p className="text-sm font-bold text-slate-500 mt-1 uppercase tracking-wider">
                Health Score
              </p>
            </div>
          </div>
        </div>

        {/* Status Message */}
        <div
          className={`rounded-2xl p-4 mb-8 flex items-start gap-3 ${score >= 80 ? 'bg-emerald-50 text-emerald-800' : score >= 60 ? 'bg-amber-50 text-amber-800' : 'bg-red-50 text-red-800'}`}>
          
          {score >= 80 ?
          <ShieldCheck className="w-6 h-6 shrink-0 text-emerald-600" /> :

          <AlertCircle className="w-6 h-6 shrink-0" />
          }
          <div>
            <h3 className="font-bold mb-1">
              {score >= 80 ?
              'Excellent Health!' :
              score >= 60 ?
              'Doing Okay' :
              'Needs Attention'}
            </h3>
            <p className="text-sm opacity-90">
              {score >= 80 ?
              'Your profit margins are strong and expenses are well-managed. Keep it up!' :
              score >= 60 ?
              'Your business is stable, but high expenses are eating into your profits.' :
              'Your expenses are exceeding your gross margin. Review your pricing and costs.'}
            </p>
          </div>
        </div>

        <h3 className="text-sm font-bold text-slate-500 mb-4 uppercase tracking-wider">
          Key Factors
        </h3>
        <div className="space-y-3">
          <KPCard className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <TrendingUp className="w-5 h-5" />
              </div>
              <div>
                <p className="font-bold text-slate-900">Sales Volume</p>
                <p className="text-xs text-slate-500">Consistent daily sales</p>
              </div>
            </div>
            <span className="font-bold text-emerald-600">Good</span>
          </KPCard>

          <KPCard className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center ${profitMargin > 20 ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'}`}>
                
                <Award className="w-5 h-5" />
              </div>
              <div>
                <p className="font-bold text-slate-900">Profit Margin</p>
                <p className="text-xs text-slate-500">
                  Currently {profitMargin.toFixed(1)}%
                </p>
              </div>
            </div>
            <span
              className={`font-bold ${profitMargin > 20 ? 'text-emerald-600' : 'text-amber-600'}`}>
              
              {profitMargin > 20 ? 'Healthy' : 'Average'}
            </span>
          </KPCard>

          <KPCard className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center ${totalExpenses > totalSales * 0.5 ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600'}`}>
                
                <TrendingDown className="w-5 h-5" />
              </div>
              <div>
                <p className="font-bold text-slate-900">Expense Ratio</p>
                <p className="text-xs text-slate-500">Costs vs Revenue</p>
              </div>
            </div>
            <span
              className={`font-bold ${totalExpenses > totalSales * 0.5 ? 'text-red-600' : 'text-emerald-600'}`}>
              
              {totalExpenses > totalSales * 0.5 ? 'High' : 'Low'}
            </span>
          </KPCard>
        </div>
      </div>
    </PageTransition>);

};