import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import {
  KPButton,
  KPCard,
  KPAmount,
  PageTransition,
  KPBadge,
  KPAvatar } from
'../../components/shared/UIComponents';
import {
  Users,
  BookOpen,
  ShieldAlert,
  Activity,
  Clock3,
  ArrowRight,
  ArrowLeft,
  Search,
  CheckCircle2,
  Ban,
  FileText,
  XCircle } from
'lucide-react';
import {
  apiAdminFetchMerchantDocument,
  apiAdminGetMerchant,
  apiAdminListComplianceFlags,
  apiAdminListInsuranceClaims,
  apiAdminListLoans,
  apiAdminListMerchants,
  apiAdminPatchUser,
  apiAdminReviewMerchant,
  apiAdminRunReconciliation,
  apiAdminUpdateComplianceFlag,
  apiAdminUpdateInsuranceClaim,
  apiDisburseLoan,
  type AdminInsuranceClaim,
  type AdminMerchantRow,
  type ReconciliationReport,
} from '../../services/api';
import type {
  User,
  LedgerEntry,
  ComplianceFlag,
  Loan,
  MerchantApprovalStatus,
  MerchantDocType,
  MerchantDocumentStatus,
} from '../../types';
type AuditEvent = {
  id: string;
  type: string;
  message: string;
  actorUserId?: string;
  createdAt: string;
};
const csvEscape = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** Backend uses `open`; older rows may still be `pending`. */
const isUnresolvedComplianceFlag = (flag: ComplianceFlag) =>
  flag.status === 'open' || flag.status === 'pending';

/** Split text into segments for optional search highlight (preserves original casing). */
const textPartsForHighlight = (text: string, query: string) => {
  const q = query.trim();
  if (!q) return [{ text, match: false as const }];
  const lower = text.toLowerCase();
  const qLower = q.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let start = 0;
  let idx = lower.indexOf(qLower, start);
  while (idx !== -1) {
    if (idx > start) parts.push({ text: text.slice(start, idx), match: false });
    parts.push({
      text: text.slice(idx, idx + q.length),
      match: true
    });
    start = idx + q.length;
    idx = lower.indexOf(qLower, start);
  }
  if (start < text.length) parts.push({ text: text.slice(start), match: false });
  return parts.length > 0 ? parts : [{ text, match: false }];
};
const HighlightedAuditText = ({
  text,
  query,
  idPrefix,
  wrapClassName
}: {
  text: string;
  query: string;
  idPrefix: string;
  wrapClassName?: string;
}) =>
<span className={wrapClassName}>
    {textPartsForHighlight(text, query).map((part, i) =>
  part.match ?
  <mark
    key={`${idPrefix}-h-${i}`}
    className="bg-amber-200/90 text-slate-900 rounded px-0.5 font-inherit">
      
      {part.text}
    </mark> :

  <Fragment key={`${idPrefix}-t-${i}`}>{part.text}</Fragment>
  )}
  </span>;
