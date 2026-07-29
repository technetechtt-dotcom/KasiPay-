import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';

import {
  KPButton,
  KPCard,
  PageTransition,
  KPBadge,
} from '../../components/shared/UIComponents';
import {
  apiAdminFetchMerchantDocument,
  apiAdminGetMerchant,
  apiAdminListMerchants,
  apiAdminReviewMerchant,
  type AdminMerchantRow,
} from '../../services/api';
import type {
  MerchantApprovalStatus,
  MerchantDocType,
  MerchantDocumentStatus,
} from '../../types';

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
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                      <KPButton
                        className="flex-1 h-10 text-sm"
                        disabled={
                          busyId === m.id ||
                          (m.documentsUploaded ?? 0) <
                            (m.documentsRequired ?? 4)
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
                </div>
              )}
            </KPCard>
          </motion.div>
        ))}
      </div>
    </PageTransition>
  );
};
