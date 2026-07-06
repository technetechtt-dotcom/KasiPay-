import { ScanLine } from 'lucide-react';

export const FloatingScanButton = ({
  onClick,
  label = 'Scan',
  accent = 'emerald',
  className = '',
}: {
  onClick: () => void;
  label?: string;
  /** Tailwind colour stem, e.g. emerald or blue */
  accent?: 'emerald' | 'blue';
  className?: string;
}) => {
  const colours =
    accent === 'blue'
      ? 'bg-blue-600 shadow-blue-600/30 active:bg-blue-700'
      : 'bg-emerald-600 shadow-emerald-600/30 active:bg-emerald-700';

  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={`absolute right-[clamp(0.75rem,3vw,1.25rem)] bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] z-40 flex items-center gap-2 px-4 sm:px-5 py-3 rounded-full text-white font-semibold text-sm shadow-lg ${colours} active:scale-95 transition-transform ${className}`}>
      <ScanLine className="w-5 h-5" />
      {label}
    </button>
  );
};
