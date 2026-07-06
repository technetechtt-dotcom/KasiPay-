import { useEffect, useState } from 'react';
import {
  KPCard,
  KPInput,
  PageTransition,
  KPButton,
  KPBadge } from
'../../components/shared/UIComponents';
import {
  ArrowLeft,
  Shield,
  Flame,
  Lock,
  AlertTriangle,
  CheckCircle2,
  X } from
'lucide-react';
import type { InsurancePolicy } from '../../types';
import { toast } from 'sonner';
import { apiListInsuranceClaims, type InsuranceClaim } from '../../services/api';
export const MicroInsurancePage = ({
  policies,
  onSubscribePlan,
  onFileClaim,
  navigate,
}: {
  policies: InsurancePolicy[];
  onSubscribePlan: (plan: 'basic' | 'comprehensive') => Promise<boolean>;
  onFileClaim?: (
    policyId: string,
    body: {
      type: 'stock' | 'fire' | 'theft';
      description: string;
      claimedAmount: number;
    },
  ) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [busyPlan, setBusyPlan] = useState<null | 'basic' | 'comprehensive'>(null);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimType, setClaimType] = useState<'stock' | 'fire' | 'theft'>('stock');
  const [claimDescription, setClaimDescription] = useState('');
  const [claimAmount, setClaimAmount] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claims, setClaims] = useState<InsuranceClaim[]>([]);
  const activePolicy = policies.find((p) => p.status === 'active');
  const activePolicyId = activePolicy?.id;

  useEffect(() => {
    if (!activePolicyId) {
      setClaims([]);
      return;
    }
    void (async () => {
      try {
        const { claims: next } = await apiListInsuranceClaims(activePolicyId);
        setClaims(next);
      } catch {
        setClaims([]);
      }
    })();
  }, [activePolicyId]);

  const submitClaim = async () => {
    if (!activePolicy || !onFileClaim) return;
    const amt = Number(claimAmount);
    if (!claimDescription.trim() || claimDescription.trim().length < 10) {
      toast.error('Describe what happened (at least 10 characters).');
      return;
    }
    if (!(amt > 0)) {
      toast.error('Enter the claim amount in rands.');
      return;
    }
    setClaimBusy(true);
    try {
      const ok = await onFileClaim(activePolicy.id, {
        type: claimType,
        description: claimDescription.trim(),
        claimedAmount: amt,
      });
      if (ok) {
        toast.success('Claim submitted — we will be in touch.');
        setClaimOpen(false);
        setClaimDescription('');
        setClaimAmount('');
        try {
          const { claims: next } = await apiListInsuranceClaims(activePolicy.id);
          setClaims(next);
        } catch {
          /* ignore refresh errors */
        }
      }
    } finally {
      setClaimBusy(false);
    }
  };

  const buy = async (plan: 'basic' | 'comprehensive') => {
    setBusyPlan(plan);
    try {
      const ok = await onSubscribePlan(plan);
      if (ok) toast.success('Policy requested');
      else toast.error('Could not create policy');
    } finally {
      setBusyPlan(null);
    }
  };
  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
              
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">
              Micro-Insurance
            </h2>
          </div>
          <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center">
            <Shield className="w-5 h-5" />
          </div>
        </div>
        <p className="text-sm text-slate-500">
          Protect your spaza shop stock from fire, theft, and spoilage.
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8">
        {activePolicy ?
        <div className="space-y-6">
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">
              Your Active Coverage
            </h3>

            <KPCard className="overflow-hidden border-2 border-emerald-500">
              <div className="bg-emerald-500 p-5 text-white">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-bold text-lg">
                      {activePolicy.provider}
                    </h3>
                    <p className="text-emerald-100 text-sm capitalize">
                      {activePolicy.type} Cover
                    </p>
                  </div>
                  <KPBadge
                  variant="success"
                  className="bg-white text-emerald-600 border-none">
                  
                    Active
                  </KPBadge>
                </div>

                <p className="text-emerald-100 text-xs uppercase tracking-wider mb-1">
                  Coverage Amount
                </p>
                <div className="text-3xl font-bold">
                  R{activePolicy.coverageAmount.toLocaleString()}
                </div>
              </div>

              <div className="p-5 bg-white">
                <div className="flex justify-between items-center mb-4 pb-4 border-b border-slate-100">
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">
                      Monthly Premium
                    </p>
                    <p className="font-bold text-slate-900 text-lg">
                      R{activePolicy.monthlyPremium}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">
                      Next Payment
                    </p>
                    <p className="font-medium text-slate-900">
                      {new Date(
                      activePolicy.nextPaymentDate
                    ).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    <span>Fire & Lightning damage</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    <span>Theft (forced entry)</span>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                    <span>Spoilage (power outages &gt; 24h)</span>
                  </div>
                </div>

                <KPButton
                variant="outline"
                className="w-full mt-6 text-red-600 border-red-200 hover:bg-red-50"
                onClick={() => setClaimOpen(true)}
                disabled={!onFileClaim}>
                
                  File a Claim
                </KPButton>
              </div>
            </KPCard>

            <KPCard className="p-5">
              <h4 className="font-bold text-slate-900 mb-3">Claim History</h4>
              {claims.length === 0 ? (
                <p className="text-sm text-slate-500">No claims submitted yet.</p>
              ) : (
                <div className="space-y-3">
                  {claims.map((claim) => (
                    <div
                      key={claim.id}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-3"
                    >
                      <div className="flex justify-between items-center">
                        <p className="text-sm font-semibold text-slate-900 capitalize">
                          {claim.type} claim
                        </p>
                        <KPBadge
                          variant={
                            claim.status === 'paid' ? 'success' :
                            claim.status === 'approved' ? 'info' :
                            claim.status === 'rejected' ? 'danger' :
                            'warning'
                          }>
                          {claim.status}
                        </KPBadge>
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        {new Date(claim.createdAt).toLocaleDateString('en-ZA')} · R
                        {claim.claimedAmount.toFixed(2)}
                      </p>
                      <p className="text-xs text-slate-600 mt-2">{claim.description}</p>
                      {claim.adminNote && (
                        <p className="text-xs text-slate-500 mt-2 italic">
                          Review note: {claim.adminNote}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </KPCard>
          </div> :

        <div className="space-y-6">
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3 mb-6">
              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
              <div>
                <h4 className="font-bold text-amber-800 mb-1">
                  Your stock is unprotected
                </h4>
                <p className="text-sm text-amber-700">
                  Get affordable cover starting from just R50/month to protect
                  your business.
                </p>
              </div>
            </div>

            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider">
              Available Plans
            </h3>

            <KPCard className="p-5">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="font-bold text-lg text-slate-900">
                    Basic Stock Cover
                  </h3>
                  <p className="text-sm text-slate-500">Essential protection</p>
                </div>
                <div className="text-right">
                  <p className="font-bold text-xl text-emerald-600">R50</p>
                  <p className="text-[10px] text-slate-400 uppercase">
                    Per Month
                  </p>
                </div>
              </div>

              <div className="bg-slate-50 rounded-xl p-3 mb-4">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">
                  Covers up to
                </p>
                <p className="font-bold text-slate-900">R10,000</p>
              </div>

              <div className="space-y-2 mb-6">
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Flame className="w-4 h-4 text-slate-400" />
                  <span>Fire damage</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Lock className="w-4 h-4 text-slate-400" />
                  <span>Theft (forced entry)</span>
                </div>
              </div>

              <KPButton
                type="button"
                className="w-full bg-emerald-600 hover:bg-emerald-700"
                disabled={busyPlan !== null}
                onClick={() => void buy('basic')}>
                {busyPlan === 'basic' ? 'Please wait…' : 'Get Covered Now'}
              </KPButton>
            </KPCard>

            <KPCard className="p-5 border-2 border-indigo-100 relative overflow-hidden">
              <div className="absolute top-3 right-[-30px] bg-indigo-500 text-white text-[10px] font-bold py-1 px-8 transform rotate-45">
                POPULAR
              </div>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="font-bold text-lg text-slate-900">
                    Comprehensive
                  </h3>
                  <p className="text-sm text-slate-500">Full peace of mind</p>
                </div>
                <div className="text-right mr-4">
                  <p className="font-bold text-xl text-indigo-600">R85</p>
                  <p className="text-[10px] text-slate-400 uppercase">
                    Per Month
                  </p>
                </div>
              </div>

              <div className="bg-indigo-50 rounded-xl p-3 mb-4">
                <p className="text-xs text-indigo-400 uppercase tracking-wider mb-1">
                  Covers up to
                </p>
                <p className="font-bold text-indigo-900">R20,000</p>
              </div>

              <div className="space-y-2 mb-6">
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Flame className="w-4 h-4 text-indigo-400" />
                  <span>Fire & Lightning</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Lock className="w-4 h-4 text-indigo-400" />
                  <span>Theft & Robbery</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <AlertTriangle className="w-4 h-4 text-indigo-400" />
                  <span>Spoilage (Load shedding)</span>
                </div>
              </div>

              <KPButton
                type="button"
                className="w-full bg-indigo-600 hover:bg-indigo-700"
                disabled={busyPlan !== null}
                onClick={() => void buy('comprehensive')}>
                {busyPlan === 'comprehensive' ? 'Please wait…' : 'Get Covered Now'}
              </KPButton>
            </KPCard>
          </div>
        }
      </div>

      {claimOpen && activePolicy ?
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg">File a claim</h3>
              <button
                type="button"
                onClick={() => setClaimOpen(false)}
                aria-label="Close">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <p className="text-xs text-slate-500 mb-3">
              Coverage up to{' '}
              <strong className="text-slate-700">
                R{activePolicy.coverageAmount.toFixed(0)}
              </strong>{' '}
              · Provider {activePolicy.provider}
            </p>
            <label
              htmlFor="claim-type"
              className="block text-xs font-medium text-slate-600 mb-1">
              Type
            </label>
            <select
              id="claim-type"
              value={claimType}
              onChange={(e) =>
                setClaimType(e.target.value as 'stock' | 'fire' | 'theft')
              }
              className="w-full mb-3 bg-slate-50 rounded-lg px-3 py-2 text-sm border border-slate-200">
              <option value="stock">Stock spoilage</option>
              <option value="fire">Fire / lightning</option>
              <option value="theft">Theft / robbery</option>
            </select>
            <KPInput
              label="Claimed amount (R)"
              type="number"
              value={claimAmount}
              onChange={(e) => setClaimAmount(e.target.value)}
            />
            <label
              htmlFor="claim-desc"
              className="block text-xs font-medium text-slate-600 mb-1">
              What happened?
            </label>
            <textarea
              id="claim-desc"
              rows={4}
              value={claimDescription}
              onChange={(e) => setClaimDescription(e.target.value)}
              className="w-full bg-slate-50 rounded-lg px-3 py-2 text-sm border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/30 mb-4"
              placeholder="Date, time, what was lost, any witnesses…"
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-600 font-medium text-sm"
                onClick={() => setClaimOpen(false)}>
                Cancel
              </button>
              <KPButton
                type="button"
                className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                disabled={claimBusy}
                onClick={() => void submitClaim()}>
                {claimBusy ? 'Submitting…' : 'Submit claim'}
              </KPButton>
            </div>
          </div>
        </div>
      : null}
    </PageTransition>);

};