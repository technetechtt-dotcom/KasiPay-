import type { FC, ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  Home,
  ArrowLeftRight,
  ShoppingCart,
  History,
  MoreHorizontal,
  Wifi,
  Battery,
  Signal,
  WifiOff } from
'lucide-react';
import type { Language } from '../../types';
import { useTranslations } from '../../hooks/useTranslations';
interface AppShellProps {
  currentPage: string;
  navigate: (page: string) => void;
  isOffline?: boolean;
  /**
   * Active workspace. Drives the bottom nav: merchant mode shows Shop,
   * wallet mode shows Services (Cash Send / money services).
   */
  workspaceMode?: 'merchant' | 'wallet';
  /** Sale / expense records queued for replay (offline outbox). */
  pendingOutbox?: number;
  language?: Language;
  children: ReactNode;
}
export const AppShell: FC<AppShellProps> = ({
  currentPage,
  navigate,
  isOffline = false,
  workspaceMode = 'merchant',
  pendingOutbox = 0,
  language = 'en',
  children,
}) => {
  const { t } = useTranslations(language);
  const isMerchantMode = workspaceMode === 'merchant';
  const time = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  const navItemsAll = [
  {
    id: 'home',
    icon: Home,
    label: t('nav.home'),
  },
  {
    id: 'services',
    icon: ArrowLeftRight,
    label: t('nav.services'),
  },
  {
    id: 'shop',
    icon: ShoppingCart,
    label: t('nav.shop'),
  },
  {
    id: 'history',
    icon: History,
    label: t('nav.history'),
  },
  {
    id: 'more',
    icon: MoreHorizontal,
    label: t('nav.more'),
  }];

  /** Merchant mode hides Services; wallet mode hides Shop. */
  const navItems = navItemsAll.filter((item) =>
    isMerchantMode ? item.id !== 'services' : item.id !== 'shop'
  );

  const merchantOnlyMoreSubpages = [
    'inventory',
    'add-stock',
    'scanner',
    'expenses',
    'analytics',
    'reports',
    'credit-book',
    'supplier-orders',
    'layby',
    'price-comparison',
    'business-health',
    'voice-notes',
    'food-safety',
    'stock-value',
  ];

  /** Wallet-mode subpages opened from More (community money tools). */
  const walletOnlyMoreSubpages = ['stokvel', 'insurance'];

  /** Pages that highlight the "More" tab (includes shared tools like load shedding). */
  const moreHighlightPages = [
    ...(isMerchantMode ? merchantOnlyMoreSubpages : walletOnlyMoreSubpages),
    'loadshedding',
    'admin',
    'ledger',
    'users',
    'compliance',
    'claims',
    'commissions',
    'settings',
    'help',
  ];

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 sm:p-8">
      {/* Phone Frame */}
      <div className="relative w-full max-w-[400px] h-[850px] max-h-[95vh] bg-slate-50 rounded-[3rem] shadow-2xl overflow-hidden border-[8px] border-slate-800 flex flex-col">
        {/* Fake Status Bar */}
        <div className="h-12 w-full bg-slate-50 flex items-center justify-between px-6 text-slate-900 text-xs font-medium z-50 shrink-0">
          <span>{time}</span>
          {/* Dynamic Island Mock */}
          <div className="absolute left-1/2 -translate-x-1/2 top-2 w-32 h-7 bg-black rounded-full"></div>
          <div className="flex items-center gap-2">
            <Signal className="w-3.5 h-3.5" />
            {isOffline ?
            <WifiOff className="w-3.5 h-3.5 text-red-500" /> :

            <Wifi className="w-3.5 h-3.5" />
            }
            <Battery className="w-4 h-4" />
          </div>
        </div>

        {/* Offline / outbox banner */}
        {isOffline ?
          <div className="bg-amber-500 text-white text-[10px] font-bold py-1.5 px-4 flex items-center justify-center gap-2 z-40 shadow-sm">
            <WifiOff className="w-3 h-3" />
            <span>
              You're offline — money services paused.
              {pendingOutbox > 0 ?
                <> {pendingOutbox} sale/expense queued.</>
              : null}
            </span>
          </div>
        : pendingOutbox > 0 ?
          <div className="bg-blue-500 text-white text-[10px] font-bold py-1.5 px-4 flex items-center justify-center gap-2 z-40 shadow-sm">
            <span>
              Syncing {pendingOutbox} queued item{pendingOutbox === 1 ? '' : 's'}…
            </span>
          </div>
        : null}

        {/* Scrollable Content Area */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden relative scrollbar-hide">
          {children}
        </div>

        {/* Bottom Navigation */}
        <div className="absolute bottom-0 left-0 w-full bg-white border-t border-slate-100 pb-safe pt-2 px-6 pb-6 z-50 rounded-b-[2.5rem]">
          <div className="flex justify-between items-center">
            {navItems.map((item) => {
              const isActive =
                currentPage === item.id ||
                (item.id === 'home' && currentPage === 'calculator') ||
                (item.id === 'services' &&
                  !isMerchantMode &&
                  (currentPage === 'send' || currentPage === 'receive')) ||
                (item.id === 'more' && moreHighlightPages.includes(currentPage));
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  onClick={() => navigate(item.id)}
                  className="relative flex flex-col items-center justify-center w-16 h-14">
                  
                  <motion.div
                    animate={{
                      y: isActive ? -4 : 0,
                      color: isActive ? '#047857' : '#64748b'
                    }}
                    className="flex flex-col items-center gap-1">
                    
                    <Icon
                      className={`w-6 h-6 ${isActive ? 'fill-emerald-50' : ''}`}
                      strokeWidth={isActive ? 2.5 : 2} />
                    
                    <span className="text-[10px] font-medium">
                      {item.label}
                    </span>
                  </motion.div>
                  {isActive &&
                  <motion.div
                    layoutId="nav-indicator"
                    className="absolute -top-2 w-1 h-1 rounded-full bg-emerald-600" />

                  }
                </button>);

            })}
          </div>
        </div>
      </div>
    </div>);

};