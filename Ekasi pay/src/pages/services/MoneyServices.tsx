import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, SVGProps } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  KPButton,
  KPCard,
  KPAmount,
  KPInput,
  PageTransition,
  KPBadge } from
'../../components/shared/UIComponents';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Send,
  Download,
  History,
  AlertCircle,
  ScanLine } from
'lucide-react';
import { toast } from 'sonner';
import type { Wallet, CashSendVoucher } from '../../types';
import {
  writeScannerSession,
  consumePendingBeneficiarySaId,
  consumePendingCollectSaId,
  consumePendingSenderSaId } from
'../../lib/scannerSession';
import {
  loadSenderKycProfile,
  saveSenderKycProfile,
} from '../../lib/senderKycProfile';
import { cashSendVoucherPinMessage } from '../../lib/pinValidation';
import { saIdValidationMessage } from '../../lib/saIdValidation';
import {
  isSaCellphoneInput,
  parseCashSendVoucherReference,
} from '../../lib/cashSendReference';
import { ApiError, apiLookupCashSend } from '../../services/api';
import { CashSendConsentGate } from '../../components/consent/CashSendDataConsent';

export type CashSendCreatePayload = {
  senderPhone: string;
  senderFirstName: string;
  senderLastName: string;
  senderIdDocument: string;
  senderAddress: string;
  recipientFirstName: string;
  recipientLastName: string;
  recipientPhone: string;
    recipientIdDocument?: string;
  amount: number;
  pin: string;
};

