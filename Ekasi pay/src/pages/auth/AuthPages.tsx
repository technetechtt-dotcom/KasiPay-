import { useState } from 'react';
import type { FormEvent } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  KPButton,
  KPInput,
  PageTransition } from
'../../components/shared/UIComponents';
import { ShieldCheck, ArrowRight, Delete } from 'lucide-react';
import { apiConfirmPinReset, apiRequestPinReset } from '../../services/api';
// Shared Logo Component
const KasiPayLogo = () =>
<div className="flex flex-col items-center mb-10">
    <div className="w-16 h-16 bg-emerald-600 rounded-2xl flex items-center justify-center shadow-lg shadow-emerald-600/20 mb-4">
      <ShieldCheck className="w-8 h-8 text-white" />
    </div>
    <h1 className="text-3xl font-bold text-slate-900 tracking-tight">
      Kasi<span className="text-emerald-600">Pay</span>
    </h1>
    <p className="text-slate-500 font-medium mt-1">Money moves in Mzansi</p>
  </div>;

export const LoginPage = ({
  onNext,
  onRegister



}: {onNext: (phone: string) => boolean;onRegister: () => void;}) => {
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const cleanedPhone = phone.replace(/\D/g, '');
    if (cleanedPhone.length < 10) {
      setError('Please enter a valid phone number');
      return;
    }
    const found = onNext(cleanedPhone);
    if (!found) setError('No account found for this phone number');
  };
  return (
    <PageTransition className="flex flex-col justify-center px-6 min-h-[100dvh] overflow-y-auto py-12 bg-gradient-to-b from-emerald-50 to-slate-50">
      <KasiPayLogo />

      <form
        onSubmit={handleSubmit}
        className="space-y-6 w-full max-w-sm mx-auto">
        
        <KPInput
          label="Phone Number"
          type="tel"
          placeholder="082 123 4567"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setError('');
          }}
          error={error}
          autoFocus />
        

        <KPButton type="submit" className="group">
          Continue
          <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
        </KPButton>
      </form>

      <div className="mt-8 text-center">
        <button
          onClick={onRegister}
          className="text-emerald-600 font-medium hover:text-emerald-700">
          
          New to KasiPay? Register here
        </button>
      </div>
    </PageTransition>);

};
export const PinPage = ({
  onLogin,
  onBack,
  userName = 'there',
  lockedForSeconds = 0,
  phone = '',
}: {
  onLogin: (pin: string) => boolean | Promise<boolean>;
  onBack: () => void;
  userName?: string;
  lockedForSeconds?: number;
  /** Phone for the account being signed in to (used by forgot-PIN flow). */
  phone?: string;
}) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const handlePadClick = (num: string) => {
    if (lockedForSeconds > 0 || submitting) return;
    if (pin.length < 4) {
      const newPin = pin + num;
      setPin(newPin);
      if (newPin.length === 4) {
        void (async () => {
          setSubmitting(true);
          try {
            const success = await Promise.resolve(onLogin(newPin));
            if (!success) {
              setError(true);
              setTimeout(() => {
                setPin('');
                setError(false);
              }, 500);
            }
          } finally {
            setSubmitting(false);
          }
        })();
      }
    }
  };
  const handleBackspace = () => {
    if (submitting) return;
    setPin(pin.slice(0, -1));
    setError(false);
  };
  return (
    <PageTransition className="flex flex-col items-center px-6 py-8 min-h-[100dvh] overflow-y-auto bg-slate-50">
      <div className="w-full max-w-[280px] flex flex-col flex-1 justify-center py-4">
      <div className="w-full text-center">
        <h2 className="text-2xl font-bold text-slate-900 mb-2">
          Welcome back, {userName.split(' ')[0]}
        </h2>
        <p className="text-slate-500">
          {lockedForSeconds > 0 ?
          `Too many attempts. Try again in ${lockedForSeconds}s` :
          submitting ?
          'Signing you in…' :
          'Enter your 4-digit PIN'}
        </p>

        {submitting &&
        <div className="flex justify-center my-6" aria-live="polite">
          <div className="w-8 h-8 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
        </div>
        }

        {/* PIN Dots */}
        <motion.div
          animate={
          error ?
          {
            x: [-10, 10, -10, 10, 0]
          } :
          {}
          }
          transition={{
            duration: 0.4
          }}
          className="flex justify-center gap-4 my-12">
          
          {[0, 1, 2, 3].map((i) =>
          <div
            key={i}
            className={`w-5 h-5 rounded-full transition-all duration-200 ${pin.length > i ? 'bg-emerald-600 scale-110' : 'bg-slate-200'} ${error ? 'bg-red-500' : ''}`} />

          )}
        </motion.div>
      </div>

      {/* Number Pad */}
      <div className="w-full grid grid-cols-3 gap-3 my-8">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) =>
        <button
          key={num}
          onClick={() => handlePadClick(num.toString())}
          disabled={lockedForSeconds > 0 || submitting}
          className="h-14 rounded-2xl bg-white text-2xl font-semibold text-slate-800 shadow-sm active:bg-slate-100 active:scale-95 transition-all">
          
            {num}
          </button>
        )}
        <button
          onClick={onBack}
          className="h-14 flex items-center justify-center text-sm font-medium text-slate-500 active:text-slate-800">
          
          Cancel
        </button>
        <button
          onClick={() => handlePadClick('0')}
          disabled={lockedForSeconds > 0 || submitting}
          className="h-14 rounded-2xl bg-white text-2xl font-semibold text-slate-800 shadow-sm active:bg-slate-100 active:scale-95 transition-all">
          
          0
        </button>
        <button
          onClick={handleBackspace}
          className="h-14 flex items-center justify-center text-slate-600 active:bg-slate-100 rounded-2xl transition-all">
          
          <Delete className="w-6 h-6" />
        </button>
      </div>

      {phone ?
        <button
          type="button"
          onClick={() => setResetOpen(true)}
          className="text-sm text-emerald-700 font-medium mb-4 underline-offset-4 hover:underline">
          Forgot your PIN?
        </button>
      : null}

      {resetOpen ?
        <ForgotPinModal
          phone={phone}
          onClose={() => setResetOpen(false)}
        />
      : null}
      </div>
    </PageTransition>);

};