const AUDIT_FILTER_PREFS_KEY = 'kasi_admin_audit_filter_prefs_v1';
type AuditFilterPrefs = {
  type: string;
  actor: string;
  messageQuery: string;
  window: '1h' | '24h' | '7d' | 'all';
  sort: 'newest' | 'oldest';
  exportScope: 'visible' | 'allMatching';
};
const getStoredAuditFilterPrefs = (): AuditFilterPrefs | null => {
  try {
    const raw = window.localStorage.getItem(AUDIT_FILTER_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuditFilterPrefs>;
    if (!parsed) return null;
    return {
      type: typeof parsed.type === 'string' ? parsed.type : 'all',
      actor: typeof parsed.actor === 'string' ? parsed.actor : '',
      messageQuery:
      typeof parsed.messageQuery === 'string' ? parsed.messageQuery : '',
      window:
      parsed.window === '1h' ||
      parsed.window === '24h' ||
      parsed.window === '7d' ||
      parsed.window === 'all' ?
      parsed.window :
      '24h',
      sort: parsed.sort === 'oldest' ? 'oldest' : 'newest',
      exportScope:
      parsed.exportScope === 'allMatching' ? 'allMatching' : 'visible'
    };
  } catch {
    return null;
  }
};
export const AdminDashboard = ({
  users,
  ledger,
  auditEvents,
  navigate,

}: {
  users: User[];
  ledger: LedgerEntry[];
  auditEvents: AuditEvent[];
  navigate: (p: string) => void;
}) => {
  const [adminFlags, setAdminFlags] = useState<ComplianceFlag[]>([]);
  useEffect(() => {
    let active = true;
    apiAdminListComplianceFlags()
      .then((r) => {
        if (active) setAdminFlags(r.flags);
      })
      .catch(() => {
        /* dashboard still works without compliance count */
      });
    return () => {
      active = false;
    };
  }, []);
  const storedPrefs = getStoredAuditFilterPrefs();
  const [auditTypeFilter, setAuditTypeFilter] = useState<'all' | string>(
    storedPrefs?.type ?? 'all'
  );
  const [auditActorFilter, setAuditActorFilter] = useState(storedPrefs?.actor ?? '');
  const [auditMessageFilter, setAuditMessageFilter] = useState(
    storedPrefs?.messageQuery ?? ''
  );
  const [auditWindow, setAuditWindow] = useState<'1h' | '24h' | '7d' | 'all'>(
    storedPrefs?.window ?? '24h'
  );
  const [auditSortOrder, setAuditSortOrder] = useState<'newest' | 'oldest'>(
    storedPrefs?.sort ?? 'newest'
  );
  const [auditExportScope, setAuditExportScope] = useState<'visible' | 'allMatching'>(
    storedPrefs?.exportScope ?? 'visible'
  );
  const [visibleAuditCount, setVisibleAuditCount] = useState(20);
  const skipPersistAuditPrefsRef = useRef(false);
  const resetPrefsFeedbackTimeoutRef = useRef<number | null>(null);
  const [resetPrefsFeedback, setResetPrefsFeedback] = useState<'idle' | 'ok' | 'error'>(
    'idle'
  );
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const activeFlags = adminFlags.filter(isUnresolvedComplianceFlag).length;
  const totalVolume = ledger.
  filter((l) => l.entryType === 'credit').
  reduce((sum, l) => sum + l.amount, 0);
  const auditTypes = Array.from(new Set(auditEvents.map((event) => event.type)));
  const getWindowStart = () => {
    const now = Date.now();
    if (auditWindow === '1h') return now - 60 * 60 * 1000;
    if (auditWindow === '24h') return now - 24 * 60 * 60 * 1000;
    if (auditWindow === '7d') return now - 7 * 24 * 60 * 60 * 1000;
    return 0;
  };
  const filteredEvents = auditEvents.
    filter((event) => {
      if (auditTypeFilter !== 'all' && event.type !== auditTypeFilter) return false;
      if (
        auditActorFilter.trim().length > 0 &&
        !(event.actorUserId ?? '').toLowerCase().includes(auditActorFilter.toLowerCase())
      ) {
        return false;
      }
      const messageQuery = auditMessageFilter.trim().toLowerCase();
      if (messageQuery.length > 0 &&
      !event.message.toLowerCase().includes(messageQuery)) {
        return false;
      }
      const windowStart = getWindowStart();
      if (windowStart > 0 && new Date(event.createdAt).getTime() < windowStart)
        return false;
      return true;
    });
  const sortedEvents = [...filteredEvents].sort((a, b) => {
    const aTs = new Date(a.createdAt).getTime();
    const bTs = new Date(b.createdAt).getTime();
    return auditSortOrder === 'newest' ? bTs - aTs : aTs - bTs;
  });
  const recentEvents = sortedEvents.
    slice(0, visibleAuditCount);
  const exportEvents =
  auditExportScope === 'allMatching' ? sortedEvents : recentEvents;
  const hasActiveAuditFilters =
  auditTypeFilter !== 'all' ||
  auditActorFilter.trim().length > 0 ||
  auditMessageFilter.trim().length > 0 ||
  auditWindow !== '24h' ||
  auditSortOrder !== 'newest' ||
  auditExportScope !== 'visible';
  const activeAuditChips = [
  auditTypeFilter !== 'all' ?
  {
    key: 'type',
    label: `Type: ${auditTypeFilter}`,
    clear: () => setAuditTypeFilter('all')
  } :
  null,
  auditActorFilter.trim().length > 0 ?
  {
    key: 'actor',
    label: `Actor: ${auditActorFilter.trim()}`,
    clear: () => setAuditActorFilter('')
  } :
  null,
  auditMessageFilter.trim().length > 0 ?
  {
    key: 'message',
    label: `Message: ${auditMessageFilter.trim().slice(0, 28)}${auditMessageFilter.trim().length > 28 ? '…' : ''}`,
    clear: () => setAuditMessageFilter('')
  } :
  null,
  auditWindow !== '24h' ?
  {
    key: 'window',
    label: `Window: ${auditWindow === 'all' ? 'All Time' : auditWindow}`,
    clear: () => setAuditWindow('24h')
  } :
  null,
  auditSortOrder !== 'newest' ?
  {
    key: 'sort',
    label: `Sort: ${auditSortOrder === 'oldest' ? 'Oldest first' : 'Newest first'}`,
    clear: () => setAuditSortOrder('newest')
  } :
  null,
  auditExportScope !== 'visible' ?
  {
    key: 'scope',
    label: 'Export: All matching',
    clear: () => setAuditExportScope('visible')
  } :
  null].
  filter((chip): chip is {
    key: string;
    label: string;
    clear: () => void;
  } => chip !== null);
  useEffect(() => {
    setVisibleAuditCount(20);
  }, [
    auditTypeFilter,
    auditActorFilter,
    auditMessageFilter,
    auditWindow,
    auditSortOrder
  ]);
  useEffect(() => {
    return () => {
      if (resetPrefsFeedbackTimeoutRef.current != null) {
        window.clearTimeout(resetPrefsFeedbackTimeoutRef.current);
      }
    };
  }, []);
  useEffect(() => {
    if (skipPersistAuditPrefsRef.current) {
      skipPersistAuditPrefsRef.current = false;
      return;
    }
    const prefs: AuditFilterPrefs = {
      type: auditTypeFilter,
      actor: auditActorFilter,
      messageQuery: auditMessageFilter,
      window: auditWindow,
      sort: auditSortOrder,
      exportScope: auditExportScope
    };
    window.localStorage.setItem(AUDIT_FILTER_PREFS_KEY, JSON.stringify(prefs));
  }, [
    auditTypeFilter,
    auditActorFilter,
    auditMessageFilter,
    auditWindow,
    auditSortOrder,
    auditExportScope
  ]);
  const clearAuditFilters = () => {
    setAuditTypeFilter('all');
    setAuditActorFilter('');
    setAuditMessageFilter('');
    setAuditWindow('24h');
    setAuditSortOrder('newest');
    setAuditExportScope('visible');
    setVisibleAuditCount(20);
  };
  const resetSavedAuditPreferences = () => {
    skipPersistAuditPrefsRef.current = true;
    let storageCleared = false;
    try {
      window.localStorage.removeItem(AUDIT_FILTER_PREFS_KEY);
      storageCleared = true;
    } catch {
      /* quota / privacy mode */
    }
    clearAuditFilters();
    window.setTimeout(() => {
      skipPersistAuditPrefsRef.current = false;
    }, 0);
    if (resetPrefsFeedbackTimeoutRef.current != null) {
      window.clearTimeout(resetPrefsFeedbackTimeoutRef.current);
    }
    setResetPrefsFeedback(storageCleared ? 'ok' : 'error');
    resetPrefsFeedbackTimeoutRef.current = window.setTimeout(() => {
      setResetPrefsFeedback('idle');
      resetPrefsFeedbackTimeoutRef.current = null;
    }, 1800);
  };
  const exportAuditCsv = () => {
    if (exportEvents.length === 0) return;
    const header = ['id', 'createdAt', 'type', 'actorUserId', 'message'];
    const rows = exportEvents.map((event) =>
    [
    event.id,
    event.createdAt,
    event.type,
    event.actorUserId ?? '',
    event.message].
    map((cell) => csvEscape(cell)).
    join(',')
    );
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-events-${new Date().toISOString()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  };
  const copyAuditJson = async () => {
    if (exportEvents.length === 0) return;
    const payload = JSON.stringify(exportEvents, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      setCopyStatus('copied');
    } catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = payload;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        setCopyStatus(copied ? 'copied' : 'error');
      } catch {
        setCopyStatus('error');
      }
    }
    window.setTimeout(() => setCopyStatus('idle'), 1800);
  };
  return (
    <PageTransition className="px-6 pt-12 bg-slate-50 min-h-full">
      <div className="mb-8 flex items-center">
        <button
          onClick={() => navigate('more')}
          className="p-2 -ml-2 mr-2 text-slate-500 hover:text-slate-900 transition-colors">
          
          <ArrowLeft className="w-6 h-6" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">System Overview</h1>
          <p className="text-slate-500 text-sm">KasiPay Network Admin</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-8">
        <KPCard className="p-4">
          <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center mb-3">
            <Users className="w-4 h-4" />
          </div>
          <p className="text-slate-500 text-xs mb-1">Total Users</p>
          <p className="text-xl font-bold text-slate-900">{users.length}</p>
        </KPCard>
        <KPCard className="p-4">
          <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-3">
            <Activity className="w-4 h-4" />
          </div>
          <p className="text-slate-500 text-xs mb-1">Total Volume</p>
          <p className="text-xl font-bold text-slate-900">
            <KPAmount amount={totalVolume} />
          </p>
        </KPCard>
        <KPCard className="p-4">
          <div className="w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-3">
            <ShieldAlert className="w-4 h-4" />
          </div>
          <p className="text-slate-500 text-xs mb-1">Active Alerts</p>
          <p className="text-xl font-bold text-slate-900">{activeFlags}</p>
        </KPCard>
        <KPCard className="p-4">
          <div className="w-8 h-8 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center mb-3">
            <BookOpen className="w-4 h-4" />
          </div>
          <p className="text-slate-500 text-xs mb-1">Ledger Entries</p>
          <p className="text-xl font-bold text-slate-900">{ledger.length}</p>
        </KPCard>
      </div>

      <h3 className="text-lg font-bold text-slate-900 mb-4">Quick Links</h3>
      <div className="space-y-3">
        {[
        {
          icon: Users,
          label: 'User Management',
          desc: 'View and manage accounts',
          path: 'users'
        },
        {
          icon: BookOpen,
          label: 'Ledger & Reconciliation',
          desc: 'Double-entry records',
          path: 'ledger'
        },
        {
          icon: ShieldAlert,
          label: 'Compliance & AML',
          desc: 'Review flagged transactions',
          path: 'compliance'
        },
        {
          icon: FileText,
          label: 'Insurance Claims',
          desc: 'Review and approve payouts',
          path: 'claims'
        },
        {
          icon: CheckCircle2,
          label: 'Merchant Approvals',
          desc: 'Review CIPC, B-BBEE and bank docs',
          path: 'merchant-approvals'
        }].
        map((link, i) =>
        <KPCard
          key={i}
          onClick={() => navigate(link.path)}
          className="p-4 flex items-center justify-between group">
          
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-600">
                <link.icon className="w-5 h-5" />
              </div>
              <div>
                <p className="font-medium text-slate-900">{link.label}</p>
                <p className="text-xs text-slate-500">{link.desc}</p>
              </div>
            </div>
            <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-emerald-600 transition-colors" />
          </KPCard>
        )}
      </div>

      <h3 className="text-lg font-bold text-slate-900 mt-8 mb-4">
        Audit Trail
      </h3>

      <KPCard className="p-0 overflow-hidden mb-8">
        <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-bold text-slate-700">Recent Audit Events</p>
            <div className="flex items-center gap-2">
              <button
                onClick={copyAuditJson}
                disabled={exportEvents.length === 0}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-slate-700 text-white disabled:bg-slate-300 disabled:text-slate-500">
                
                Copy JSON
              </button>
              <button
                onClick={exportAuditCsv}
                disabled={exportEvents.length === 0}
                className="px-3 py-1 rounded-lg text-xs font-medium bg-emerald-600 text-white disabled:bg-slate-300 disabled:text-slate-500">
                
                Export CSV
              </button>
            </div>
          </div>
          {copyStatus !== 'idle' &&
          <p
            className={`mt-2 text-[11px] font-medium ${copyStatus === 'copied' ? 'text-emerald-600' : 'text-red-600'}`}>
            
              {copyStatus === 'copied' ?
            'Copied audit JSON to clipboard.' :
            'Copy failed. Please try again.'}
            </p>
          }
        </div>
        <div className="px-4 py-3 border-b border-slate-100 bg-white space-y-3">
          <div className="flex gap-2 overflow-x-auto scrollbar-hide">
            {(['24h', '1h', '7d', 'all'] as const).map((window) =>
            <button
              key={window}
              onClick={() => setAuditWindow(window)}
              className={`px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap ${auditWindow === window ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
              
                {window === 'all' ? 'All Time' : window}
              </button>
            )}
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-[11px] text-slate-500">
              Showing {recentEvents.length} of {filteredEvents.length} matching
              events ({auditEvents.length} total)
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={resetSavedAuditPreferences}
                title="Remove saved audit filters from this browser and reset defaults"
                className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
                
                Reset saved prefs
              </button>
              <button
                type="button"
                onClick={clearAuditFilters}
                disabled={!hasActiveAuditFilters}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:text-slate-400 disabled:bg-slate-50">
                
                Clear filters
              </button>
            </div>
          </div>
          {resetPrefsFeedback !== 'idle' &&
          <p
            className={`text-[11px] font-medium ${resetPrefsFeedback === 'ok' ? 'text-emerald-600' : 'text-red-600'}`}>
            
              {resetPrefsFeedback === 'ok' ?
            'Saved audit settings cleared for this browser.' :
            'Could not clear browser storage. Filters were still reset.'}
            </p>
          }
          {activeAuditChips.length > 0 &&
          <div className="flex flex-wrap gap-2">
              {activeAuditChips.map((chip) =>
              <button
                key={chip.key}
                onClick={chip.clear}
                className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-100 hover:bg-emerald-100">
                  
                  {chip.label} x
                </button>
              )}
            </div>
          }
          <select
            value={auditExportScope}
            onChange={(e) =>
            setAuditExportScope(e.target.value as 'visible' | 'allMatching')
            }
            className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-slate-400/30">
            
            <option value="visible">
              Export scope: Visible rows ({recentEvents.length})
            </option>
            <option value="allMatching">
              Export scope: All matching rows ({filteredEvents.length})
            </option>
          </select>
          <input
            type="text"
            value={auditActorFilter}
            onChange={(e) => setAuditActorFilter(e.target.value)}
            placeholder="Filter by actor user id..."
            className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-slate-400/30" />
          
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              type="search"
              value={auditMessageFilter}
              onChange={(e) => setAuditMessageFilter(e.target.value)}
              placeholder="Search message text..."
              className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 pl-9 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-slate-400/30"
              autoComplete="off" />
          
          </div>
          <select
            value={auditSortOrder}
            onChange={(e) =>
            setAuditSortOrder(e.target.value as 'newest' | 'oldest')
            }
            className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-slate-400/30">
            
            <option value="newest">Sort: Newest first</option>
            <option value="oldest">Sort: Oldest first</option>
          </select>
          <select
            value={auditTypeFilter}
            onChange={(e) => setAuditTypeFilter(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 rounded-lg py-2 px-3 text-xs focus:outline-none focus:ring-2 focus:ring-slate-400/30">
            
            <option value="all">All event types</option>
            {auditTypes.map((type) =>
            <option key={type} value={type}>
                {type}
              </option>
            )}
          </select>
        </div>
        <div className="divide-y divide-slate-100">
          {recentEvents.length === 0 &&
          <div className="px-4 py-5 text-sm text-slate-500 text-center">
              No audit events yet.
            </div>
          }
          {recentEvents.map((event) =>
          <div key={event.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-mono text-slate-500 mb-1">
                    <HighlightedAuditText
                      text={event.type}
                      query={auditMessageFilter}
                      idPrefix={`${event.id}-type`}
                      wrapClassName="font-mono" />
                  
                  </p>
                  <p className="text-sm text-slate-800">
                    <HighlightedAuditText
                      text={event.message}
                      query={auditMessageFilter}
                      idPrefix={`${event.id}-msg`} />
                  
                  </p>
                </div>
                <div className="flex items-center gap-1 text-[10px] text-slate-400 whitespace-nowrap">
                  <Clock3 className="w-3 h-3" />
                  {new Date(event.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
                </div>
              </div>
            </div>
          )}
        </div>
        {filteredEvents.length > 20 &&
        <div className="px-4 py-3 border-t border-slate-100 bg-slate-50 flex items-center justify-between gap-2">
            <p className="text-[11px] text-slate-500">
              Loaded {recentEvents.length} of {filteredEvents.length}
            </p>
            <div className="flex items-center gap-2">
              {recentEvents.length > 20 &&
              <button
                onClick={() => setVisibleAuditCount(20)}
                className="px-3 py-1 rounded-md text-xs font-medium bg-slate-100 text-slate-600 hover:bg-slate-200">
                  
                  Show less
                </button>
              }
              {recentEvents.length < filteredEvents.length &&
              <button
                onClick={() =>
                setVisibleAuditCount((count) => Math.min(count + 20, filteredEvents.length))
                }
                className="px-3 py-1 rounded-md text-xs font-medium bg-slate-800 text-white">
                  
                  Load more
                </button>
              }
            </div>
          </div>
        }
      </KPCard>
    </PageTransition>);

};
export const LedgerView = ({
  ledger,
  navigate



}: {ledger: LedgerEntry[];navigate: (p: string) => void;}) => {
  return (
    <PageTransition className="px-4 pt-12 bg-slate-50 min-h-full pb-8">
      <div className="mb-6 px-2 flex items-center">
        <button
          onClick={() => navigate('admin')}
          className="p-2 -ml-2 mr-2 text-slate-500 hover:text-slate-900 transition-colors">
          
          <ArrowLeft className="w-6 h-6" />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Immutable Ledger
          </h1>
          <p className="text-slate-500 text-sm">
            Double-entry accounting records
          </p>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600 font-medium border-b border-slate-200">
              <tr>
                <th className="px-4 py-3">ID / Tx</th>
                <th className="px-4 py-3">Account</th>
                <th className="px-4 py-3 text-right">Debit</th>
                <th className="px-4 py-3 text-right">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ledger.map((entry) =>
              <tr key={entry.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <div className="font-mono text-xs text-slate-500">
                      {entry.id.substring(0, 6)}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {entry.transactionId.substring(0, 6)}
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {entry.accountId.substring(0, 8)}...
                  </td>
                  <td className="px-4 py-3 text-right text-red-600 font-medium">
                    {entry.entryType === 'debit' ?
                  formatZAR(entry.amount) :
                  '-'}
                  </td>
                  <td className="px-4 py-3 text-right text-emerald-600 font-medium">
                    {entry.entryType === 'credit' ?
                  formatZAR(entry.amount) :
                  '-'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <LoanDisbursementCard />

      <ReconciliationCheckCard />
    </PageTransition>);

};

/** Admin queue for loans awaiting disbursement. Lists pending applications and posts
 *  the escrow → user-wallet transfer via `apiDisburseLoan`. */
const LoanDisbursementCard = () => {
  const [loans, setLoans] = useState<Loan[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { loans: rows } = await apiAdminListLoans('pending');
      setLoans(rows);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load loans';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot mount
  }, []);

  const disburse = async (loan: Loan) => {
    setBusyId(loan.id);
    try {
      await apiDisburseLoan(loan.id);
      toast.success(`Disbursed R${loan.amount.toFixed(2)} — borrower ${loan.userId.slice(0, 6)}…`);
      setLoans((prev) => prev.filter((l) => l.id !== loan.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Disbursement failed';
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mt-8 px-2">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-bold text-slate-900">Loan disbursement queue</h3>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-xs font-medium text-emerald-700">
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {loans.length === 0 ?
        <KPCard className="p-5 text-sm text-slate-500 text-center">
          {loading ? 'Loading pending loans…' : 'No pending loan applications.'}
        </KPCard>
      :
        <div className="space-y-3">
          {loans.map((loan) => (
            <KPCard key={loan.id} className="p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-bold text-slate-900">
                  R{loan.amount.toFixed(2)}
                  <span className="ml-2 text-[11px] font-medium text-amber-700 uppercase tracking-wider">
                    {(loan.interestRate * 100).toFixed(1)}% APR
                  </span>
                </p>
                <p className="text-xs text-slate-500 font-mono truncate">
                  borrower {loan.userId.slice(0, 12)}…
                </p>
              </div>
              <KPButton
                type="button"
                fullWidth={false}
                className="!min-w-[120px]"
                disabled={busyId === loan.id}
                onClick={() => void disburse(loan)}>
                {busyId === loan.id ? 'Posting…' : 'Disburse'}
              </KPButton>
            </KPCard>
          ))}
        </div>
      }
    </div>
  );
};

/** Inline card that calls the backend reconciliation endpoint and renders the result. */
const ReconciliationCheckCard = () => {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const run = async () => {
    setBusy(true);
    setReport(null);
    try {
      const r = await apiAdminRunReconciliation();
      setReport(r);
      if (r.ok) {
        toast.success(`Reconciliation OK — ${r.walletsChecked} wallets balanced.`);
      } else {
        toast.error(`${r.discrepancies.length} wallet(s) out of balance.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Reconciliation failed';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-6 px-2">
      <KPButton
        variant="outline"
        className="w-full"
        onClick={run}
        disabled={busy}>
        {busy ? 'Running…' : 'Run Reconciliation Check'}
      </KPButton>
      {report && (
        <KPCard className="mt-4 p-4">
          <p className="text-sm font-bold text-slate-900 mb-2">
            {report.ok ? 'All balanced' : 'Discrepancies detected'}
          </p>
          <p className="text-xs text-slate-500 mb-3">
            Ran at {new Date(report.ranAt).toLocaleString()} ·{' '}
            {report.walletsChecked} wallet(s) checked
          </p>
          {report.discrepancies.length === 0 ?
            <p className="text-xs text-emerald-600">
              Every wallet's stored balance matches its ledger total.
            </p>
          :
            <ul className="space-y-2 text-xs">
              {report.discrepancies.slice(0, 25).map((d) =>
                <li
                  key={d.walletId}
                  className="p-2 rounded-lg bg-red-50 border border-red-100">
                  <div className="font-mono text-slate-700">
                    {d.walletId.slice(0, 8)}… ({d.kind})
                  </div>
                  <div className="text-slate-500">
                    wallet R{d.walletBalance.toFixed(2)} vs ledger R
                    {d.ledgerBalance.toFixed(2)} · Δ R{d.delta.toFixed(2)}
                  </div>
                </li>
              )}
              {report.discrepancies.length > 25 && (
                <li className="text-slate-500 italic">
                  +{report.discrepancies.length - 25} more — export the API
                  result for the full list.
                </li>
              )}
            </ul>
          }
        </KPCard>
      )}
    </div>
  );
};
export const UserManagement = ({
  users: initialUsers,
  currentUserId,
  navigate,
}: {
  users: User[];
  currentUserId?: string;
  navigate: (p: string) => void;
}) => {
  const [localUsers, setLocalUsers] = useState<User[]>(initialUsers);
  const [searchQuery, setSearchQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    setLocalUsers(initialUsers);
  }, [initialUsers]);

  const patchUser = async (
    userId: string,
    body: { role?: User['role']; suspended?: boolean },
  ) => {
    setBusyId(userId);
    try {
      const { user } = await apiAdminPatchUser(userId, body);
      const updated: User = {
        id: user.id,
        name: user.name,
        phone: user.phone,
        role: user.role as User['role'],
        kycStatus: user.kycStatus as User['kycStatus'],
        accountTier: user.accountTier as User['accountTier'],
        countryCode: user.countryCode ?? 'ZA',
        createdAt: user.createdAt,
        suspendedAt: user.suspendedAt ?? null,
      };
      setLocalUsers((prev) => prev.map((u) => (u.id === userId ? updated : u)));
      toast.success('User updated.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update user');
    } finally {
      setBusyId(null);
    }
  };

  const filteredUsers = localUsers.filter((u) => {
    const matchesSearch =
    u.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.phone.includes(searchQuery);
    const matchesRole = roleFilter === 'all' || u.role === roleFilter;
    return matchesSearch && matchesRole;
  });
  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center mb-6">
          <button
            onClick={() => navigate('admin')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">Users</h2>
        </div>

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Search name or phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-100 rounded-xl py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20" />
          
        </div>

        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {['all', 'customer', 'merchant', 'agent', 'admin'].map((role) =>
          <button
            key={role}
            onClick={() => setRoleFilter(role)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize whitespace-nowrap transition-colors ${roleFilter === role ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
            
              {role}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 space-y-3">
        {filteredUsers.map((user, i) =>
        <motion.div
          key={user.id}
          initial={{
            opacity: 0,
            y: 10
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          transition={{
            delay: i * 0.05
          }}>
          
            <KPCard className="p-4">
              <div className="flex items-center gap-4 mb-3">
                <KPAvatar name={user.name} size="md" />
                <div className="flex-1">
                  <p className="font-bold text-slate-900">{user.name}</p>
                  <p className="text-sm text-slate-500">{user.phone}</p>
                </div>
                <KPBadge
                variant={
                user.suspendedAt ?
                'danger' :
                user.role === 'admin' ?
                'danger' :
                user.role === 'merchant' ?
                'warning' :
                'info'
                }>
                
                  {user.suspendedAt ? 'suspended' : user.role}
                </KPBadge>
              </div>
              <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">KYC:</span>
                  <KPBadge
                  variant={
                  user.kycStatus === 'verified' ? 'success' : 'warning'
                  }
                  className="text-[10px] px-2">
                  
                    {user.kycStatus}
                  </KPBadge>
                </div>
                <span className="text-xs font-medium text-slate-700 bg-slate-100 px-2 py-1 rounded">
                  Tier: {user.accountTier}
                </span>
              </div>
              {user.id !== currentUserId && (
                <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
                  <label className="text-xs text-slate-500 font-medium">Role</label>
                  <select
                    value={user.role}
                    disabled={busyId === user.id}
                    onChange={(e) =>
                      void patchUser(user.id, {
                        role: e.target.value as User['role'],
                      })
                    }
                    className="w-full bg-slate-100 rounded-xl py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20">
                    {(['customer', 'merchant', 'agent', 'admin'] as const).map(
                      (role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ),
                    )}
                  </select>
                  <KPButton
                    variant={user.suspendedAt ? 'primary' : 'outline'}
                    className="w-full h-10 text-sm"
                    disabled={busyId === user.id}
                    onClick={() =>
                      void patchUser(user.id, { suspended: !user.suspendedAt })
                    }>
                    {busyId === user.id ?
                      'Saving…' :
                      user.suspendedAt ?
                        'Reactivate account' :
                        <>
                          <Ban className="w-4 h-4 mr-2 inline" />
                          Suspend account
                        </>
                    }
                  </KPButton>
                </div>
              )}
            </KPCard>
          </motion.div>
        )}
      </div>
    </PageTransition>);

};
export const CompliancePage = ({
  navigate,
}: {
  navigate: (p: string) => void;
}) => {
  const [localFlags, setLocalFlags] = useState<ComplianceFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    apiAdminListComplianceFlags()
      .then((r) => {
        if (active) setLocalFlags(r.flags);
      })
      .catch((e) => {
        if (active) {
          setLoadError(e instanceof Error ? e.message : 'Could not load compliance flags');
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const handleResolve = async (id: string) => {
    setBusyId(id);
    try {
      const { flag } = await apiAdminUpdateComplianceFlag(id, 'resolved');
      setLocalFlags((prev) =>
        prev.map((f) => (f.id === id ? flag : f))
      );
      toast.success('Flag marked resolved.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not update flag';
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  };
  const handleDismiss = async (id: string) => {
    setBusyId(id);
    try {
      const { flag } = await apiAdminUpdateComplianceFlag(id, 'dismissed');
      setLocalFlags((prev) =>
        prev.map((f) => (f.id === id ? flag : f))
      );
      toast.success('Flag dismissed.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not dismiss flag';
      toast.error(msg);
    } finally {
      setBusyId(null);
    }
  };
  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-red-100 text-red-700 border-red-200';
      case 'high':
        return 'bg-orange-100 text-orange-700 border-orange-200';
      case 'medium':
        return 'bg-amber-100 text-amber-700 border-amber-200';
      default:
        return 'bg-blue-100 text-blue-700 border-blue-200';
    }
  };
  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center mb-6">
          <button
            onClick={() => navigate('admin')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">
            Compliance Alerts
          </h2>
        </div>
        <div className="flex gap-4">
          <div className="flex-1 bg-red-50 rounded-xl p-3 border border-red-100">
            <p className="text-xs text-red-600 font-medium mb-1">
              Pending Review
            </p>
            <p className="text-xl font-bold text-red-700">
              {localFlags.filter(isUnresolvedComplianceFlag).length}
            </p>
          </div>
          <div className="flex-1 bg-emerald-50 rounded-xl p-3 border border-emerald-100">
            <p className="text-xs text-emerald-600 font-medium mb-1">
              Resolved
            </p>
            <p className="text-xl font-bold text-emerald-700">
              {localFlags.filter((f) => f.status === 'resolved').length}
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 space-y-4">
        {loading && (
          <p className="text-center text-sm text-slate-500 py-8">Loading compliance flags…</p>
        )}
        {!loading && loadError && (
          <KPCard className="p-4 bg-red-50 border border-red-100 text-sm text-red-700">
            {loadError}
          </KPCard>
        )}
        {!loading && !loadError && localFlags.length === 0 && (
          <p className="text-center text-sm text-slate-500 py-8">No compliance flags on record.</p>
        )}
        {localFlags.map((flag, i) =>
        <motion.div
          key={flag.id}
          initial={{
            opacity: 0,
            y: 10
          }}
          animate={{
            opacity: 1,
            y: 0
          }}
          transition={{
            delay: i * 0.05
          }}>
          
            <KPCard
            className={`p-4 border-l-4 ${flag.status === 'resolved' ? 'border-l-emerald-500 opacity-70' : 'border-l-red-500'}`}>
            
              <div className="flex justify-between items-start mb-3">
                <span
                className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${getSeverityColor(flag.severity)}`}>
                
                  {flag.severity} Risk
                </span>
                <span className="text-xs text-slate-400">
                  {new Date(flag.createdAt).toLocaleDateString()}
                </span>
              </div>

              <h4 className="font-bold text-slate-900 mb-1">{flag.reason}</h4>
              <div className="text-xs text-slate-500 mb-4 font-mono bg-slate-100 p-2 rounded">
                User: {flag.userId} <br />
                {flag.transactionId && `Tx: ${flag.transactionId}`}
              </div>

              {flag.status === 'resolved' || flag.status === 'dismissed' ?
            <div className="flex items-center justify-center gap-2 text-emerald-600 text-sm font-medium bg-emerald-50 py-2 rounded-xl">
                  <CheckCircle2 className="w-4 h-4" />
                  {flag.status === 'resolved' ? 'Resolved' : 'Dismissed'}
                </div> :

            <div className="space-y-2">
              <KPButton
                variant="outline"
                className="w-full h-10 text-sm"
                onClick={() => handleResolve(flag.id)}
                disabled={busyId === flag.id}>
                  {busyId === flag.id ? 'Saving…' : 'Mark as Resolved'}
                </KPButton>
              <KPButton
                variant="outline"
                className="w-full h-10 text-sm text-slate-600"
                onClick={() => handleDismiss(flag.id)}
                disabled={busyId === flag.id}>
                <XCircle className="w-4 h-4 mr-1 inline" />
                Dismiss
              </KPButton>
            </div>
            }
            </KPCard>
          </motion.div>
        )}
      </div>
    </PageTransition>);

};
// Helper for formatZAR in this file
const formatZAR = (amount: number) =>
new Intl.NumberFormat('en-ZA', {
  style: 'currency',
  currency: 'ZAR'
}).format(amount);

const claimStatusBadge = (status: AdminInsuranceClaim['status']) => {
  switch (status) {
    case 'submitted':
      return 'warning';
    case 'approved':
      return 'info';
    case 'paid':
      return 'success';
    case 'rejected':
      return 'danger';
    default:
      return 'info';
  }
};

export const ClaimsReviewPage = ({
  navigate,
}: {
  navigate: (p: string) => void;
}) => {
  const [claims, setClaims] = useState<AdminInsuranceClaim[]>([]);
  const [statusFilter, setStatusFilter] = useState<
    'all' | AdminInsuranceClaim['status']
  >('submitted');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const loadClaims = useCallback(async (filter: typeof statusFilter) => {
    setLoading(true);
    setLoadError(null);
    try {
      const { claims: rows } = await apiAdminListInsuranceClaims(
        filter === 'all' ? undefined : filter,
      );
      setClaims(rows);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load claims');
      setClaims([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadClaims(statusFilter);
  }, [loadClaims, statusFilter]);

  const updateClaim = async (
    claimId: string,
    status: 'approved' | 'rejected' | 'paid',
  ) => {
    setBusyId(claimId);
    try {
      const { claim } = await apiAdminUpdateInsuranceClaim(claimId, {
        status,
        adminNote: notes[claimId]?.trim() || undefined,
      });
      setClaims((prev) => prev.map((c) => (c.id === claimId ? claim : c)));
      toast.success(`Claim ${status}.`);
      if (statusFilter !== 'all' && status !== statusFilter) {
        setClaims((prev) => prev.filter((c) => c.id !== claimId));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update claim');
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = claims.filter((c) => c.status === 'submitted').length;

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center mb-6">
          <button
            onClick={() => navigate('admin')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">
            Insurance Claims
          </h2>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {(['all', 'submitted', 'approved', 'rejected', 'paid'] as const).map(
            (status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-4 py-1.5 rounded-full text-sm font-medium capitalize whitespace-nowrap transition-colors ${statusFilter === status ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'}`}>
                {status}
              </button>
            ),
          )}
        </div>
        {statusFilter === 'submitted' && !loading && (
          <p className="text-xs text-amber-700 mt-3">
            {pendingCount} claim{pendingCount === 1 ? '' : 's'} awaiting review
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 space-y-4">
        {loading && (
          <p className="text-center text-sm text-slate-500 py-8">Loading claims…</p>
        )}
        {!loading && loadError && (
          <KPCard className="p-4 bg-red-50 border border-red-100 text-sm text-red-700">
            {loadError}
          </KPCard>
        )}
        {!loading && !loadError && claims.length === 0 && (
          <p className="text-center text-sm text-slate-500 py-8">No claims in this queue.</p>
        )}
        {claims.map((claim, i) => (
          <motion.div
            key={claim.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}>
            <KPCard className="p-4">
              <div className="flex justify-between items-start mb-2">
                <KPBadge variant={claimStatusBadge(claim.status)}>
                  {claim.status}
                </KPBadge>
                <span className="text-xs text-slate-400">
                  {new Date(claim.createdAt).toLocaleDateString()}
                </span>
              </div>
              <h4 className="font-bold text-slate-900 capitalize">{claim.type} claim</h4>
              <p className="text-sm text-slate-600 mt-1">{claim.description}</p>
              <p className="text-lg font-bold text-slate-900 mt-2">
                {formatZAR(claim.claimedAmount)}
              </p>
              {claim.merchantBusinessName && (
                <p className="text-xs text-slate-500 mt-2">
                  Merchant: {claim.merchantBusinessName}
                </p>
              )}
              {claim.adminNote && (
                <p className="text-xs text-slate-600 mt-2 bg-slate-100 p-2 rounded">
                  Note: {claim.adminNote}
                </p>
              )}
              {claim.status === 'submitted' && (
                <div className="mt-4 space-y-2">
                  <textarea
                    placeholder="Admin note (optional)"
                    value={notes[claim.id] ?? ''}
                    onChange={(e) =>
                      setNotes((prev) => ({ ...prev, [claim.id]: e.target.value }))
                    }
                    className="w-full bg-slate-100 rounded-xl p-3 text-sm min-h-[72px] focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <div className="flex gap-2">
                    <KPButton
                      className="flex-1 h-10 text-sm"
                      disabled={busyId === claim.id}
                      onClick={() => void updateClaim(claim.id, 'approved')}>
                      Approve
                    </KPButton>
                    <KPButton
                      variant="outline"
                      className="flex-1 h-10 text-sm text-red-600 border-red-200"
                      disabled={busyId === claim.id}
                      onClick={() => void updateClaim(claim.id, 'rejected')}>
                      Reject
                    </KPButton>
                  </div>
                </div>
              )}
              {claim.status === 'approved' && (
                <KPButton
                  className="w-full h-10 text-sm mt-4"
                  disabled={busyId === claim.id}
                  onClick={() => void updateClaim(claim.id, 'paid')}>
                  Mark as paid
                </KPButton>
              )}
            </KPCard>
          </motion.div>
        ))}
      </div>
    </PageTransition>
  );
};

const MERCHANT_DOC_LABELS: Record<MerchantDocType, string> = {
  cipc_14_3: 'CIPC 14.3',
  beee_certificate: 'B-BBEE certificate',
  municipal_business_reg: 'Municipal business registration',
  proof_of_bank: 'Proof of bank account',
};

function approvalBadge(
  status: MerchantApprovalStatus | undefined,
): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  switch (status) {
    case 'approved':
      return 'success';
    case 'pending_approval':
      return 'warning';
    case 'rejected':
      return 'danger';
    case 'pending_docs':
      return 'info';
    default:
      return 'neutral';
  }
}

export const MerchantApprovalsPage = ({
  navigate,
}: {
  navigate: (p: string) => void;
}) => {
  const [merchants, setMerchants] = useState<AdminMerchantRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<
    'all' | MerchantApprovalStatus
  >('pending_approval');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [docsByMerchant, setDocsByMerchant] = useState<
    Record<string, MerchantDocumentStatus[]>
  >({});

  const loadMerchants = useCallback(async (filter: typeof statusFilter) => {
    setLoading(true);
    setLoadError(null);
    try {
      const { merchants: rows } = await apiAdminListMerchants(
        filter === 'all' ? undefined : filter,
      );
      setMerchants(rows);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load merchants');
      setMerchants([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMerchants(statusFilter);
  }, [loadMerchants, statusFilter]);

  const openDocs = async (merchantId: string) => {
    if (expandedId === merchantId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(merchantId);
    if (docsByMerchant[merchantId]) return;
    try {
      const { documents } = await apiAdminGetMerchant(merchantId);
      setDocsByMerchant((prev) => ({ ...prev, [merchantId]: documents }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load documents');
    }
  };

  const viewDoc = async (merchantId: string, docType: MerchantDocType) => {
    try {
      const { blob, fileName } = await apiAdminFetchMerchantDocument(
        merchantId,
        docType,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open document');
    }
  };

  const review = async (
    merchantId: string,
    status: 'approved' | 'rejected',
  ) => {
    if (status === 'rejected' && !reasons[merchantId]?.trim()) {
      toast.error('Add a rejection reason first.');
      return;
    }
    setBusyId(merchantId);
    try {
      const { merchant } = await apiAdminReviewMerchant(merchantId, {
        status,
        reason: reasons[merchantId]?.trim() || undefined,
      });
      setMerchants((prev) =>
        prev.map((m) => (m.id === merchantId ? { ...m, ...merchant } : m)),
      );
      toast.success(
        status === 'approved' ? 'Merchant approved.' : 'Merchant rejected.',
      );
      if (statusFilter !== 'all' && statusFilter !== status) {
        setMerchants((prev) => prev.filter((m) => m.id !== merchantId));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update merchant');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center mb-6">
          <button
            type="button"
            onClick={() => navigate('admin')}
            className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <h2 className="text-xl font-bold ml-2 text-slate-900">
            Merchant Approvals
          </h2>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {(
            [
              'all',
              'pending_approval',
              'pending_docs',
              'approved',
              'rejected',
            ] as const
          ).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                statusFilter === status
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-600'
              }`}>
              {status.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 space-y-4">
        {loading && (
          <p className="text-center text-sm text-slate-500 py-8">
            Loading merchants…
          </p>
        )}
        {!loading && loadError && (
          <KPCard className="p-4 bg-red-50 border border-red-100 text-sm text-red-700">
            {loadError}
          </KPCard>
        )}
        {!loading && !loadError && merchants.length === 0 && (
          <p className="text-center text-sm text-slate-500 py-8">
            No merchants in this queue.
          </p>
        )}
        {merchants.map((m, i) => (
          <motion.div
            key={m.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}>
            <KPCard className="p-4">
              <div className="flex justify-between items-start mb-2">
                <KPBadge variant={approvalBadge(m.approvalStatus)}>
                  {(m.approvalStatus ?? 'approved').replace(/_/g, ' ')}
                </KPBadge>
                <span className="text-xs text-slate-400">
                  {m.documentsUploaded ?? 0}/{m.documentsRequired ?? 4} docs
                </span>
              </div>
              <h4 className="font-bold text-slate-900">{m.businessName}</h4>
              <p className="text-sm text-slate-600 mt-1">
                {m.ownerName ?? 'Owner'} · {m.ownerPhone ?? '—'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                {m.location} · {m.category}
              </p>
              {m.rejectionReason ? (
                <p className="text-xs text-red-600 mt-2 bg-red-50 p-2 rounded">
                  {m.rejectionReason}
                </p>
              ) : null}

              <button
                type="button"
                onClick={() => void openDocs(m.id)}
                className="mt-3 text-sm font-medium text-emerald-700">
                {expandedId === m.id ? 'Hide documents' : 'View documents'}
              </button>

              {expandedId === m.id && (
                <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
                  {(docsByMerchant[m.id] ?? []).length === 0 ? (
                    <p className="text-xs text-slate-500">No documents uploaded.</p>
                  ) : (
                    (docsByMerchant[m.id] ?? []).map((doc) => (
                      <button
                        key={doc.docType}
                        type="button"
                        onClick={() =>
                          void viewDoc(m.id, doc.docType as MerchantDocType)
                        }
                        className="w-full text-left text-sm px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-700">
                        {MERCHANT_DOC_LABELS[doc.docType as MerchantDocType] ??
                          doc.docType}
                        {doc.fileName ? ` · ${doc.fileName}` : ''}
                      </button>
                    ))
                  )}
                </div>
              )}

              {(m.approvalStatus === 'pending_approval' ||
                m.approvalStatus === 'pending_docs') && (
                <div className="mt-4 space-y-2">
                  <textarea
                    placeholder="Rejection reason (required to reject)"
                    value={reasons[m.id] ?? ''}
                    onChange={(e) =>
                      setReasons((prev) => ({
                        ...prev,
                        [m.id]: e.target.value,
                      }))
                    }
                    className="w-full bg-slate-100 rounded-xl p-3 text-sm min-h-[72px] focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  />
                  <div className="flex gap-2">
                    <KPButton
                      className="flex-1 h-10 text-sm"
                      disabled={
                        busyId === m.id || (m.documentsUploaded ?? 0) < 4
                      }
                      onClick={() => void review(m.id, 'approved')}>
                      Approve
                    </KPButton>
                    <KPButton
                      variant="outline"
                      className="flex-1 h-10 text-sm text-red-600 border-red-200"
                      disabled={busyId === m.id}
                      onClick={() => void review(m.id, 'rejected')}>
                      Reject
                    </KPButton>
                  </div>
                </div>
              )}
            </KPCard>
          </motion.div>
        ))}
      </div>
    </PageTransition>
  );
};