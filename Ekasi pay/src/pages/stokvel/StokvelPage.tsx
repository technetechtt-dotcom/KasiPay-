import { useState } from 'react';
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
} from 'lucide-react';
import type { StokvelGroup } from '../../types';
import { toast } from 'sonner';

type Member = { name: string; phone: string; contributed: number };

export const StokvelPage = ({
  groups,
  onCreateGroup,
  onUpdateMembers,
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
  /** Replace the members list on an existing stokvel. */
  onUpdateMembers?: (id: string, members: Member[]) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [targetAmount, setTargetAmount] = useState('');
  const [currentAmount, setCurrentAmount] = useState('0');
  const [frequency, setFrequency] = useState<'weekly' | 'monthly'>('monthly');
  const [nextPayout, setNextPayout] = useState('');
  /** Draft members captured in the create flow. */
  const [draftMembers, setDraftMembers] = useState<Member[]>([]);
  const [draftMemberName, setDraftMemberName] = useState('');
  const [draftMemberPhone, setDraftMemberPhone] = useState('');
  /** Manage-members modal state. */
  const [manageGroup, setManageGroup] = useState<StokvelGroup | null>(null);

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
          Save together with other spaza owners for bulk buying and emergencies.
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
                  <div className="space-y-3">
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
              <ul className="space-y-1 text-xs mb-3">
                {draftMembers.map((m, i) =>
                  <li
                    key={`${m.phone}-${i}`}
                    className="flex justify-between items-center bg-slate-50 rounded-md px-2 py-1">
                    <span>
                      <strong className="text-slate-700">{m.name}</strong>{' '}
                      <span className="text-slate-400">· {m.phone}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setDraftMembers((prev) =>
                          prev.filter((_, idx) => idx !== i),
                        )
                      }
                      aria-label="Remove member"
                      className="text-red-500">
                      <Trash2 className="w-3.5 h-3.5" />
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
    </PageTransition>
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
          <input
            placeholder="Contributed (R)"
            value={contributed}
            onChange={(e) => setContributed(e.target.value)}
            className="col-span-2 bg-slate-50 rounded-lg px-3 py-2 text-sm border border-slate-200"
            type="number"
            inputMode="decimal"
          />
        </div>
        <button
          type="button"
          onClick={add}
          className="w-full mb-3 py-2 rounded-lg bg-purple-100 text-purple-700 text-sm font-medium">
          + Add member
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-600 font-medium text-sm">
            Cancel
          </button>
          <KPButton
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="flex-1 bg-purple-600">
            {busy ? 'Saving…' : 'Save members'}
          </KPButton>
        </div>
      </div>
    </div>
  );
};
