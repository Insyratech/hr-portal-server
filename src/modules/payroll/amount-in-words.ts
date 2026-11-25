/**
 * Convert a non-negative INR amount to words (Indian numbering).
 * Rupees from the integer part; paise from the fractional part (rounded to 2 dp).
 */

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
] as const;

const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'] as const;

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  const ten = Math.floor(n / 10);
  const one = n % 10;
  return one === 0 ? TENS[ten]! : `${TENS[ten]} ${ONES[one]}`;
}

function threeDigits(n: number): string {
  if (n < 100) return twoDigits(n);
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  return rest === 0 ? `${ONES[hundred]} Hundred` : `${ONES[hundred]} Hundred ${twoDigits(rest)}`;
}

function integerToWords(value: number): string {
  if (value === 0) return 'Zero';
  const crore = Math.floor(value / 1_00_00_000);
  const lakh = Math.floor((value % 1_00_00_000) / 1_00_000);
  const thousand = Math.floor((value % 1_00_000) / 1_000);
  const hundred = value % 1_000;
  const parts: string[] = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred) parts.push(threeDigits(hundred));
  return parts.join(' ');
}

export function amountInWordsInr(amount: number): string {
  const safe = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const rounded = Math.round(safe * 100) / 100;
  const rupees = Math.floor(rounded);
  const paise = Math.round((rounded - rupees) * 100);
  const rupeePart = `${integerToWords(rupees)} Rupee${rupees === 1 ? '' : 's'}`;
  if (paise <= 0) return `${rupeePart} Only`;
  const paisePart = `${integerToWords(paise)} Paise`;
  return `${rupeePart} and ${paisePart} Only`;
}
