/**
 * Regional / internationalization foundations.
 * Core money paths should resolve rules through this module instead of
 * hard-coding South Africa assumptions.
 */
export type IsoCurrency = 'ZAR' | 'USD' | 'EUR' | 'GBP' | 'BWP' | 'NAD' | 'MZN';

export type CountryCode = 'ZA' | 'BW' | 'NA' | 'MZ' | 'US' | 'GB';

export type RegionConfig = {
  country: CountryCode;
  defaultCurrency: IsoCurrency;
  defaultLedgerPool: string;
  timeZone: string;
  locale: string;
  dataResidency: string;
  kycDocumentTypes: readonly string[];
  taxReceiptMode: 'za-vat' | 'generic' | 'none';
  productGates: Record<string, boolean>;
};

const REGIONS: Record<CountryCode, RegionConfig> = {
  ZA: {
    country: 'ZA',
    defaultCurrency: 'ZAR',
    defaultLedgerPool: 'ZA',
    timeZone: 'Africa/Johannesburg',
    locale: 'en-ZA',
    dataResidency: 'af-south-1-or-za',
    kycDocumentTypes: [
      'cipc_14_3',
      'beee_certificate',
      'municipal_business_reg',
      'proof_of_bank',
    ],
    taxReceiptMode: 'za-vat',
    productGates: {
      cashSend: true,
      utilities: true,
      lending: false,
      insurance: false,
      stokvel: false,
    },
  },
  BW: {
    country: 'BW',
    defaultCurrency: 'BWP',
    defaultLedgerPool: 'BW',
    timeZone: 'Africa/Gaborone',
    locale: 'en-BW',
    dataResidency: 'af-south-1',
    kycDocumentTypes: ['company_registration', 'proof_of_address', 'proof_of_bank'],
    taxReceiptMode: 'generic',
    productGates: { cashSend: false, utilities: false, lending: false, insurance: false, stokvel: false },
  },
  NA: {
    country: 'NA',
    defaultCurrency: 'NAD',
    defaultLedgerPool: 'NA',
    timeZone: 'Africa/Windhoek',
    locale: 'en-NA',
    dataResidency: 'af-south-1',
    kycDocumentTypes: ['company_registration', 'proof_of_address', 'proof_of_bank'],
    taxReceiptMode: 'generic',
    productGates: { cashSend: false, utilities: false, lending: false, insurance: false, stokvel: false },
  },
  MZ: {
    country: 'MZ',
    defaultCurrency: 'MZN',
    defaultLedgerPool: 'MZ',
    timeZone: 'Africa/Maputo',
    locale: 'pt-MZ',
    dataResidency: 'af-south-1',
    kycDocumentTypes: ['company_registration', 'proof_of_address', 'proof_of_bank'],
    taxReceiptMode: 'generic',
    productGates: { cashSend: false, utilities: false, lending: false, insurance: false, stokvel: false },
  },
  US: {
    country: 'US',
    defaultCurrency: 'USD',
    defaultLedgerPool: 'US',
    timeZone: 'America/New_York',
    locale: 'en-US',
    dataResidency: 'us-east-1',
    kycDocumentTypes: ['ein_letter', 'proof_of_address', 'proof_of_bank'],
    taxReceiptMode: 'generic',
    productGates: { cashSend: false, utilities: false, lending: false, insurance: false, stokvel: false },
  },
  GB: {
    country: 'GB',
    defaultCurrency: 'GBP',
    defaultLedgerPool: 'GB',
    timeZone: 'Europe/London',
    locale: 'en-GB',
    dataResidency: 'eu-west-2',
    kycDocumentTypes: ['companies_house', 'proof_of_address', 'proof_of_bank'],
    taxReceiptMode: 'generic',
    productGates: { cashSend: false, utilities: false, lending: false, insurance: false, stokvel: false },
  },
};

export function resolveRegion(
  country = (process.env.DEFAULT_COUNTRY?.trim().toUpperCase() || 'ZA') as CountryCode,
): RegionConfig {
  return REGIONS[country] ?? REGIONS.ZA;
}

export function minorUnitsForCurrency(currency: IsoCurrency): number {
  // ISO 4217 minor units — extend when adding zero-decimal currencies.
  if (currency === 'ZAR' || currency === 'USD' || currency === 'EUR' || currency === 'GBP' || currency === 'BWP' || currency === 'NAD' || currency === 'MZN') {
    return 2;
  }
  return 2;
}

export function listSupportedRegions(): RegionConfig[] {
  return Object.values(REGIONS);
}
