import { useMemo } from 'react';
import {
  ArrowLeft,
  Bell,
  Package,
  ShieldAlert,
  Clock3,
  CheckCircle2,
} from 'lucide-react';
import {
  KPCard,
  PageTransition,
  KPBadge,
} from '../../components/shared/UIComponents';
import type {
  FoodSafetyAlert,
  ComplianceFlag,
  ExpiryItem,
  Product,
} from '../../types';
import { LOW_STOCK_THRESHOLD } from './notificationCount';

type Severity = 'critical' | 'warning' | 'info';

type NotificationItem = {
  id: string;
  source: 'alert' | 'flag' | 'expiry' | 'low-stock';
  title: string;
  body: string;
  createdAt: string;
  severity: Severity;
  unread: boolean;
  onAcknowledge?: () => void;
  onOpen?: () => void;
};

const severityChip: Record<Severity, { variant: 'success' | 'warning' | 'neutral'; label: string }> = {
  critical: { variant: 'warning', label: 'Critical' },
  warning: { variant: 'warning', label: 'Warning' },
  info: { variant: 'neutral', label: 'Info' },
};

/**
 * Aggregates the four signal sources that drove the placeholder red dot:
 *   - Unread food-safety alerts (`isRead === false`).
 *   - Open compliance flags for the current user.
 *   - Expiry items expiring within 7 days or already expired.
 *   - Products at or below `LOW_STOCK_THRESHOLD`.
 *
 * Only the alerts source has a real "mark read" endpoint; everything else is
 * informational and acknowledged by navigating to the source page.
 */
