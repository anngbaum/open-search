/**
 * Phone and email normalization utilities for matching
 * iMessage handles against AddressBook contacts.
 */

export function isEmail(s: string): boolean {
  return s.includes('@');
}

/**
 * Normalize an email: lowercase, trim, strip angle brackets.
 */
export function normalizeEmail(raw: string): string {
  let e = raw.trim().toLowerCase();
  if (e.startsWith('<') && e.endsWith('>')) {
    e = e.slice(1, -1);
  }
  return e;
}

/**
 * Normalize a phone number and return all lookup keys.
 * Strips non-digits, generates variants with/without country code.
 */
export function normalizePhone(raw: string): string[] {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) return [];

  const keys = new Set<string>();

  // Full digit string
  keys.add(digits);
  // With + prefix
  keys.add('+' + digits);

  // US numbers: 11-digit starting with 1 → also store 10-digit
  if (digits.length === 11 && digits.startsWith('1')) {
    keys.add(digits.slice(1));
    keys.add('+' + digits.slice(1));
  }

  // 10-digit → also store with leading 1
  if (digits.length === 10) {
    keys.add('1' + digits);
    keys.add('+1' + digits);
  }

  return Array.from(keys);
}
