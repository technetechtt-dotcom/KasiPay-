import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  KPCard,
  KPButton,
  KPInput,
  PageTransition,
  KPBadge,
} from '../../components/shared/UIComponents';
import {
  ArrowLeft,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  Clock,
  Package,
  CheckCircle2,
  Info,
  Building2,
  FileText,
  Plus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  Supplier,
  SupplierVerification,
  ExpiryItem,
  FoodSafetyAlert } from
'../../types';
export const FoodSafetyPage = ({
  suppliers,
  verifications,
  expiryItems,
  alerts,
  markAlertRead,
  onUpsertVerification,
  onAddExpiryItem,
  onPublishVendorAlert,
  navigate,
}: {
  suppliers: Supplier[];
  verifications: SupplierVerification[];
  expiryItems: ExpiryItem[];
  alerts: FoodSafetyAlert[];
  markAlertRead: (id: string) => void;
  onUpsertVerification: (
    supplierId: string,
    body: {
      cipcRegistered: boolean;
      healthDeptApproved: boolean;
      lastInspectionDate: string;
      certificateExpiry: string;
      verificationStatus:
        | 'verified'
        | 'pending'
        | 'unverified'
        | 'flagged';
      riskLevel: 'low' | 'medium' | 'high';
    }
  ) => Promise<boolean>;
  onAddExpiryItem: (body: {
    productName: string;
    category: string;
    batchNumber: string;
    expiryDate: string;
    quantity: number;
    supplierId: string;
    status?: ExpiryItem['status'];
  }) => Promise<boolean>;
  onPublishVendorAlert: (body: {
    type: 'recall' | 'expiry' | 'supplier' | 'inspection';
    title: string;
    description: string;
    severity: 'critical' | 'warning' | 'info';
  }) => Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const [activeTab, setActiveTab] = useState<'suppliers' | 'expiry' | 'alerts'>(
    'suppliers'
  );
  const [verifyForId, setVerifyForId] = useState<string | null>(null);
  const [showExpiryModal, setShowExpiryModal] = useState(false);
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [busy, setBusy] = useState(false);

  const [vCipc, setVCipc] = useState(false);
  const [vHealth, setVHealth] = useState(false);
  const [vLast, setVLast] = useState('');
  const [vCertExp, setVCertExp] = useState('');
  const [vStatus, setVStatus] =
    useState<'verified' | 'pending' | 'unverified' | 'flagged'>('pending');
  const [vRisk, setVRisk] = useState<'low' | 'medium' | 'high'>('medium');

  const openVerify = (supplierId: string) => {
    const row = verifications.find((x) => x.supplierId === supplierId);
    setVCipc(row?.cipcRegistered ?? false);
    setVHealth(row?.healthDeptApproved ?? false);
    setVLast(row?.lastInspectionDate ?? new Date().toISOString().slice(0, 10));
    setVCertExp(
      row?.certificateExpiry ??
        new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)
    );
    setVStatus(row?.verificationStatus ?? 'pending');
    setVRisk(row?.riskLevel ?? 'medium');
    setVerifyForId(supplierId);
  };

  const [exProduct, setExProduct] = useState('');
  const [exCategory, setExCategory] = useState('');
  const [exBatch, setExBatch] = useState('');
  const [exDate, setExDate] = useState('');
  const [exQty, setExQty] = useState('1');
  const [exSupplierId, setExSupplierId] = useState('');
  const [exStatus, setExStatus] = useState<ExpiryItem['status']>('safe');

  const [alTitle, setAlTitle] = useState('');
  const [alDesc, setAlDesc] = useState('');
  const [alSev, setAlSev] = useState<'critical' | 'warning' | 'info'>('info');
  const [alType, setAlType] =
    useState<'recall' | 'expiry' | 'supplier' | 'inspection'>('inspection');
  // Calculate Compliance Score
  const verifiedSuppliers = verifications.filter(
    (v) => v.verificationStatus === 'verified'
  ).length;
  const totalSuppliers = suppliers.length;
  const supplierScore =
  totalSuppliers > 0 ? verifiedSuppliers / totalSuppliers * 40 : 0;
  const safeItems = expiryItems.filter((i) => i.status === 'safe').length;
  const totalItems = expiryItems.length;
  const itemsScore = totalItems > 0 ? safeItems / totalItems * 40 : 0;
  const readAlerts = alerts.filter((a) => a.isRead).length;
  const totalAlerts = alerts.length;
  const alertsScore = totalAlerts > 0 ? readAlerts / totalAlerts * 20 : 20;
  const complianceScore = Math.round(supplierScore + itemsScore + alertsScore);
  const getScoreColor = (s: number) => {
    if (s >= 80) return 'text-emerald-500';
    if (s >= 60) return 'text-amber-500';
    return 'text-red-500';
  };
  const getScoreBg = (s: number) => {
    if (s >= 80) return 'bg-emerald-50 text-emerald-800';
    if (s >= 60) return 'bg-amber-50 text-amber-800';
    return 'bg-red-50 text-red-800';
  };
  const getScoreStatus = (s: number) => {
    if (s >= 80) return 'Compliant';
    if (s >= 60) return 'Needs Attention';
    return 'At Risk';
  };
  // Sort expiry items: expired first, then expiring-soon, then safe
  const sortedExpiryItems = [...expiryItems].sort((a, b) => {
    const statusWeight = {
      expired: 0,
      'expiring-soon': 1,
      safe: 2
    };
    if (statusWeight[a.status] !== statusWeight[b.status]) {
      return statusWeight[a.status] - statusWeight[b.status];
    }
    return new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime();
  });
  // Format relative days for expiry
  const getDaysText = (dateStr: string) => {
    const diffTime = new Date(dateStr).getTime() - new Date().getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return `${Math.abs(diffDays)} days overdue`;
    if (diffDays === 0) return 'Expires today';
    return `In ${diffDays} days`;
  };
  return (
    <PageTransition className="flex flex-col h-full bg-slate-50">
      {/* Header */}
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-20 shrink-0">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center">
            <button
              onClick={() => navigate('more')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900 transition-colors">
              
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">
              Food Safety
            </h2>
          </div>
          <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex p-1 bg-slate-100 rounded-xl">
          <button
            onClick={() => setActiveTab('suppliers')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'suppliers' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>
            
            Suppliers
          </button>
          <button
            onClick={() => setActiveTab('expiry')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all ${activeTab === 'expiry' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>
            
            Expiry
          </button>
          <button
            onClick={() => setActiveTab('alerts')}
            className={`flex-1 py-2 text-sm font-medium rounded-lg transition-all relative ${activeTab === 'alerts' ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500'}`}>
            
            Alerts
            {alerts.some((a) => !a.isRead) &&
            <span className="absolute top-2 right-3 w-2 h-2 bg-red-500 rounded-full"></span>
            }
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 pb-24">
        {/* Hero Score - Shown on all tabs */}
        <div className="flex flex-col items-center justify-center py-4 mb-6">
          <div className="relative w-40 h-40 flex items-center justify-center">
            <svg className="absolute inset-0 w-full h-full transform -rotate-90">
              <circle
                cx="80"
                cy="80"
                r="72"
                stroke="currentColor"
                strokeWidth="10"
                fill="transparent"
                className="text-slate-200" />
              
              <motion.circle
                initial={{
                  strokeDashoffset: 2 * Math.PI * 72
                }}
                animate={{
                  strokeDashoffset:
                  2 * Math.PI * 72 * (1 - complianceScore / 100)
                }}
                cx="80"
                cy="80"
                r="72"
                stroke="currentColor"
                strokeWidth="10"
                fill="transparent"
                strokeDasharray={2 * Math.PI * 72}
                className={`${getScoreColor(complianceScore)} transition-all duration-1000 ease-out`}
                strokeLinecap="round" />
              
            </svg>
            <div className="text-center z-10">
              <span
                className={`text-4xl font-black tracking-tighter ${getScoreColor(complianceScore)}`}>
                
                {complianceScore}
              </span>
              <span className="text-slate-400 text-lg font-bold">/100</span>
            </div>
          </div>
          <div
            className={`mt-4 px-4 py-1.5 rounded-full text-sm font-bold flex items-center gap-2 ${getScoreBg(complianceScore)}`}>
            
            {complianceScore >= 80 ?
            <ShieldCheck className="w-4 h-4" /> :

            <ShieldAlert className="w-4 h-4" />
            }
            {getScoreStatus(complianceScore)}
          </div>
          <p className="text-xs font-medium text-slate-500 mt-2 uppercase tracking-wider">
            Dept of Health Compliance
          </p>
        </div>

        <AnimatePresence mode="wait">
          {/* SUPPLIERS TAB */}
          {activeTab === 'suppliers' &&
          <motion.div
            key="suppliers"
            initial={{
              opacity: 0,
              y: 10
            }}
            animate={{
              opacity: 1,
              y: 0
            }}
            exit={{
              opacity: 0,
              y: -10
            }}
            className="space-y-4">
            
              <div className="grid grid-cols-3 gap-2 mb-6">
                <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-emerald-600">
                    {verifiedSuppliers}
                  </p>
                  <p className="text-[10px] font-bold text-emerald-800 uppercase">
                    Verified
                  </p>
                </div>
                <div className="bg-amber-50 border border-amber-100 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-amber-600">
                    {
                  verifications.filter(
                    (v) => v.verificationStatus === 'pending'
                  ).length
                  }
                  </p>
                  <p className="text-[10px] font-bold text-amber-800 uppercase">
                    Pending
                  </p>
                </div>
                <div className="bg-red-50 border border-red-100 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-red-600">
                    {
                  verifications.filter((v) =>
                  ['unverified', 'flagged'].includes(
                    v.verificationStatus
                  )
                  ).length
                  }
                  </p>
                  <p className="text-[10px] font-bold text-red-800 uppercase">
                    Flagged
                  </p>
                </div>
              </div>

              {suppliers.length === 0 && (
                <p className="text-center text-slate-500 text-sm py-6">
                  Add suppliers from Supplier Orders to track compliance.
                </p>
              )}
              {suppliers.map((supplier) => {
                const verification = verifications.find(
                  (v) => v.supplierId === supplier.id
                );
                const isVerified =
                  verification?.verificationStatus === 'verified';
                const isFlagged =
                  verification &&
                  ['unverified', 'flagged'].includes(
                    verification.verificationStatus
                  );
                return (
                  <KPCard
                    key={supplier.id}
                    className={`p-4 border-l-4 ${!verification ? 'border-l-slate-300' : isVerified ? 'border-l-emerald-500' : isFlagged ? 'border-l-red-500' : 'border-l-amber-500'}`}>
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <h3 className="font-bold text-slate-900">{supplier.name}</h3>
                        <p className="text-xs text-slate-500">{supplier.category}</p>
                      </div>
                      {!verification ?
                        <KPBadge variant="warning">No record</KPBadge>
                      : isVerified ?
                        <KPBadge variant="success">
                          <ShieldCheck className="w-3 h-3 mr-1" /> Verified
                        </KPBadge>
                      : isFlagged ?
                        <KPBadge variant="danger">
                          <ShieldAlert className="w-3 h-3 mr-1" /> Flagged
                        </KPBadge>
                      : <KPBadge variant="warning">
                          <Clock className="w-3 h-3 mr-1" /> Pending
                        </KPBadge>}
                    </div>

                    {verification && (
                      <div className="flex gap-2 mb-3">
                        <div
                          className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-md font-medium ${verification.cipcRegistered ? 'bg-slate-100 text-slate-600' : 'bg-red-50 text-red-600'}`}>
                          <Building2 className="w-3 h-3" />
                          CIPC {verification.cipcRegistered ? 'Yes' : 'No'}
                        </div>
                        <div
                          className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-md font-medium ${verification.healthDeptApproved ? 'bg-slate-100 text-slate-600' : 'bg-red-50 text-red-600'}`}>
                          <FileText className="w-3 h-3" />
                          Health {verification.healthDeptApproved ? 'Yes' : 'No'}
                        </div>
                      </div>
                    )}

                    {verification && isFlagged && (
                      <div className="bg-red-50 text-red-700 text-xs p-2 rounded-lg flex items-start gap-2 mt-2 mb-3">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <p>
                          Exercise caution buying perishables until this supplier is verified.
                        </p>
                      </div>
                    )}

                    <KPButton
                      type="button"
                      variant="outline"
                      className="mt-2 !min-h-[40px] text-xs"
                      onClick={() => openVerify(supplier.id)}>
                      {verification ? 'Update verification' : 'Record verification'}
                    </KPButton>
                  </KPCard>
                );
              })}
            </motion.div>
          }

          {/* EXPIRY TRACKER TAB */}
          {activeTab === 'expiry' &&
          <motion.div
            key="expiry"
            initial={{
              opacity: 0,
              y: 10
            }}
            animate={{
              opacity: 1,
              y: 0
            }}
            exit={{
              opacity: 0,
              y: -10
            }}
            className="space-y-4">
            
              <div className="flex items-center justify-between bg-slate-100 p-3 rounded-xl mb-4">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                  <Package className="w-4 h-4" /> Tracked Items
                </div>
                <span className="bg-white px-3 py-1 rounded-full text-sm font-bold text-slate-900 shadow-sm">
                  {expiryItems.length}
                </span>
              </div>

              <KPButton
                type="button"
                className="bg-emerald-600 mb-4"
                disabled={suppliers.length === 0}
                onClick={() => {
                  setExSupplierId(suppliers[0]?.id ?? '');
                  setShowExpiryModal(true);
                }}>
                <Plus className="w-4 h-4 mr-2" /> Add batch / expiry
              </KPButton>

              {sortedExpiryItems.map((item) => {
              const isExpired = item.status === 'expired';
              const isExpiringSoon = item.status === 'expiring-soon';
              const supplier = suppliers.find((s) => s.id === item.supplierId);
              return (
                <KPCard
                  key={item.id}
                  className={`p-4 ${isExpired ? 'bg-red-50/50 border-red-100' : isExpiringSoon ? 'bg-amber-50/50 border-amber-100' : ''}`}>
                  
                    <div className="flex justify-between items-start mb-2">
                      <h4 className="font-bold text-slate-900">
                        {item.productName}
                      </h4>
                      {isExpired ?
                    <KPBadge variant="danger">Expired</KPBadge> :
                    isExpiringSoon ?
                    <KPBadge variant="warning">Expiring Soon</KPBadge> :

                    <KPBadge variant="success">Safe</KPBadge>
                    }
                    </div>

                    <div className="grid grid-cols-2 gap-y-2 text-xs text-slate-500 mb-3">
                      <div>
                        <span className="block text-[10px] uppercase tracking-wider opacity-70">
                          Batch No
                        </span>
                        <span className="font-mono text-slate-700">
                          {item.batchNumber}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[10px] uppercase tracking-wider opacity-70">
                          Supplier
                        </span>
                        <span className="text-slate-700 truncate block pr-2">
                          {supplier?.name || 'Unknown'}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[10px] uppercase tracking-wider opacity-70">
                          Quantity
                        </span>
                        <span className="text-slate-700">
                          {item.quantity} units
                        </span>
                      </div>
                      <div>
                        <span className="block text-[10px] uppercase tracking-wider opacity-70">
                          Expiry Date
                        </span>
                        <span
                        className={`font-bold ${isExpired ? 'text-red-600' : isExpiringSoon ? 'text-amber-600' : 'text-slate-700'}`}>
                        
                          {new Date(item.expiryDate).toLocaleDateString()}
                        </span>
                      </div>
                    </div>

                    <div
                    className={`text-xs font-medium px-3 py-2 rounded-lg flex items-center justify-between ${isExpired ? 'bg-red-100 text-red-700' : isExpiringSoon ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                    
                      <span className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        {getDaysText(item.expiryDate)}
                      </span>
                      {isExpired &&
                    <span className="uppercase tracking-wider text-[10px] font-bold">
                          Remove from shelf
                        </span>
                    }
                    </div>
                  </KPCard>);

            })}
            </motion.div>
          }

          {/* ALERTS TAB */}
          {activeTab === 'alerts' &&
          <motion.div
            key="alerts"
            initial={{
              opacity: 0,
              y: 10
            }}
            animate={{
              opacity: 1,
              y: 0
            }}
            exit={{
              opacity: 0,
              y: -10
            }}
            className="space-y-3">
              <KPButton
                type="button"
                variant="outline"
                className="border-emerald-200 text-emerald-800"
                onClick={() => setShowAlertModal(true)}>
                <Plus className="w-4 h-4 mr-2" /> Post internal safety note
              </KPButton>

              {alerts.length === 0 ?
                <div className="text-center py-12 text-slate-500">
                  <CheckCircle2 className="w-12 h-12 mx-auto mb-3 text-emerald-400" />
                  <p>No alerts in your list</p>
                </div>
              : alerts.map((alert) => {
              const isCritical = alert.severity === 'critical';
              const isWarning = alert.severity === 'warning';
              return (
                <KPCard
                  key={alert.id}
                  onClick={() => {
                    if (!alert.isRead) markAlertRead(alert.id);
                  }}
                  className={`p-4 transition-all cursor-pointer relative overflow-hidden ${!alert.isRead ? 'ring-2 ring-emerald-500/20' : 'opacity-75'}`}>
                  
                      {!alert.isRead &&
                  <div className="absolute top-4 right-4 w-2 h-2 bg-emerald-500 rounded-full"></div>
                  }
                      <div className="flex items-start gap-3">
                        <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${isCritical ? 'bg-red-100 text-red-600' : isWarning ? 'bg-amber-100 text-amber-600' : 'bg-blue-100 text-blue-600'}`}>
                      
                          {alert.type === 'recall' ?
                      <ShieldAlert className="w-5 h-5" /> :
                      alert.type === 'expiry' ?
                      <Clock className="w-5 h-5" /> :
                      alert.type === 'supplier' ?
                      <Building2 className="w-5 h-5" /> :

                      <Info className="w-5 h-5" />
                      }
                        </div>
                        <div className="pr-4">
                          <h4
                        className={`font-bold mb-1 ${!alert.isRead ? 'text-slate-900' : 'text-slate-700'}`}>
                        
                            {alert.title}
                          </h4>
                          <p className="text-sm text-slate-600 mb-2 leading-relaxed">
                            {alert.description}
                          </p>
                          <span className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">
                            {new Date(alert.createdAt).toLocaleDateString()}
                          </span>
                        </div>
                      </div>
                    </KPCard>);

            })
            }
            </motion.div>
          }
        </AnimatePresence>
      </div>

      {verifyForId && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl space-y-3">
            <div className="flex justify-between items-center">
              <h3 className="font-bold text-lg">Supplier verification</h3>
              <button type="button" onClick={() => setVerifyForId(null)} aria-label="Close">
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={vCipc} onChange={(e) => setVCipc(e.target.checked)} /> CIPC registered
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={vHealth} onChange={(e) => setVHealth(e.target.checked)} /> Health dept approved
            </label>
            <KPInput type="date" label="Last inspection" value={vLast} onChange={(e) => setVLast(e.target.value)} />
            <KPInput type="date" label="Certificate expiry" value={vCertExp} onChange={(e) => setVCertExp(e.target.value)} />
            <div>
              <label className="text-sm font-medium text-slate-700">Status</label>
              <select
                className="w-full border rounded-xl py-3 px-3 mt-1 text-sm bg-white"
                value={vStatus}
                onChange={(e) =>
                  setVStatus(e.target.value as typeof vStatus)
                }>
                <option value="pending">Pending</option>
                <option value="verified">Verified</option>
                <option value="unverified">Unverified</option>
                <option value="flagged">Flagged</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Risk level</label>
              <select
                className="w-full border rounded-xl py-3 px-3 mt-1 text-sm bg-white"
                value={vRisk}
                onChange={(e) =>
                  setVRisk(e.target.value as typeof vRisk)
                }>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <KPButton
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const ok = await onUpsertVerification(verifyForId, {
                    cipcRegistered: vCipc,
                    healthDeptApproved: vHealth,
                    lastInspectionDate: vLast,
                    certificateExpiry: vCertExp,
                    verificationStatus: vStatus,
                    riskLevel: vRisk,
                  });
                  if (ok) {
                    toast.success('Saved');
                    setVerifyForId(null);
                  } else toast.error('Could not save');
                } finally {
                  setBusy(false);
                }
              }}>
              {busy ? 'Saving…' : 'Save'}
            </KPButton>
          </div>
        </div>
      )}

      {showExpiryModal && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg">Track expiry</h3>
              <button type="button" onClick={() => setShowExpiryModal(false)}>
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <label className="text-sm font-medium text-slate-700">Supplier</label>
            <select
              className="w-full border rounded-xl py-3 px-3 mb-3 text-sm bg-white"
              value={exSupplierId}
              onChange={(e) => setExSupplierId(e.target.value)}>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <KPInput label="Product" value={exProduct} onChange={(e) => setExProduct(e.target.value)} />
            <KPInput label="Category" value={exCategory} onChange={(e) => setExCategory(e.target.value)} />
            <KPInput label="Batch number" value={exBatch} onChange={(e) => setExBatch(e.target.value)} />
            <KPInput type="date" label="Expiry date" value={exDate} onChange={(e) => setExDate(e.target.value)} />
            <KPInput label="Quantity" type="number" value={exQty} onChange={(e) => setExQty(e.target.value)} />
            <div className="mb-3">
              <label className="text-sm font-medium text-slate-700">Status</label>
              <select
                className="w-full border rounded-xl py-3 px-3 mt-1 text-sm bg-white"
                value={exStatus}
                onChange={(e) =>
                  setExStatus(e.target.value as ExpiryItem['status'])
                }>
                <option value="safe">Safe</option>
                <option value="expiring-soon">Expiring soon</option>
                <option value="expired">Expired</option>
              </select>
            </div>
            <KPButton
              type="button"
              disabled={busy}
              onClick={async () => {
                const q = Number(exQty);
                if (!exProduct.trim() || !exBatch.trim() || !exDate || !(q >= 0) || !exSupplierId) {
                  toast.error('Fill all fields');
                  return;
                }
                setBusy(true);
                try {
                  const ok = await onAddExpiryItem({
                    productName: exProduct.trim(),
                    category: exCategory.trim() || 'General',
                    batchNumber: exBatch.trim(),
                    expiryDate: exDate,
                    quantity: q,
                    supplierId: exSupplierId,
                    status: exStatus,
                  });
                  if (ok) {
                    toast.success('Batch tracked');
                    setShowExpiryModal(false);
                    setExProduct('');
                    setExCategory('');
                    setExBatch('');
                    setExDate('');
                    setExQty('1');
                  } else toast.error('Could not save');
                } finally {
                  setBusy(false);
                }
              }}>
              {busy ? 'Saving…' : 'Save'}
            </KPButton>
          </div>
        </div>
      )}

      {showAlertModal && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white rounded-t-3xl sm:rounded-2xl w-full max-h-[90vh] overflow-y-auto p-6 sm:max-w-md shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg">Safety note</h3>
              <button type="button" onClick={() => setShowAlertModal(false)}>
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>
            <div className="mb-3">
              <label className="text-sm font-medium text-slate-700">Type</label>
              <select
                className="w-full border rounded-xl py-3 px-3 mt-1 text-sm bg-white"
                value={alType}
                onChange={(e) =>
                  setAlType(e.target.value as typeof alType)
                }>
                <option value="inspection">Inspection</option>
                <option value="expiry">Expiry</option>
                <option value="supplier">Supplier</option>
                <option value="recall">Recall</option>
              </select>
            </div>
            <KPInput label="Title" value={alTitle} onChange={(e) => setAlTitle(e.target.value)} />
            <KPInput label="Description" value={alDesc} onChange={(e) => setAlDesc(e.target.value)} />
            <div className="mb-3">
              <label className="text-sm font-medium text-slate-700">Severity</label>
              <select
                className="w-full border rounded-xl py-3 px-3 mt-1 text-sm bg-white"
                value={alSev}
                onChange={(e) =>
                  setAlSev(e.target.value as typeof alSev)
                }>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <KPButton
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!alTitle.trim() || !alDesc.trim()) {
                  toast.error('Title and description required');
                  return;
                }
                setBusy(true);
                try {
                  const ok = await onPublishVendorAlert({
                    type: alType,
                    title: alTitle.trim(),
                    description: alDesc.trim(),
                    severity: alSev,
                  });
                  if (ok) {
                    toast.success('Posted');
                    setShowAlertModal(false);
                    setAlTitle('');
                    setAlDesc('');
                  } else toast.error('Could not post');
                } finally {
                  setBusy(false);
                }
              }}>
              {busy ? 'Posting…' : 'Post to my shop'}
            </KPButton>
          </div>
        </div>
      )}
    </PageTransition>);

};