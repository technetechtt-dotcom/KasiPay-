/**
 * Lookup packaged-goods metadata from public barcode databases.
 * Open Food Facts is free and covers many SA retail SKUs (no API key).
 */

export type BarcodeCatalogHit = {
  found: boolean;
  name?: string;
  brand?: string;
  imageUrl?: string;
  category?: 'Food' | 'Drinks' | 'Household' | 'Airtime';
  source: 'openfoodfacts' | 'none';
};

const OFF_USER_AGENT = 'EkasiPay/1.0 (barcode lookup; contact@ekasipay.local)';

function mapOffCategory(tags: string[] | undefined): BarcodeCatalogHit['category'] {
  const joined = (tags ?? []).join(' ').toLowerCase();
  if (joined.includes('beverage') || joined.includes('drink')) return 'Drinks';
  if (joined.includes('household') || joined.includes('cleaning')) return 'Household';
  return 'Food';
}

export async function lookupBarcodeInCatalog(
  rawCode: string,
): Promise<BarcodeCatalogHit> {
  const digits = rawCode.replace(/\D/g, '');
  let lookup = digits;

  if (digits.length === 13 && digits[0] === '2') {
    lookup = `${digits.slice(0, 6)}${'0'.repeat(7)}`.slice(0, 13);
  } else if (digits.startsWith('01') && digits.length >= 16) {
    lookup = digits.slice(2, 16).slice(1);
  } else if (digits.length === 14) {
    lookup = digits.slice(1);
  } else if (digits.length === 12) {
    lookup = `0${digits}`;
  } else if (digits.length === 8) {
    lookup = `000000${digits}`;
  }
  if (lookup.length < 8) {
    return { found: false, source: 'none' };
  }

  const code = lookup;

  try {
    const res = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`,
      {
        headers: { 'User-Agent': OFF_USER_AGENT },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      return { found: false, source: 'none' };
    }
    const data = (await res.json()) as {
      status?: number;
      product?: {
        product_name?: string;
        generic_name?: string;
        brands?: string;
        image_front_small_url?: string;
        image_small_url?: string;
        image_url?: string;
        categories_tags?: string[];
      };
    };
    if (data.status !== 1 || !data.product) {
      return { found: false, source: 'none' };
    }
    const p = data.product;
    const name =
      p.product_name?.trim() ||
      p.generic_name?.trim() ||
      undefined;
    if (!name) {
      return { found: false, source: 'none' };
    }
    const brand = p.brands?.split(',')[0]?.trim();
    const imageUrl =
      p.image_front_small_url?.trim() ||
      p.image_small_url?.trim() ||
      p.image_url?.trim() ||
      undefined;
    return {
      found: true,
      name: brand ? `${brand} ${name}` : name,
      brand,
      imageUrl,
      category: mapOffCategory(p.categories_tags),
      source: 'openfoodfacts',
    };
  } catch {
    return { found: false, source: 'none' };
  }
}
