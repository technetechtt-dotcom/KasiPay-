import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  KPCard,
  KPAmount,
  PageTransition,
  KPButton,
  KPInput,
} from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  Download,
  FileText,
  Receipt,
  Package,
  Smartphone,
  Home } from
'lucide-react';
import { toast } from 'sonner';
import type { Sale, Expense, Product, Merchant, Loan } from '../../types';
import { apiGetIncomeStatement, type IncomeStatement } from '../../services/api';
type Period = 'daily' | 'weekly' | 'monthly' | 'yearly';
export const FinancialReportsPage = ({
  sales,
  expenses,
  products,
  merchant,
  loans,
  onRequestLoan,
  onRepayLoan,
  navigate,
}: {
  sales: Sale[];
  expenses: Expense[];
  products: Product[];
  merchant: Merchant;
  loans: Loan[];
  onRequestLoan: (amount: number) => Promise<boolean>;
  onRepayLoan?: (loanId: string, amount: number) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [period, setPeriod] = useState<Period>('monthly');
  const [loanAmt, setLoanAmt] = useState('');
  const [loanBusy, setLoanBusy] = useState(false);
  const [repayingId, setRepayingId] = useState<string | null>(null);
  const [repayAmt, setRepayAmt] = useState('');
  const [repayBusy, setRepayBusy] = useState(false);
  const [serverStatement, setServerStatement] = useState<IncomeStatement | null>(
    null,
  );
  const [statementError, setStatementError] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const statement = await apiGetIncomeStatement(period);
        setServerStatement(statement);
        setStatementError(false);
      } catch {
        setServerStatement(null);
        setStatementError(true);
      }
    })();
  }, [period]);
  // Helper to filter data by period
  const filterByPeriod = <
    T extends {
      createdAt: string;
    },>(

  items: T[],
  selectedPeriod: Period) =>
  {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return items.filter((item) => {
      const itemDate = new Date(item.createdAt);
      const itemDay = new Date(
        itemDate.getFullYear(),
        itemDate.getMonth(),
        itemDate.getDate()
      );
      switch (selectedPeriod) {
        case 'daily':
          return itemDay.getTime() === today.getTime();
        case 'weekly':{
            const weekAgo = new Date(today);
            weekAgo.setDate(weekAgo.getDate() - 7);
            return itemDay >= weekAgo && itemDay <= today;
          }
        case 'monthly':{
            const monthAgo = new Date(today);
            monthAgo.setMonth(monthAgo.getMonth() - 1);
            return itemDay >= monthAgo && itemDay <= today;
          }
        case 'yearly':{
            const yearAgo = new Date(today);
            yearAgo.setFullYear(yearAgo.getFullYear() - 1);
            return itemDay >= yearAgo && itemDay <= today;
          }
        default:
          return true;
      }
    });
  };
  const periodSales = filterByPeriod(sales, period);
  const periodExpenses = filterByPeriod(expenses, period);
  // Revenue
  const localRevenue = periodSales.reduce((sum, s) => sum + s.total, 0);
  // COGS
  const localCOGS = periodSales.reduce((sum, s) => {
    return (
      sum +
      s.items.reduce((itemSum, item) => {
        const product = products.find((p) => p.id === item.productId);
        const costPrice = product?.costPrice ?? item.price * 0.7;
        return itemSum + costPrice * item.quantity;
      }, 0));

  }, 0);
  const localGrossProfit = localRevenue - localCOGS;
  const localGrossMarginPct =
  localRevenue > 0 ? localGrossProfit / localRevenue * 100 : 0;
  const localExpenses = periodExpenses.reduce((sum, e) => sum + e.amount, 0);
  const localNetProfit = localGrossProfit - localExpenses;
  const totalRevenue = serverStatement?.totalRevenue ?? localRevenue;
  const totalCOGS = serverStatement?.totalCOGS ?? localCOGS;
  const grossProfit = serverStatement?.grossProfit ?? localGrossProfit;
  const grossMarginPct = serverStatement?.grossMarginPct ?? localGrossMarginPct;
  const totalExpenses = serverStatement?.totalExpenses ?? localExpenses;
  const netProfit = serverStatement?.netProfit ?? localNetProfit;
  // Payment method breakdown
  const paymentMethods = periodSales.reduce(
    (acc, sale) => {
      acc[sale.paymentMethod] = (acc[sale.paymentMethod] || 0) + sale.total;
      return acc;
    },
    {} as Record<string, number>
  );
  // Top sellers
  const productSales = periodSales.
  flatMap((s) => s.items).
  reduce(
    (acc, item) => {
      const existing = acc.find((p) => p.productId === item.productId);
      if (existing) {
        existing.quantity += item.quantity;
        existing.revenue += item.price * item.quantity;
      } else {
        acc.push({
          productId: item.productId,
          productName: item.name,
          quantity: item.quantity,
          revenue: item.price * item.quantity
        });
      }
      return acc;
    },
    [] as Array<{
      productId: string;
      productName: string;
      quantity: number;
      revenue: number;
    }>
  ).
  sort((a, b) => b.revenue - a.revenue).
  slice(0, 5);
  const maxSellerRevenue = productSales[0]?.revenue || 1;
  // Sales by category
  const categorySales = periodSales.
  flatMap((s) => s.items).
  reduce(
    (acc, item) => {
      const product = products.find((p) => p.id === item.productId);
      const category = product?.category || 'Other';
      if (!acc[category]) {
        acc[category] = {
          units: 0,
          revenue: 0
        };
      }
      acc[category].units += item.quantity;
      acc[category].revenue += item.price * item.quantity;
      return acc;
    },
    {} as Record<
      string,
      {
        units: number;
        revenue: number;
      }>

  );
  const categoryData = Object.entries(categorySales).
  map(([category, data]) => ({
    category,
    ...data,
    pct: data.revenue / totalRevenue * 100
  })).
  sort((a, b) => b.revenue - a.revenue);
  // Expense breakdown
  const expensesByCategory = periodExpenses.reduce(
    (acc, exp) => {
      acc[exp.category] = (acc[exp.category] || 0) + exp.amount;
      return acc;
    },
    {} as Record<string, number>
  );
  const localExpenseData = Object.entries(expensesByCategory).
  map(([category, amount]) => ({
    category,
    amount,
    pct: amount / totalExpenses * 100
  })).
  sort((a, b) => b.amount - a.amount);
  const expenseData =
    serverStatement?.expensesByCategory?.length
      ? serverStatement.expensesByCategory.map((e) => ({
          category: e.category,
          amount: e.amount,
          pct: totalExpenses > 0 ? (e.amount / totalExpenses) * 100 : 0,
        }))
      : localExpenseData;
  const getCategoryIcon = (cat: string) => {
    const lower = cat.toLowerCase();
    if (lower.includes('rent') || lower.includes('utilities')) return Home;
    if (lower.includes('stock') || lower.includes('inventory')) return Package;
    if (lower.includes('airtime') || lower.includes('data')) return Smartphone;
    return Receipt;
  };
  // Download CSV
  const handleDownloadCSV = () => {
    const periodLabels = {
      daily: 'Today',
      weekly: 'Last 7 Days',
      monthly: 'Last 30 Days',
      yearly: 'Last 12 Months'
    };
    const rows = [
    ['FINANCIAL REPORT', merchant.businessName],
    ['Period', periodLabels[period]],
    ['Generated On', new Date().toLocaleString()],
    [],
    ['SUMMARY', ''],
    ['Total Revenue', totalRevenue.toFixed(2)],
    ['Cost of Goods Sold', totalCOGS.toFixed(2)],
    ['Gross Profit', grossProfit.toFixed(2)],
    ['Operating Expenses', totalExpenses.toFixed(2)],
    ['Net Profit/Loss', netProfit.toFixed(2)],
    [],
    ['EXPENSE BREAKDOWN', ''],
    ...expenseData.map((e) => [e.category, e.amount.toFixed(2)]),
    [],
    ['RECENT TRANSACTIONS (SALES)', ''],
    ['Date', 'Amount', 'Payment Method'],
    ...periodSales.
    slice(0, 50).
    map((s) => [
    new Date(s.createdAt).toLocaleString(),
    s.total.toFixed(2),
    s.paymentMethod]
    )];

    const csvContent = rows.map((e) => e.join(',')).join('\n');
    const blob = new Blob([csvContent], {
      type: 'text/csv;charset=utf-8;'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `${merchant.businessName.replace(/\s+/g, '_')}_Financial_Report_${period}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Report downloaded');
  };
  const handleDownloadIncomeStatement = () => {
    const periodLabels = {
      daily: 'Daily',
      weekly: 'Weekly',
      monthly: 'Monthly',
      yearly: 'Yearly'
    };
    const rows = [
    ['INCOME STATEMENT'],
    [merchant.businessName],
    [`${periodLabels[period]} Report`],
    [`Generated: ${new Date().toLocaleDateString()}`],
    [],
    ['REVENUE', ''],
    ['Sales Revenue', totalRevenue.toFixed(2)],
    [],
    ['COST OF GOODS SOLD', ''],
    ['Product Costs', totalCOGS.toFixed(2)],
    [],
    ['GROSS PROFIT', grossProfit.toFixed(2)],
    [`Gross Margin`, `${grossMarginPct.toFixed(1)}%`],
    [],
    ['OPERATING EXPENSES', ''],
    ...expenseData.map((e) => [e.category, e.amount.toFixed(2)]),
    ['Total Operating Expenses', totalExpenses.toFixed(2)],
    [],
    ['NET PROFIT (LOSS)', netProfit.toFixed(2)],
    [`Net Margin`, `${(netProfit / totalRevenue * 100).toFixed(1)}%`]];

    const csvContent = rows.map((e) => e.join(',')).join('\n');
    const blob = new Blob([csvContent], {
      type: 'text/csv;charset=utf-8;'
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `${merchant.businessName.replace(/\s+/g, '_')}_Income_Statement_${period}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast.success('Income statement downloaded');
  };
  const periodOptions: {
    id: Period;
    label: string;
  }[] = [
  {
    id: 'daily',
    label: 'Daily'
  },
  {
    id: 'weekly',
    label: 'Weekly'
  },
  {
    id: 'monthly',
    label: 'Monthly'
  },
  {
    id: 'yearly',
    label: 'Yearly'
  }];

  return (
    <PageTransition className="flex flex-col h-full bg-slate-50">
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
              Financial Reports
            </h2>
          </div>
          <button
            onClick={handleDownloadCSV}
            className="p-2 bg-emerald-50 text-emerald-600 rounded-full hover:bg-emerald-100 transition-colors"
            title="Download CSV">
            
            <Download className="w-5 h-5" />
          </button>
        </div>

        {/* Period Selector */}
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {periodOptions.map((p) =>
          <button
            key={p.id}
            onClick={() => setPeriod(p.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${period === p.id ? 'bg-slate-900 text-white shadow-md' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
            
              {p.label}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 pb-24 space-y-6">
        {statementError ? (
          <KPCard className="p-3 text-xs text-amber-700 bg-amber-50 border-amber-100">
            Using local report math because the server statement API is unavailable.
          </KPCard>
        ) : null}
        <KPCard className="p-5 border border-amber-100 bg-amber-50/40">
          <h3 className="text-sm font-bold text-amber-900 mb-1">Working capital</h3>
          <p className="text-xs text-amber-800/80 mb-3">
            Submit a loan request you can track from the server.
          </p>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <KPInput
                type="number"
                placeholder="Amount (R)"
                value={loanAmt}
                onChange={(e) => setLoanAmt(e.target.value)}
              />
            </div>
            <KPButton
              type="button"
              fullWidth={false}
              className="!min-w-[120px] bg-amber-600"
              disabled={loanBusy}
              onClick={async () => {
                const a = Number(loanAmt);
                if (!(a > 0)) {
                  toast.error('Enter a loan amount greater than R0.');
                  return;
                }
                setLoanBusy(true);
                try {
                  const ok = await onRequestLoan(a);
                  if (ok) {
                    toast.success('Loan request sent');
                    setLoanAmt('');
                  } else toast.error('Request failed');
                } finally {
                  setLoanBusy(false);
                }
              }}>
              {loanBusy ? '…' : 'Apply'}
            </KPButton>
          </div>

          {loans.length > 0 ?
            <div className="mt-5 space-y-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-900/80">
                My loans
              </p>
              {loans.map((loan) => {
                const outstanding = Math.max(0, loan.amount - loan.repaidAmount);
                const canRepay =
                  loan.status === 'disbursed' && outstanding > 0 && !!onRepayLoan;
                const isRow = repayingId === loan.id;
                return (
                  <div
                    key={loan.id}
                    className="rounded-xl border border-amber-200/70 bg-white/70 p-3">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-900">
                          R{loan.amount.toFixed(2)}
                          <span className="ml-2 text-[11px] font-medium uppercase tracking-wider text-amber-700">
                            {loan.status}
                          </span>
                        </p>
                        <p className="text-[11px] text-slate-500">
                          Repaid R{loan.repaidAmount.toFixed(2)} · Outstanding
                          R{outstanding.toFixed(2)}
                          {loan.dueDate ?
                            <> · due {new Date(loan.dueDate).toLocaleDateString('en-ZA')}</>
                          : null}
                        </p>
                      </div>
                      {canRepay && !isRow ?
                        <button
                          type="button"
                          onClick={() => {
                            setRepayingId(loan.id);
                            setRepayAmt(outstanding.toFixed(2));
                          }}
                          className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 px-3 py-1.5 rounded-lg">
                          Repay
                        </button>
                      : null}
                    </div>

                    {isRow ?
                      <div className="mt-3 flex gap-2 items-end">
                        <div className="flex-1">
                          <KPInput
                            type="number"
                            placeholder="Amount (R)"
                            value={repayAmt}
                            onChange={(e) => setRepayAmt(e.target.value)}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setRepayingId(null);
                            setRepayAmt('');
                          }}
                          className="px-3 py-3 text-xs font-medium text-slate-500 border border-slate-200 rounded-xl">
                          Cancel
                        </button>
                        <KPButton
                          type="button"
                          fullWidth={false}
                          className="!min-w-[100px]"
                          disabled={repayBusy}
                          onClick={async () => {
                            if (!onRepayLoan) return;
                            const a = Number(repayAmt);
                            if (!(a > 0)) {
                              toast.error('Enter a repayment greater than R0.');
                              return;
                            }
                            if (a > outstanding + 0.01) {
                              toast.error(
                                `Repayment exceeds outstanding (R${outstanding.toFixed(2)}).`,
                              );
                              return;
                            }
                            setRepayBusy(true);
                            try {
                              const ok = await onRepayLoan(loan.id, a);
                              if (ok) {
                                toast.success('Repayment recorded');
                                setRepayingId(null);
                                setRepayAmt('');
                              }
                            } finally {
                              setRepayBusy(false);
                            }
                          }}>
                          {repayBusy ? '…' : 'Pay'}
                        </KPButton>
                      </div>
                    : null}
                  </div>
                );
              })}
            </div>
          : null}
        </KPCard>

        {/* Income Statement Card */}
        <KPCard className="p-6 bg-slate-900 text-white overflow-hidden relative font-mono">
          <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full -mr-10 -mt-10 blur-2xl"></div>
          <div className="relative z-10">
            <h3 className="text-xs font-bold text-slate-400 mb-1 uppercase tracking-widest">
              Income Statement
            </h3>
            <p className="text-sm text-slate-500 mb-6">
              {periodOptions.find((p) => p.id === period)?.label} Report
            </p>

            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-300">Revenue</span>
                <span className="tabular-nums">
                  R{' '}
                  {totalRevenue.toLocaleString('en-ZA', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })}
                </span>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-300">Less: Cost of Goods Sold</span>
                <span className="tabular-nums text-red-400">
                  (R{' '}
                  {totalCOGS.toLocaleString('en-ZA', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })}
                  )
                </span>
              </div>

              <div className="border-t border-slate-700 pt-3 flex justify-between font-bold">
                <span>Gross Profit</span>
                <div className="text-right">
                  <span className="tabular-nums text-emerald-400">
                    R{' '}
                    {grossProfit.toLocaleString('en-ZA', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}
                  </span>
                  <span className="text-xs text-slate-400 ml-2">
                    {grossMarginPct.toFixed(1)}%
                  </span>
                </div>
              </div>

              <div className="flex justify-between pt-2">
                <span className="text-slate-300">Operating Expenses</span>
                <span className="tabular-nums text-red-400">
                  (R{' '}
                  {totalExpenses.toLocaleString('en-ZA', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })}
                  )
                </span>
              </div>

              <div className="border-t-2 border-slate-600 pt-4 flex justify-between text-lg font-bold">
                <span>NET PROFIT</span>
                <span
                  className={`tabular-nums ${netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  
                  R{' '}
                  {netProfit.toLocaleString('en-ZA', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })}
                </span>
              </div>
            </div>
          </div>
        </KPCard>

        {/* Payment Methods */}
        {Object.keys(paymentMethods).length > 0 &&
        <section>
            <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
              Sales by Payment Method
            </h3>
            <KPCard className="p-4 space-y-3">
              {Object.entries(paymentMethods).map(([method, amount]) => {
              const pct = amount / totalRevenue * 100;
              return (
                <div key={method}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="capitalize font-medium text-slate-700">
                        {method}
                      </span>
                      <span className="text-slate-500">
                        <KPAmount amount={amount} /> ({pct.toFixed(0)}%)
                      </span>
                    </div>
                    <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                      <motion.div
                      initial={{
                        width: 0
                      }}
                      animate={{
                        width: `${pct}%`
                      }}
                      transition={{
                        duration: 0.5,
                        delay: 0.1
                      }}
                      className="h-full bg-emerald-500 rounded-full" />
                    
                    </div>
                  </div>);

            })}
            </KPCard>
          </section>
        }

        {/* Top Sellers */}
        {productSales.length > 0 &&
        <section>
            <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
              Top 5 Best Sellers
            </h3>
            <KPCard className="divide-y divide-slate-100">
              {productSales.map((item, i) =>
            <div
              key={item.productId}
              className="p-4 flex items-center gap-4">
              
                  <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-sm shrink-0">
                    {i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-slate-900 truncate">
                      {item.productName}
                    </p>
                    <p className="text-xs text-slate-500">
                      {item.quantity} units sold
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <KPAmount
                  amount={item.revenue}
                  className="font-bold text-slate-900" />
                
                    <div className="w-20 h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1">
                      <div
                    className="h-full bg-emerald-500 rounded-full"
                    style={{
                      width: `${item.revenue / maxSellerRevenue * 100}%`
                    }} />
                  
                    </div>
                  </div>
                </div>
            )}
            </KPCard>
          </section>
        }

        {/* Sales by Category */}
        {categoryData.length > 0 &&
        <section>
            <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
              Sales by Category
            </h3>
            <KPCard className="divide-y divide-slate-100">
              {categoryData.map((cat) =>
            <div key={cat.category} className="p-4">
                  <div className="flex justify-between items-center mb-2">
                    <span className="font-medium text-slate-900">
                      {cat.category}
                    </span>
                    <span className="text-sm text-slate-500">
                      {cat.pct.toFixed(0)}%
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-slate-500 mb-2">
                    <span>{cat.units} units</span>
                    <KPAmount amount={cat.revenue} />
                  </div>
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <motion.div
                  initial={{
                    width: 0
                  }}
                  animate={{
                    width: `${cat.pct}%`
                  }}
                  transition={{
                    duration: 0.5
                  }}
                  className="h-full bg-blue-500 rounded-full" />
                
                  </div>
                </div>
            )}
            </KPCard>
          </section>
        }

        {/* Expense Breakdown */}
        {expenseData.length > 0 &&
        <section>
            <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
              Expense Breakdown
            </h3>
            <KPCard className="divide-y divide-slate-100">
              {expenseData.map((exp) => {
              const Icon = getCategoryIcon(exp.category);
              return (
                <div
                  key={exp.category}
                  className="p-4 flex items-center justify-between">
                  
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-red-50 text-red-600 flex items-center justify-center">
                        <Icon className="w-4 h-4" />
                      </div>
                      <div>
                        <p className="capitalize font-medium text-slate-700">
                          {exp.category}
                        </p>
                        <p className="text-xs text-slate-500">
                          {exp.pct.toFixed(0)}% of expenses
                        </p>
                      </div>
                    </div>
                    <KPAmount amount={exp.amount} className="text-slate-900" />
                  </div>);

            })}
            </KPCard>
          </section>
        }

        {/* Download Actions */}
        <div className="pt-4 space-y-3">
          <KPButton
            onClick={handleDownloadCSV}
            className="w-full bg-slate-900 hover:bg-slate-800">
            
            <FileText className="w-5 h-5 mr-2" />
            Download Full Report (CSV)
          </KPButton>
          <KPButton
            onClick={handleDownloadIncomeStatement}
            variant="outline"
            className="w-full">
            
            <Download className="w-5 h-5 mr-2" />
            Download Income Statement
          </KPButton>
          <p className="text-center text-xs text-slate-500 mt-3">
            SARS-ready format with P&L structure
          </p>
        </div>
      </div>
    </PageTransition>);

};