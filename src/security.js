import { scryptSync, randomBytes, timingSafeEqual, randomInt } from 'node:crypto';

export function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(secret), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function checkSecret(secret, stored) {
  if (!stored) return false;
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(secret), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export const isValidPin = (pin) => /^\d{4}$/.test(String(pin ?? ''));

// Rejects PINs that are trivially guessable.
export function isWeakPin(pin) {
  const p = String(pin);
  if (/^(\d)\1{3}$/.test(p)) return true; // 1111
  const asc = '0123456789', desc = '9876543210';
  return asc.includes(p) || desc.includes(p) || ['1212', '6969', '2580'].includes(p);
}

export const sixDigitCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

// Turns what people type ("07700 900123", "+1 (555) 010-0000") into E.164.
export function normalizePhone(input, defaultCountryCode) {
  if (!input) return null;
  let s = String(input).trim();
  const plus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  if (plus) {
    // already international
  } else if (s.startsWith('00')) {
    s = s.slice(2);
  } else if (s.startsWith('0')) {
    s = defaultCountryCode + s.slice(1);
  } else if (defaultCountryCode === '1' && s.length === 10) {
    s = '1' + s;
  } else if (!s.startsWith(defaultCountryCode)) {
    s = defaultCountryCode + s;
  }
  return s.length >= 8 && s.length <= 15 ? `+${s}` : null;
}

// Keeps names short and free of anything that looks like contact details.
export function cleanName(input) {
  const name = String(input ?? '')
    .replace(/[^\p{L}\p{M}' -]/gu, '')
    .trim()
    .split(/\s+/)[0] ?? '';
  return name.slice(0, 20);
}
