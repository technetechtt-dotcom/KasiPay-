import { useCallback, useState } from 'react';
import { useAppState } from './hooks/useAppState';
import { AppShell } from './components/shared/AppShell';
import { LoginPage, RegisterPage, PinPage } from './pages/auth/AuthPages';
import { SpazaHome } from './pages/home/SpazaHome';
import { MoneyServices } from './pages/services/MoneyServices';
import { ShopPage } from './pages/shop/ShopPage';
import { HistoryPage } from './pages/history/HistoryPage';
import { MorePage } from './pages/more/MorePage';
import {
  AdminDashboard,
  LedgerView,
  UserManagement,
  CompliancePage,
  ClaimsReviewPage,
} from './pages/admin/AdminPages';
import { InventoryPage } from './pages/inventory/InventoryPage';
import { AddStockPage } from './pages/inventory/AddStockPage';
import { RecordPurchaseSlipPage } from './pages/inventory/RecordPurchaseSlipPage';
import { SettingsPage } from './pages/settings/SettingsPage';
import { HelpPage } from './pages/settings/HelpPage';
import { ExpensesPage } from './pages/expenses/ExpensesPage';
import { AnalyticsPage } from './pages/analytics/AnalyticsPage';
import { FinancialReportsPage } from './pages/reports/FinancialReportsPage';
import { CommissionsPage } from './pages/commissions/CommissionsPage';
import { ScannerPage } from './pages/scanner/ScannerPage';
import { CalculatorPage } from './pages/calculator/CalculatorPage';
import { CreditBookPage } from './pages/credit/CreditBookPage';
import { SupplierOrdersPage } from './pages/suppliers/SupplierOrdersPage';
import { StokvelPage } from './pages/stokvel/StokvelPage';
import { LaybyPage } from './pages/layby/LaybyPage';
import { LoadSheddingPage } from './pages/loadshedding/LoadSheddingPage';
import { BusinessHealthPage } from './pages/analytics/BusinessHealthPage';
import { PriceComparisonPage } from './pages/analytics/PriceComparisonPage';
import { MicroInsurancePage } from './pages/services/MicroInsurancePage';
import { VoiceNotesPage } from './pages/voicenotes/VoiceNotesPage';
import { FoodSafetyPage } from './pages/safety/FoodSafetyPage';
import { StockValuePage } from './pages/inventory/StockValuePage';
import { NotificationsPage } from './pages/notifications/NotificationsPage';
import { BuyUtilityPage } from './pages/services/BuyUtilityPage';
import { TransferMoneyPage } from './pages/services/TransferMoneyPage';
import { toast } from 'sonner';
import { saIdValidationMessage } from './lib/saIdValidation';
import {
  clearScannerSession,
  readScannerSession,
  digitsFromBarcodeForSaId,
  storeScannedSaId,
  enqueueShopScan,
  isContinuousProductScan,
  defaultStockMode,
} from './lib/scannerSession';
import {
  findProductByBarcode,
  groceryLookupCode,
  groceryScanDetail,
  parseGroceryScan,
} from './lib/productBarcode';
import {
  MERCHANT_PORTAL_PAGE_IDS,
  WALLET_ONLY_PAGE_IDS,
} from './config/merchantPortalPages';

