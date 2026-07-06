import { type ReactNode, useState } from 'react';
import { Shield, FileText } from 'lucide-react';
import { KPButton, KPCard } from '../shared/UIComponents';
import {
  CASH_SEND_CONSENT_STORAGE_KEY,
  hasCashSendDataConsent,
} from './cashSendConsentStorage';

/** Pilot notice: IDs and Cash Send terms (POPIA-style transparency, not legal advice). */
export function CashSendConsentGate({
  children,
}: {
  children: ReactNode;
}) {
  const [accepted, setAccepted] = useState(hasCashSendDataConsent);
  const [confirmed, setConfirmed] = useState(false);

  if (accepted) return <>{children}</>;

  return (
    <div className="page-scroll p-6 flex flex-col gap-4 max-w-lg mx-auto w-full">
      <KPCard className="p-5 border-amber-200 bg-amber-50/40">
        <div className="flex items-start gap-3 mb-4">
          <Shield className="w-10 h-10 text-amber-700 shrink-0" />
          <div>
            <h2 className="font-bold text-slate-900 text-lg mb-1">
              Cash Send & identity data (field pilot)
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              Before you capture sender and beneficiary SA ID numbers, your shop agrees that:
              (1) you only collect what is needed for payout verification; (2) you keep devices
              passcode-protected; (3) you will follow your pilot host’s retention and backup rules
              for the server database (IDs are stored until you delete vouchers or purge data per
              your policy).
            </p>
          </div>
        </div>
        <ul className="text-xs text-slate-700 space-y-2 mb-4 list-disc pl-5">
          <li>When sending, capture the sender&apos;s SA ID number only.</li>
          <li>At collection the beneficiary must present the voucher reference and 4-digit PIN from the sender, then scan their own SA ID.</li>
          <li>Do not share PINs or references in public channels.</li>
          <li>Support contact for this pilot should be documented in your field pack.</li>
        </ul>
        <label className="flex items-start gap-2 text-sm text-slate-800 cursor-pointer select-none">
          <input
            type="checkbox"
            className="mt-1 rounded border-slate-300"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>We understand how ID data will be used in this prototype and will explain it to customers.</span>
        </label>
        <KPButton
          className="w-full mt-4"
          disabled={!confirmed}
          onClick={() => {
            if (typeof window !== 'undefined') {
              window.localStorage.setItem(CASH_SEND_CONSENT_STORAGE_KEY, '1');
            }
            setAccepted(true);
          }}>
          Continue to Cash Send
        </KPButton>
      </KPCard>
      <p className="text-[11px] text-slate-500 flex items-start gap-2 px-1">
        <FileText className="w-4 h-4 shrink-0 mt-0.5" />
        Not legal advice—have your compliance sponsor review wording before scaling beyond pilots.
      </p>
    </div>
  );
}
