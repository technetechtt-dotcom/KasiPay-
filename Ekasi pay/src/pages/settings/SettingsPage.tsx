import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  KPCard,
  KPAvatar,
  PageTransition,
  KPBadge,
  KPInput,
  KPButton } from
'../../components/shared/UIComponents';
import {
  ArrowLeft,
  ShieldCheck,
  CheckCircle2,
  Globe,
  ClipboardList,
  Store,
  AlertTriangle } from
'lucide-react';
import { toast } from 'sonner';
import { snapshotClientDiag } from '../../services/clientDiagnostics';
import {
  apiDeleteMyAccount,
  apiUpdateMerchantProfile,
} from '../../services/api';
import { useTranslations } from '../../hooks/useTranslations';
import type { User, Merchant, Language } from '../../types';
export const SettingsPage = ({
  user,
  merchant,
  language,
  setLanguage,
  updatePin,
  onMerchantUpdated,
  onAccountClosed,
  navigate,

}: {
  user: User;
  merchant: Merchant;
  language: Language;
  setLanguage: (lang: Language) => void;
  updatePin: (
    currentPin: string,
    newPin: string,
  ) => boolean | Promise<boolean>;
  onMerchantUpdated?: (merchant: Merchant) => void;
  onAccountClosed?: () => void;
  navigate: (p: string) => void;
}) => {
  const { t } = useTranslations(language);
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [saved, setSaved] = useState(false);
  /* Business profile edit state */
  const [editingBiz, setEditingBiz] = useState(false);
  const [bizName, setBizName] = useState(merchant.businessName);
  const [bizLocation, setBizLocation] = useState(merchant.location);
  const [bizCategory, setBizCategory] = useState(merchant.category);
  const [bizBusy, setBizBusy] = useState(false);
  /* Account deletion state */
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePin, setDeletePin] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);

  const saveBusiness = async () => {
    setBizBusy(true);
    try {
      const { merchant: updated } = await apiUpdateMerchantProfile({
        businessName: bizName.trim() || undefined,
        location: bizLocation.trim() || undefined,
        category: bizCategory.trim() || undefined,
      });
      toast.success('Business profile updated.');
      onMerchantUpdated?.(updated);
      setEditingBiz(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not update profile';
      toast.error(msg);
    } finally {
      setBizBusy(false);
    }
  };

  const closeAccount = async () => {
    setDeleteBusy(true);
    try {
      await apiDeleteMyAccount({
        pin: deletePin,
        confirmPhrase: deleteConfirm,
      });
      toast.success('Account closed. Signing you out.');
      setDeleteOpen(false);
      onAccountClosed?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not close account';
      toast.error(msg);
    } finally {
      setDeleteBusy(false);
    }
  };
  const handleSavePin = async (e: FormEvent) => {
    e.preventDefault();
    if (newPin !== confirmPin || newPin.length < 6 || newPin.length > 12) return;
    const pinUpdated = await Promise.resolve(updatePin(currentPin, newPin));
    if (pinUpdated) {
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        setCurrentPin('');
        setNewPin('');
        setConfirmPin('');
      }, 3000);
    }
  };
  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center">
          <button
            onClick={() => navigate('more')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">
            {t('settings.title')}
          </h2>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 space-y-8">
        {/* Profile Info */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
            Profile Information
          </h3>
          <KPCard className="p-5">
            <div className="flex items-center gap-4 mb-6">
              <KPAvatar name={user.name} size="lg" />
              <div>
                <h3 className="font-bold text-slate-900 text-lg">
                  {user.name}
                </h3>
                <p className="text-slate-500">{user.phone}</p>
              </div>
            </div>

            <div className="space-y-4 border-t border-slate-100 pt-4">
              {editingBiz ?
                <>
                  <KPInput
                    label="Business name"
                    value={bizName}
                    onChange={(e) => setBizName(e.target.value)}
                  />
                  <KPInput
                    label="Location"
                    value={bizLocation}
                    onChange={(e) => setBizLocation(e.target.value)}
                  />
                  <KPInput
                    label="Category"
                    value={bizCategory}
                    onChange={(e) => setBizCategory(e.target.value)}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingBiz(false);
                        setBizName(merchant.businessName);
                        setBizLocation(merchant.location);
                        setBizCategory(merchant.category);
                      }}
                      className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-600 font-medium text-sm">
                      Cancel
                    </button>
                    <KPButton
                      type="button"
                      className="flex-1"
                      disabled={bizBusy}
                      onClick={saveBusiness}>
                      {bizBusy ? 'Saving…' : 'Save changes'}
                    </KPButton>
                  </div>
                </>
              :
                <>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Business Name</p>
                    <p className="font-medium text-slate-900">
                      {merchant.businessName}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Location</p>
                    <p className="font-medium text-slate-900">
                      {merchant.location}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">Category</p>
                    <p className="font-medium text-slate-900">
                      {merchant.category}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingBiz(true)}
                    className="inline-flex items-center gap-2 text-sm font-medium text-emerald-700 mt-1">
                    <Store className="w-4 h-4" /> Edit business profile
                  </button>
                </>
              }
            </div>
          </KPCard>
        </section>

        {/* Account Status */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
            Account Status
          </h3>
          <KPCard className="p-0 overflow-hidden">
            <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-emerald-50/50">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <p className="font-bold text-slate-900">KYC Status</p>
                  <p className="text-xs text-slate-500">
                    Identity verification
                  </p>
                </div>
              </div>
              <KPBadge
                variant={user.kycStatus === 'verified' ? 'success' : 'warning'}>
                
                {user.kycStatus.toUpperCase()}
              </KPBadge>
            </div>
            <div className="p-5 flex justify-between items-center">
              <div>
                <p className="font-bold text-slate-900">Account Tier</p>
                <p className="text-xs text-slate-500">
                  Determines transaction limits
                </p>
              </div>
              <span className="font-bold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-lg">
                {user.accountTier}
              </span>
            </div>
          </KPCard>
        </section>

        {/* Language */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider flex items-center gap-2">
            <Globe className="w-4 h-4" /> {t('settings.language')}
          </h3>
          <KPCard className="p-4">
            <div className="flex flex-col gap-2">
              <button
                onClick={() => setLanguage('en')}
                className={`p-3 rounded-xl text-left font-medium transition-colors ${language === 'en' ? 'bg-emerald-50 text-emerald-700 border-2 border-emerald-500' : 'bg-slate-50 text-slate-700 border-2 border-transparent hover:bg-slate-100'}`}>
                
                English
              </button>
              <button
                onClick={() => setLanguage('zu')}
                className={`p-3 rounded-xl text-left font-medium transition-colors ${language === 'zu' ? 'bg-emerald-50 text-emerald-700 border-2 border-emerald-500' : 'bg-slate-50 text-slate-700 border-2 border-transparent hover:bg-slate-100'}`}>
                
                isiZulu
              </button>
              <button
                onClick={() => setLanguage('xh')}
                className={`p-3 rounded-xl text-left font-medium transition-colors ${language === 'xh' ? 'bg-emerald-50 text-emerald-700 border-2 border-emerald-500' : 'bg-slate-50 text-slate-700 border-2 border-transparent hover:bg-slate-100'}`}>
                
                isiXhosa
              </button>
            </div>
          </KPCard>
        </section>

        {/* Field-test diagnostics */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider flex items-center gap-2">
            <ClipboardList className="w-4 h-4" />
            {t('settings.diagnostics')}
          </h3>
          <KPCard className="p-5 space-y-3">
            <p className="text-xs text-slate-600 leading-relaxed">
              Copies a short snapshot (page URL, connectivity, recent API errors
              from this session) for your pilot coordinator. Server logs also
              include{' '}
              <code className="text-[11px] bg-slate-100 px-1 rounded">X-Request-Id</code>{' '}
              from each call.
            </p>
            <p className="text-xs text-slate-500">
              Build tag:{' '}
              <strong className="text-slate-700">
                {(import.meta.env.VITE_APP_VERSION as string | undefined) || 'dev'}
              </strong>
            </p>
            <KPButton
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => {
                void navigator.clipboard.writeText(snapshotClientDiag()).then(
                  () => toast.success('Diagnostics copied'),
                  () =>
                    toast.error('Could not copy — select and copy manually if needed.')
                );
              }}>
              
              Copy diagnostics to clipboard
            </KPButton>
          </KPCard>
        </section>

        {/* Security */}
        <section>
          <h3 className="text-sm font-bold text-slate-500 mb-3 uppercase tracking-wider">
            Security
          </h3>
          <KPCard className="p-5">
            <h4 className="font-bold text-slate-900 mb-4">{t('settings.pin')}</h4>

            {saved ?
            <div className="bg-emerald-50 text-emerald-700 p-4 rounded-xl flex items-center gap-3 mb-4">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                <p className="text-sm font-medium">PIN successfully updated</p>
              </div> :

            <form onSubmit={handleSavePin} className="space-y-4">
                <KPInput
                type="password"
                label="Current PIN"
                placeholder="••••"
                maxLength={12}
                value={currentPin}
                onChange={(e) => setCurrentPin(e.target.value)} />
              
                <div className="grid grid-cols-2 gap-4">
                  <KPInput
                  type="password"
                  label="New PIN"
                  placeholder="••••"
                  maxLength={12}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value)} />
                
                  <KPInput
                  type="password"
                  label="Confirm PIN"
                  placeholder="••••"
                  maxLength={12}
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value)} />
                
                </div>
                <KPButton
                type="submit"
                disabled={
                !currentPin || newPin.length < 6 || newPin !== confirmPin
                }
                className="mt-2">
                
                  Update PIN
                </KPButton>
              </form>
            }
          </KPCard>
        </section>

        {/* Danger zone */}
        <section>
          <h3 className="text-sm font-bold text-red-600 mb-3 uppercase tracking-wider flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" /> Danger Zone
          </h3>
          <KPCard className="p-5 border border-red-100">
            <p className="text-sm font-bold text-slate-900 mb-2">
              Close my account
            </p>
            <p className="text-xs text-slate-500 leading-relaxed mb-4">
              Permanently deactivates your KasiPay account. Your wallet must be
              empty first. Ledger and sales rows are retained for tax-law
              compliance but linked only to an anonymous id.
            </p>
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              className="w-full py-3 rounded-xl bg-red-50 text-red-700 font-medium text-sm border border-red-100">
              Close my account
            </button>
          </KPCard>
        </section>
      </div>

      {deleteOpen ?
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
            <h3 className="font-bold text-lg mb-2 text-red-700">
              Close my KasiPay account?
            </h3>
            <p className="text-sm text-slate-500 mb-4 leading-relaxed">
              Withdraw any remaining wallet balance first. To confirm, enter
              your 4-digit PIN and type the phrase{' '}
              <strong className="text-slate-700">DELETE MY ACCOUNT</strong>.
            </p>
            <KPInput
              label="Your PIN"
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={deletePin}
              onChange={(e) =>
                setDeletePin(e.target.value.replace(/\D/g, '').slice(0, 4))
              }
            />
            <KPInput
              label="Type: DELETE MY ACCOUNT"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
            />
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => {
                  setDeleteOpen(false);
                  setDeletePin('');
                  setDeleteConfirm('');
                }}
                className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-600 font-medium text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={closeAccount}
                disabled={
                  deleteBusy ||
                  deletePin.length !== 4 ||
                  deleteConfirm.trim().toUpperCase() !== 'DELETE MY ACCOUNT'
                }
                className="flex-1 py-3 rounded-xl bg-red-600 text-white font-medium text-sm disabled:bg-red-300">
                {deleteBusy ? 'Closing…' : 'Permanently close account'}
              </button>
            </div>
          </div>
        </div>
      : null}
    </PageTransition>);

};