const getLockRemainingSeconds = (lockedUntil: number | null) => {
  if (!lockedUntil) return 0;
  const remainingMs = lockedUntil - Date.now();
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
};
export function App() {
  const state = useAppState();
  const [scannedBarcode, setScannedBarcode] = useState<string | undefined>();
  const [shopSetupBusy, setShopSetupBusy] = useState(false);
  const isAdmin = state.currentUser?.role === 'admin';

  const handleDecodedBarcode = useCallback(
    async (raw: string): Promise<boolean> => {
      const ctx = readScannerSession();
      const returnPage = ctx?.returnPage ?? 'add-stock';
      const capture = ctx?.capture ?? 'product';
      const continuous = isContinuousProductScan(ctx);

      if (capture === 'product') {
        const parsed = parseGroceryScan(raw);
        if (parsed.isDigitalLink) {
          toast.message(
            'Digital coupon / link — scan the product UPC, EAN, or GS1 sticker instead.',
          );
          return continuous;
        }

        const code = groceryLookupCode(raw);
        const match = findProductByBarcode(state.products, raw);
        const detail = groceryScanDetail(parsed);
        const mode = defaultStockMode(ctx);

        if (returnPage === 'inventory') {
          if (match) {
            const delta = mode === 'sale' ? -1 : 1;
            if (mode === 'sale' && match.stock <= 0) {
              toast.error(`${match.name} — already at zero stock`);
              return continuous;
            }
            await state.restockProduct(match.id, delta);
            toast.success(
              mode === 'sale'
                ? `Stock −1 — ${match.name}${detail}`
                : `Stock +1 — ${match.name}${detail}`,
            );
            return continuous;
          }
          toast.message('Unknown barcode — add product under Add stock');
          return continuous;
        }

        if (returnPage === 'shop') {
          if (match) {
            if (match.stock <= 0) {
              toast.error(`${match.name} is out of stock`);
              return continuous;
            }
            enqueueShopScan({ productId: match.id });
            toast.success(`Cart +1 — ${match.name}${detail}`);
            return continuous;
          }
          if (continuous) {
            toast.message('Unknown barcode — add it under Inventory first');
            return true;
          }
          setScannedBarcode(code);
          state.navigate('add-stock');
          return false;
        }

        if (continuous) {
          if (match) {
            toast.message(`Matched ${match.name}${detail}`);
          }
          return true;
        }

        setScannedBarcode(code);
        if (!match) {
          if (parsed.format === 'gs1_databar') {
            toast.message('GS1 sticker — finish on Add stock.');
          } else if (parsed.format === 'weighted_ean13') {
            toast.message(`Weighed PLU ${parsed.weightedPlu ?? ''}${detail}`);
          }
        }
        state.navigate('add-stock');
        clearScannerSession();
        return false;
      }

      const digits = digitsFromBarcodeForSaId(raw);
      if (digits.length !== 13) {
        toast.error(
          'Could not read 13 digits from that scan. Try again or type the SA ID.',
        );
        clearScannerSession();
        return false;
      }
      storeScannedSaId(capture, digits);
      const idMsg = saIdValidationMessage(digits);
      if (idMsg) {
        toast.warning(
          `Scan read ${digits}, but the checksum failed. Edit the digits manually — check the last digit on the ID.`,
        );
      } else {
        toast.message('ID scanned — verify the digits look correct.');
      }
      clearScannerSession();
      return false;
    },
    [state],
  );

  if (!state.isReady) {
    return (
      <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-slate-50 text-slate-600 px-8 text-center text-sm">
        Loading Ekasi Pay…
      </div>
    );
  }
  const adminPages = new Set(['admin', 'ledger', 'users', 'compliance', 'claims']);
  // --- Auth Flow Routing ---
  if (!state.isAuthenticated) {if (state.authStep === 'login') {
      return (
        <LoginPage
          onNext={state.loginStep1}
          onRegister={() => state.setAuthStep('register')} />);


    }
    if (state.authStep === 'pin') {
      return (
        <PinPage
          onLogin={state.loginStep2}
          lockedForSeconds={getLockRemainingSeconds(state.pinLockedUntil)}
          phone={state.tempPhone}
          onBack={() => state.setAuthStep('login')} />);


    }
    if (state.authStep === 'register') {
      return (
        <RegisterPage
          onRegister={state.register}
          onBack={() => state.setAuthStep('login')} />);


    }
  }
  if (!state.currentUser) return null;
  const currentUser = state.currentUser;
  const myWallet = state.getMyWallet();
  if (!myWallet) {
    return (
      <div className="p-8 text-center text-slate-500 mt-20">
        Wallet unavailable for this account.
        <button
          onClick={() => state.logout()}
          className="block mx-auto mt-4 text-emerald-600">
          Log Out
        </button>
      </div>
    );
  }
  const merchant =
    state.merchantProfile ?? {
      id: '',
      userId: currentUser.id,
      businessName:
        currentUser.role === 'merchant' ? `${currentUser.name}'s Shop` : currentUser.name,
      location: '—',
      category: currentUser.role === 'merchant' ? 'Retail' : 'Customer',
    };

  const hasMerchantProfile = state.merchantProfile !== null;
  const showMerchantWorkspace = state.workspaceMode === 'merchant';
  const isAgent = currentUser.role === 'agent';
  const agentWithoutMerchantProfile = isAgent && !hasMerchantProfile;

  const merchantPortalPages = MERCHANT_PORTAL_PAGE_IDS;
  /**
   * Money services and community money tools (stokvel + micro-insurance) live
   * in wallet mode only — they're personal-wallet features, not shop tools.
   */
  const walletOnlyPages = WALLET_ONLY_PAGE_IDS;

  // --- Unified App Routing ---
  const renderPage = () => {
    if (adminPages.has(state.currentPage) && !isAdmin) {
      return (
        <div className="p-8 text-center text-slate-500 mt-20">
          You are not authorized to access this page.
          <button
            onClick={() => state.navigate('home')}
            className="block mx-auto mt-4 text-emerald-600">
            Go Home
          </button>
        </div>
      );
    }
    if (!showMerchantWorkspace && merchantPortalPages.has(state.currentPage)) {
      return (
        <div className="p-8 text-center text-slate-600 mt-16 px-6">
          <p className="text-base font-medium text-slate-800 mb-2">
            Merchant tools are hidden
          </p>
          <p className="text-sm mb-6 max-w-xs mx-auto leading-relaxed">
            You’re in wallet mode. Use the floating mode button on Home (or open{' '}
            <strong className="text-slate-800">More</strong>) to switch to{' '}
            <strong className="text-slate-800">Merchant mode</strong> for POS, stock,
            and shop dashboards.
          </p>
          <button
            type="button"
            onClick={() => state.navigate('more')}
            className="block mx-auto mb-3 text-emerald-600 font-medium text-sm">
            Open More
          </button>
          <button
            type="button"
            onClick={() => state.navigate('home')}
            className="block mx-auto text-slate-500 text-sm">
            Go home
          </button>
        </div>
      );
    }
    if (showMerchantWorkspace && walletOnlyPages.has(state.currentPage)) {
      return (
        <div className="p-8 text-center text-slate-600 mt-16 px-6">
          <p className="text-base font-medium text-slate-800 mb-2">
            Wallet feature
          </p>
          <p className="text-sm mb-6 max-w-xs mx-auto leading-relaxed">
            You’re in merchant mode. Switch to{' '}
            <strong className="text-slate-800">Wallet mode</strong> to use send,
            receive, Cash Send, Community Stokvel, and Micro-Insurance. Use the
            floating mode button on Home or open{' '}
            <strong className="text-slate-800">More</strong>.
          </p>
          <button
            type="button"
            onClick={() => {
              state.setWorkspaceMode('wallet');
            }}
            className="block mx-auto mb-3 text-emerald-600 font-medium text-sm">
            Switch to wallet mode
          </button>
          <button
            type="button"
            onClick={() => state.navigate('home')}
            className="block mx-auto text-slate-500 text-sm">
            Go home
          </button>
        </div>
      );
    }
    if (
      showMerchantWorkspace &&
      agentWithoutMerchantProfile &&
      merchantPortalPages.has(state.currentPage)
    ) {
      return (
        <div className="p-8 text-center text-slate-600 mt-16 px-6">
          <p className="text-base font-medium text-slate-800 mb-2">
            Set up your shop first
          </p>
          <p className="text-sm mb-6 max-w-xs mx-auto leading-relaxed">
            Agent accounts need a linked shop profile before POS, stock, and
            reports can load. This creates your spaza profile on Ekasi Pay.
          </p>
          <button
            type="button"
            disabled={shopSetupBusy}
            onClick={() => {
              setShopSetupBusy(true);
              void (async () => {
                try {
                  const created = await state.ensureMerchantProfile();
                  if (!created) {
                    toast.error('Could not create shop profile. Try Settings.');
                    return;
                  }
                  await state.reloadRemoteData();
                  toast.success('Shop profile ready — open your tools again.');
                  state.navigate('home');
                } finally {
                  setShopSetupBusy(false);
                }
              })();
            }}
            className="block mx-auto mb-3 rounded-xl bg-emerald-600 text-white font-medium text-sm px-5 py-3 disabled:opacity-60">
            {shopSetupBusy ? 'Setting up…' : 'Set up shop profile'}
          </button>
          <button
            type="button"
            onClick={() => state.navigate('settings')}
            className="block mx-auto mb-3 text-emerald-600 font-medium text-sm">
            Edit shop in Settings
          </button>
          <button
            type="button"
            onClick={() => state.navigate('home')}
            className="block mx-auto text-slate-500 text-sm">
            Go home
          </button>
        </div>
      );
    }
    switch (state.currentPage) {
      case 'home':
        return (
          <SpazaHome
            user={currentUser}
            wallet={myWallet}
            merchant={merchant}
            showMerchantWorkspace={showMerchantWorkspace}
            workspaceMode={state.workspaceMode}
            setWorkspaceMode={state.setWorkspaceMode}
            agentWithoutMerchantProfile={agentWithoutMerchantProfile}
            transactions={state.transactions}
            sales={state.sales}
            products={state.products}
            expenses={state.expenses}
            alerts={state.foodSafetyAlerts}
            flags={state.flags}
            expiryItems={state.expiryItems}
            language={state.language}
            navigate={state.navigate}
            hasSeenOnboarding={state.hasSeenOnboarding}
            completeOnboarding={state.completeOnboarding}
            onPullRefresh={async () => {
              await state.reloadRemoteData();
            }}
            isSyncingData={state.isSyncingData}
          />);


      case 'services':
      case 'send':
      case 'receive':
        return (
          <MoneyServices
            wallet={myWallet}
            authenticatedUserPhone={currentUser.phone}
            cashSendVouchers={state.cashSendVouchers}
            createCashSend={state.createCashSend}
            collectCashSend={state.collectCashSend}
            cancelCashSend={state.cancelCashSend}
            navigate={state.navigate}
            scanReturnRoute={state.currentPage}
            initialTab={state.currentPage === 'receive' ? 'receive' : 'send'}
            showBackButton={
            state.currentPage === 'send' || state.currentPage === 'receive'
            } />);

      case 'transfer':
        return (
          <TransferMoneyPage
            wallet={myWallet}
            onSendMoney={state.sendMoney}
            navigate={state.navigate}
          />
        );


      case 'shop':
        return (
          <ShopPage
            products={state.products}
            onMakeSale={state.makeSale}
            navigate={state.navigate} />);


      case 'history':
        return (
          <HistoryPage
            transactions={state.transactions}
            sales={state.sales}
            wallet={myWallet} />);


      case 'more':
        return (
          <MorePage
            user={currentUser}
            merchant={merchant}
            showMerchantWorkspace={showMerchantWorkspace}
            workspaceMode={state.workspaceMode}
            setWorkspaceMode={state.setWorkspaceMode}
            agentWithoutMerchantProfile={agentWithoutMerchantProfile}
            alerts={state.foodSafetyAlerts}
            language={state.language}
            navigate={state.navigate}
            logout={state.logout} />);


      // Sub-pages accessible from More or Home
      case 'inventory':
        return (
          <InventoryPage
            products={state.products}
            onRestock={state.restockProduct}
            navigate={state.navigate} />);


      case 'stock-value':
        return (
          <StockValuePage
            products={state.products}
            stockMovements={state.stockMovements}
            navigate={state.navigate} />);


      case 'add-stock':
        return (
          <AddStockPage
            onAddProduct={state.addProduct}
            onRestockProduct={state.restockProduct}
            existingProducts={state.products}
            navigate={state.navigate}
            scannedBarcode={scannedBarcode} />);

      case 'record-purchase-slip':
        return (
          <RecordPurchaseSlipPage
            products={state.products}
            onRecordPurchase={state.recordStockPurchase}
            navigate={state.navigate}
          />
        );

      case 'scanner':
        return (
          <ScannerPage
            onDecoded={handleDecodedBarcode}
            navigate={state.navigate}
          />);


      case 'expenses':
        return (
          <ExpensesPage
            expenses={state.expenses}
            sales={state.sales}
            products={state.products}
            onAddExpense={state.addExpense}
            navigate={state.navigate} />);


      case 'analytics':
        return (
          <AnalyticsPage
            sales={state.sales}
            products={state.products}
            navigate={state.navigate} />);


      case 'reports':
        return (
          <FinancialReportsPage
            sales={state.sales}
            expenses={state.expenses}
            products={state.products}
            merchant={merchant}
            loans={state.loans}
            onRequestLoan={state.requestWorkingCapitalLoan}
            onRepayLoan={state.repayLoan}
            navigate={state.navigate}
          />
        );


      case 'commissions':
        return <CommissionsPage navigate={state.navigate} />;


      case 'calculator':
        return <CalculatorPage navigate={state.navigate} />;
      case 'credit-book':
        return (
          <CreditBookPage
            customers={state.creditCustomers}
            transactions={state.creditTransactions}
            onAddTransaction={state.addCreditTransaction}
            onCreateCustomer={state.createCreditCustomerRecord}
            requestCreditOtp={state.requestCreditOtp}
            confirmCreditOtp={state.confirmCreditOtp}
            navigate={state.navigate}
          />
        );


      case 'supplier-orders':
        return (
          <SupplierOrdersPage
            suppliers={state.suppliers}
            orders={state.supplierOrders}
            onCreateOrder={state.createSupplierOrderRecord}
            onCreateSupplier={state.addSupplierRecord}
            onUpdateOrderStatus={state.updateSupplierOrderStatusRecord}
            navigate={state.navigate}
          />
        );


      case 'stokvel':
        return (
          <StokvelPage
            groups={state.stokvelGroups}
            onCreateGroup={state.addStokvelGroupRecord}
            onUpdateMembers={state.updateStokvelMembers}
            navigate={state.navigate}
          />
        );

      case 'layby':
        return (
          <LaybyPage
            orders={state.laybyOrders}
            onCreateLayby={state.addLaybyOrderRecord}
            onAddPayment={state.recordLaybyInstallment}
            navigate={state.navigate}
          />
        );

      case 'loadshedding':
        return (
          <LoadSheddingPage
            schedule={state.loadSheddingSchedule}
            navigate={state.navigate}
            onRefresh={state.reloadRemoteData} />);


      case 'business-health':
        return (
          <BusinessHealthPage
            sales={state.sales}
            expenses={state.expenses}
            navigate={state.navigate} />);


      case 'price-comparison':
        return (
          <PriceComparisonPage
            comparisons={state.priceComparisons}
            onAddComparison={state.addTrackedPriceComparison}
            navigate={state.navigate}
          />
        );


      case 'insurance':
        return (
          <MicroInsurancePage
            policies={state.insurancePolicies}
            onSubscribePlan={state.subscribeMicroInsurancePlan}
            onFileClaim={state.fileInsuranceClaim}
            navigate={state.navigate}
          />
        );


      case 'voice-notes':
        return (
          <VoiceNotesPage
            notes={state.voiceNotes}
            onAddNote={state.addVoiceNote}
            onDeleteNote={state.deleteVoiceNote}
            navigate={state.navigate} />);


      case 'food-safety':
        return (
          <FoodSafetyPage
            suppliers={state.suppliers}
            verifications={state.supplierVerifications}
            expiryItems={state.expiryItems}
            alerts={state.foodSafetyAlerts}
            markAlertRead={state.markAlertRead}
            onUpsertVerification={state.upsertSupplierVerificationRecord}
            onAddExpiryItem={state.addTrackedExpiryItem}
            onPublishVendorAlert={state.publishFoodSafetyNotice}
            navigate={state.navigate}
          />
        );


      case 'settings':
        return (
          <SettingsPage
            user={currentUser}
            merchant={merchant}
            language={state.language}
            setLanguage={state.setLanguage}
            updatePin={state.updateUserPin}
            onMerchantUpdated={state.setMerchantProfile}
            onAccountClosed={state.logout}
            navigate={state.navigate} />);


      case 'help':
        return <HelpPage navigate={state.navigate} />;
      case 'buy':
        return (
          <BuyUtilityPage wallet={myWallet} navigate={state.navigate} />
        );
      case 'notifications':
        return (
          <NotificationsPage
            alerts={state.foodSafetyAlerts}
            flags={state.flags}
            expiry={state.expiryItems}
            products={
              state.merchantProfile
                ? state.products.filter(
                    (p) => p.merchantId === state.merchantProfile?.id,
                  )
                : []
            }
            markAlertRead={state.markAlertRead}
            navigate={state.navigate}
          />
        );
      // Admin pages
      case 'admin':
        return (
          <AdminDashboard
            users={state.users}
            ledger={state.ledger}
            auditEvents={state.auditEvents}
            navigate={state.navigate} />);


      case 'ledger':
        return <LedgerView ledger={state.ledger} navigate={state.navigate} />;
      case 'users':
        return (
          <UserManagement
            users={state.users}
            currentUserId={state.currentUser?.id}
            navigate={state.navigate}
          />
        );
      case 'compliance':
        return <CompliancePage navigate={state.navigate} />;
      case 'claims':
        return <ClaimsReviewPage navigate={state.navigate} />;
      default:
        return (
          <div className="p-8 text-center text-slate-500 mt-20">
            Page under construction
            <button
              onClick={() => state.navigate('home')}
              className="block mx-auto mt-4 text-emerald-600">
              
              Go Home
            </button>
          </div>);

    }
  };
  return (
    <AppShell
      currentPage={state.currentPage}
      navigate={state.navigate}
      isOffline={state.isOffline}
      pendingOutbox={state.pendingOutbox}
      workspaceMode={state.workspaceMode}
      language={state.language}>
      
      {renderPage()}
    </AppShell>);

}