export const MoneyServices = ({
  wallet,
  authenticatedUserPhone = '',
  cashSendVouchers,
  createCashSend,
  collectCashSend,
  cancelCashSend,
  navigate,
  scanReturnRoute,
  initialTab = 'send',
  showBackButton = false





















}: {
  wallet: Wallet;
  authenticatedUserPhone?: string;
  cashSendVouchers: CashSendVoucher[];
  createCashSend: (
    payload: CashSendCreatePayload
  ) => Promise<CashSendVoucher | null>;
  collectCashSend: (
    referenceNumber: string,
    pin: string,
    scannedIdDocument: string
  ) => Promise<{
    success: boolean;
    reason?: string;
    voucher?: CashSendVoucher;
  }>;
  cancelCashSend: (voucherId: string) => Promise<boolean>;
  navigate: (p: string) => void;
  scanReturnRoute: string;
  initialTab?: 'send' | 'receive' | 'vouchers';
  showBackButton?: boolean;
}) => {
  const [activeTab, setActiveTab] = useState<'send' | 'receive' | 'vouchers'>(
    () => inferCashSendTabFromDraft(initialTab),
  );
  return (
    <PageTransition className="flex flex-col h-full min-h-0 bg-slate-50">
      <CashSendConsentGate>
      <div className="flex flex-col flex-1 min-h-0">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center mb-4">
          {showBackButton &&
          <button
            onClick={() => navigate('home')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            
              <ArrowLeft className="w-6 h-6" />
            </button>
          }
          <h2
            className={`text-xl font-bold text-slate-900 ${showBackButton ? 'ml-2' : ''}`}>
            
            Cash Send
          </h2>
        </div>
        <div className="flex p-1 bg-slate-100 rounded-xl overflow-x-auto scrollbar-hide">
          <button
            onClick={() => setActiveTab('send')}
            className={`flex-1 min-w-[100px] py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'send' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>
            
            Send Cash
          </button>
          <button
            onClick={() => setActiveTab('receive')}
            className={`flex-1 min-w-[100px] py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'receive' ? 'bg-white text-amber-700 shadow-sm' : 'text-slate-500'}`}>
            
            Collect Cash
          </button>
          <button
            onClick={() => setActiveTab('vouchers')}
            className={`flex-1 min-w-[100px] py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'vouchers' ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}>
            
            My Vouchers
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {activeTab === 'send' &&
        <SendCashFlow
          wallet={wallet}
          authenticatedUserPhone={authenticatedUserPhone}
          createCashSend={createCashSend}
          navigate={navigate}
          scanReturnRoute={scanReturnRoute} />

        }
        {activeTab === 'receive' &&
        <CollectCashFlow
          collectCashSend={collectCashSend}
          navigate={navigate}
          scanReturnRoute={scanReturnRoute} />

        }
        {activeTab === 'vouchers' &&
        <div className="flex-1 min-h-0 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
          <VouchersList
            vouchers={cashSendVouchers}
            cancelCashSend={cancelCashSend} />
        </div>
        }
      </div>
      </div>
      </CashSendConsentGate>
    </PageTransition>);

};
const PinInput = ({
  length = 4,
  value,
  onChange




}: {length?: number;value: string;onChange: (val: string) => void;}) => {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const handleChange = (
  index: number,
  e: ChangeEvent<HTMLInputElement>) =>
  {
    const val = e.target.value.replace(/\D/g, '');
    if (!val) return;
    const newVal = value.split('');
    newVal[index] = val[val.length - 1];
    const finalVal = newVal.join('').slice(0, length);
    onChange(finalVal);
    if (index < length - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };
  const handleKeyDown = (
  index: number,
  e: KeyboardEvent<HTMLInputElement>) =>
  {
    if (e.key === 'Backspace') {
      const newVal = value.split('');
      newVal[index] = '';
      onChange(newVal.join(''));
      if (index > 0) {
        inputRefs.current[index - 1]?.focus();
      }
    }
  };
  return (
    <div className="flex gap-3 justify-center">
      {Array.from({
        length
      }).map((_, i) =>
      <input
        key={i}
        ref={(el) => inputRefs.current[i] = el}
        type="password"
        inputMode="numeric"
        maxLength={1}
        value={value[i] || ''}
        onChange={(e) => handleChange(i, e)}
        onKeyDown={(e) => handleKeyDown(i, e)}
        className="w-14 h-16 text-center text-2xl font-bold bg-slate-100 border-2 border-slate-200 rounded-xl focus:border-emerald-500 focus:bg-white focus:outline-none transition-colors" />

      )}
    </div>);

};
type SendCashFlowProps = {
  wallet: Wallet;
  authenticatedUserPhone: string;
  createCashSend: (
    payload: CashSendCreatePayload
  ) => Promise<CashSendVoucher | null>;
  navigate: (p: string) => void;
  scanReturnRoute: string;
};

const onlyDigits = (v: string) => v.replace(/\D/g, '');

const SEND_CASH_SCAN_DRAFT_KEY = 'ekasi.sendCashDraft.v1';
const COLLECT_CASH_SCAN_DRAFT_KEY = 'ekasi.collectCashDraft.v1';

function inferCashSendTabFromDraft(
  initialTab: 'send' | 'receive' | 'vouchers',
): 'send' | 'receive' | 'vouchers' {
  try {
    if (sessionStorage.getItem(COLLECT_CASH_SCAN_DRAFT_KEY)) return 'receive';
    if (sessionStorage.getItem(SEND_CASH_SCAN_DRAFT_KEY)) return 'send';
  } catch {
    /* ignore */
  }
  return initialTab;
}

const SendCashFlow = ({
  wallet,
  authenticatedUserPhone,
  createCashSend,
  navigate,
  scanReturnRoute,
}: SendCashFlowProps) => {
  const [step, setStep] = useState(1);
  const [senderFirstName, setSenderFirstName] = useState('');
  const [senderLastName, setSenderLastName] = useState('');
  const [senderId, setSenderId] = useState('');
  const [senderPhone, setSenderPhone] = useState('');
  const [senderAddress, setSenderAddress] = useState('');
  const [recipientFirstName, setRecipientFirstName] = useState('');
  const [recipientLastName, setRecipientLastName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [voucher, setVoucher] = useState<CashSendVoucher | null>(null);

  useEffect(() => {
    let usedDraft = false;
    try {
      const raw = sessionStorage.getItem(SEND_CASH_SCAN_DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Record<string, unknown>;
        sessionStorage.removeItem(SEND_CASH_SCAN_DRAFT_KEY);
        usedDraft = true;
        const st = d.step;
        if (typeof st === 'number' && st >= 1 && st <= 4) setStep(st);
        if (typeof d.senderFirstName === 'string')
          setSenderFirstName(d.senderFirstName);
        if (typeof d.senderLastName === 'string')
          setSenderLastName(d.senderLastName);
        if (typeof d.senderId === 'string') setSenderId(d.senderId);
        if (typeof d.senderPhone === 'string') setSenderPhone(d.senderPhone);
        if (typeof d.senderAddress === 'string')
          setSenderAddress(d.senderAddress);
        if (typeof d.recipientFirstName === 'string')
          setRecipientFirstName(d.recipientFirstName);
        if (typeof d.recipientLastName === 'string')
          setRecipientLastName(d.recipientLastName);
        if (typeof d.recipientPhone === 'string')
          setRecipientPhone(d.recipientPhone);
        if (typeof d.recipientId === 'string') setRecipientId(d.recipientId);
        if (typeof d.amount === 'string') setAmount(d.amount);
        if (typeof d.pin === 'string') setPin(d.pin);
      }
    } catch {
      sessionStorage.removeItem(SEND_CASH_SCAN_DRAFT_KEY);
    }
    // Only prefill from the persisted KYC profile if there's no in-progress
    // draft, otherwise we'd clobber the user's typing.
    if (!usedDraft) {
      const stored = loadSenderKycProfile(onlyDigits(authenticatedUserPhone));
      if (stored) {
        setSenderFirstName(stored.firstName);
        setSenderLastName(stored.lastName);
        setSenderId(stored.idDocument);
        setSenderAddress(stored.address);
        if (stored.senderCellphone && onlyDigits(stored.senderCellphone).length >= 10) {
          setSenderPhone(onlyDigits(stored.senderCellphone));
        }
      }
    }
    const sid = consumePendingSenderSaId();
    if (sid && onlyDigits(sid).length === 13)
      setSenderId(onlyDigits(sid).slice(0, 13));
    const bid = consumePendingBeneficiarySaId();
    if (bid && onlyDigits(bid).length === 13)
      setRecipientId(onlyDigits(bid).slice(0, 13));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount
  }, []);

  const openSendIdScanner = () => {
    sessionStorage.setItem(
      SEND_CASH_SCAN_DRAFT_KEY,
      JSON.stringify({
        step,
        senderFirstName,
        senderLastName,
        senderId,
        senderPhone,
        senderAddress,
        recipientFirstName,
        recipientLastName,
        recipientPhone,
        recipientId,
        amount,
        pin,
      }),
    );
    writeScannerSession({
      capture: 'sender-id',
      returnPage: scanReturnRoute,
    });
    navigate('scanner');
  };

  const handleNext = async () => {
    setError('');
    if (step === 1) {
      const senderIdMsg = saIdValidationMessage(onlyDigits(senderId));
      if (
        !senderFirstName.trim() ||
        !senderLastName.trim() ||
        senderIdMsg ||
        onlyDigits(senderPhone).length < 10 ||
        senderAddress.trim().length < 3
      ) {
        setError(
          senderIdMsg ??
            'Complete sender details: name, surname, valid 13-digit SA ID, cellphone, and physical address.'
        );
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (
        !recipientFirstName.trim() ||
        !recipientLastName.trim() ||
        onlyDigits(recipientPhone).length < 10
      ) {
        setError(
          'Complete beneficiary details: name, surname, and cellphone number.'
        );
        return;
      }
      if (onlyDigits(recipientPhone) === onlyDigits(senderPhone)) {
        setError('Beneficiary cellphone must differ from the sender’s.');
        return;
      }
      setStep(3);
      return;
    }
    if (step === 3) {
      const amt = Number(amount);
      if (amt > 0 && amt + 10 <= wallet.balance) setStep(4);
      else if (amt <= 0) setError('Enter a valid amount');
      else setError('Insufficient shop funds (including R10 fee)');
      return;
    }
    if (step === 4) {
      const pinMsg = cashSendVoucherPinMessage(pin);
      if (pinMsg) {
        setError(pinMsg);
        return;
      }
      setBusy(true);
      try {
        const newVoucher = await createCashSend({
          senderPhone: onlyDigits(senderPhone),
          senderFirstName: senderFirstName.trim(),
          senderLastName: senderLastName.trim(),
          senderIdDocument: onlyDigits(senderId),
          senderAddress: senderAddress.trim(),
          recipientFirstName: recipientFirstName.trim(),
          recipientLastName: recipientLastName.trim(),
          recipientPhone: onlyDigits(recipientPhone),
          recipientIdDocument: '',
          amount: Number(amount),
          pin,
        });
        if (newVoucher) {
          // Cache the sender KYC for the next voucher — saves four
          // re-keystrokes per send and reduces transcription errors.
          saveSenderKycProfile({
            phone: onlyDigits(authenticatedUserPhone),
            firstName: senderFirstName.trim(),
            lastName: senderLastName.trim(),
            idDocument: onlyDigits(senderId),
            address: senderAddress.trim(),
            senderCellphone: onlyDigits(senderPhone),
            savedAt: new Date().toISOString(),
          });
          setVoucher(newVoucher);
          setStep(5);
          toast.success('Cash Send created successfully!');
        } else {
          setError(
            'Could not create Cash Send — check your details and wallet balance, then try again.'
          );
        }
      } finally {
        setBusy(false);
      }
    }
  };

  const handleCopy = () => {
    if (!voucher) return;
    const beneficiary =
      `${voucher.recipientFirstName ?? ''} ${voucher.recipientLastName ?? ''}`.trim() ||
      voucher.recipientName ||
      voucher.recipientPhone;
    const text = `KasiPay Cash Send for ${beneficiary}. Amount R${voucher.amount.toFixed(
      2
    )}. Ref: ${voucher.referenceNumber} PIN: ${voucher.atmPin}. At collection the shop will scan the beneficiary’s SA ID.`;
    navigator.clipboard.writeText(text);
    toast.success('Details copied to clipboard');
  };

  if (step === 5 && voucher) {
    return (
      <div className="p-6 flex flex-col items-center text-center pt-8">
        <div className="w-20 h-20 bg-emerald-100 rounded-full flex items-center justify-center mb-6">
          <CheckCircle2 className="w-10 h-10 text-emerald-600" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">
          Cash Send Ready
        </h2>
        <p className="text-slate-500 mb-6">
          Share these details with the recipient securely.
        </p>

        <KPCard className="w-full mb-6 p-6 border-2 border-emerald-100 bg-emerald-50/30">
          <div className="mb-4">
            <p className="text-xs text-slate-500 uppercase tracking-wider font-bold mb-1">
              Reference Number
            </p>
            <p className="text-3xl font-mono font-bold text-slate-900 tracking-widest">
              {voucher.referenceNumber}
            </p>
          </div>
          <div className="mb-4">
            <p className="text-xs text-slate-500 uppercase tracking-wider font-bold mb-1">
              ATM PIN
            </p>
            <p className="text-3xl font-mono font-bold text-slate-900 tracking-widest">
              {voucher.atmPin}
            </p>
          </div>
          <div className="flex justify-between items-center pt-4 border-t border-emerald-200/50">
            <span className="text-slate-600 font-medium">Amount</span>
            <span className="text-xl font-bold text-emerald-700">
              R{voucher.amount.toFixed(2)}
            </span>
          </div>
        </KPCard>

        <div className="bg-amber-50 text-amber-800 p-4 rounded-xl text-sm w-full mb-6 flex items-start gap-3 text-left">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            The beneficiary needs the <strong>voucher reference</strong> and{' '}
            <strong>4-digit PIN</strong> from the sender. At collection they must present both, then the shop scans their SA ID. Voucher expires in 14 days.
          </p>
        </div>

        <div className="w-full space-y-3">
          <KPButton
            onClick={handleCopy}
            className="w-full bg-slate-900 hover:bg-slate-800">
            
            <Copy className="w-5 h-5 mr-2" /> Copy Details for SMS
          </KPButton>
          <KPButton
            variant="outline"
            onClick={() => navigate('home')}
            className="w-full">
            
            Back to Home
          </KPButton>
        </div>
      </div>);

  }
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-6 pb-4">
      <AnimatePresence mode="wait">
        {step === 1 &&
        <motion.div
          key="step1"
          initial={{
            x: 20,
            opacity: 0
          }}
          animate={{
            x: 0,
            opacity: 1
          }}
          exit={{
            x: -20,
            opacity: 0
          }}
          className="flex-1 space-y-4">
          
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <Send className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900">Sender details</h3>
                <p className="text-xs text-slate-500">Step 1 of 4 — KYC</p>
              </div>
            </div>
            <KPInput
            label="Sender name"
            placeholder="Name"
            value={senderFirstName}
            onChange={(e) => setSenderFirstName(e.target.value)} />
            <KPInput
            label="Sender surname"
            placeholder="Surname"
            value={senderLastName}
            onChange={(e) => setSenderLastName(e.target.value)} />
            <div className="flex gap-2 items-end">
              <div className="flex-1 min-w-0">
                <KPInput
                label="Sender SA ID number (13 digits)"
                type="tel"
                inputMode="numeric"
                autoComplete="off"
                maxLength={13}
                placeholder="Type 13 digits or scan"
                value={senderId}
                onChange={(e) =>
                setSenderId(onlyDigits(e.target.value).slice(0, 13))
                } />
              </div>
              <KPButton
                type="button"
                variant="outline"
                fullWidth={false}
                className="shrink-0 px-3 h-11 self-end mb-0.5"
                aria-label="Scan sender ID with camera"
                onClick={() => openSendIdScanner()}>
                
                <Camera className="w-5 h-5" />
              </KPButton>
            </div>
            <KPInput
            label="Sender cellphone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="Customer's 10-digit number"
            value={senderPhone}
            onChange={(e) =>
              setSenderPhone(onlyDigits(e.target.value).slice(0, 10))
            } />
            <KPInput
            label="Sender physical address"
            placeholder="Street, suburb, city"
            value={senderAddress}
            onChange={(e) => setSenderAddress(e.target.value)} />
          
          </motion.div>
        }

        {step === 2 &&
        <motion.div
          key="step2"
          initial={{
            x: 20,
            opacity: 0
          }}
          animate={{
            x: 0,
            opacity: 1
          }}
          exit={{
            x: -20,
            opacity: 0
          }}
          className="flex-1 space-y-4">
          
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center">
                <Send className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900">Beneficiary</h3>
                <p className="text-xs text-slate-500">Step 2 of 4 — who receives the cash</p>
              </div>
            </div>
            <KPInput
            label="Beneficiary name"
            placeholder="Name"
            value={recipientFirstName}
            onChange={(e) => setRecipientFirstName(e.target.value)} />
            <KPInput
            label="Beneficiary surname"
            placeholder="Surname"
            value={recipientLastName}
            onChange={(e) => setRecipientLastName(e.target.value)} />
            <KPInput
            label="Beneficiary cellphone"
            type="tel"
            placeholder="0719876543"
            value={recipientPhone}
            onChange={(e) => setRecipientPhone(e.target.value)} />
            <p className="text-xs text-slate-500 leading-relaxed">
              Their SA ID is only scanned when they withdraw the cash at a shop — you do not need it now.
            </p>
          
          </motion.div>
        }

        {step === 3 &&
        <motion.div
          key="step3"
          initial={{
            x: 20,
            opacity: 0
          }}
          animate={{
            x: 0,
            opacity: 1
          }}
          exit={{
            x: -20,
            opacity: 0
          }}
          className="flex-1 flex flex-col pt-4">
          
            <h3 className="font-bold text-slate-900 mb-2 text-center">
              Amount to Send
            </h3>
            <p className="text-xs text-slate-500 text-center mb-4">Step 3 of 4</p>
            <div className="flex items-center justify-center text-5xl font-bold text-slate-900 mb-8 border-b-2 border-slate-200 pb-4 w-full max-w-[200px] mx-auto">
              <span className="text-2xl text-slate-400 mr-2">R</span>
              <input
              type="number"
              className="w-full bg-transparent outline-none text-center"
              placeholder="0"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setError('');
              }}
              autoFocus />
            
            </div>
            <KPCard className="p-4 mb-6 bg-slate-50 border-none">
              <div className="flex justify-between py-2 border-b border-slate-200">
                <span className="text-slate-500">Amount</span>
                <span className="font-bold">
                  R{Number(amount || 0).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between py-2 border-b border-slate-200">
                <span className="text-slate-500">Agent Fee</span>
                <span className="font-medium">R10.00</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="font-bold text-slate-900">
                  Total to Collect
                </span>
                <span className="font-bold text-emerald-600">
                  R{(Number(amount || 0) + 10).toFixed(2)}
                </span>
              </div>
            </KPCard>
            <p className="text-sm text-center text-slate-500">
              Shop Wallet Balance: <KPAmount amount={wallet.balance} />
            </p>
          </motion.div>
        }

        {step === 4 &&
        <motion.div
          key="step4"
          initial={{
            x: 20,
            opacity: 0
          }}
          animate={{
            x: 0,
            opacity: 1
          }}
          exit={{
            x: -20,
            opacity: 0
          }}
          className="flex-1 flex flex-col items-center pt-8">
          
            <h3 className="font-bold text-slate-900 mb-2">Create ATM PIN</h3>
            <p className="text-xs text-slate-500 mb-1">Step 4 of 4</p>
            <p className="text-slate-500 text-sm text-center mb-8 px-4">
              Ask the sender to choose a 4-digit PIN the beneficiary will use with the reference at collection.
            </p>
            <PinInput
            value={pin}
            onChange={(val) => {
              setPin(val);
              setError('');
            }} />
          
          </motion.div>
        }
      </AnimatePresence>
      </div>

      <div className="shrink-0 border-t border-slate-200 bg-white px-6 py-4 z-20 shadow-[0_-4px_12px_rgba(15,23,42,0.06)] pb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
        {error &&
        <p className="text-red-500 text-sm mb-3 text-center">{error}</p>
        }
        <div className="flex gap-3">
          {step > 1 &&
          <KPButton
            variant="outline"
            onClick={() => setStep(step - 1)}
            className="w-1/3">
            
              Back
            </KPButton>
          }
          <KPButton
            onClick={() => void handleNext()}
            disabled={busy}
            className="flex-1">
            
            {step === 4 ? (busy ? 'Creating…' : 'Create Cash Send') : 'Continue'}
          </KPButton>
        </div>
      </div>
    </div>);

};
type CollectCashFlowProps = {
  collectCashSend: (
    referenceNumber: string,
    pin: string,
    scannedIdDocument: string
  ) => Promise<{ success: boolean; reason?: string; voucher?: CashSendVoucher }>;
  navigate: (p: string) => void;
  scanReturnRoute: string;
};

const CollectCashFlow = ({
  collectCashSend,
  navigate,
  scanReturnRoute,
}: CollectCashFlowProps) => {
  const [step, setStep] = useState(1);
  const [reference, setReference] = useState('');
  const [pin, setPin] = useState('');
  const [scannedIdDoc, setScannedIdDoc] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [voucher, setVoucher] = useState<CashSendVoucher | null>(null);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(COLLECT_CASH_SCAN_DRAFT_KEY);
      if (raw) {
        const d = JSON.parse(raw) as Record<string, unknown>;
        sessionStorage.removeItem(COLLECT_CASH_SCAN_DRAFT_KEY);
        if (typeof d.reference === 'string')
          setReference(d.reference.toUpperCase());
        if (typeof d.pin === 'string') setPin(d.pin);
        if (d.step === 2) setStep(2);
      }
    } catch {
      sessionStorage.removeItem(COLLECT_CASH_SCAN_DRAFT_KEY);
    }
    const scanned = consumePendingCollectSaId();
    if (scanned && onlyDigits(scanned).length === 13)
      setScannedIdDoc(onlyDigits(scanned).slice(0, 13));
  }, []);

  const openCollectCameraScanner = () => {
    sessionStorage.setItem(
      COLLECT_CASH_SCAN_DRAFT_KEY,
      JSON.stringify({
        reference: reference.trim(),
        pin,
        step: 2,
      }),
    );
    writeScannerSession({
      capture: 'collect-id',
      returnPage: scanReturnRoute,
    });
    navigate('scanner');
  };

  const goToIdStep = async () => {
    setError('');
    if (isSaCellphoneInput(reference)) {
      setError(
        'Cash can only be collected with the voucher number (CS…) from the sender — not a cellphone number.',
      );
      return;
    }
    const refNorm = parseCashSendVoucherReference(reference);
    if (!refNorm) {
      setError(
        'Enter the voucher number (starts with CS…) and 4-digit PIN the beneficiary received from the sender.',
      );
      return;
    }
    if (pin.length !== 4) {
      setError('Enter the 4-digit PIN the beneficiary received from the sender.');
      return;
    }
    setBusy(true);
    try {
      const lookup = await apiLookupCashSend({ reference: refNorm, pin });
      if (lookup.status !== 'active') {
        setError(`This voucher is ${lookup.status} and cannot be collected.`);
        return;
      }
      setReference(lookup.referenceNumber);
      setStep(2);
    } catch (e) {
      setError(
        e instanceof ApiError ?
          e.message
        : 'Could not verify voucher — check the reference and PIN from the sender.',
      );
    } finally {
      setBusy(false);
    }
  };

  const handlePayout = async () => {
    setError('');
    const digits = onlyDigits(scannedIdDoc);
    const idMsg = saIdValidationMessage(digits);
    if (idMsg) {
      setError(idMsg);
      return;
    }
    setBusy(true);
    try {
      const refNorm = parseCashSendVoucherReference(reference);
      if (!refNorm) {
        setError('Enter a valid voucher number (CS…) and PIN.');
        return;
      }
      const result = await collectCashSend(refNorm, pin, digits);
      if (result.success && result.voucher) {
        setVoucher(result.voucher);
        setStep(3);
      } else {
        setError(result.reason || 'Payout failed');
      }
    } finally {
      setBusy(false);
    }
  };

  if (step === 3 && voucher) {
    return (
      <div className="p-6 flex flex-col items-center text-center pt-8">
        <div className="w-20 h-20 bg-amber-100 rounded-full flex items-center justify-center mb-6">
          <CheckCircle2 className="w-10 h-10 text-amber-600" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">
          Payout approved
        </h2>
        <p className="text-slate-500 mb-4">Hand cash to the customer</p>

        {voucher.collectIdMatchedOnFile ?
          <div className="bg-emerald-50 text-emerald-900 text-sm rounded-xl px-4 py-3 w-full mb-6">
            Recipient SA ID matched the details captured when this send was created.
          </div>
        : null}

        <div className="text-5xl font-bold text-slate-900 mb-8">
          <KPAmount amount={voucher.amount} />
        </div>

        <div className="bg-emerald-50 text-emerald-800 p-4 rounded-xl text-sm w-full mb-8">
          Your shop wallet has been credited with{' '}
          <KPAmount amount={voucher.amount} />.
        </div>

        <KPButton
          onClick={() => {
            setStep(1);
            setReference('');
            setPin('');
            setScannedIdDoc('');
            setVoucher(null);
          }}
          className="w-full">
          
          Done
        </KPButton>
      </div>);

  }
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-6 pb-4">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center">
          <Download className="w-5 h-5" />
        </div>
        <div>
          <h3 className="font-bold text-slate-900">Collect cash</h3>
          <p className="text-xs text-slate-500">
            {step === 1 ?
              'Beneficiary presents voucher ref + PIN'
            : 'Scan beneficiary SA ID'}
            
          </p>
        </div>
      </div>

      {step === 1 &&
      <div className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Voucher number (CS… only)
          </label>
          <input
            type="text"
            placeholder="CS1783348762065946"
            value={reference}
            onChange={(e) => setReference(e.target.value.toUpperCase())}
            className="w-full bg-slate-50 border border-slate-200 rounded-xl py-3 px-4 text-lg font-mono font-bold focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-400 uppercase" />
          <p className="text-xs text-slate-500 mt-1.5">
            The beneficiary must show the unique CS… number they received from the sender (SMS or receipt).
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            4-digit voucher PIN (from sender)
          </label>
          <PinInput value={pin} onChange={setPin} />
          <p className="text-xs text-slate-500 mt-1.5">
            The beneficiary must also present the PIN the sender chose when creating this send.
          </p>
        </div>

        <div className="bg-blue-50 text-blue-800 p-4 rounded-xl text-sm flex items-start gap-3">
          <InfoIcon className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            After the reference and PIN check, scan the beneficiary’s SA ID to confirm identity before handing over cash.
          </p>
        </div>
      </div>
      }

      {step === 2 &&
      <div className="space-y-6">
        <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 p-6 text-center">
          <ScanLine className="w-10 h-10 text-amber-600 mx-auto mb-3" />
          <p className="font-semibold text-slate-900 mb-1">Beneficiary SA ID</p>
          <p className="text-xs text-slate-600 mb-4">
            Type the 13-digit ID number below, or open the camera scanner. USB barcode scanners will fill the field automatically.
          </p>
          <KPButton
            type="button"
            variant="outline"
            className="w-full mb-4 border-amber-200 text-amber-900 flex flex-row items-center justify-center gap-2"
            onClick={() => openCollectCameraScanner()}>
            
            <Camera className="w-5 h-5 shrink-0" />
            Open camera ID scanner
          </KPButton>
          <KPInput
            label="SA ID number (13 digits)"
            type="tel"
            inputMode="numeric"
            autoComplete="off"
            maxLength={13}
            placeholder="Type 13 digits from ID book / card"
            value={scannedIdDoc}
            onChange={(e) =>
            setScannedIdDoc(onlyDigits(e.target.value).slice(0, 13))
            } />

        </div>
      </div>
      }
      </div>

      {step === 2 &&
      <div className="shrink-0 border-t border-slate-200 bg-white px-6 py-4 z-20 shadow-[0_-4px_12px_rgba(15,23,42,0.06)] pb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
        {error && <p className="text-red-500 text-sm mb-3 text-center">{error}</p>}
        <div className="flex gap-3">
          <KPButton variant="outline" onClick={() => setStep(1)} className="w-1/3">
            Back
          </KPButton>
          <KPButton
            onClick={() => void handlePayout()}
            disabled={busy}
            className="flex-1 bg-amber-600 hover:bg-amber-700">
            
            {busy ? 'Processing…' : 'Verify ID & pay out'}
          </KPButton>
        </div>
      </div>
      }

      {step === 1 &&
      <div className="shrink-0 border-t border-slate-200 bg-white px-6 py-4 z-20 shadow-[0_-4px_12px_rgba(15,23,42,0.06)] pb-[calc(env(safe-area-inset-bottom)+5.5rem)]">
        {error && <p className="text-red-500 text-sm mb-3 text-center">{error}</p>}
        <KPButton
          onClick={() => void goToIdStep()}
          disabled={busy}
          className="w-full bg-amber-600 hover:bg-amber-700">
          
          {busy ? 'Checking reference…' : 'Continue to ID verification'}
        </KPButton>
      </div>
      }
    </div>);

};
const InfoIcon = (props: SVGProps<SVGSVGElement>) =>
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="24"
  height="24"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  strokeWidth="2"
  strokeLinecap="round"
  strokeLinejoin="round"
  {...props}>
  
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </svg>;

