import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Html5Qrcode,
  Html5QrcodeScannerState,
} from 'html5-qrcode';
import { PageTransition, KPButton } from '../../components/shared/UIComponents';
import {
  X,
  ScanLine,
  CameraOff,
  CheckCircle2,
  PackagePlus,
  ShoppingCart,
  Package,
} from 'lucide-react';
import {
  defaultStockMode,
  digitsFromBarcodeForSaId,
  isContinuousProductScan,
  readScannerSession,
  clearScannerSession,
  storePendingProductCatalogHit,
  updateScannerSession,
  type StockScanMode,
} from '../../lib/scannerSession';
import { vibrateScanSuccess } from '../../lib/scannerFeedback';
import { groceryLookupCode } from '../../lib/productBarcode';
import { apiLookupProductBarcode, type BarcodeCatalogHit } from '../../services/api';
import {
  formatsForScannerSession,
  GROCERY_PRODUCT_SCAN_HINT,
  ID_SCAN_HINT,
} from '../../config/groceryScannerFormats';

async function safeStopScanner(
  scanner: Html5Qrcode | null,
  startPromise?: Promise<unknown> | null,
): Promise<void> {
  if (!scanner) return;
  if (startPromise) {
    try {
      await startPromise;
    } catch {
      /* start failed */
    }
  }
  let state: Html5QrcodeScannerState | undefined;
  try {
    state = scanner.getState();
  } catch {
    state = undefined;
  }
  if (
    state === Html5QrcodeScannerState.SCANNING ||
    state === Html5QrcodeScannerState.PAUSED
  ) {
    try {
      await scanner.stop();
    } catch {
      /* ignore */
    }
  }
  try {
    const maybe = scanner.clear() as unknown;
    if (
      maybe &&
      typeof (maybe as { then?: unknown }).then === 'function'
    ) {
      try {
        await (maybe as Promise<unknown>);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

const SCAN_DEBOUNCE_MS = 1400;
const SCANNER_CATALOG_LOOKUP_TIMEOUT_MS = 1800;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function quickCatalogLookup(code: string): Promise<BarcodeCatalogHit | null> {
  try {
    const timeout = new Promise<null>((resolve) =>
      window.setTimeout(() => resolve(null), SCANNER_CATALOG_LOOKUP_TIMEOUT_MS),
    );
    return await Promise.race([apiLookupProductBarcode(code), timeout]);
  } catch {
    return null;
  }
}

type CatalogPreviewState =
  | {
      phase: 'loading';
    }
  | {
      phase: 'found';
      name: string;
      brand?: string;
      imageUrl?: string;
    }
  | {
      phase: 'not-found';
    };

export const ScannerPage = ({
  onDecoded,
  navigate,
}: {
  /** Return `true` to keep scanning (continuous mode), `false` to finish. */
  onDecoded: (raw: string) => boolean | Promise<boolean>;
  navigate: (p: string) => void;
}) => {
  const reactId = useId().replace(/\W/g, '');
  const elementId = useMemo(() => `h5qr-${reactId}`, [reactId]);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const startPromiseRef = useRef<Promise<unknown> | null>(null);
  const finishedRef = useRef(false);
  const onDecodedRef = useRef(onDecoded);
  onDecodedRef.current = onDecoded;
  const lastScanKeyRef = useRef<{ key: string; at: number } | null>(null);
  const processingRef = useRef(false);
  const scanCountRef = useRef(0);

  const sessionPeek = useMemo(() => readScannerSession(), []);
  const continuous = isContinuousProductScan(sessionPeek);
  const isProduct = sessionPeek?.capture === 'product';
  const isShop = sessionPeek?.returnPage === 'shop';

  const [cameraError, setCameraError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(true);
  const [stockMode, setStockMode] = useState<StockScanMode>(
    defaultStockMode(sessionPeek),
  );
  const [scanCount, setScanCount] = useState(0);
  const [lastLabel, setLastLabel] = useState<string | null>(null);
  const [flashOk, setFlashOk] = useState(false);
  const [catalogPreview, setCatalogPreview] = useState<CatalogPreviewState | null>(
    null,
  );

  const titleLabel =
    sessionPeek?.capture === 'sender-id' ||
    sessionPeek?.capture === 'beneficiary-id' ||
    sessionPeek?.capture === 'collect-id'
      ? 'Scan SA ID'
      : continuous
        ? isShop
          ? 'Scan to sell'
          : 'Scan stock'
        : 'Scan product barcode';

  const subtitle = isProduct ? GROCERY_PRODUCT_SCAN_HINT : ID_SCAN_HINT;

  const fallbackReturnPage = sessionPeek?.returnPage ?? 'add-stock';

  const finishAndReturn = useCallback(() => {
    finishedRef.current = true;
    clearScannerSession();
    setCatalogPreview(null);
    void safeStopScanner(scannerRef.current, startPromiseRef.current).finally(
      () => {
        scannerRef.current = null;
        startPromiseRef.current = null;
        navigate(fallbackReturnPage);
      },
    );
  }, [fallbackReturnPage, navigate]);

  const triggerSuccessFeedback = useCallback((label: string) => {
    vibrateScanSuccess();
    setLastLabel(label);
    setFlashOk(true);
    scanCountRef.current += 1;
    setScanCount(scanCountRef.current);
    window.setTimeout(() => setFlashOk(false), 450);
  }, []);

  const setMode = (mode: StockScanMode) => {
    setStockMode(mode);
    updateScannerSession({ stockMode: mode });
  };

  useEffect(() => {
    finishedRef.current = false;
    lastScanKeyRef.current = null;
    scanCountRef.current = 0;

    const scanFormats = formatsForScannerSession(sessionPeek?.capture);

    const html5Qr = new Html5Qrcode(elementId, {
      verbose: false,
      formatsToSupport: scanFormats,
    });
    scannerRef.current = html5Qr;

    const onSuccess = async (decodedText: string) => {
      if (finishedRef.current || processingRef.current) return;

      const normalizedKey = isProduct
        ? groceryLookupCode(decodedText)
        : digitsFromBarcodeForSaId(decodedText);
      const key = normalizedKey.trim()
        ? `${isProduct ? 'product' : 'id'}:${normalizedKey.trim()}`
        : decodedText.trim();
      const now = Date.now();
      const last = lastScanKeyRef.current;
      if (last && last.key === key && now - last.at < SCAN_DEBOUNCE_MS) {
        return;
      }
      lastScanKeyRef.current = { key, at: now };

      processingRef.current = true;
      let keepScanning = true;
      try {
        if (isProduct && !continuous && fallbackReturnPage === 'add-stock') {
          const lookupCode = groceryLookupCode(decodedText).trim();
          if (lookupCode.length >= 8) {
            setCatalogPreview({ phase: 'loading' });
            const hit = await quickCatalogLookup(lookupCode);
            if (hit) {
              storePendingProductCatalogHit({
                code: lookupCode,
                found: hit.found,
                name: hit.name,
                brand: hit.brand,
                imageUrl: hit.imageUrl,
                category: hit.category,
                source: hit.source,
              });
              if (hit.found && hit.name) {
                setCatalogPreview({
                  phase: 'found',
                  name: hit.name,
                  brand: hit.brand,
                  imageUrl: hit.imageUrl,
                });
              } else {
                setCatalogPreview({ phase: 'not-found' });
              }
              await sleep(hit.found ? 420 : 260);
            } else {
              setCatalogPreview(null);
            }
          }
        }
        keepScanning = await Promise.resolve(onDecodedRef.current(decodedText));
      } catch (err) {
        // Keep scanner alive if route logic throws for one frame.
        console.error('[Scanner] decode handler failed', err);
        keepScanning = true;
      }

      if (keepScanning) {
        triggerSuccessFeedback(key.slice(0, 24));
        processingRef.current = false;
        return;
      }

      finishedRef.current = true;
      clearScannerSession();
      await safeStopScanner(html5Qr, startPromiseRef.current);
      navigate(fallbackReturnPage);
      processingRef.current = false;
    };

    const qrbox = continuous
      ? (w: number, h: number) => {
          const width = Math.min(Math.floor(w * 0.92), w - 16);
          const height = Math.min(Math.floor(h * 0.42), Math.floor(width * 0.45));
          return { width, height };
        }
      : { width: 280, height: 160 };

    const config = {
      fps: continuous ? 12 : 8,
      qrbox,
      aspectRatio: 1.77,
      disableFlip: false,
    };

    const startPromise = html5Qr
      .start({ facingMode: 'environment' }, config, onSuccess, () => undefined)
      .then(() => {
        if (!finishedRef.current) setIsStarting(false);
      })
      .catch((err: unknown) => {
        console.error('[Scanner]', err);
        if (finishedRef.current) return;
        setIsStarting(false);
        setCameraError(
          err instanceof Error
            ? err.message
            : 'Could not start the camera. Use a plugged-in scanner/wedge or enter the code manually.',
        );
      });
    startPromiseRef.current = startPromise;

    return () => {
      finishedRef.current = true;
      void safeStopScanner(html5Qr, startPromise).finally(() => {
        if (scannerRef.current === html5Qr) scannerRef.current = null;
        if (startPromiseRef.current === startPromise) {
          startPromiseRef.current = null;
        }
      });
    };
  }, [
    elementId,
    sessionPeek?.capture,
    continuous,
    isProduct,
    triggerSuccessFeedback,
    fallbackReturnPage,
    navigate,
  ]);

  return (
    <PageTransition className="min-h-0 h-full bg-slate-900 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full p-6 pt-12 z-20 flex justify-between items-start bg-gradient-to-b from-black/70 to-transparent pointer-events-none">
        <div className="pointer-events-auto pr-14 max-w-[70%]">
          <h2 className="text-white font-bold text-lg">{titleLabel}</h2>
          <p className="text-white/70 text-xs mt-1 leading-snug">{subtitle}</p>
          {catalogPreview?.phase === 'loading' && (
            <div className="mt-2 inline-flex items-center rounded-full bg-emerald-500/20 border border-emerald-300/40 px-3 py-1 text-[11px] font-medium text-emerald-100">
              Identifying product...
            </div>
          )}
          {catalogPreview?.phase === 'found' && (
            <div className="mt-2 flex items-center gap-2 rounded-xl bg-emerald-500/20 border border-emerald-300/40 px-2.5 py-2 text-emerald-100">
              <div className="w-8 h-8 rounded-lg bg-emerald-400/25 border border-emerald-200/30 flex items-center justify-center shrink-0">
                {catalogPreview.imageUrl ? (
                  <img
                    src={catalogPreview.imageUrl}
                    alt={catalogPreview.name}
                    className="w-full h-full rounded-lg object-cover"
                    loading="eager"
                    referrerPolicy="no-referrer"
                  />
                ) : catalogPreview.brand?.trim() ? (
                  <span className="text-[10px] font-bold uppercase leading-none">
                    {catalogPreview.brand.trim().slice(0, 2)}
                  </span>
                ) : (
                  <Package className="w-4 h-4" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold truncate">
                  Found: {catalogPreview.name}
                </p>
                {catalogPreview.brand?.trim() && (
                  <span className="inline-flex mt-0.5 rounded-full border border-emerald-200/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                    {catalogPreview.brand}
                  </span>
                )}
              </div>
            </div>
          )}
          {catalogPreview?.phase === 'not-found' && (
            <div className="mt-2 inline-flex items-center rounded-full bg-slate-500/25 border border-slate-300/30 px-3 py-1 text-[11px] font-medium text-slate-100">
              No product found in catalog
            </div>
          )}
          {continuous && (
            <p className="text-emerald-300/90 text-[11px] mt-2 font-medium">
              Continuous mode — scan multiple items, then tap Done
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={finishAndReturn}
          className="pointer-events-auto absolute top-12 right-6 w-10 h-10 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center text-white active:bg-white/30 transition-colors">
          <X className="w-5 h-5" />
        </button>
      </div>

      {continuous && isProduct && !isShop && (
        <div className="absolute top-[7.5rem] left-0 right-0 z-20 flex justify-center px-6 pointer-events-none">
          <div className="pointer-events-auto flex rounded-xl bg-black/50 backdrop-blur-md p-1 border border-white/15">
            <button
              type="button"
              onClick={() => setMode('restock')}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
                stockMode === 'restock'
                  ? 'bg-emerald-600 text-white'
                  : 'text-white/70'
              }`}>
              <PackagePlus className="w-4 h-4" />
              Restock (+)
            </button>
            <button
              type="button"
              onClick={() => setMode('sale')}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold transition-colors ${
                stockMode === 'sale'
                  ? 'bg-amber-600 text-white'
                  : 'text-white/70'
              }`}>
              <ShoppingCart className="w-4 h-4" />
              Sale (−)
            </button>
          </div>
        </div>
      )}

      {continuous && isShop && (
        <div className="absolute top-[7.5rem] left-0 right-0 z-20 flex justify-center pointer-events-none">
          <span className="px-3 py-1.5 rounded-full bg-blue-600/90 text-white text-xs font-semibold">
            Sale mode — each scan adds to cart
          </span>
        </div>
      )}

      <div className="flex-1 relative flex flex-col min-h-0">
        {!cameraError ? (
          <div
            id={elementId}
            className="w-full flex-1 min-h-[55vh] bg-black [&_video]:object-cover [&_#qr-shaded-region]:border-emerald-400/80"
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
            <CameraOff className="w-14 h-14 text-white/40 mb-4" />
            <p className="text-white font-medium mb-2">Camera unavailable</p>
            <p className="text-white/65 text-sm mb-6">{cameraError}</p>
          </div>
        )}

        {continuous && !cameraError && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center z-10"
            aria-hidden>
            <div className="w-[92%] max-w-md aspect-[2.2/1] rounded-2xl border-2 border-emerald-400/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}

        <AnimatePresence>
          {flashOk && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-30 pointer-events-none bg-emerald-400/25 flex items-center justify-center">
              <motion.div
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 1.2, opacity: 0 }}
                className="w-20 h-20 rounded-full bg-emerald-500/90 flex items-center justify-center shadow-lg">
                <CheckCircle2 className="w-10 h-10 text-white" />
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {isStarting && !cameraError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 pointer-events-none">
            <div className="flex flex-col items-center gap-3">
              <div className="w-16 h-16 rounded-full border-2 border-emerald-400/80 border-t-transparent animate-spin" />
              <p className="text-white/80 text-sm">Starting camera…</p>
            </div>
          </div>
        ) : null}
      </div>

      <div className="shrink-0 p-6 pb-safe bg-black/90 backdrop-blur-md z-20 flex flex-col gap-3 rounded-t-3xl border-t border-white/10">
        {continuous && scanCount > 0 && (
          <p className="text-center text-emerald-300 text-sm font-medium">
            {scanCount} scan{scanCount === 1 ? '' : 's'} this session
            {lastLabel ? ` · last: ${lastLabel}` : ''}
          </p>
        )}
        {!cameraError && (
          <div className="flex items-center justify-center gap-2 text-white/80 text-sm font-medium pb-1">
            <ScanLine className="w-4 h-4 text-emerald-400" />
            {continuous
              ? 'Align barcode inside the green frame'
              : 'Hold steady until it finishes'}
          </div>
        )}
        <KPButton
          type="button"
          onClick={finishAndReturn}
          className="w-full bg-emerald-600 hover:bg-emerald-700 border-none text-white">
          {continuous ? 'Done' : 'Close'}
        </KPButton>
        <KPButton
          variant="outline"
          type="button"
          onClick={finishAndReturn}
          className="w-full border-white/25 text-white hover:bg-white/10">
          Enter manually instead
        </KPButton>
      </div>
    </PageTransition>
  );
};
