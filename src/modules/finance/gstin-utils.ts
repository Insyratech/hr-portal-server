/** GSTIN lookup result + local parse. External enrichment lives in gstin-lookup.ts. */

const STATE_BY_CODE: Record<string, string> = {
  '01': 'Jammu and Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/;

export type GstinLookupSource =
  | 'parsed'
  | 'customer_master'
  | 'vendor_master'
  | 'org_master'
  | 'gst_profile'
  | 'gst_network';

export type GstinLookupResult = {
  gstin: string;
  validFormat: boolean;
  stateCode: string | null;
  stateName: string | null;
  pan: string | null;
  /** Legal / company name when known. */
  legalName: string | null;
  tradeName: string | null;
  cin: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  /** Full multiline address for forms that still use a single text field. */
  billingAddress: string | null;
  shippingAddress: string | null;
  registrationType: 'regular' | 'composition' | 'unregistered' | null;
  source: GstinLookupSource;
  message: string;
};

export function normalizeGstin(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export function emptyGstinLookup(gstin: string, message: string): GstinLookupResult {
  return {
    gstin,
    validFormat: false,
    stateCode: null,
    stateName: null,
    pan: null,
    legalName: null,
    tradeName: null,
    cin: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    postalCode: null,
    billingAddress: null,
    shippingAddress: null,
    registrationType: null,
    source: 'parsed',
    message,
  };
}

export function composeBillingAddress(parts: {
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateName?: string | null;
  postalCode?: string | null;
}): string | null {
  const lines = [
    parts.addressLine1?.trim(),
    parts.addressLine2?.trim(),
    [parts.city?.trim(), parts.stateName?.trim(), parts.postalCode?.trim()].filter(Boolean).join(', '),
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : null;
}

export function parseGstin(raw: string): GstinLookupResult {
  const gstin = normalizeGstin(raw);
  const validFormat = GSTIN_REGEX.test(gstin);
  if (!validFormat || gstin.length !== 15) {
    return emptyGstinLookup(
      gstin,
      'GSTIN format looks invalid. Check and try again, or enter details manually.',
    );
  }
  const stateCode = gstin.slice(0, 2);
  const pan = gstin.slice(2, 12);
  const stateName = STATE_BY_CODE[stateCode] ?? null;
  return {
    gstin,
    validFormat: true,
    stateCode,
    stateName,
    pan,
    legalName: null,
    tradeName: null,
    cin: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    postalCode: null,
    billingAddress: null,
    shippingAddress: null,
    registrationType: null,
    source: 'parsed',
    message: stateName
      ? `GSTIN decoded: state ${stateName} (${stateCode}), PAN ${pan}. Looking up company details…`
      : `GSTIN decoded: state code ${stateCode}, PAN ${pan}. Looking up company details…`,
  };
}

export function mergeGstinLookup(
  base: GstinLookupResult,
  patch: Partial<GstinLookupResult>,
): GstinLookupResult {
  const next: GstinLookupResult = { ...base };
  for (const [key, value] of Object.entries(patch) as [keyof GstinLookupResult, GstinLookupResult[keyof GstinLookupResult]][]) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  if (!next.billingAddress) {
    next.billingAddress = composeBillingAddress({
      addressLine1: next.addressLine1,
      addressLine2: next.addressLine2,
      city: next.city,
      stateName: next.stateName,
      postalCode: next.postalCode,
    });
  }
  return next;
}

export function finalizeGstinLookupMessage(result: GstinLookupResult): GstinLookupResult {
  if (!result.validFormat) return result;
  const bits: string[] = [];
  if (result.legalName) bits.push('company name');
  if (result.tradeName) bits.push('trade name');
  if (result.cin) bits.push('CIN');
  if (result.addressLine1 || result.billingAddress) bits.push('address');
  if (result.pan) bits.push('PAN');
  if (result.stateName) bits.push(`state ${result.stateName}`);

  let message: string;
  if (bits.length <= 2 && result.source === 'parsed') {
    message = result.stateName
      ? `GSTIN decoded: state ${result.stateName} (${result.stateCode}), PAN ${result.pan}. Enter company name, CIN, and address manually or configure GST network lookup.`
      : `GSTIN decoded: state code ${result.stateCode}, PAN ${result.pan}. Enter details manually.`;
  } else if (result.source === 'gst_network') {
    message = `GST network returned ${bits.join(', ')}. Review and auto-fill or edit.`;
  } else if (result.source === 'customer_master') {
    message = `Matched customer master (${bits.join(', ')}). Confirm or edit before continuing.`;
  } else if (result.source === 'vendor_master') {
    message = `Matched vendor master (${bits.join(', ')}). Confirm or edit before continuing.`;
  } else if (result.source === 'gst_profile') {
    message = `Matched existing GST registration (${bits.join(', ')}). Confirm or edit before continuing.`;
  } else if (result.source === 'org_master') {
    message = `Matched organisation profile by PAN/GSTIN (${bits.join(', ')}). Address may differ for this state — confirm.`;
  } else {
    message = `Lookup ready: ${bits.join(', ')}. Confirm or edit before continuing.`;
  }
  return { ...result, message };
}

export function istTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function addDaysIso(isoDate: string, days: number): string {
  const base = new Date(`${isoDate}T12:00:00+05:30`);
  base.setUTCDate(base.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(base);
}

export function formatIstDisplay(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
}

export function defaultQuoteTerms(expiryIso: string): string {
  const until = formatIstDisplay(expiryIso);
  return [
    `1. This quotation is valid for 30 days from the quote date (until ${until}, IST).`,
    '2. Prices are in INR and exclusive of taxes unless stated otherwise.',
    '3. GST will be charged as applicable under the GST Act.',
    '4. Payment terms as agreed on the purchase order / advance instruction.',
    '5. Delivery / TAT as mentioned in the notes or as mutually agreed.',
    '6. Please mention the quotation number on your purchase order.',
  ].join('\n');
}

export function defaultQuoteNotes(expiryIso: string): string {
  return `Looking forward to your business. This quotation remains valid until ${formatIstDisplay(expiryIso)} (IST).`;
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const t = Math.floor(n / 10);
  const o = n % 10;
  return `${TENS[t]}${o ? ` ${ONES[o]}` : ''}`.trim();
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h && r) return `${ONES[h]} Hundred ${twoDigits(r)}`;
  if (h) return `${ONES[h]} Hundred`;
  return twoDigits(r);
}

/** Indian numbering: crore / lakh / thousand. */
export function amountInWordsInr(amount: number): string {
  const rounded = Math.round(amount);
  if (rounded === 0) return 'Indian Rupee Zero Only';
  let n = rounded;
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  const rest = n;
  const parts: string[] = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${threeDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return `Indian Rupee ${parts.join(' ')} Only`;
}
