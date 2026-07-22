import { forwardRef } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from 'react';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { absMoney, compareMoney, formatMoney, type MoneyInput } from '../../money';
// --- Typography & Formatting ---
const formatZAR = (amount: MoneyInput) => `R ${formatMoney(amount)}`;
export const KPAmount = ({
  amount,
  className = '',
  showSign = false




}: {amount: MoneyInput;className?: string;showSign?: boolean;}) => {
  const isNegative = compareMoney(amount, 0) < 0;
  const displayAmount = absMoney(amount);
  const prefix = showSign ? isNegative ? '- ' : '+ ' : '';
  return (
    <span className={`font-semibold tracking-tight ${className}`}>
      {prefix}
      {formatZAR(displayAmount)}
    </span>);

};
// --- Buttons ---
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  isLoading?: boolean;
  fullWidth?: boolean;
}
export const KPButton = forwardRef<HTMLButtonElement, ButtonProps>(
  (
  {
    children,
    variant = 'primary',
    isLoading,
    fullWidth = true,
    className = '',
    disabled,
    ...props
  },
  ref) =>
  {
    const baseStyles =
    'relative flex items-center justify-center min-h-[48px] px-6 py-3 rounded-xl font-medium transition-all active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none overflow-hidden';
    const variants = {
      primary: 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm',
      secondary: 'bg-amber-500 text-slate-900 hover:bg-amber-600 shadow-sm',
      outline:
      'border-2 border-slate-200 text-slate-700 hover:border-emerald-600 hover:text-emerald-700',
      ghost: 'text-slate-600 hover:bg-slate-100',
      danger: 'bg-red-50 text-red-600 hover:bg-red-100'
    };
    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={`${baseStyles} ${variants[variant]} ${fullWidth ? 'w-full' : ''} ${className}`}
        {...props}>
        
        {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : children}
      </button>);

  }
);
KPButton.displayName = 'KPButton';
// --- Inputs ---
interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}
export const KPInput = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = '', ...props }, ref) => {
    return (
      <div className="w-full space-y-1.5">
        {label &&
        <label className="block text-sm font-medium text-slate-700">
            {label}
          </label>
        }
        <input
          ref={ref}
          className={`w-full min-h-[48px] px-4 rounded-xl border bg-white text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-colors ${error ? 'border-red-500 focus:border-red-500 focus:ring-red-500/20' : 'border-slate-200'} ${className}`}
          {...props} />
        
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>);

  }
);
KPInput.displayName = 'KPInput';
// --- Cards ---
export const KPCard = ({
  children,
  className = '',
  onClick




}: {children: ReactNode;className?: string;onClick?: () => void;}) => {
  const CardComponent = onClick ? motion.button : motion.div;
  return (
    <CardComponent
      onClick={onClick}
      whileTap={
      onClick ?
      {
        scale: 0.98
      } :
      undefined
      }
      className={`bg-white rounded-2xl p-5 shadow-sm border border-slate-100 ${onClick ? 'text-left w-full' : ''} ${className}`}>
      
      {children}
    </CardComponent>);

};
// --- Badges ---
export const KPBadge = ({
  children,
  variant = 'info',
  className = ''




}: {children: ReactNode;variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral';className?: string;}) => {
  const variants = {
    success: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    warning: 'bg-amber-50 text-amber-700 border-amber-200',
    danger: 'bg-red-50 text-red-700 border-red-200',
    info: 'bg-blue-50 text-blue-700 border-blue-200',
    neutral: 'bg-slate-100 text-slate-700 border-slate-200'
  };
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${variants[variant]} ${className}`}>
      
      {children}
    </span>);

};
// --- Avatar ---
export const KPAvatar = ({
  name,
  size = 'md'



}: {name: string;size?: 'sm' | 'md' | 'lg';}) => {
  const initials = name.
  split(' ').
  map((n) => n[0]).
  join('').
  substring(0, 2).
  toUpperCase();
  const sizes = {
    sm: 'w-8 h-8 text-xs',
    md: 'w-12 h-12 text-base',
    lg: 'w-16 h-16 text-xl'
  };
  return (
    <div
      className={`${sizes[size]} rounded-full bg-emerald-100 text-emerald-700 font-bold flex items-center justify-center shrink-0`}>
      
      {initials}
    </div>);

};
// --- Page Transition Wrapper ---
export const PageTransition = ({
  children,
  className = ''



}: {children: ReactNode;className?: string;}) =>
<motion.div
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
  transition={{
    duration: 0.2
  }}
  className={`w-full min-h-0 flex flex-col ${className}`}>
  
    {children}
  </motion.div>;