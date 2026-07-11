import { useEffect, useMemo, useState } from 'react';
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
  HandCoins,
  Wallet,
  ChevronRight,
} from 'lucide-react';
import type {
  StokvelContribution,
  StokvelGroup,
  StokvelLoan,
} from '../../types';
import { toast } from 'sonner';

type Member = { name: string; phone: string; contributed: number };
type DetailTab = 'overview' | 'members' | 'contributions' | 'loans';

const INTEREST_TIERS = [10, 20, 30, 40, 50] as const;

function calcInterest(amount: number, ratePercent: number) {
  const interestAmount = Number(((amount / 100) * ratePercent).toFixed(2));
  return {
    interestAmount,
    totalDue: Number((amount + interestAmount).toFixed(2)),
  };
}

function currentPeriodMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatPeriod(period: string) {
  const [y, m] = period.split('-').map(Number);
  if (!y || !m) return period;
  return new Date(y, m - 1, 1).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

export const StokvelPage = ({
  groups,
  onCreateGroup,
  onUpdateMembers,
  onCreateLoan,
  onRepayLoan,
  onRecordContribution,
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
  onRecordContribution?: (
    stokvelId: string,
    payload: {
      memberPhone: string;
      amount: number;
      periodMonth: string;
      notes?: string;
    },
  ) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [showCreate, setShowCreate] = useState(false);
  const [showLoan, setShowLoan] = useState(false);
  const [showContribution, setShowContribution] = useState(false);

  const selected = useMemo(
    () => groups.find((g) => g.id === selectedId) ?? null,
    [groups, selectedId],
  );

  useEffect(() => {
    if (selectedId && !groups.some((g) => g.id === selectedId)) {
      setSelectedId(null);
    }
  }, [groups, selectedId]);

  if (selected) {
    return (
      <GroupDetail
        group={selected}
        tab={tab}
        setTab={setTab}
        onBack={() => {
          setSelectedId(null);
          setTab('overview');
        }}
        onUpdateMembers={onUpdateMembers}
        onCreateLoan={onCreateLoan}
        onRepayLoan={onRepayLoan}
        onRecordContribution={onRecordContribution}
        showLoan={showLoan}
        setShowLoan={setShowLoan}
        showContribution={showContribution}
        setShowContribution={setShowContribution}
      />
    );
  }

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50 relative">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between mb-4">
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
          Manage groups, members, monthly contributions, and member loans.
        </p>
        <KPButton
          type="button"
          className="bg-purple-600 hover:bg-purple-700"
          onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-2" /> New group
        </KPButton>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 space-y-3">
        {groups.length === 0 && (
          <p className="text-center text-slate-500 py-8">No stokvels yet.</p>
        )}
        {groups.map((group) => {
          const openLoans = (group.loans ?? []).filter(
            (l) => l.status === 'active',
          ).length;
          const monthPaid = (group.contributions ?? []).filter(
            (c) => c.periodMonth === currentPeriodMonth(),
          ).length;
          return (
            <button
              key={group.id}
              type="button"
              onClick={() => {
                setSelectedId(group.id);
                setTab('overview');
              }}
              className="w-full text-left">
              <KPCard className="p-4 hover:border-purple-200 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-bold text-slate-900 truncate">
                      {group.name}
                    </h3>
                    <p className="text-sm text-slate-500 mt-0.5">
                      {group.members.length} members · {group.frequency}
                    </p>
                    <p className="text-sm text-emerald-700 font-medium mt-2">
                      Pool R{group.currentAmount.toLocaleString()} / R
                      {group.targetAmount.toLocaleString()}
                    </p>
                    <p className="text-xs text-slate-400 mt-1">
                      This month: {monthPaid}/{group.members.length} paid
                      {openLoans > 0 ? ` · ${openLoans} open loans` : ''}
                    </p>
                  </div>
                  <ChevronRight className="w-5 h-5 text-slate-300 shrink-0 mt-1" />
                </div>
              </KPCard>
            </button>
          );
        })}
      </div>

      {showCreate && (
        <CreateGroupModal
          onClose={() => setShowCreate(false)}
          onCreate={async (payload) => {
            const ok = await onCreateGroup(payload);
            if (ok) {
              toast.success('Stokvel created');
              setShowCreate(false);
            }
            return ok;
          }}
        />
      )}
    </PageTransition>
  );
};

function GroupDetail({
  group,
  tab,
  setTab,
  onBack,
  onUpdateMembers,
  onCreateLoan,
  onRepayLoan,
  onRecordContribution,
  showLoan,
  setShowLoan,
  showContribution,
  setShowContribution,
}: {
  group: StokvelGroup;
  tab: DetailTab;
  setTab: (t: DetailTab) => void;
  onBack: () => void;
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
  onRecordContribution?: (
    stokvelId: string,
    payload: {
      memberPhone: string;
      amount: number;
      periodMonth: string;
      notes?: string;
    },
  ) => Promise<boolean>;
  showLoan: boolean;
  setShowLoan: (v: boolean) => void;
  showContribution: boolean;
  setShowContribution: (v: boolean) => void;
}) {
  const progress =
    group.targetAmount > 0
      ? (group.currentAmount / group.targetAmount) * 100
      : 0;
  const loans = group.loans ?? [];
  const contributions = group.contributions ?? [];
  const thisMonth = currentPeriodMonth();

  const tabs: { id: DetailTab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'members', label: 'Members' },
    { id: 'contributions', label: 'Contributions' },
    { id: 'loans', label: 'Loans' },
  ];

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50 relative">
      <div className="bg-white px-6 pt-12 pb-3 shadow-sm z-10 shrink-0">
        <div className="flex items-center mb-3">
          <button
            type="button"
            onClick={onBack}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div className="ml-2 min-w-0">
            <h2 className="text-xl font-bold text-slate-900 truncate">
              {group.name}
            </h2>
            <p className="text-xs text-slate-500">
              {group.members.length} members · next payout{' '}
              {new Date(group.nextPayoutDate).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1 scrollbar-hide">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap ${
                tab === t.id
                  ? 'bg-purple-700 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8">
        {tab === 'overview' && (
          <div className="space-y-4">
            <KPCard className="p-5 bg-purple-600 text-white border-none">
              <p className="text-purple-100 text-sm">Current pool</p>
              <p className="text-3xl font-bold mt-1">
                R{group.currentAmount.toLocaleString()}
              </p>
              <div className="h-2 bg-purple-900/30 rounded-full overflow-hidden mt-4">
                <div
                  className="h-full bg-white rounded-full"
                  style={{ width: `${Math.min(100, progress)}%` }}
                />
              </div>
              <div className="flex justify-between text-xs mt-2 text-purple-100">
                <span>{progress.toFixed(0)}% to target</span>
                <span>Target R{group.targetAmount.toLocaleString()}</span>
              </div>
            </KPCard>
            <div className="grid grid-cols-2 gap-3">
              <KPCard className="p-4">
                <Users className="w-4 h-4 text-purple-600 mb-2" />
                <p className="text-xs text-slate-500">Members</p>
                <p className="text-xl font-bold text-slate-900">
                  {group.members.length}
                </p>
              </KPCard>
              <KPCard className="p-4">
                <Wallet className="w-4 h-4 text-emerald-600 mb-2" />
                <p className="text-xs text-slate-500">Paid this month</p>
                <p className="text-xl font-bold text-slate-900">
                  {
                    contributions.filter((c) => c.periodMonth === thisMonth)
                      .length
                  }
                  /{group.members.length}
                </p>
              </KPCard>
              <KPCard className="p-4">
                <HandCoins className="w-4 h-4 text-amber-600 mb-2" />
                <p className="text-xs text-slate-500">Open loans</p>
                <p className="text-xl font-bold text-slate-900">
                  {loans.filter((l) => l.status === 'active').length}
                </p>
              </KPCard>
              <KPCard className="p-4">
                <Calendar className="w-4 h-4 text-slate-600 mb-2" />
                <p className="text-xs text-slate-500">Frequency</p>
                <p className="text-xl font-bold text-slate-900 capitalize">
                  {group.frequency}
                </p>
              </KPCard>
            </div>
            <div className="flex gap-2">
              <KPButton
                type="button"
                className="bg-purple-600 flex-1"
                onClick={() => {
                  setTab('contributions');
                  setShowContribution(true);
                }}>
                Record contribution
              </KPButton>
              <KPButton
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setTab('loans');
                  setShowLoan(true);
                }}>
                Record loan
              </KPButton>
            </div>
          </div>
        )}

        {tab === 'members' && (
          <MembersPanel group={group} onUpdateMembers={onUpdateMembers} />
        )}

        {tab === 'contributions' && (
          <ContributionsPanel
            group={group}
            contributions={contributions}
            onAdd={() => setShowContribution(true)}
          />
        )}

        {tab === 'loans' && (
          <LoansPanel
            group={group}
            loans={loans}
            onAdd={() => setShowLoan(true)}
            onRepayLoan={onRepayLoan}
          />
        )}
      </div>

      {showContribution && onRecordContribution && (
        <ContributionModal
          group={group}
          onClose={() => setShowContribution(false)}
          onSave={async (payload) => {
            const ok = await onRecordContribution(group.id, payload);
            if (ok) {
              toast.success('Contribution saved');
              setShowContribution(false);
            }
            return ok;
          }}
        />
      )}

      {showLoan && onCreateLoan && (
        <RecordLoanModal
          group={group}
          onClose={() => setShowLoan(false)}
          onSave={async (payload) => {
            const ok = await onCreateLoan(group.id, payload);
            if (ok) {
              toast.success('Loan recorded');
              setShowLoan(false);
            }
            return ok;
          }}
        />
      )}
    </PageTransition>
  );
}