function buildNotifications({
  alerts,
  flags,
  expiry,
  products,
  navigate,
  onAcknowledgeAlert,
}: {
  alerts: FoodSafetyAlert[];
  flags: ComplianceFlag[];
  expiry: ExpiryItem[];
  products: Product[];
  navigate: (page: string) => void;
  onAcknowledgeAlert: (id: string) => void;
}): NotificationItem[] {
  const out: NotificationItem[] = [];
  const now = Date.now();

  for (const a of alerts) {
    out.push({
      id: `alert:${a.id}`,
      source: 'alert',
      title: a.title,
      body: a.description,
      createdAt: a.createdAt,
      severity: a.severity,
      unread: !a.isRead,
      onAcknowledge: () => onAcknowledgeAlert(a.id),
      onOpen: () => navigate('food-safety'),
    });
  }

  for (const f of flags) {
    if (f.status !== 'open' && f.status !== 'pending') continue;
    const sev: Severity =
      f.severity === 'high' || f.severity === 'critical'
        ? 'critical'
        : f.severity === 'medium'
          ? 'warning'
          : 'info';
    out.push({
      id: `flag:${f.id}`,
      source: 'flag',
      title: `Compliance flag · ${f.severity}`,
      body: f.reason,
      createdAt: f.createdAt,
      severity: sev,
      unread: true,
      onOpen: () => navigate('compliance'),
    });
  }

  for (const e of expiry) {
    const ts = new Date(e.expiryDate).getTime();
    if (!Number.isFinite(ts)) continue;
    const daysOut = Math.round((ts - now) / 86400000);
    if (daysOut > 7) continue;
    out.push({
      id: `expiry:${e.id}`,
      source: 'expiry',
      title:
        daysOut < 0
          ? `${e.productName} — expired`
          : daysOut === 0
            ? `${e.productName} — expires today`
            : `${e.productName} — expires in ${daysOut} day${daysOut === 1 ? '' : 's'}`,
      body: `Batch ${e.batchNumber} · ${e.quantity} unit${e.quantity === 1 ? '' : 's'} · ${e.category}`,
      createdAt: e.expiryDate,
      severity: daysOut < 0 ? 'critical' : daysOut <= 2 ? 'warning' : 'info',
      unread: true,
      onOpen: () => navigate('food-safety'),
    });
  }

  for (const p of products) {
    if (p.stock > LOW_STOCK_THRESHOLD) continue;
    out.push({
      id: `low-stock:${p.id}`,
      source: 'low-stock',
      title: `${p.name} — low stock`,
      body:
        p.stock === 0
          ? 'Out of stock. Reorder before the next sale.'
          : `Only ${p.stock} left at R${p.price.toFixed(2)}.`,
      createdAt: new Date().toISOString(),
      severity: p.stock === 0 ? 'critical' : 'warning',
      unread: true,
      onOpen: () => navigate('inventory'),
    });
  }

  out.sort((a, b) => {
    if (a.unread !== b.unread) return a.unread ? -1 : 1;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  return out;
}

const sourceIcon = (source: NotificationItem['source']) => {
  switch (source) {
    case 'alert':
      return ShieldAlert;
    case 'flag':
      return ShieldAlert;
    case 'expiry':
      return Clock3;
    case 'low-stock':
      return Package;
    default:
      return Bell;
  }
};

const sourceBg: Record<NotificationItem['source'], string> = {
  alert: 'bg-red-50 text-red-600',
  flag: 'bg-amber-50 text-amber-600',
  expiry: 'bg-orange-50 text-orange-600',
  'low-stock': 'bg-purple-50 text-purple-600',
};

export const NotificationsPage = ({
  alerts,
  flags,
  expiry,
  products,
  markAlertRead,
  navigate,
}: {
  alerts: FoodSafetyAlert[];
  flags: ComplianceFlag[];
  expiry: ExpiryItem[];
  products: Product[];
  markAlertRead: (id: string) => void;
  navigate: (page: string) => void;
}) => {
  const items = useMemo(
    () =>
      buildNotifications({
        alerts,
        flags,
        expiry,
        products,
        navigate,
        onAcknowledgeAlert: markAlertRead,
      }),
    [alerts, flags, expiry, products, navigate, markAlertRead],
  );

  const markAllRead = () => {
    for (const a of alerts) {
      if (!a.isRead) markAlertRead(a.id);
    }
  };

  const hasUnreadAlerts = alerts.some((a) => !a.isRead);

  return (
    <PageTransition className="min-h-0 h-full bg-slate-50">
      <div className="bg-white px-6 pt-12 pb-4 shadow-sm z-10 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => navigate('home')}
              className="p-2 -ml-2 text-slate-500 hover:text-slate-900">
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h2 className="text-xl font-bold ml-2 text-slate-900">Notifications</h2>
          </div>
          {hasUnreadAlerts ?
            <button
              type="button"
              onClick={markAllRead}
              className="text-xs font-medium text-emerald-700">
              Mark alerts read
            </button>
          : null}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-6 pb-8 space-y-3">
        {items.length === 0 ?
          <div className="text-center py-16">
            <div className="w-16 h-16 mx-auto rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3">
              <CheckCircle2 className="w-8 h-8" />
            </div>
            <p className="text-slate-700 font-medium">All caught up</p>
            <p className="text-xs text-slate-500 mt-1">
              No alerts, low-stock or expiring stock right now.
            </p>
          </div>
        :
          items.map((item) => {
            const Icon = sourceIcon(item.source);
            const chip = severityChip[item.severity];
            return (
              <KPCard
                key={item.id}
                onClick={item.onOpen}
                className={`p-4 flex gap-3 items-start cursor-pointer ${item.unread ? '' : 'opacity-70'}`}>
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${sourceBg[item.source]}`}>
                  <Icon className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-slate-900 truncate">{item.title}</p>
                    <KPBadge variant={chip.variant}>{chip.label}</KPBadge>
                  </div>
                  <p className="text-xs text-slate-600 mt-0.5 leading-relaxed">
                    {item.body}
                  </p>
                  <div className="flex items-center justify-between mt-2">
                    <p className="text-[10px] text-slate-400 uppercase tracking-wider">
                      {new Date(item.createdAt).toLocaleString('en-ZA')}
                    </p>
                    {item.onAcknowledge && item.unread ?
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          item.onAcknowledge?.();
                        }}
                        className="text-[11px] font-medium text-emerald-700">
                        Mark read
                      </button>
                    : null}
                  </div>
                </div>
              </KPCard>
            );
          })
        }
      </div>
    </PageTransition>
  );
};
