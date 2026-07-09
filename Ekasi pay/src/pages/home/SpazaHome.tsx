import { useState } from 'react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';
import {
  KPCard,
  KPAmount,
  KPAvatar,
  PageTransition,
  KPBadge } from
'../../components/shared/UIComponents';
import {
  ArrowUpRight,
  ArrowDownLeft,
  Download,
  ShoppingCart,
  Package,
  Eye,
  EyeOff,
  Bell,
  Calculator,
  Zap,
  Loader2,
  RefreshCw,
  X,
  TrendingUp,
  ChevronRight,
  Coins,
  History,
  Wallet as WalletIcon,
  Briefcase,
} from 'lucide-react';
import type {
  User,
  Wallet,
  Transaction,
  Sale,
  Merchant,
  Expense,
  Language,
  Product,
  FoodSafetyAlert,
  ComplianceFlag,
  ExpiryItem,
} from '../../types';
import type { WorkspaceMode } from '../../hooks/useAppState';
import { useTranslations } from '../../hooks/useTranslations';
import { countUnreadNotifications } from '../notifications/notificationCount';
const OnboardingOverlay = ({ onComplete }: {onComplete: () => void;}) => {
  const [step, setStep] = useState(0);
  const steps = [
  {
    title: 'Welcome to KasiPay!',
    desc: "Your all-in-one spaza shop management app. Let's take a quick tour.",
    icon: <TrendingUp className="w-12 h-12 text-emerald-600" />
  },
  {
    title: 'Shop POS',
    desc: 'Ring up sales quickly, calculate change, and share receipts via WhatsApp.',
    icon: <ShoppingCart className="w-12 h-12 text-blue-600" />
  },
  {
    title: 'Inventory & Stock',
    desc: 'Track your products, get low stock alerts, and manage your margins.',
    icon: <Package className="w-12 h-12 text-purple-600" />
  },
  {
    title: 'Money Services',
    desc: 'Earn extra income by helping customers send and receive money.',
    icon: <ArrowUpRight className="w-12 h-12 text-amber-600" />
  }];

  const currentStep = steps[step];
  return (
    <div className="absolute inset-0 z-[100] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-6">
      <motion.div
        key={step}
        initial={{
          opacity: 0,
          scale: 0.9,
          y: 20
        }}
        animate={{
          opacity: 1,
          scale: 1,
          y: 0
        }}
        exit={{
          opacity: 0,
          scale: 0.9,
          y: -20
        }}
        className="bg-white rounded-3xl p-8 w-full max-w-sm shadow-2xl flex flex-col items-center text-center relative overflow-hidden">
        
        <div className="absolute top-0 left-0 w-full h-32 bg-slate-50 -z-10 rounded-t-3xl"></div>
        <div className="w-24 h-24 bg-white rounded-full shadow-md flex items-center justify-center mb-6 z-10">
          {currentStep.icon}
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-3">
          {currentStep.title}
        </h2>
        <p className="text-slate-500 mb-8">{currentStep.desc}</p>

        <div className="flex gap-2 mb-8">
          {steps.map((_, i) =>
          <div
            key={i}
            className={`w-2 h-2 rounded-full transition-colors ${i === step ? 'bg-emerald-600' : 'bg-slate-200'}`} />

          )}
        </div>

        <button
          onClick={() => {
            if (step < steps.length - 1) setStep(step + 1);else
            onComplete();
          }}
          className="w-full bg-slate-900 text-white py-4 rounded-xl font-bold flex items-center justify-center gap-2 active:scale-95 transition-transform">
          
          {step < steps.length - 1 ? 'Next' : 'Get Started'}
          {step < steps.length - 1 && <ChevronRight className="w-5 h-5" />}
        </button>

        {step < steps.length - 1 &&
        <button
          onClick={onComplete}
          className="mt-4 text-sm font-medium text-slate-400 hover:text-slate-600">
          
            Skip Tour
          </button>
        }
      </motion.div>
    </div>);

};
export const SpazaHome = ({
  user,
  wallet,
  merchant,
  showMerchantWorkspace,
  workspaceMode,
  setWorkspaceMode,
  agentWithoutMerchantProfile,
  transactions,
  sales,
  products,
  expenses,
  alerts,
  flags,
  expiryItems,
  language,
  navigate,
  hasSeenOnboarding,
  completeOnboarding,
  onPullRefresh,
  isSyncingData = false,
}: {
  user: User;
  wallet: Wallet;
  merchant: Merchant;
  /** User chose merchant workspace (vs simplified wallet view) */
  showMerchantWorkspace: boolean;
  workspaceMode: WorkspaceMode;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  /** Agents without a linked shop still get payout-style shortcuts */
  agentWithoutMerchantProfile: boolean;
  transactions: Transaction[];
  sales: Sale[];
  products: Product[];
  expenses: Expense[];
  alerts: FoodSafetyAlert[];
  flags: ComplianceFlag[];
  expiryItems: ExpiryItem[];
  language: Language;
  navigate: (p: string) => void;
  hasSeenOnboarding?: boolean;
  completeOnboarding?: () => void;
  /** Reload wallet, sales & activity from the API. */
  onPullRefresh?: () => Promise<void>;
  /** Background sync after login or app hydrate. */
  isSyncingData?: boolean;
}) => {
  const unreadCount = countUnreadNotifications({
    alerts,
    flags,
    expiry: expiryItems,
    products: showMerchantWorkspace ? products : [],
  });
  const showShopTiles = showMerchantWorkspace;
  const showAgentTiles =
    showMerchantWorkspace && agentWithoutMerchantProfile;
  const [showBalance, setShowBalance] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showDailySummary, setShowDailySummary] = useState(true);
  const { t } = useTranslations(language);
  const todaySales = sales.filter(
    (s) => new Date(s.createdAt).toDateString() === new Date().toDateString()
  );
  const todaySalesTotal = todaySales.reduce((sum, s) => sum + s.total, 0);
  // Calculate gross margin from sales using product cost prices
  const todayGrossMargin = todaySales.reduce((sum, s) => {
    return (
      sum +
      s.items.reduce((itemSum, item) => {
        const product = products.find((p) => p.id === item.productId);
        const costPrice = product?.costPrice ?? item.price * 0.7;
        return itemSum + (item.price - costPrice) * item.quantity;
      }, 0));

  }, 0);
  const todayExpenses = expenses.filter(
    (e) => new Date(e.createdAt).toDateString() === new Date().toDateString()
  );
  const todayExpensesTotal = todayExpenses.reduce((sum, e) => sum + e.amount, 0);
  const todayProfit = todayGrossMargin - todayExpensesTotal;
  const todayTransfers = transactions.filter(
    (t) =>
    new Date(t.createdAt).toDateString() === new Date().toDateString() &&
    t.type === 'transfer'
  );
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return t('greeting.morning');
    if (hour < 18) return t('greeting.afternoon');
    return t('greeting.evening');
  };
  // Manual refresh — pull-to-drag was removed because it fought native scroll on mobile.
  const handleManualRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      if (onPullRefresh) {
        await onPullRefresh();
        toast.success('Dashboard synced');
      } else {
        toast.message('Connect your app to the API to sync live data.');
      }
    } catch {
      toast.error('Could not refresh. Check your internet connection.');
    } finally {
      setIsRefreshing(false);
    }
  };
  // Combine and sort recent activity
  const recentActivity = [
  ...transactions.map((t) => ({
    ...t,
    activityType: 'transaction' as const
  })),
  ...sales.map((s) => ({
    ...s,
    activityType: 'sale' as const
  }))].

  sort(
    (a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  ).
  slice(0, 5);
  return (
    <PageTransition className="relative flex flex-col min-h-0">
      {!hasSeenOnboarding && completeOnboarding &&
      <OnboardingOverlay onComplete={completeOnboarding} />
      }

      {(isSyncingData || isRefreshing) &&
      <div className="sticky top-0 z-20 bg-emerald-50 border-b border-emerald-100 px-4 py-2 flex items-center justify-center gap-2 text-emerald-700 text-xs font-medium">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        <span>{isRefreshing ? 'Refreshing dashboard…' : 'Syncing your data…'}</span>
      </div>
      }

      <div className="px-6 pt-6 pb-nav relative bg-slate-50">
        
        {/* Header */}
        <div className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-3">
            <KPAvatar name={user.name} />
            <div>
              <p className="text-sm text-slate-500">
                {getGreeting()}, {user.name.split(' ')[0]}
              </p>
              <h2 className="text-lg font-bold text-slate-900">
                {merchant.businessName}
              </h2>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleManualRefresh()}
              disabled={isRefreshing || isSyncingData}
              aria-label="Refresh dashboard"
              className="p-2 bg-white rounded-full shadow-sm border border-slate-100 hover:bg-slate-50 transition-colors disabled:opacity-50">
              <RefreshCw className={`w-5 h-5 text-slate-600 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={() => navigate('notifications')}
            aria-label={
              unreadCount > 0
                ? `Notifications (${unreadCount} unread)`
                : 'Notifications'
            }
            className="relative p-2 bg-white rounded-full shadow-sm border border-slate-100 hover:bg-slate-50 transition-colors">
            <Bell className="w-5 h-5 text-slate-600" />
            {unreadCount > 0 ?
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-red-500 text-white text-[10px] font-bold rounded-full border border-white flex items-center justify-center">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            : null}
          </button>
          </div>
        </div>

        {/* Daily Summary Notification */}
        {showDailySummary && todaySalesTotal > 0 &&
        <motion.div
          initial={{
            opacity: 0,
            y: -20
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          exit={{
            opacity: 0,
            scale: 0.95
          }}
          className="bg-emerald-50 border border-emerald-100 rounded-2xl p-4 mb-6 relative">
          
            <button
            onClick={() => setShowDailySummary(false)}
            className="absolute top-3 right-3 text-emerald-400 hover:text-emerald-600 transition-colors">
            
              <X className="w-4 h-4" />
            </button>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center shrink-0">
                <TrendingUp className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-emerald-900 text-sm mb-1">
                  Great day so far!
                </h3>
                <p className="text-emerald-700 text-xs">
                  You've made <KPAmount amount={todaySalesTotal} /> in sales
                  today, with a net profit of <KPAmount amount={todayProfit} />.
                  Keep it up!
                </p>
              </div>
            </div>
          </motion.div>
        }

        {/* Balance Card */}
        <motion.div
          className="bg-emerald-600 rounded-3xl p-6 text-white shadow-xl shadow-emerald-600/20 mb-6 relative overflow-hidden"
          whileTap={{
            scale: 0.98
          }}>
          
          <div className="absolute -right-10 -top-10 w-40 h-40 bg-white/10 rounded-full blur-2xl"></div>
          <div className="absolute -left-10 -bottom-10 w-40 h-40 bg-emerald-800/20 rounded-full blur-2xl"></div>

          <div className="relative z-10">
            <div className="flex justify-between items-center mb-2">
              <span className="text-emerald-50 font-medium">
                {t('home.walletBalance')}
              </span>
              <button
                onClick={() => setShowBalance(!showBalance)}
                className="text-emerald-100 hover:text-white transition-colors">
                
                {showBalance ?
                <EyeOff className="w-5 h-5" /> :

                <Eye className="w-5 h-5" />
                }
              </button>
            </div>
            <div className="text-4xl font-bold tracking-tight mb-6">
              {showBalance ? <KPAmount amount={wallet.balance} /> : 'R •••••'}
            </div>
            <div className="flex justify-between items-end">
              <div className="flex gap-4">
                <div>
                  <p className="text-[10px] text-emerald-200 mb-1 uppercase tracking-wider">
                    {t('home.todaysSales')}
                  </p>
                  <p className="font-medium text-sm">
                    <KPAmount amount={todaySalesTotal} />
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-emerald-200 mb-1 uppercase tracking-wider">
                    {t('home.todaysProfit')}
                  </p>
                  <p
                    className={`font-medium text-sm ${todayProfit < 0 ? 'text-red-200' : ''}`}>
                    
                    <KPAmount amount={todayProfit} />
                  </p>
                </div>
              </div>
              <KPBadge
                variant="success"
                className="bg-white/20 text-white border-white/10 backdrop-blur-sm">
                
                {todayTransfers.length} {t('home.transfers')}
              </KPBadge>
            </div>
          </div>
        </motion.div>

        {/* Quick Actions Grid */}
        <div className="grid grid-cols-2 gap-3 mb-8">
          {!showMerchantWorkspace ?
            <>
              <button
                onClick={() => navigate('transfer')}
                className="bg-emerald-50 border border-emerald-100 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform">
                <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                  <ArrowUpRight className="w-5 h-5" />
                </div>
                <span className="font-semibold text-emerald-800 text-sm">
                  Wallet Transfer
                </span>
              </button>

              <button
                onClick={() => navigate('send')}
                className="bg-amber-50 border border-amber-100 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform">
                <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center">
                  <ArrowDownLeft className="w-5 h-5" />
                </div>
                <span className="font-semibold text-amber-800 text-sm">
                  Cash Send
                </span>
              </button>

              <button
                onClick={() => navigate('receive')}
                className="col-span-2 bg-blue-50 border border-blue-100 p-4 rounded-2xl flex flex-row items-center justify-center gap-3 active:scale-95 transition-transform">
                <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
                  <Download className="w-5 h-5" />
                </div>
                <span className="font-semibold text-blue-800 text-sm">
                  Collect Cash (payout at shop)
                </span>
              </button>
            </>
          : null}

          {showAgentTiles ?
            <>
              <button
                type="button"
                onClick={() => navigate('commissions')}
                className="bg-amber-50 border border-amber-100 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform">
                <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center">
                  <Coins className="w-5 h-5" />
                </div>
                <span className="font-semibold text-amber-900 text-sm text-center leading-tight">
                  Commissions
                </span>
              </button>
              <button
                type="button"
                onClick={() => navigate('history')}
                className="bg-slate-50 border border-slate-200 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform">
                <div className="w-10 h-10 rounded-full bg-slate-200 text-slate-700 flex items-center justify-center">
                  <History className="w-5 h-5" />
                </div>
                <span className="font-semibold text-slate-800 text-sm text-center leading-tight">
                  Activity
                </span>
              </button>
            </>
          : null}

          {showShopTiles ?
            <>
              <button
                type="button"
                onClick={() => navigate('shop')}
                className="bg-blue-50 border border-blue-100 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform">
                <div className="w-10 h-10 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center">
                  <ShoppingCart className="w-5 h-5" />
                </div>
                <span className="font-semibold text-blue-800 text-sm">
                  {t('actions.newSale')}
                </span>
              </button>

              <button
                type="button"
                onClick={() => navigate('inventory')}
                className="bg-purple-50 border border-purple-100 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform">
                <div className="w-10 h-10 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center">
                  <Package className="w-5 h-5" />
                </div>
                <span className="font-semibold text-purple-800 text-sm">
                  {t('actions.checkStock')}
                </span>
              </button>
            </>
          : null}

          <button
            type="button"
            onClick={() => navigate('buy')}
            className="bg-amber-50 border border-amber-100 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform">
            <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center">
              <Zap className="w-5 h-5" />
            </div>
            <span className="font-semibold text-amber-800 text-sm">Buy airtime / electricity</span>
          </button>

          <button
            type="button"
            onClick={() => navigate('calculator')}
            className="bg-teal-50 border border-teal-100 p-4 rounded-2xl flex flex-col items-center justify-center gap-2 active:scale-95 transition-transform">
            <div className="w-10 h-10 rounded-full bg-teal-100 text-teal-600 flex items-center justify-center">
              <Calculator className="w-5 h-5" />
            </div>
            <span className="font-semibold text-teal-800 text-sm">
              {t('actions.calculator')}
            </span>
          </button>
        </div>

        {/* Recent Activity Feed */}
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-lg font-bold text-slate-900">
              {t('home.recentActivity')}
            </h3>
            {recentActivity.length > 0 &&
            <button
              onClick={() => navigate('history')}
              className="text-sm font-medium text-emerald-600">
              
                {t('actions.viewAll')}
              </button>
            }
          </div>
          <div className="space-y-3 pb-8">
            {recentActivity.length === 0 ?
            <div className="text-center py-10 bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                <p className="text-slate-500 text-sm">No recent activity</p>
              </div> :

            recentActivity.map((item) => {
              if (item.activityType === 'sale') {
                const sale = item as Sale & {
                  activityType: 'sale';
                };
                return (
                  <KPCard
                    key={`sale-${sale.id}`}
                    className="p-4 flex items-center justify-between">
                    
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full flex items-center justify-center bg-blue-50 text-blue-600">
                          <ShoppingCart className="w-5 h-5" />
                        </div>
                        <div>
                          <p className="font-medium text-slate-900">
                            Shop Sale
                          </p>
                          <p className="text-xs text-slate-500">
                            {sale.items.length} items • {sale.paymentMethod}
                          </p>
                        </div>
                      </div>
                      <KPAmount
                      amount={sale.total}
                      showSign
                      className="text-emerald-600" />
                    
                    </KPCard>);

              } else {
                const tx = item as Transaction & {
                  activityType: 'transaction';
                };
                const isOutgoing = tx.fromWalletId === wallet.id;
                return (
                  <KPCard
                    key={`tx-${tx.id}`}
                    className="p-4 flex items-center justify-between">
                    
                      <div className="flex items-center gap-3">
                        <div
                        className={`w-10 h-10 rounded-full flex items-center justify-center ${isOutgoing ? 'bg-slate-100 text-slate-600' : 'bg-emerald-50 text-emerald-600'}`}>
                        
                          {isOutgoing ?
                        <ArrowUpRight className="w-5 h-5" /> :

                        <ArrowDownLeft className="w-5 h-5" />
                        }
                        </div>
                        <div>
                          <p className="font-medium text-slate-900">
                            {tx.description}
                          </p>
                          <p className="text-xs text-slate-500">
                            {tx.status === 'pending' ?
                          'Pending Collection' :
                          'Completed'}
                          </p>
                        </div>
                      </div>
                      <KPAmount
                      amount={tx.amount}
                      showSign
                      className={
                      isOutgoing ? 'text-slate-900' : 'text-emerald-600'
                      } />
                    
                    </KPCard>);

              }
            })
            }
          </div>
        </div>
      </div>

      {/* Floating workspace-mode toggle. Sits above the bottom nav (~88px). */}
      <motion.button
        type="button"
        onClick={() => {
          const next: WorkspaceMode =
            workspaceMode === 'merchant' ? 'wallet' : 'merchant';
          setWorkspaceMode(next);
          toast.success(
            next === 'wallet' ?
              'Switched to wallet mode'
            : 'Switched to merchant mode',
          );
        }}
        aria-label={
        workspaceMode === 'merchant' ?
          'Switch to wallet mode' :
          'Switch to merchant mode'
        }
        title={
        workspaceMode === 'merchant' ?
          'Switch to wallet mode' :
          'Switch to merchant mode'
        }
        initial={{ scale: 0, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        whileTap={{ scale: 0.94 }}
        transition={{ type: 'spring', stiffness: 320, damping: 22 }}
        className={`absolute right-5 bottom-24 z-30 flex items-center gap-2 px-4 h-12 rounded-full shadow-lg shadow-emerald-900/20 active:shadow-md font-medium text-sm ${
        workspaceMode === 'merchant' ?
          'bg-emerald-600 text-white' :
          'bg-amber-500 text-slate-900'
        }`}>
        {workspaceMode === 'merchant' ?
          <WalletIcon className="w-5 h-5" /> :
          <Briefcase className="w-5 h-5" />
        }
        <span>
          {workspaceMode === 'merchant' ? 'Wallet mode' : 'Merchant mode'}
        </span>
      </motion.button>
    </PageTransition>);

};