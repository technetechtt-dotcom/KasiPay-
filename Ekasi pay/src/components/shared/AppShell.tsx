import type { FC, ReactNode } from 'react';
import { motion } from 'framer-motion';
import {
  Home,
  ArrowLeftRight,
  ShoppingCart,
  History,
  MoreHorizontal,
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
  /** When false, the Services tab is omitted (Cash Send disabled by ops). */
  showServicesTab?: boolean;
  /** Sale / expense records queued for replay (offline outbox). */
  pendingOutbox?: number;
  language?: Language;
  /** Fixed controls rendered above the bottom nav (outside the scroll area). */
  floatingOverlay?: ReactNode;
  children: ReactNode;
}
export const AppShell: FC<AppShellProps> = ({
  currentPage,
  navigate,
  isOffline = false,
  workspaceMode = 'merchant',
  showServicesTab = true,
  pendingOutbox = 0,
  language = 'en',
  floatingOverlay,
  children,
}) => {
  const { t } = useTranslations(language);
  const isMerchantMode = workspaceMode === 'merchant';
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

  /** Merchant mode hides Services; wallet mode hides Shop; ops can hide Services. */
  const navItems = navItemsAll.filter((item) => {
    if (item.id === 'services' && (isMerchantMode || !showServicesTab)) {
      return false;
    }
    if (item.id === 'shop' && !isMerchantMode) return false;
    return true;
  });

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
    'float-cash',
    'record-purchase-slip',
  ];

  /** Wallet-mode subpages opened from More (community money tools). */
  const walletOnlyMoreSubpages = [
    'stokvel',
    'insurance',
    'loadshedding',
    'transfer',
    'buy',
    'notifications',
  ];

  /** Pages that highlight the "More" tab (includes shared tools like load shedding). */
  const moreHighlightPages = [
    ...(isMerchantMode ? merchantOnlyMoreSubpages : walletOnlyMoreSubpages),
    'loadshedding',
    'notifications',
    'admin',
    'ledger',
    'users',
    'compliance',
    'claims',
    'merchant-approvals',
    'commissions',
    'settings',
    'help',
  ];

  /** Pages where the bottom tab bar is hidden (full-height tools). */
  const hideBottomNav = new Set(['scanner']);

  return (
    <div className="min-h-[100dvh] bg-slate-100 flex items-center justify-center p-0 sm:p-4 lg:p-6">
      {/* Production shell: full-bleed on phones, wider workspace on tablets/desktops. */}
      <div className="relative w-full max-w-[960px] h-[100dvh] sm:h-[calc(100dvh-2rem)] sm:max-h-[960px] bg-slate-50 sm:rounded-[2rem] shadow-xl overflow-hidden sm:border border-slate-200 flex flex-col">
        {/* Offline / outbox banner */}
        {isOffline ?
          <div className="bg-amber-500 text-white text-xs font-bold py-1.5 px-4 flex items-center justify-center gap-2 z-40 shadow-sm">
            <WifiOff className="w-3 h-3" />
            <span>
              You're offline — money services paused.
              {pendingOutbox > 0 ?
                <> {pendingOutbox} sale/expense queued.</>
              : null}
            </span>
          </div>
        : pendingOutbox > 0 ?
          <div className="bg-blue-500 text-white text-xs font-bold py-1.5 px-4 flex items-center justify-center gap-2 z-40 shadow-sm">
            <span>
              Syncing {pendingOutbox} queued item{pendingOutbox === 1 ? '' : 's'}…
            </span>
          </div>
        : null}

        {/* Main content — flex child scrolls; tab bar is a sibling, not an overlay. */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col relative">
          <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide overscroll-y-contain touch-pan-y">
            {children}
          </div>
          {floatingOverlay ?
          <div className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+5.5rem)] right-5 z-30 pointer-events-none">
            <div className="pointer-events-auto">{floatingOverlay}</div>
          </div>
          : null}
        </div>

        {/* Bottom Navigation — extra bottom padding clears phone-frame radius
            and the device home indicator so icons/labels are not clipped. */}
        {!hideBottomNav.has(currentPage) ? (
        <div className="shrink-0 flex-none w-full bg-white border-t border-slate-100 pt-2.5 px-3 z-50 rounded-b-[2.5rem] max-sm:rounded-b-none pb-[max(1.25rem,calc(env(safe-area-inset-bottom,0px)+0.75rem))] sm:pb-8">
          <div className="flex justify-between items-center gap-0.5 overflow-visible">
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
                  type="button"
                  onClick={() => navigate(item.id)}
                  className="relative flex flex-1 flex-col items-center justify-center min-h-[3.75rem] max-w-[5.5rem] py-1 overflow-visible">
                  
                  <motion.div
                    animate={{
                      color: isActive ? '#047857' : '#64748b'
                    }}
                    className="flex flex-col items-center gap-0.5 overflow-visible">
                    
                    <Icon
                      className={`w-6 h-6 shrink-0 ${isActive ? 'fill-emerald-50' : ''}`}
                      strokeWidth={isActive ? 2.5 : 2} />
                    
                    <span className="text-[11px] font-medium leading-tight whitespace-nowrap">
                      {item.label}
                    </span>
                  </motion.div>
                  {isActive &&
                  <motion.div
                    layoutId="nav-indicator"
                    className="absolute top-0 w-1 h-1 rounded-full bg-emerald-600" />

                  }
                </button>);

            })}
          </div>
        </div>
        ) : null}
      </div>
    </div>);

};