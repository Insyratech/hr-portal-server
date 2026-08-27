/** Standard email format check (work, Gmail, Outlook, Yahoo, etc.). */
const EMAIL_PATTERN =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  if (normalized.length < 5 || normalized.length > 254) return false;
  if (!EMAIL_PATTERN.test(normalized)) return false;
  const at = normalized.lastIndexOf('@');
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!local || local.length > 64 || !domain.includes('.')) return false;
  const tld = domain.slice(domain.lastIndexOf('.') + 1);
  return tld.length >= 2;
}
