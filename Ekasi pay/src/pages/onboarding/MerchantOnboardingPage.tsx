import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  FileUp,
  Loader2,
  LogOut,
  Upload,
} from 'lucide-react';
import {
  KPButton,
  KPCard,
  PageTransition,
} from '../../components/shared/UIComponents';
import {
  apiGetMerchantDocuments,
  apiSubmitMerchantDocuments,
  apiUploadMerchantDocument,
} from '../../services/api';
import type {
  Merchant,
  MerchantApprovalStatus,
  MerchantDocType,
  MerchantDocumentStatus,
} from '../../types';

const DOC_LABELS: Record<MerchantDocType, string> = {
  cipc_14_3: 'CIPC 14.3 document',
  beee_certificate: 'B-BBEE certificate',
  municipal_business_reg: 'Municipal business registration certificate',
  proof_of_bank: 'Proof of bank account',
};

const DOC_ORDER: MerchantDocType[] = [
  'cipc_14_3',
  'beee_certificate',
  'municipal_business_reg',
  'proof_of_bank',
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const base64 = result.includes(',') ? result.split(',')[1]! : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

export function MerchantOnboardingPage({
  merchant,
  onMerchantUpdated,
  onLogout,
}: {
  merchant: Merchant;
  onMerchantUpdated: (merchant: Merchant) => void;
  onLogout: () => void;
}) {
  const status: MerchantApprovalStatus =
    merchant.approvalStatus ?? 'pending_docs';
  const [documents, setDocuments] = useState<MerchantDocumentStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<MerchantDocType | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGetMerchantDocuments();
      setDocuments(res.documents);
      onMerchantUpdated(res.merchant);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load documents');
    } finally {
      setLoading(false);
    }
  }, [onMerchantUpdated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allUploaded = DOC_ORDER.every((type) =>
    documents.some((d) => d.docType === type && d.uploaded),
  );

  const onPickFile = async (docType: MerchantDocType, file: File | null) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Each file must be 5 MB or smaller.');
      return;
    }
    setUploading(docType);
    try {
      const dataBase64 = await fileToBase64(file);
      const { merchant: next, document } = await apiUploadMerchantDocument({
        docType,
        fileName: file.name,
        contentType: file.type || 'application/pdf',
        dataBase64,
      });
      onMerchantUpdated(next);
      setDocuments((prev) => {
        const others = prev.filter((d) => d.docType !== docType);
        return [...others, { ...document, uploaded: true }];
      });
      toast.success(`${DOC_LABELS[docType]} uploaded.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      const { merchant: next } = await apiSubmitMerchantDocuments();
      onMerchantUpdated(next);
      toast.success('Documents submitted for admin review.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not submit');
    } finally {
      setSubmitting(false);
    }
  };

  if (status === 'pending_approval') {
    return (
      <PageTransition className="min-h-0 h-full bg-slate-50 flex flex-col px-6 py-12">
        <div className="flex-1 flex flex-col items-center justify-center text-center max-w-sm mx-auto">
          <div className="w-14 h-14 rounded-full bg-amber-100 text-amber-700 flex items-center justify-center mb-5">
            <Loader2 className="w-7 h-7 animate-spin" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">
            Under review
          </h1>
          <p className="text-slate-500 text-sm leading-relaxed mb-8">
            Your compliance documents were submitted
            {merchant.docsSubmittedAt
              ? ` on ${new Date(merchant.docsSubmittedAt).toLocaleDateString()}`
              : ''}
            . An admin must approve your merchant account before you can use
            KasiPay.
          </p>
          <KPButton
            variant="secondary"
            onClick={() => void refresh()}
            className="mb-3 w-full">
            Refresh status
          </KPButton>
          <button
            type="button"
            onClick={onLogout}
            className="text-sm text-slate-500 flex items-center gap-2">
            <LogOut className="w-4 h-4" /> Log out
          </button>
        </div>
      </PageTransition>
    );
  }

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50 flex flex-col">
      <div className="bg-white px-6 pt-12 pb-5 shadow-sm shrink-0">
        <h1 className="text-2xl font-bold text-slate-900">
          Complete your merchant setup
        </h1>
        <p className="text-slate-500 text-sm mt-2 leading-relaxed">
          Upload the four required business documents. An admin will review them
          before you can start using the platform.
        </p>
        {status === 'rejected' && merchant.rejectionReason ? (
          <div className="mt-4 rounded-xl bg-red-50 border border-red-100 p-3 text-sm text-red-700">
            <p className="font-semibold mb-1">Application rejected</p>
            <p>{merchant.rejectionReason}</p>
            <p className="mt-2 text-xs">
              Re-upload the corrected documents and submit again.
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-3 pb-8">
        {loading ? (
          <p className="text-center text-sm text-slate-500 py-10">
            Loading document checklist…
          </p>
        ) : (
          DOC_ORDER.map((docType) => {
            const row = documents.find((d) => d.docType === docType);
            const uploaded = Boolean(row?.uploaded);
            const busy = uploading === docType;
            return (
              <KPCard key={docType} className="p-4">
                <div className="flex items-start gap-3">
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                      uploaded
                        ? 'bg-emerald-100 text-emerald-700'
                        : 'bg-slate-100 text-slate-500'
                    }`}>
                    {uploaded ? (
                      <CheckCircle2 className="w-5 h-5" />
                    ) : (
                      <FileUp className="w-5 h-5" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold text-slate-900 text-sm">
                      {DOC_LABELS[docType]}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      PDF, JPG, or PNG · max 5 MB
                    </p>
                    {uploaded && row?.fileName ? (
                      <p className="text-xs text-emerald-700 mt-1 truncate">
                        {row.fileName}
                      </p>
                    ) : null}
                    <label className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-emerald-700 cursor-pointer">
                      <Upload className="w-4 h-4" />
                      {busy ? 'Uploading…' : uploaded ? 'Replace file' : 'Upload file'}
                      <input
                        type="file"
                        accept="application/pdf,image/jpeg,image/png,image/webp"
                        className="hidden"
                        disabled={busy}
                        onChange={(e) => {
                          const file = e.target.files?.[0] ?? null;
                          e.target.value = '';
                          void onPickFile(docType, file);
                        }}
                      />
                    </label>
                  </div>
                </div>
              </KPCard>
            );
          })
        )}

        <KPButton
          className="w-full mt-2"
          disabled={!allUploaded || submitting || loading}
          isLoading={submitting}
          onClick={() => void onSubmit()}>
          Submit for admin approval
        </KPButton>
        <button
          type="button"
          onClick={onLogout}
          className="w-full text-center text-sm text-slate-500 py-3 flex items-center justify-center gap-2">
          <LogOut className="w-4 h-4" /> Log out
        </button>
      </div>
    </PageTransition>
  );
}
