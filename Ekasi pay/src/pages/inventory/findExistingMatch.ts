import { barcodesMatch } from '../../lib/productBarcode';
import type { Product } from '../../types';

/**
 * Find an existing product with the same barcode (preferred — unambiguous)
 * or the same normalised name. Used so adding "Albany Bread" twice tops up
 * the existing SKU instead of creating a duplicate row.
 */
export function findExistingMatch(
  products: Product[],
  name: string,
  barcode: string,
): Product | null {
  const code = barcode.trim();
  if (code.length > 0) {
    const byCode = products.find((p) => {
      const existingBarcode = (p.barcode ?? '').trim();
      return existingBarcode.length > 0 && barcodesMatch(existingBarcode, code);
    });
    if (byCode) return byCode;
  }
  const normalisedName = name.trim().toLowerCase();
  if (normalisedName.length === 0) return null;
  return (
    products.find((p) => p.name.trim().toLowerCase() === normalisedName) ?? null
  );
}
