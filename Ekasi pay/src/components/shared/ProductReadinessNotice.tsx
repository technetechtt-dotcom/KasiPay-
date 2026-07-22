import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';

import {
  apiGetProductReadiness,
  type ProductReadinessStatus,
} from '../../services/api';

type Product = ProductReadinessStatus['product'];

const LABELS: Record<Product, string> = {
  stokvel: 'Stokvel',
  lending: 'Lending',
  merchant_credit: 'Merchant credit book',
  insurance: 'Insurance',
  utilities: 'Utilities',
};

export function useProductReadiness(product: Product) {
  const [status, setStatus] = useState<ProductReadinessStatus | null>(null);
  useEffect(() => {
    let active = true;
    apiGetProductReadiness()
      .then((result) => {
        if (active) {
          setStatus(result.products.find((item) => item.product === product) ?? null);
        }
      })
      .catch(() => {
        if (active) setStatus(null);
      });
    return () => {
      active = false;
    };
  }, [product]);
  return status;
}

export function ProductReadinessNotice({ product }: { product: Product }) {
  const status = useProductReadiness(product);
  const enabled = status?.enabled ?? false;
  const Icon = enabled ? ShieldCheck : AlertTriangle;
  return (
    <div
      role="status"
      className={`mx-6 mt-4 rounded-xl border p-3 ${
        enabled
          ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
          : 'border-amber-200 bg-amber-50 text-amber-950'
      }`}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="text-xs font-semibold">
            {LABELS[product]} · {status?.environment ?? 'controlled'} mode
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed opacity-80">
            {enabled
              ? 'The server-side sandbox readiness gate is satisfied.'
              : `Transactions are server-disabled. Missing evidence: ${
                  status?.missing.join(', ') || 'readiness status unavailable'
                }.`}
          </p>
        </div>
      </div>
    </div>
  );
}
