import { maskSecret } from '../employees/payment-mask';

const KEYS = new Set(['pan', 'ifsc', 'bankaccountnumber', 'bank_account_number', 'bankname', 'bank_name']);

export function maskAuditValues(value: unknown): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(maskAuditValues);
  if (typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    const normalized = key.replaceAll('_', '').toLowerCase();
    if (KEYS.has(normalized) || KEYS.has(key.toLowerCase())) {
      next[key] = typeof nested === 'string' ? maskSecret(nested) : nested;
    } else if (key === 'panMasked' || key === 'bankAccountMasked' || key === 'ifscMasked' || key === 'bankNameMasked') {
      next[key] = nested;
    } else {
      next[key] = maskAuditValues(nested);
    }
  }
  return next;
}