function MembersPanel({
  group,
  onUpdateMembers,
}: {
  group: StokvelGroup;
  onUpdateMembers?: (id: string, members: Member[]) => Promise<boolean>;
}) {
  const [members, setMembers] = useState<Member[]>(group.members);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMembers(group.members);
  }, [group.members]);

  const add = () => {
    const cleanPhone = phone.replace(/\s+/g, '');
    if (!name.trim() || cleanPhone.length < 9) {
      toast.error('Add a name and phone (min 9 digits)');
      return;
    }
    if (members.some((m) => m.phone === cleanPhone)) {
      toast.error('Member already on the list');
      return;
    }
    setMembers((prev) => [
      ...prev,
      { name: name.trim(), phone: cleanPhone, contributed: 0 },
    ]);
    setName('');
    setPhone('');
  };

  const save = async () => {
    if (!onUpdateMembers) return;
    setBusy(true);
    try {
      const ok = await onUpdateMembers(group.id, members);
      if (ok) toast.success('Members updated');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        Add or remove people in this stokvel. Totals update when you capture
        monthly contributions.
      </p>
      <div className="space-y-2">
        {members.length === 0 && (
          <p className="text-sm text-slate-400">No members yet.</p>
        )}
        {members.map((m, i) => (
          <KPCard key={`${m.phone}-${i}`} className="p-3 flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center font-bold text-sm">
              {m.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-slate-900 truncate">{m.name}</p>
              <p className="text-xs text-slate-500">{m.phone}</p>
            </div>
            <div className="text-right">
              <p className="text-sm font-bold text-emerald-600">
                R{m.contributed.toLocaleString()}
              </p>
              <p className="text-[10px] text-slate-400">total</p>
            </div>
            <button
              type="button"
              className="text-red-500 p-1"
              aria-label="Remove member"
              onClick={() =>
                setMembers((prev) => prev.filter((_, idx) => idx !== i))
              }>
              <Trash2 className="w-4 h-4" />
            </button>
          </KPCard>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="bg-white rounded-xl px-3 py-2.5 text-sm border border-slate-200"
        />
        <input
          placeholder="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          className="bg-white rounded-xl px-3 py-2.5 text-sm border border-slate-200"
        />
      </div>
      <button
        type="button"
        onClick={add}
        className="w-full py-2.5 rounded-xl bg-purple-100 text-purple-800 text-sm font-medium">
        Add member to list
      </button>
      {onUpdateMembers ? (
        <KPButton
          type="button"
          disabled={busy}
          onClick={() => void save()}
          className="bg-purple-600">
          {busy ? 'Saving…' : 'Save members'}
        </KPButton>
      ) : null}
    </div>
  );
}

function ContributionsPanel({
  group,
  contributions,
  onAdd,
}: {
  group: StokvelGroup;
  contributions: StokvelContribution[];
  onAdd: () => void;
}) {
  const thisMonth = currentPeriodMonth();
  const byMonth = useMemo(() => {
    const map = new Map<string, StokvelContribution[]>();
    for (const c of contributions) {
      const list = map.get(c.periodMonth) ?? [];
      list.push(c);
      map.set(c.periodMonth, list);
    }
    return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [contributions]);

  const paidPhones = new Set(
    contributions
      .filter((c) => c.periodMonth === thisMonth)
      .map((c) => c.memberPhone),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-bold text-slate-900">Monthly contributions</h3>
          <p className="text-xs text-slate-500">
            {formatPeriod(thisMonth)}: {paidPhones.size}/{group.members.length}{' '}
            members paid
          </p>
        </div>
        <KPButton
          type="button"
          fullWidth={false}
          className="!min-w-0 bg-purple-600 h-10 px-3 text-sm"
          onClick={onAdd}>
          <Plus className="w-4 h-4 mr-1" /> Capture
        </KPButton>
      </div>

      {group.members.length > 0 && (
        <KPCard className="p-3">
          <p className="text-xs font-bold text-slate-500 uppercase mb-2">
            {formatPeriod(thisMonth)} status
          </p>
          <div className="space-y-2">
            {group.members.map((m) => {
              const paid = contributions.find(
                (c) =>
                  c.periodMonth === thisMonth && c.memberPhone === m.phone,
              );
              return (
                <div
                  key={m.phone}
                  className="flex justify-between items-center text-sm">
                  <span className="text-slate-800">{m.name}</span>
                  {paid ? (
                    <span className="text-emerald-600 font-medium">
                      Paid R{paid.amount.toLocaleString()}
                    </span>
                  ) : (
                    <span className="text-amber-600 text-xs font-medium">
                      Outstanding
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </KPCard>
      )}

      {byMonth.length === 0 && (
        <p className="text-sm text-slate-400 text-center py-6">
          No contributions captured yet.
        </p>
      )}
      {byMonth.map(([period, rows]) => (
        <div key={period}>
          <h4 className="text-xs font-bold text-slate-500 uppercase mb-2">
            {formatPeriod(period)}
          </h4>
          <div className="space-y-2">
            {rows.map((c) => (
              <KPCard key={c.id} className="p-3 flex justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-900">{c.memberName}</p>
                  <p className="text-xs text-slate-500">{c.memberPhone}</p>
                </div>
                <p className="font-bold text-emerald-600">
                  R{c.amount.toLocaleString()}
                </p>
              </KPCard>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function LoansPanel({
  group,
  loans,
  onAdd,
  onRepayLoan,
}: {
  group: StokvelGroup;
  loans: StokvelLoan[];
  onAdd: () => void;
  onRepayLoan?: (stokvelId: string, loanId: string) => Promise<boolean>;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="font-bold text-slate-900">Member loans</h3>
          <p className="text-xs text-slate-500">
            Who loaned to whom, with interest per R100
          </p>
        </div>
        <KPButton
          type="button"
          fullWidth={false}
          className="!min-w-0 bg-purple-600 h-10 px-3 text-sm"
          onClick={onAdd}>
          <Plus className="w-4 h-4 mr-1" /> Loan
        </KPButton>
      </div>
      {loans.length === 0 && (
        <p className="text-sm text-slate-400 text-center py-6">
          No loans yet. Example: Ivan loaned R1,000 to George at 10% per R100.
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
  );
}

function LoanRow({
  loan,
  onRepay,
}: {
  loan: StokvelLoan;
  onRepay?: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <KPCard className="p-3 text-sm">
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
      {onRepay ? (
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
      ) : null}
    </KPCard>
  );
}

function ContributionModal({
  group,
  onClose,
  onSave,
}: {
  group: StokvelGroup;
  onClose: () => void;
  onSave: (payload: {
    memberPhone: string;
    amount: number;
    periodMonth: string;
    notes?: string;
  }) => Promise<boolean>;
}) {
  const [memberPhone, setMemberPhone] = useState(group.members[0]?.phone ?? '');
  const [amount, setAmount] = useState('');
  const [periodMonth, setPeriodMonth] = useState(currentPeriodMonth());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const existing = group.contributions?.find(
    (c) => c.memberPhone === memberPhone && c.periodMonth === periodMonth,
  );

  useEffect(() => {
    if (existing) setAmount(String(existing.amount));
  }, [existing]);

  const submit = async () => {
    const a = Number(amount);
    if (!memberPhone) {
      toast.error('Select a member');
      return;
    }
    if (!(a > 0)) {
      toast.error('Enter contribution amount');
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodMonth)) {
      toast.error('Pick a valid month');
      return;
    }
    setBusy(true);
    try {
      await onSave({
        memberPhone,
        amount: a,
        periodMonth,
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
          <h3 className="font-bold text-lg">Capture contribution</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="w-6 h-6 text-slate-400" />
          </button>
        </div>
        {group.members.length === 0 ? (
          <p className="text-sm text-amber-700 mb-4">
            Add members on the Members tab first.
          </p>
        ) : (
          <>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Member
            </label>
            <select
              className="w-full border rounded-xl py-3 px-3 mb-3 text-sm bg-white"
              value={memberPhone}
              onChange={(e) => setMemberPhone(e.target.value)}>
              {group.members.map((m) => (
                <option key={m.phone} value={m.phone}>
                  {m.name} ({m.phone})
                </option>
              ))}
            </select>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Month
            </label>
            <KPInput
              type="month"
              className="mb-3"
              value={periodMonth}
              onChange={(e) => setPeriodMonth(e.target.value)}
            />
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Amount (R)
            </label>
            <KPInput
              type="number"
              className="mb-3"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {existing ? (
              <p className="text-xs text-amber-700 mb-3">
                Updating existing {formatPeriod(periodMonth)} contribution for
                this member.
              </p>
            ) : null}
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
              disabled={busy}
              onClick={() => void submit()}
              className="bg-purple-600">
              {busy ? 'Saving…' : existing ? 'Update contribution' : 'Save contribution'}
            </KPButton>
          </>
        )}
      </div>
    </div>
  );
}

function CreateGroupModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (payload: {
    name: string;
    members: Member[];
    targetAmount: number;
    currentAmount: number;
    frequency: 'weekly' | 'monthly';
    nextPayoutDate: string;
  }) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currentAmount, setCurrentAmount] = useState('0');
  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('monthly');
  const [nextPayout, setNextPayout] = useState('');
  const [draftMembers, setDraftMembers] = useState<Member[]>([]);
  const [draftMemberName, setDraftMemberName] = useState('');
  const [draftMemberPhone, setDraftMemberPhone] = useState('');

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

  const submit = async () => {
    const t = Number(targetAmount);
    const c = Number(currentAmount);
    if (!name.trim() || !(t > 0) || !nextPayout.trim()) {
      toast.error('Fill name, target, and payout date');
      return;
    }
    setBusy(true);
    try {
      await onCreate({
        name: name.trim(),
        members: draftMembers,
        targetAmount: t,
        currentAmount: Number.isFinite(c) ? c : 0,
        frequency,
        nextPayoutDate: nextPayout,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/40 flex items-end justify-center sm:items-center p-0 sm:p-4">
      <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[85vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-bold text-lg">New stokvel</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="w-6 h-6 text-slate-400" />
          </button>
        </div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Group name
        </label>
        <KPInput className="mb-3" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Target (R)
        </label>
        <KPInput
          type="number"
          className="mb-3"
          value={targetAmount}
          onChange={(e) => setTargetAmount(e.target.value)}
        />
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Already saved (R)
        </label>
        <KPInput
          type="number"
          className="mb-3"
          value={currentAmount}
          onChange={(e) => setCurrentAmount(e.target.value)}
        />
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Frequency
        </label>
        <select
          className="w-full border rounded-xl py-3 px-3 mb-3 text-sm bg-white"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as 'weekly' | 'monthly')}>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <label className="block text-sm font-medium text-slate-700 mb-1">
          Next payout date
        </label>
        <KPInput
          type="date"
          className="mb-4"
          value={nextPayout}
          onChange={(e) => setNextPayout(e.target.value)}
        />
        <h4 className="text-xs font-bold text-slate-500 uppercase mb-2">
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
        {draftMembers.length > 0 ? (
          <ul className="text-sm space-y-1 mb-4">
            {draftMembers.map((m, i) => (
              <li
                key={`${m.phone}-${i}`}
                className="flex justify-between text-slate-600">
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
            ))}
          </ul>
        ) : null}
        <KPButton
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="bg-purple-600">
          {busy ? 'Saving…' : 'Create group'}
        </KPButton>
      </div>
    </div>
  );
}

function RecordLoanModal({
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
}) {
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
          <h3 className="font-bold text-lg">Record loan</h3>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="w-6 h-6 text-slate-400" />
          </button>
        </div>
        {group.members.length === 0 ? (
          <p className="text-sm text-amber-700">Add members first.</p>
        ) : (
          <>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Lender (member)
            </label>
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
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Borrower name
            </label>
            <KPInput
              className="mb-3"
              value={borrowerName}
              onChange={(e) => setBorrowerName(e.target.value)}
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
            />
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Interest per R100
            </label>
            <div className="flex flex-wrap gap-2 mb-3">
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
            {preview ? (
              <div className="mb-3 rounded-xl bg-purple-50 text-purple-900 text-sm p-3">
                Interest R{preview.interestAmount.toLocaleString()} · Due R
                {preview.totalDue.toLocaleString()}
              </div>
            ) : null}
            <label className="flex items-center gap-2 text-sm text-slate-700 mb-3">
              <input
                type="checkbox"
                checked={fromPool}
                onChange={(e) => setFromPool(e.target.checked)}
              />
              Taken from stokvel pool
            </label>
            <KPInput
              className="mb-4"
              placeholder="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
            <KPButton
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="bg-purple-600">
              {busy ? 'Saving…' : 'Save loan'}
            </KPButton>
          </>
        )}
      </div>
    </div>
  );
}