const VouchersList = ({
  vouchers,
  cancelCashSend



}: {vouchers: CashSendVoucher[];cancelCashSend: (id: string) => Promise<boolean>;}) => {
  const [showPin, setShowPin] = useState<Record<string, boolean>>({});
  const handleCancel = (id: string) => {
    if (
    window.confirm(
      'Are you sure you want to cancel this Cash Send? The funds will be returned to your wallet.'
    ))
    {
      void (async () => {
        if (await cancelCashSend(id)) {
          toast.success('Cash Send cancelled');
        } else {
          toast.error('Could not cancel voucher');
        }
      })();
    }
  };
  if (vouchers.length === 0) {
    return (
      <div className="p-6 text-center py-12 text-slate-500">
        <History className="w-12 h-12 mx-auto mb-3 text-slate-300" />
        <p>No Cash Send history</p>
      </div>);

  }
  return (
    <div className="p-6 space-y-4">
      {vouchers.map((v) => {
        const isActive = v.status === 'active';
        const isCollected = v.status === 'collected';
        const beneficiaryParts = [
          v.recipientFirstName?.trim(),
          v.recipientLastName?.trim(),
        ].filter(Boolean);
        const beneficiaryLine =
          beneficiaryParts.length ?
            beneficiaryParts.join(' ')
          : v.recipientName?.trim();
        const idHint =
          v.recipientIdLast4 ?
            ` · ID ****${v.recipientIdLast4}`
          : '';
        const pinStored = v.atmPin !== '****';
        return (
          <KPCard key={v.id} className={`p-4 ${!isActive ? 'opacity-75' : ''}`}>
            <div className="flex justify-between items-start mb-3">
              <div>
                <p className="font-bold text-slate-900">
                  {beneficiaryLine || 'Cash send'}
                </p>
                <p className="text-xs text-slate-600">{v.recipientPhone}{idHint}</p>
                <p className="text-xs text-slate-500 mt-1">
                  {new Date(v.createdAt).toLocaleDateString()}
                </p>
                {isCollected && v.collectIdMatchedOnFile ?
                  <p className="text-xs text-emerald-700 mt-1">
                    Collection verified against beneficiary SA ID on file.
                  </p>
                : null}
              </div>
              <KPBadge
                variant={
                isActive ? 'warning' : isCollected ? 'success' : 'danger'
                }>
                
                {v.status.toUpperCase()}
              </KPBadge>
            </div>

            <div className="bg-slate-50 rounded-lg p-3 mb-3 space-y-2">
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">Amount</span>
                <span className="font-bold text-slate-900">
                  R{v.amount.toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-xs text-slate-500">Ref</span>
                <span className="font-mono font-bold text-slate-700">
                  {v.referenceNumber}
                </span>
              </div>
              {isActive &&
              <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-500">PIN</span>
                  {pinStored ?
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-slate-700">
                      {showPin[v.id] ? v.atmPin : '••••'}
                    </span>
                    <button
                    onClick={() =>
                    setShowPin((p) => ({
                      ...p,
                      [v.id]: !p[v.id]
                    }))
                    }
                    className="text-slate-400 hover:text-slate-600">
                    
                      {showPin[v.id] ?
                    <EyeOff className="w-4 h-4" /> :

                    <Eye className="w-4 h-4" />
                    }
                    </button>
                  </div>
                  :
                  <span className="text-xs text-slate-500 text-right max-w-[60%]">
                    Shown once at creation — copy when sending
                  </span>
                  }
                </div>
              }
            </div>

            {isActive &&
            <div className="flex justify-between items-center mt-2">
                <span className="text-xs text-amber-600 font-medium">
                  Expires: {new Date(v.expiresAt).toLocaleDateString()}
                </span>
                <button
                onClick={() => handleCancel(v.id)}
                className="text-xs text-red-500 font-medium hover:text-red-700">
                
                  Cancel
                </button>
              </div>
            }
          </KPCard>);

      })}
    </div>);

};