import { useEffect, useState } from 'react';

import {
  DISABLED_RUNTIME_CONTROLS,
  HIDDEN_CUSTOMER_PRODUCTS,
  resolveCustomerProductVisibility,
  type CustomerProductVisibility,
} from '../lib/productVisibility';
import {
  apiGetProductReadiness,
  apiGetRuntimeControls,
  type ProductReadinessStatus,
  type RuntimeProductControls,
} from '../services/api';

type State = {
  controls: RuntimeProductControls;
  readiness: ProductReadinessStatus[] | null;
  visibility: CustomerProductVisibility;
  loading: boolean;
};

const INITIAL: State = {
  controls: DISABLED_RUNTIME_CONTROLS,
  readiness: null,
  visibility: HIDDEN_CUSTOMER_PRODUCTS,
  loading: true,
};

/**
 * Customer-facing product gates from ops: runtime env flags + readiness evidence.
 * Fail-closed until both responses arrive (or errors → all hidden).
 */
export function useCustomerProductVisibility(): State {
  const [state, setState] = useState<State>(INITIAL);

  useEffect(() => {
    let active = true;
    Promise.all([
      apiGetRuntimeControls().catch(() => ({
        controls: DISABLED_RUNTIME_CONTROLS,
      })),
      apiGetProductReadiness().catch(() => ({
        environment: 'sandbox' as const,
        products: [] as ProductReadinessStatus[],
      })),
    ]).then(([controlsRes, readinessRes]) => {
      if (!active) return;
      const controls = controlsRes.controls ?? DISABLED_RUNTIME_CONTROLS;
      const readiness = readinessRes.products ?? [];
      setState({
        controls,
        readiness,
        visibility: resolveCustomerProductVisibility(controls, readiness),
        loading: false,
      });
    });
    return () => {
      active = false;
    };
  }, []);

  return state;
}

/** Runtime flags only (admin screens that do not need Phase-7 readiness). */
export function useRuntimeControls(): {
  controls: RuntimeProductControls;
  loading: boolean;
} {
  const [controls, setControls] = useState<RuntimeProductControls | null>(null);
  useEffect(() => {
    let active = true;
    apiGetRuntimeControls()
      .then((result) => {
        if (active) setControls(result.controls);
      })
      .catch(() => {
        if (active) setControls(DISABLED_RUNTIME_CONTROLS);
      });
    return () => {
      active = false;
    };
  }, []);
  return {
    controls: controls ?? DISABLED_RUNTIME_CONTROLS,
    loading: controls === null,
  };
}
