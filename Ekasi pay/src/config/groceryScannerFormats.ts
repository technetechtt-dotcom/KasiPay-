import { Html5QrcodeSupportedFormats } from 'html5-qrcode';

/**
 * Grocery-industry symbologies enabled for camera scanning (South Africa retail).
 *
 * | Format              | Use case                                      | ZXing / html5-qrcode |
 * |---------------------|-----------------------------------------------|----------------------|
 * | EAN-13              | Standard 13-digit on packaged goods (SA norm) | EAN_13               |
 * | UPC-A               | 12-digit USA/Canada (accepted at SA tills)    | UPC_A                |
 * | UPC-E               | Compressed UPC                                  | UPC_E                |
 * | EAN-8               | Small packs (sweets, etc.)                    | EAN_8                |
 * | Weighted EAN-13     | Deli / bakery / counter scales (prefix `2`)   | EAN_13               |
 * | ITF-14              | Carton & case logistics (14-digit)            | ITF                  |
 * | GS1 DataBar         | Fresh perishables (weight, batch, expiry)     | RSS_14, RSS_EXPANDED |
 * | QR / Data Matrix    | 2D traceability & digital coupons             | QR_CODE, DATA_MATRIX |
 * | GS1-128             | Case / logistics linear barcodes              | CODE_128             |
 */
export const GROCERY_PRODUCT_SCAN_FORMATS: Html5QrcodeSupportedFormats[] = [
  Html5QrcodeSupportedFormats.EAN_13,
  Html5QrcodeSupportedFormats.EAN_8,
  Html5QrcodeSupportedFormats.UPC_A,
  Html5QrcodeSupportedFormats.UPC_E,
  Html5QrcodeSupportedFormats.ITF,
  Html5QrcodeSupportedFormats.RSS_14,
  Html5QrcodeSupportedFormats.RSS_EXPANDED,
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
  Html5QrcodeSupportedFormats.CODE_128,
];

/** SA ID book / card barcodes (Cash Send flows). */
export const ID_DOCUMENT_SCAN_FORMATS: Html5QrcodeSupportedFormats[] = [
  Html5QrcodeSupportedFormats.PDF_417,
  Html5QrcodeSupportedFormats.CODE_128,
  Html5QrcodeSupportedFormats.QR_CODE,
  Html5QrcodeSupportedFormats.DATA_MATRIX,
];

export function formatsForScannerSession(
  capture: 'product' | 'sender-id' | 'beneficiary-id' | 'collect-id' | undefined,
): Html5QrcodeSupportedFormats[] {
  return capture === 'product'
    ? GROCERY_PRODUCT_SCAN_FORMATS
    : ID_DOCUMENT_SCAN_FORMATS;
}

export const GROCERY_PRODUCT_SCAN_HINT =
  'EAN-13 & UPC-A packaged goods, EAN-8 small items, weighed deli/bakery labels, ITF-14 cartons, GS1 DataBar produce, and QR/Data Matrix.';

export const ID_SCAN_HINT =
  'Point at the SA ID barcode on the book or card.';

export const GROCERY_BARCODE_TYPES = [
  { id: 'ean13', label: 'EAN-13', description: 'Standard 13-digit barcode on packaged goods in South Africa.' },
  { id: 'upca', label: 'UPC-A', description: '12-digit USA/Canada format — accepted at Shoprite-class POS tills.' },
  { id: 'ean8', label: 'EAN-8', description: 'Condensed 8-digit code for small products.' },
  { id: 'weighted', label: 'Weighted EAN-13', description: 'Deli, bakery, or counter scales — embeds PLU plus weight or price.' },
  { id: 'itf14', label: 'ITF-14', description: '14-digit carton / case barcode for bulk warehouse scanning.' },
  { id: 'gs1_databar', label: 'GS1 DataBar', description: 'Fresh perishables with weight, batch, and expiry data.' },
  { id: 'qr', label: 'QR / 2D', description: 'Traceability and digital coupon barcodes on modern packaging.' },
] as const;
