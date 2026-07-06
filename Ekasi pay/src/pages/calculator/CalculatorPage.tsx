import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Delete, Calculator as CalcIcon, Coins } from 'lucide-react';
function formatDisplay(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value);
  }
  const fixed = parseFloat(value.toFixed(10));
  const str = String(fixed);
  if (str.length > 12) {
    return value.toPrecision(8);
  }
  return str;
}
export function CalculatorPage({
  navigate


}: {navigate: (p: string) => void;}) {
  const [mode, setMode] = useState<'standard' | 'change'>('standard');
  const [display, setDisplay] = useState('0');
  const [equation, setEquation] = useState('');
  const [previousValue, setPreviousValue] = useState<number | null>(null);
  const [operator, setOperator] = useState<string | null>(null);
  const [waitingForNewValue, setWaitingForNewValue] = useState(false);
  const [justCalculated, setJustCalculated] = useState(false);
  const [totalOwed, setTotalOwed] = useState('');
  const [amountReceived, setAmountReceived] = useState('');
  const [activeInput, setActiveInput] = useState<'owed' | 'received'>('owed');
  const handleDigit = (digit: string) => {
    if (waitingForNewValue || justCalculated) {
      setDisplay(digit);
      setWaitingForNewValue(false);
      setJustCalculated(false);
    } else {
      if (display.length >= 12) return;
      setDisplay(display === '0' ? digit : display + digit);
    }
  };
  const handleDecimal = () => {
    if (waitingForNewValue || justCalculated) {
      setDisplay('0.');
      setWaitingForNewValue(false);
      setJustCalculated(false);
      return;
    }
    if (!display.includes('.')) {
      setDisplay(display + '.');
    }
  };
  const performCalculation = (op: string, a: number, b: number): number => {
    switch (op) {
      case '+':
        return a + b;
      case '−':
        return a - b;
      case '×':
        return a * b;
      case '÷':
        return b !== 0 ? a / b : 0;
      default:
        return b;
    }
  };
  const handleOperator = (nextOperator: string) => {
    const currentDisplayValue = parseFloat(display);
    if (justCalculated) {
      setPreviousValue(currentDisplayValue);
      setOperator(nextOperator);
      setEquation(`${formatDisplay(currentDisplayValue)} ${nextOperator}`);
      setWaitingForNewValue(true);
      setJustCalculated(false);
      return;
    }
    if (waitingForNewValue && operator) {
      setOperator(nextOperator);
      setEquation(
        `${previousValue !== null ? formatDisplay(previousValue) : display} ${nextOperator}`
      );
      return;
    }
    if (previousValue !== null && operator) {
      const result = performCalculation(
        operator,
        previousValue,
        currentDisplayValue
      );
      const formatted = formatDisplay(result);
      setDisplay(formatted);
      setPreviousValue(result);
      setEquation(`${formatted} ${nextOperator}`);
    } else {
      setPreviousValue(currentDisplayValue);
      setEquation(`${display} ${nextOperator}`);
    }
    setWaitingForNewValue(true);
    setOperator(nextOperator);
  };
  const handleEqual = () => {
    if (!operator || previousValue === null) return;
    const currentDisplayValue = parseFloat(display);
    const result = performCalculation(
      operator,
      previousValue,
      currentDisplayValue
    );
    const formatted = formatDisplay(result);
    setEquation(`${formatDisplay(previousValue)} ${operator} ${display} =`);
    setDisplay(formatted);
    setPreviousValue(null);
    setOperator(null);
    setWaitingForNewValue(false);
    setJustCalculated(true);
  };
  const handleClear = () => {
    setDisplay('0');
    setEquation('');
    setPreviousValue(null);
    setOperator(null);
    setWaitingForNewValue(false);
    setJustCalculated(false);
  };
  const handleDelete = () => {
    if (waitingForNewValue || justCalculated) return;
    setDisplay(display.length > 1 ? display.slice(0, -1) : '0');
  };
  const handlePercent = () => {
    const val = parseFloat(display);
    if (previousValue !== null) {
      const percentVal = previousValue * (val / 100);
      setDisplay(formatDisplay(percentVal));
    } else {
      setDisplay(formatDisplay(val / 100));
    }
  };
  const handleChangeDigit = (digit: string) => {
    if (activeInput === 'owed') {
      if (totalOwed.replace('.', '').length >= 10) return;
      setTotalOwed(totalOwed === '0' ? digit : totalOwed + digit);
    } else {
      if (amountReceived.replace('.', '').length >= 10) return;
      setAmountReceived(amountReceived === '0' ? digit : amountReceived + digit);
    }
  };
  const handleChangeDelete = () => {
    if (activeInput === 'owed') {
      setTotalOwed(totalOwed.length > 1 ? totalOwed.slice(0, -1) : '');
    } else {
      setAmountReceived(
        amountReceived.length > 1 ? amountReceived.slice(0, -1) : ''
      );
    }
  };
  const handleChangeDecimal = () => {
    if (activeInput === 'owed') {
      if (!totalOwed.includes('.')) setTotalOwed((totalOwed || '0') + '.');
    } else {
      if (!amountReceived.includes('.'))
      setAmountReceived((amountReceived || '0') + '.');
    }
  };
  const owed = parseFloat(totalOwed) || 0;
  const received = parseFloat(amountReceived) || 0;
  const change = received - owed;
  // Shared button styles
  const btn =
  'rounded-xl font-bold active:scale-95 transition-transform flex items-center justify-center text-base';
  const numBtn = `${btn} bg-slate-800 text-white`;
  const opBtn = (op: string) =>
  `${btn} ${operator === op && waitingForNewValue ? 'bg-white text-emerald-600' : 'bg-emerald-600 text-white'}`;
  return (
    <motion.div
      initial={{
        opacity: 0,
        y: 10
      }}
      animate={{
        opacity: 1,
        y: 0
      }}
      transition={{
        duration: 0.2
      }}
      className="w-full bg-slate-900">
      
      {/* Header */}
      <div className="px-4 pt-8 pb-2">
        <div className="flex items-center mb-2">
          <button
            onClick={() => navigate('home')}
            className="p-1.5 -ml-1.5 text-slate-400 hover:text-white transition-colors">
            
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h2 className="text-base font-bold ml-1 text-white">Calculator</h2>
        </div>

        <div className="flex p-0.5 bg-slate-800 rounded-lg">
          <button
            onClick={() => setMode('standard')}
            className={`flex-1 py-1.5 text-[11px] font-medium rounded-md transition-all flex items-center justify-center gap-1 ${mode === 'standard' ? 'bg-slate-700 text-white shadow-sm' : 'text-slate-400'}`}>
            
            <CalcIcon className="w-3 h-3" />
            Standard
          </button>
          <button
            onClick={() => setMode('change')}
            className={`flex-1 py-1.5 text-[11px] font-medium rounded-md transition-all flex items-center justify-center gap-1 ${mode === 'change' ? 'bg-emerald-600 text-white shadow-sm' : 'text-slate-400'}`}>
            
            <Coins className="w-3 h-3" />
            Change
          </button>
        </div>
      </div>

      {/* Standard Calculator */}
      {mode === 'standard' ?
      <div className="px-3 pt-2 pb-24">
          {/* Display */}
          <div className="min-h-[80px] flex flex-col justify-end items-end mb-3 px-1">
            <div className="text-slate-500 text-xs font-mono tracking-wider truncate w-full text-right leading-tight">
              {equation || '\u00A0'}
            </div>
            <div className="text-white text-4xl font-bold font-mono tracking-tight break-all text-right w-full leading-snug mt-1">
              {display}
            </div>
          </div>

          {/* Keypad */}
          <div className="grid grid-cols-4 gap-2">
            <button
            onClick={handleClear}
            className={`${btn} bg-slate-700 text-white h-12`}>
            
              AC
            </button>
            <button
            onClick={handlePercent}
            className={`${btn} bg-slate-700 text-white h-12`}>
            
              %
            </button>
            <button
            onClick={handleDelete}
            className={`${btn} bg-slate-700 text-slate-300 h-12`}>
            
              <Delete className="w-4 h-4" />
            </button>
            <button
            onClick={() => handleOperator('÷')}
            className={`${opBtn('÷')} h-12`}>
            
              ÷
            </button>

            {[7, 8, 9].map((n) =>
          <button
            key={n}
            onClick={() => handleDigit(String(n))}
            className={`${numBtn} h-12`}>
            
                {n}
              </button>
          )}
            <button
            onClick={() => handleOperator('×')}
            className={`${opBtn('×')} h-12`}>
            
              ×
            </button>

            {[4, 5, 6].map((n) =>
          <button
            key={n}
            onClick={() => handleDigit(String(n))}
            className={`${numBtn} h-12`}>
            
                {n}
              </button>
          )}
            <button
            onClick={() => handleOperator('−')}
            className={`${opBtn('−')} h-12`}>
            
              −
            </button>

            {[1, 2, 3].map((n) =>
          <button
            key={n}
            onClick={() => handleDigit(String(n))}
            className={`${numBtn} h-12`}>
            
                {n}
              </button>
          )}
            <button
            onClick={() => handleOperator('+')}
            className={`${opBtn('+')} h-12`}>
            
              +
            </button>

            <button
            onClick={() => handleDigit('0')}
            className={`col-span-2 ${numBtn} h-12`}>
            
              0
            </button>
            <button onClick={handleDecimal} className={`${numBtn} h-12`}>
              .
            </button>
            <button
            onClick={handleEqual}
            className={`${btn} bg-emerald-500 text-white h-12`}>
            
              =
            </button>
          </div>
        </div> /* Change Calculator */ :

      <div className="px-3 pt-2 pb-24">
          {/* Input fields */}
          <div className="space-y-2 mb-3">
            <div
            onClick={() => setActiveInput('owed')}
            className={`px-4 py-3 rounded-xl border-2 transition-colors cursor-pointer ${activeInput === 'owed' ? 'border-emerald-500 bg-slate-800' : 'border-slate-700 bg-slate-800/50'}`}>
            
              <p className="text-slate-400 text-[10px] mb-0.5 uppercase tracking-wider">
                Total Owed
              </p>
              <div className="text-xl font-bold text-white flex items-center">
                <span className="text-slate-500 mr-1 text-base">R</span>
                {totalOwed || '0'}
              </div>
            </div>

            <div
            onClick={() => setActiveInput('received')}
            className={`px-4 py-3 rounded-xl border-2 transition-colors cursor-pointer ${activeInput === 'received' ? 'border-emerald-500 bg-slate-800' : 'border-slate-700 bg-slate-800/50'}`}>
            
              <p className="text-slate-400 text-[10px] mb-0.5 uppercase tracking-wider">
                Amount Received
              </p>
              <div className="text-xl font-bold text-white flex items-center">
                <span className="text-slate-500 mr-1 text-base">R</span>
                {amountReceived || '0'}
              </div>
            </div>
          </div>

          {/* Change result */}
          <div className="border-t border-slate-700 py-3 mb-4">
            <p className="text-slate-400 text-[10px] mb-1 text-center uppercase tracking-wider">
              Change to Give
            </p>
            <div
            className={`text-3xl font-bold text-center ${change >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            
              R {Math.abs(change).toFixed(2)}
            </div>
            {change < 0 &&
          <p className="text-[10px] text-red-400 text-center mt-1">
                Short by R{Math.abs(change).toFixed(2)}
              </p>
          }
          </div>

          {/* Keypad */}
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
          <button
            key={n}
            onClick={() => handleChangeDigit(String(n))}
            className={`${numBtn} h-12`}>
            
                {n}
              </button>
          )}
            <button onClick={handleChangeDecimal} className={`${numBtn} h-12`}>
              .
            </button>
            <button
            onClick={() => handleChangeDigit('0')}
            className={`${numBtn} h-12`}>
            
              0
            </button>
            <button
            onClick={handleChangeDelete}
            className={`${btn} bg-slate-700 text-slate-300 h-12`}>
            
              <Delete className="w-4 h-4" />
            </button>

            <button
            onClick={() => {
              setTotalOwed('');
              setAmountReceived('');
              setActiveInput('owed');
            }}
            className={`col-span-3 ${btn} bg-slate-700 text-white h-11 mt-1`}>
            
              Clear All
            </button>
          </div>
        </div>
      }
    </motion.div>);

}