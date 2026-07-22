import { AlertTriangle } from 'lucide-react';

type Props = {
  title: string;
  detail?: string;
};

/** Static banner when a product is server-disabled (loans, insurance, Cash Send, stokvel money). */
export function ProductDisabledNotice({ title, detail }: Props) {
  return (
    <div
      role="status"
      className="mx-6 mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-950">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="text-xs font-semibold">{title}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed opacity-80">
            {detail ??
              'This product is disabled on the server until legal, provider, and accounting gates are approved.'}
          </p>
        </div>
      </div>
    </div>
  );
}