/** Phone-based PIN reset modal — uses the backend's /pin-reset/{request,confirm}. */
const ForgotPinModal = ({
  phone,
  onClose,
}: {
  phone: string;
  onClose: () => void;
}) => {
  const [step, setStep] = useState<'request' | 'confirm'>('request');
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [busy, setBusy] = useState(false);
  const requestCode = async () => {
    setBusy(true);
    try {
      const r = await apiRequestPinReset(phone);
      toast.success(r.message);
      if (r.devCode) {
        toast.message(`Dev code: ${r.devCode}`, {
          description: 'Auto-filled — visible in dev only.',
        });
        setCode(r.devCode);
      }
      setStep('confirm');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not start reset';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      await apiConfirmPinReset({ phone, code, newPin });
      toast.success('PIN updated — sign in with your new PIN.');
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not reset PIN';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
        <h3 className="font-bold text-lg mb-2">Reset your PIN</h3>
        <p className="text-sm text-slate-500 mb-4">
          {step === 'request' ?
            <>We’ll send a 6-digit code to <strong>{phone}</strong>.</>
          : <>Enter the 6-digit code we sent and pick a new 4-digit PIN.</>}
        </p>
        {step === 'confirm' ?
          <>
            <KPInput
              label="6-digit code"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
              }
            />
            <KPInput
              label="New 4-digit PIN"
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={newPin}
              onChange={(e) =>
                setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))
              }
            />
          </>
        : null}
        <div className="flex gap-2 mt-4">
          <button
            type="button"
            className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-600 font-medium"
            onClick={onClose}>
            Cancel
          </button>
          <KPButton
            className="flex-1"
            disabled={
              busy ||
              (step === 'confirm' && (code.length !== 6 || newPin.length !== 4))
            }
            onClick={step === 'request' ? requestCode : confirm}>
            {busy ? 'Working…' :
              step === 'request' ? 'Send code' : 'Set new PIN'}
          </KPButton>
        </div>
      </div>
    </div>
  );
};
export const RegisterPage = ({
  onRegister,
  onBack



}: {onRegister: (
  name: string,
  phone: string,
  pin: string,
  role: 'customer' | 'merchant' | 'agent'
) => boolean | Promise<boolean>;onBack: () => void;}) => {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const phoneDigits = phone.replace(/\D/g, '');
  const pinDigits = pin.replace(/\D/g, '').slice(0, 4);
  const nameOk = name.trim().length >= 2;
  const canSubmit =
    nameOk && phoneDigits.length >= 10 && pinDigits.length === 4 && !submitting;
  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError('');
    if (!nameOk || phoneDigits.length < 10 || pinDigits.length !== 4) {
      setFormError(
        'Enter your full name, a mobile number with at least 10 digits, and a 4-digit PIN.'
      );
      return;
    }
    setSubmitting(true);
    try {
      // New accounts are shop merchants by default (no account-type picker).
      await Promise.resolve(onRegister(name.trim(), phone, pinDigits, 'merchant'));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <PageTransition className="flex flex-col px-6 py-12 min-h-full bg-slate-50 overflow-y-auto pb-12">
      <button
        onClick={onBack}
        className="text-slate-500 mb-6 flex items-center font-medium">
        
        <ArrowRight className="w-5 h-5 mr-1 rotate-180" /> Back
      </button>

      <h2 className="text-3xl font-bold text-slate-900 mb-2">Create Account</h2>
      <p className="text-slate-500 mb-8">Join the KasiPay network today.</p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <KPInput
          label="Full Name"
          placeholder="e.g. Sipho Nkosi"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setFormError('');
          }}
          required />
        
        <KPInput
          label="Phone Number"
          type="tel"
          placeholder="082 123 4567"
          inputMode="numeric"
          value={phone}
          onChange={(e) => {
            setPhone(e.target.value);
            setFormError('');
          }}
          required />
        
        <KPInput
          label="Create 4-Digit PIN"
          type="password"
          inputMode="numeric"
          maxLength={4}
          placeholder="••••"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, '').slice(0, 4));
            setFormError('');
          }}
          required />

        {formError ?
        <p className="text-sm text-red-600 mt-2" role="alert">
            {formError}
          </p> :
        null}

        <KPButton
          type="submit"
          className="mt-4"
          disabled={!canSubmit}
          isLoading={submitting}>
          
          Create Account
        </KPButton>
      </form>
    </PageTransition>);

};