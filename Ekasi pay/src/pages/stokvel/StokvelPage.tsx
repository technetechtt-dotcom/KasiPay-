import { useMemo, useState } from 'react';
import {
  KPCard,
  PageTransition,
  KPBadge,
  KPButton,
  KPInput,
} from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  Users,
  Calendar,
  Plus,
  X,
  Trash2,
  UserPlus,
  HandCoins,
} from 'lucide-react';
import type { StokvelGroup, StokvelLoan } from '../../types';
import { toast } from 'sonner';

type Member = { name: string; phone: string; contributed: number };

const INTEREST_TIERS = [10, 20, 30, 40, 50] as const;

function calcInterest(amount: number, ratePercent: number) {
  const interestAmount = Number(((amount / 100) * ratePercent).toFixed(2));
  return {
    interestAmount,
    totalDue: Number((amount + interestAmount).toFixed(2)),
  };
}

export const StokvelPage = ({
  groups,
  onCreateGroup,
  onUpdateMembers,
  onCreateLoan,
  onRepayLoan,
  navigate,
}: {
  groups: StokvelGroup[];
  onCreateGroup: (payload: {
    name: string;
    members: Member[];
    targetAmount: number;
    currentAmount: number;
    frequency: 'weekly' | 'monthly';
    nextPayoutDate: string;
  }) => Promise<boolean>;
  onUpdateMembers?: (id: string, members: Member[]) => Promise<boolean>;
  onCreateLoan?: (
    stokvelId: string,
    payload: {
      lenderName: string;
      lenderPhone: string;
      borrowerName: string;
      borrowerPhone: string;
      amount: number;
      interestRatePercent: number;
      fromPool?: boolean;
      notes?: string;
    },
  ) => Promise<boolean>;
  onRepayLoan?: (stokvelId: string, loanId: string) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currentAmount, setCurrentAmount] = useState('0');
  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('monthly');
  const [nextPayout, setNextPayout] = useState('');
  const [draftMembers, setDraftMembers] = useState<Member[]>([]);
  const [draftMemberName, setDraftMemberName] = useState('');
  const [draftMemberPhone, setDraftMemberPhone] = useState('');
  const [manageGroup, setManageGroup] = useState<StokvelGroup | null>(null);
  const [loanGroup, setLoanGroup] = useState<StokvelGroup | null>(null);

  const submit = async () => {
    const t = Number(targetAmount);
    const c = Number(currentAmount);
    if (!name.trim() || !(t > 0) || !nextPayout.trim()) {
      toast.error('Fill name, target, and payout date');
      return;
    }
    setBusy(true);
    try {
      const ok = await onCreateGroup({
        name: name.trim(),
        members: draftMembers,
        targetAmount: t,
        currentAmount: Number.isFinite(c) ? c : 0,
        frequency,
        nextPayoutDate: nextPayout,
      });
      if (ok) {
        toast.success('Stokvel created');
        setShowForm(false);
        setName('');
        setTargetAmount('');
        setCurrentAmount('0');
        setNextPayout('');
        setDraftMembers([]);
      } else toast.error('Could not save');
    } finally {
      setBusy(false);
    }
  };

  const addDraftMember = () => {
    const cleanName = draftMemberName.trim();
    const cleanPhone = draftMemberPhone.replace(/\s+/g, '');
    if (!cleanName || cleanPhone.length < 9) {
      toast.error('Add a name and phone (min 9 digits).');
      return;
    }
    if (draftMembers.some((m) => m.phone === cleanPhone)) {
      toast.error('Member already on the list.');
      return;
    }
    setDraftMembers((prev) => [
      ...prev,
      { name: cleanName, phone: cleanPhone, contributed: 0 },
    ]);
    setDraftMemberName('');
    setDraftMemberPhone('');
  };

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50 relative">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">
              Community Stokvel
            </h2>
          </div>
          <div className="w-10 h-10 bg-purple-100 text-purple-600 rounded-full flex items-center justify-center">
            <Users className="w-5 h-5" />
          </div>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Save together, track member loans, and set interest per R100 loaned
          out.
        </p>
        <KPButton
          type="button"
          className="bg-purple-600 hover:bg-purple-700"
          onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4 mr-2" /> New group
        </KPButton>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8">
        <div className="space-y-6">
          {groups.length === 0 && (
            <p className="text-center text-slate-500 py-8">No stokvels yet.</p>
          )}
          {groups.map((group) => {
            const progress = (group.currentAmount / group.targetAmount) * 100;
            const loans = group.loans ?? [];
            const activeLoans = loans.filter((l) => l.status === 'active');
            return (
              <KPCard key={group.id} className="overflow-hidden">
                <div className="bg-purple-600 p-5 text-white">
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <h3 className="font-bold text-lg">{group.name}</h3>
                      <p className="text-purple-200 text-sm">
                        {group.members.length} Members • {group.frequency}{' '}
                        contributions
                      </p>
                    </div>
                    <KPBadge
                      variant="success"
                      className="bg-white/20 text-white border-none">
                      Active
                    </KPBadge>
                  </div>
                  <div className="mb-2">
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-purple-100">Current Pool</span>
                      <span className="font-bold">
                        R{group.currentAmount.toLocaleString()}
                      </span>
                    </div>
                    <div className="h-2 bg-purple-900/30 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-white rounded-full"
                        style={{ width: `${Math.min(100, progress)}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs mt-1 text-purple-200">
                      <span>{progress.toFixed(0)}% to target</span>
                      <span>Target: R{group.targetAmount.toLocaleString()}</span>
                    </div>
                  </div>
                </div>

                <div className="p-5">
                  <div className="flex items-center gap-2 text-sm text-slate-600 bg-slate-50 p-3 rounded-xl mb-4">
                    <Calendar className="w-4 h-4 text-purple-600" />
                    <span>
                      Next Payout:{' '}
                      <span className="font-bold text-slate-900">
                        {new Date(group.nextPayoutDate).toLocaleDateString()}
                      </span>
                    </span>
                  </div>

                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                      Members
                    </h4>
                    {onUpdateMembers ?
                      <button
                        type="button"
                        onClick={() => setManageGroup(group)}
                        className="text-xs font-medium text-purple-700 flex items-center gap-1">
                        <UserPlus className="w-3.5 h-3.5" /> Manage
                      </button>
                    : null}
                  </div>
                  <div className="space-y-3 mb-5">
                    {group.members.length === 0 && (
                      <p className="text-sm text-slate-400">No members listed yet.</p>
                    )}
                    {group.members.map((member, i) => (
                      <div
                        key={i}
                        className="flex justify-between items-center text-sm">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 font-bold text-xs">
                            {member.name.charAt(0)}
                          </div>
                          <div>
                            <p className="font-medium text-slate-900">{member.name}</p>
                            <p className="text-[10px] text-slate-500">{member.phone}</p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-emerald-600">
                            R{member.contributed.toLocaleString()}
                          </p>
                          <p className="text-[10px] text-slate-400">Contributed</p>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center justify-between mb-3 border-t border-slate-100 pt-4">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                      <HandCoins className="w-3.5 h-3.5" />
                      Member loans
                      {activeLoans.length > 0 ?
                        <span className="normal-case font-medium text-amber-700">
                          ({activeLoans.length} open)
                        </span>
                      : null}
                    </h4>
                    {onCreateLoan ?
                      <button
                        type="button"
                        onClick={() => setLoanGroup(group)}
                        className="text-xs font-medium text-purple-700 flex items-center gap-1">
                        <Plus className="w-3.5 h-3.5" /> Record loan
                      </button>
                    : null}
                  </div>
                  <div className="space-y-3">
                    {loans.length === 0 && (
                      <p className="text-sm text-slate-400">
                        No loans yet. Example: Ivan loaned R1,000 to George at
                        10% per R100.
                      </p>
                    )}
                    {loans.map((loan) => (
                      <LoanRow
                        key={loan.id}
                        loan={loan}
                        onRepay={
                          onRepayLoan && loan.status === 'active'
                            ? async () => {
                                const ok = await onRepayLoan(group.id, loan.id);
                                if (ok) toast.success('Loan marked repaid');
                                return ok;
                              }
                            : undefined
                        }
                      />
                    ))}
                  </div>
                </div>
              </KPCard>
            );
          })}
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end justify-center sm:items-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[85vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg">New stokvel</h3>
              <button type="button" onClick={() => setShowForm(false)} aria-label="Close">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Group name</label>
            <KPInput className="mb-3" value={name} onChange={(e) => setName(e.target.value)} />
            <label className="block text-sm font-medium text-slate-700 mb-1">Target (R)</label>
            <KPInput
              type="number"
              className="mb-3"
              value={targetAmount}
              onChange={(e) => setTargetAmount(e.target.value)}
            />
            <label className="block text-sm font-medium text-slate-700 mb-1">Already saved (R)</label>
            <KPInput
              type="number"
              className="mb-3"
              value={currentAmount}
              onChange={(e) => setCurrentAmount(e.target.value)}
            />
            <label className="block text-sm font-medium text-slate-700 mb-1">Frequency</label>
            <select
              className="w-full border rounded-xl py-3 px-3 mb-3 text-sm bg-white"
              value={frequency}
              onChange={(e) =>
                setFrequency(e.target.value as 'weekly' | 'monthly')
              }>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <label className="block text-sm font-medium text-slate-700 mb-1">Next payout date</label>
            <KPInput type="date" className="mb-4" value={nextPayout} onChange={(e) => setNextPayout(e.target.value)} />

            <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mt-2 mb-2">
              Members (optional)
            </h4>
            <div className="flex gap-2 mb-2">
              <input
                placeholder="Name"
                value={draftMemberName}
                onChange={(e) => setDraftMemberName(e.target.value)}
                className="flex-1 bg-slate-50 rounded-lg px-3 py-2 text-sm border border-slate-200"
              />
              <input
                placeholder="Phone"
                value={draftMemberPhone}
                onChange={(e) => setDraftMemberPhone(e.target.value)}
                className="flex-1 bg-slate-50 rounded-lg px-3 py-2 text-sm border border-slate-200"
                inputMode="tel"
              />
              <button
                type="button"
                onClick={addDraftMember}
                className="px-3 py-2 rounded-lg bg-purple-100 text-purple-700 text-sm font-medium">
                <Plus className="w-4 h-4" />
              </button>
            </div>
            {draftMembers.length > 0 ?
              <ul className="text-sm space-y-1 mb-4">
                {draftMembers.map((m, i) =>
                  <li key={`${m.phone}-${i}`} className="flex justify-between text-slate-600">
                    <span>
                      {m.name} · {m.phone}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setDraftMembers((prev) => prev.filter((_, idx) => idx !== i))
                      }
                      aria-label="Remove">
                      <Trash2 className="w-3.5 h-3.5 text-red-500" />
                    </button>
                  </li>
                )}
              </ul>
            : null}

            <KPButton type="button" disabled={busy} onClick={() => void submit()} className="bg-purple-600">
              {busy ? 'Saving…' : 'Create group'}
            </KPButton>
          </div>
        </div>
      )}

      {manageGroup ?
        <ManageMembersModal
          group={manageGroup}
          onClose={() => setManageGroup(null)}
          onSave={async (members) => {
            if (!onUpdateMembers) return false;
            const ok = await onUpdateMembers(manageGroup.id, members);
            if (ok) {
              toast.success('Members updated');
              setManageGroup(null);
            }
            return ok;
          }}
        />
      : null}

      {loanGroup && onCreateLoan ?
        <RecordLoanModal
          group={loanGroup}
          onClose={() => setLoanGroup(null)}
          onSave={async (payload) => {
            const ok = await onCreateLoan(loanGroup.id, payload);
            if (ok) {
              toast.success('Loan recorded');
              setLoanGroup(null);
            }
            return ok;
          }}
        />
      : null}
    </PageTransition>
  );
};

function LoanRow({
  loan,
  onRepay,
}: {
  loan: StokvelLoan;
  onRepay?: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-sm">
      <div className="flex justify-between gap-2 mb-1">
        <p className="font-medium text-slate-900">
          {loan.lenderName}{' '}
          <span className="font-normal text-slate-500">loaned to</span>{' '}
          {loan.borrowerName}
        </p>
        <KPBadge variant={loan.status === 'active' ? 'warning' : 'success'}>
          {loan.status}
        </KPBadge>
      </div>
      <p className="text-slate-600">
        R{loan.amount.toLocaleString()} at {loan.interestRatePercent}% per R100
        → interest R{loan.interestAmount.toLocaleString()} · due{' '}
        <strong>R{loan.totalDue.toLocaleString()}</strong>
      </p>
      <p className="text-[11px] text-slate-400 mt-1">
        {loan.lenderPhone} → {loan.borrowerPhone}
        {loan.fromPool ? ' · from pool' : ''}
        {' · '}
        {new Date(loan.createdAt).toLocaleDateString()}
      </p>
      {onRepay ?
        <button
          type="button"
          disabled={busy}
          className="mt-2 text-xs font-medium text-emerald-700"
          onClick={() => {
            void (async () => {
              setBusy(true);
              try {
                await onRepay();
              } finally {
                setBusy(false);
              }
            })();
          }}>
          {busy ? 'Saving…' : 'Mark repaid'}
        </button>
      : null}
    </div>
  );
}

const RecordLoanModal = ({
  group,
  onClose,
  onSave,
}: {
  group: StokvelGroup;
  onClose: () => void;
  onSave: (payload: {
    lenderName: string;
    lenderPhone: string;
    borrowerName: string;
    borrowerPhone: string;
    amount: number;
    interestRatePercent: number;
    fromPool?: boolean;
    notes?: string;
  }) => Promise<boolean>;
}) => {
  const [lenderPhone, setLenderPhone] = useState(group.members[0]?.phone ?? '');
  const [borrowerName, setBorrowerName] = useState('');
  const [borrowerPhone, setBorrowerPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [rate, setRate] = useState<(typeof INTEREST_TIERS)[number]>(10);
  const [fromPool, setFromPool] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const lender = useMemo(
    () => group.members.find((m) => m.phone === lenderPhone),
    [group.members, lenderPhone],
  );

  const preview = useMemo(() => {
    const a = Number(amount);
    if (!(a > 0)) return null;
    return calcInterest(a, rate);
  }, [amount, rate]);

  const submit = async () => {
    const a = Number(amount);
    if (!lender) {
      toast.error('Pick which member loaned the money.');
      return;
    }
    if (!borrowerName.trim() || borrowerPhone.replace(/\s+/g, '').length < 9) {
      toast.error('Add borrower name and phone.');
      return;
    }
    if (!(a > 0)) {
      toast.error('Enter a loan amount.');
      return;
    }
    setBusy(true);
    try {
      await onSave({
        lenderName: lender.name,
        lenderPhone: lender.phone,
        borrowerName: borrowerName.trim(),
        borrowerPhone: borrowerPhone.replace(/\s+/g, ''),
        amount: a,
        interestRatePercent: rate,
        fromPool,
        notes: notes.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-lg">Record loan — {group.name}</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="w-6 h-6 text-slate-400" />
          </button>
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Track who loaned to whom. Interest is charged per R100 (e.g. 10% =
          R10 interest on every R100).
        </p>

        <label className="block text-sm font-medium text-slate-700 mb-1">
          Member who loaned (lender)
        </label>
        {group.members.length === 0 ?
          <p className="text-sm text-amber-700 mb-3">
            Add members first, then record loans.
          </p>
        :
          <select
            className="w-full border rounded-xl py-3 px-3 mb-3 text-sm bg-white"
            value={lenderPhone}
            onChange={(e) => setLenderPhone(e.target.value)}>
            {group.members.map((m) => (
              <option key={m.phone} value={m.phone}>
                {m.name} ({m.phone})
              </option>
            ))}
          </select>
        }

        <label className="block text-sm font-medium text-slate-700 mb-1">
          Borrower name
        </label>
        <KPInput
          className="mb-3"
          value={borrowerName}
          onChange={(e) => setBorrowerName(e.target.value)}
          placeholder="e.g. George"
        />
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Borrower phone
        </label>
        <KPInput
          className="mb-3"
          value={borrowerPhone}
          onChange={(e) => setBorrowerPhone(e.target.value)}
          inputMode="tel"
        />

        <label className="block text-sm font-medium text-slate-700 mb-1">
          Amount (R)
        </label>
        <KPInput
          type="number"
          className="mb-3"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="1000"
        />

        <label className="block text-sm font-medium text-slate-700 mb-1">
          Interest per R100
        </label>
        <div className="flex flex-wrap gap-2 mb-2">
          {INTEREST_TIERS.map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => setRate(tier)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium ${
                rate === tier
                  ? 'bg-purple-700 text-white'
                  : 'bg-slate-100 text-slate-700'
              }`}>
              {tier}%
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500 mb-3">
          {rate}% on R100 = R{rate} interest. On R1,000 = R
          {((1000 / 100) * rate).toFixed(0)} interest.
        </p>

        {preview ?
          <div className="mb-3 rounded-xl bg-purple-50 text-purple-900 text-sm p-3">
            Interest: <strong>R{preview.interestAmount.toLocaleString()}</strong>
            {' · '}
            Total due:{' '}
            <strong>R{preview.totalDue.toLocaleString()}</strong>
          </div>
        : null}

        <label className="flex items-center gap-2 text-sm text-slate-700 mb-3">
          <input
            type="checkbox"
            checked={fromPool}
            onChange={(e) => setFromPool(e.target.checked)}
          />
          Taken from stokvel pool (deduct R{amount || '0'} now)
        </label>

        <label className="block text-sm font-medium text-slate-700 mb-1">
          Notes (optional)
        </label>
        <KPInput
          className="mb-4"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />

        <KPButton
          type="button"
          disabled={busy || group.members.length === 0}
          onClick={() => void submit()}
          className="bg-purple-600">
          {busy ? 'Saving…' : 'Save loan'}
        </KPButton>
      </div>
    </div>
  );
};

const ManageMembersModal = ({
  group,
  onClose,
  onSave,
}: {
  group: StokvelGroup;
  onClose: () => void;
  onSave: (members: Member[]) => Promise<boolean>;
}) => {
  const [members, setMembers] = useState<Member[]>(group.members);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [contributed, setContributed] = useState('0');
  const [busy, setBusy] = useState(false);

  const add = () => {
    const cleanPhone = phone.replace(/\s+/g, '');
    if (!name.trim() || cleanPhone.length < 9) {
      toast.error('Add a name and phone');
      return;
    }
    if (members.some((m) => m.phone === cleanPhone)) {
      toast.error('Member already on the list');
      return;
    }
    setMembers((prev) => [
      ...prev,
      {
        name: name.trim(),
        phone: cleanPhone,
        contributed: Math.max(0, Number(contributed) || 0),
      },
    ]);
    setName('');
    setPhone('');
    setContributed('0');
  };

  const save = async () => {
    setBusy(true);
    try {
      await onSave(members);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-lg">Members — {group.name}</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="w-6 h-6 text-slate-400" />
          </button>
        </div>
        <ul className="space-y-1 text-sm mb-4 max-h-48 overflow-y-auto">
          {members.length === 0 && (
            <li className="text-slate-400 text-xs">No members yet.</li>
          )}
          {members.map((m, i) => (
            <li
              key={`${m.phone}-${i}`}
              className="flex justify-between items-center bg-slate-50 rounded-md px-2 py-1">
              <span>
                <strong className="text-slate-700">{m.name}</strong>{' '}
                <span className="text-slate-400">· {m.phone}</span>{' '}
                <span className="text-emerald-600">
                  R{m.contributed.toFixed(2)}
                </span>
              </span>
              <button
                type="button"
                onClick={() =>
                  setMembers((prev) => prev.filter((_, idx) => idx !== i))
                }
                aria-label="Remove member"
                className="text-red-500">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-2 mb-2">
          <input
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="bg-slate-50 rounded-lg px-3 py-2 text-sm border border-slate-200"
          />
          <input
            placeholder="Phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="bg-slate-50 rounded-lg px-3 py-2 text-sm border border-slate-200"
            inputMode="tel"
          />
        </div>
        <input
          placeholder="Contributed (R)"
          type="number"
          value={contributed}
          onChange={(e) => setContributed(e.target.value)}
          className="w-full bg-slate-50 rounded-lg px-3 py-2 text-sm border border-slate-200 mb-2"
        />
        <button
          type="button"
          onClick={add}
          className="w-full mb-4 py-2 rounded-xl bg-purple-100 text-purple-800 text-sm font-medium">
          Add member
        </button>
        <KPButton
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="bg-purple-600">
          {busy ? 'Saving…' : 'Save members'}
        </KPButton>
      </div>
    </div>
  );
};
