import {
  KPCard,
  KPAvatar,
  PageTransition,
  KPBadge,
  KPButton } from
'../../components/shared/UIComponents';
import {
  Package,
  ShieldAlert,
  BookOpen,
  LogOut,
  ChevronRight,
  Settings,
  HelpCircle,
  Receipt,
  BarChart3,
  FileText,
  Coins,
  Truck,
  Users,
  ShoppingBag,
  Zap,
  Activity,
  Tags,
  Shield,
  Mic,
  ShieldCheck,
  Wallet,
  Download,
  History } from
'lucide-react';
import type {
  User,
  Merchant,
  FoodSafetyAlert,
  Language,
} from '../../types';
import type { WorkspaceMode } from '../../hooks/useAppState';
import { useTranslations } from '../../hooks/useTranslations';
export const MorePage = ({
  user,
  merchant,
  showMerchantWorkspace,
  workspaceMode,
  setWorkspaceMode,
  agentWithoutMerchantProfile,
  alerts,
  language = 'en',
  navigate,
  logout,
}: {
  user: User;
  merchant: Merchant;
  showMerchantWorkspace: boolean;
  workspaceMode: WorkspaceMode;
  setWorkspaceMode: (mode: WorkspaceMode) => void;
  agentWithoutMerchantProfile: boolean;
  alerts: FoodSafetyAlert[];
  language?: Language;
  navigate: (p: string) => void;
  logout: () => void;
}) => {
  const { t } = useTranslations(language);
  const showFullShopTools = showMerchantWorkspace;
  const unreadCritical = alerts.filter(
    (a) => !a.isRead && a.severity === 'critical'
  ).length;
  return (
    <PageTransition className="px-6 pt-12 pb-8 bg-slate-50 min-h-full">
      <h2 className="text-xl font-bold text-slate-900 mb-6">More</h2>

      {/* Profile Summary */}
      <KPCard className="mb-8 p-4 flex items-center gap-4">
        <KPAvatar name={user.name} size="lg" />
        <div>
          <h3 className="font-bold text-slate-900">{user.name}</h3>
          <p className="text-sm text-slate-500 mb-1">{merchant.businessName}</p>
          {workspaceMode === 'wallet' ?
            <KPBadge variant="neutral">Wallet view</KPBadge>
          : agentWithoutMerchantProfile ?
            <KPBadge variant="warning">Agent · no shop linked</KPBadge>
          : user.role === 'agent' ?
            <KPBadge variant="success">Verified Agent</KPBadge>
          : user.role === 'merchant' ?
            <KPBadge variant="success">Merchant</KPBadge>
          :
            <KPBadge variant="neutral">Wallet</KPBadge>
          }
        </div>
      </KPCard>

      <KPCard className="mb-8 p-4 border border-slate-200 bg-white">
        <p className="text-xs text-slate-600 mb-3 leading-relaxed">
          {workspaceMode === 'merchant' ?
            'Merchant mode shows shop, stock, POS, and business tools in the app.'
          : 'Wallet mode keeps money, history, and shared tools — shop dashboards are hidden.'}
        </p>
        <KPButton
          type="button"
          variant={workspaceMode === 'merchant' ? 'outline' : 'primary'}
          onClick={() =>
            setWorkspaceMode(workspaceMode === 'merchant' ? 'wallet' : 'merchant')
          }>
          {workspaceMode === 'merchant' ?
            'Switch to wallet mode'
          : 'Switch to merchant mode'}
        </KPButton>
      </KPCard>

      {agentWithoutMerchantProfile && !showMerchantWorkspace ?
        <>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
            Agent workspace
          </h3>
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mb-8">
            <button
              type="button"
              onClick={() => navigate('send')}
              className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
                  <Wallet className="w-4 h-4" />
                </div>
                <span className="font-medium text-slate-700">Cash Send</span>
              </div>
              <ChevronRight className="w-5 h-5 text-slate-300" />
            </button>
            <button
              type="button"
              onClick={() => navigate('commissions')}
              className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center">
                  <Coins className="w-4 h-4" />
                </div>
                <span className="font-medium text-slate-700">Commissions</span>
              </div>
              <ChevronRight className="w-5 h-5 text-slate-300" />
            </button>
            <button
              type="button"
              onClick={() => navigate('history')}
              className="w-full flex items-center justify-between p-4 active:bg-slate-50">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center">
                  <History className="w-4 h-4" />
                </div>
                <span className="font-medium text-slate-700">Activity & history</span>
              </div>
              <ChevronRight className="w-5 h-5 text-slate-300" />
            </button>
          </div>
        </>
      : null}

      {/* Shop Management */}
      {showFullShopTools && (
        <>
      <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
        {t('more.shopManagement')}
      </h3>
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mb-8">
        <button
          onClick={() => navigate('food-safety')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50 relative">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">
              Food Safety & Compliance
            </span>
          </div>
          <div className="flex items-center gap-2">
            {unreadCritical > 0 &&
            <span className="bg-red-500 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">
                {unreadCritical} New
              </span>
            }
            <ChevronRight className="w-5 h-5 text-slate-300" />
          </div>
        </button>

        <button
          onClick={() => navigate('credit-book')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <BookOpen className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">
              Credit Book (Izikweletu)
            </span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>

        <button
          onClick={() => navigate('voice-notes')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-teal-50 text-teal-600 flex items-center justify-center">
              <Mic className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">Voice Notes</span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>

        <button
          onClick={() => navigate('supplier-orders')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
              <Truck className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">Supplier Orders</span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>

        <button
          onClick={() => navigate('inventory')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-purple-50 text-purple-600 flex items-center justify-center">
              <Package className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">
              Inventory & Stock
            </span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>

        <button
          onClick={() => navigate('expenses')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-red-50 text-red-600 flex items-center justify-center">
              <Receipt className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">
              Expenses & Profit
            </span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>

        <button
          onClick={() => navigate('business-health')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
              <Activity className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">Business Health</span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>

        <button
          onClick={() => navigate('analytics')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
              <BarChart3 className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">
              Advanced Analytics
            </span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>

        <button
          onClick={() => navigate('price-comparison')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <Tags className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">Smart Pricing</span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>

        <button
          onClick={() => navigate('reports')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-indigo-50 text-indigo-600 flex items-center justify-center">
              <FileText className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">
              Financial Reports
            </span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>
      </div>
        </>
      )}

      {!agentWithoutMerchantProfile ?
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mb-8">
          <button
            onClick={() => navigate('commissions')}
            className="w-full flex items-center justify-between p-4 active:bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center">
                <Coins className="w-4 h-4" />
              </div>
              <span className="font-medium text-slate-700">
                Agent Commissions
              </span>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-300" />
          </button>
        </div>
      : null}

      {/* Community & Services */}
      <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
        {t('more.communityServices')}
      </h3>
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mb-8 divide-y divide-slate-100">
        {!showMerchantWorkspace && (
          <button
            onClick={() => navigate('send')}
            className="w-full flex items-center justify-between p-4 active:bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center">
                <Wallet className="w-4 h-4" />
              </div>
              <span className="font-medium text-slate-700">Cash Send</span>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-300" />
          </button>
        )}

        {!showMerchantWorkspace && (
          <button
            onClick={() => navigate('receive')}
            className="w-full flex items-center justify-between p-4 active:bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
                <Download className="w-4 h-4" />
              </div>
              <span className="font-medium text-slate-700">Collect Cash</span>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-300" />
          </button>
        )}

        {!showMerchantWorkspace && (
          <button
            onClick={() => navigate('stokvel')}
            className="w-full flex items-center justify-between p-4 active:bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-purple-50 text-purple-600 flex items-center justify-center">
                <Users className="w-4 h-4" />
              </div>
              <span className="font-medium text-slate-700">
                Community Stokvel
              </span>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-300" />
          </button>
        )}

        {!showMerchantWorkspace && (
          <button
            onClick={() => navigate('insurance')}
            className="w-full flex items-center justify-between p-4 active:bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center">
                <Shield className="w-4 h-4" />
              </div>
              <span className="font-medium text-slate-700">
                Micro-Insurance
              </span>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-300" />
          </button>
        )}

        {showFullShopTools && (
          <button
            onClick={() => navigate('layby')}
            className="w-full flex items-center justify-between p-4 active:bg-slate-50">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center">
                <ShoppingBag className="w-4 h-4" />
              </div>
              <span className="font-medium text-slate-700">Layby Orders</span>
            </div>
            <ChevronRight className="w-5 h-5 text-slate-300" />
          </button>
        )}

        <button
          onClick={() => navigate('loadshedding')}
          className="w-full flex items-center justify-between p-4 active:bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-slate-800 text-white flex items-center justify-center">
              <Zap className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">Load Shedding</span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>
      </div>

      {/* Admin Tools (if admin) */}
      {user.role === 'admin' &&
      <>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
            Admin Tools
          </h3>
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mb-8">
            <button
            onClick={() => navigate('admin')}
            className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
            
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center">
                  <ShieldAlert className="w-4 h-4" />
                </div>
                <span className="font-medium text-slate-700">
                  System Dashboard
                </span>
              </div>
              <ChevronRight className="w-5 h-5 text-slate-300" />
            </button>
            <button
            onClick={() => navigate('ledger')}
            className="w-full flex items-center justify-between p-4 active:bg-slate-50">
            
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center">
                  <BookOpen className="w-4 h-4" />
                </div>
                <span className="font-medium text-slate-700">
                  Immutable Ledger
                </span>
              </div>
              <ChevronRight className="w-5 h-5 text-slate-300" />
            </button>
          </div>
        </>
      }

      {/* Settings */}
      <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
        Settings
      </h3>
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mb-8">
        <button
          onClick={() => navigate('settings')}
          className="w-full flex items-center justify-between p-4 border-b border-slate-100 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center">
              <Settings className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">Account Settings</span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>
        <button
          onClick={() => navigate('help')}
          className="w-full flex items-center justify-between p-4 active:bg-slate-50">
          
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center">
              <HelpCircle className="w-4 h-4" />
            </div>
            <span className="font-medium text-slate-700">Help & Support</span>
          </div>
          <ChevronRight className="w-5 h-5 text-slate-300" />
        </button>
      </div>

      <button
        onClick={logout}
        className="w-full flex items-center justify-center gap-2 p-4 text-red-600 font-medium bg-red-50 rounded-2xl active:bg-red-100 transition-colors">
        
        <LogOut className="w-5 h-5" />
        {t('more.signOut')}
      </button>
    </PageTransition>);

};