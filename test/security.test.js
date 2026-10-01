import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, isWeakPin, cleanName, hashSecret, checkSecret } from '../src/security.js';

test('phone numbers are normalised to international format', () => {
  assert.equal(normalizePhone('07700 900123', '44'), '+447700900123');
  assert.equal(normalizePhone('+44 7700 900123', '44'), '+447700900123');
  assert.equal(normalizePhone('0044 7700 900123', '44'), '+447700900123');
  assert.equal(normalizePhone('(555) 010-0000', '1'), '+15550100000');
  assert.equal(normalizePhone('123', '44'), null);
});

test('easy PINs are refused', () => {
  for (const pin of ['1111', '1234', '9876', '0000']) assert.ok(isWeakPin(pin), pin);
  assert.ok(!isWeakPin('2468'));
});

test('names are reduced to a first name with no contact details', () => {
  assert.equal(cleanName('Margaret Smith'), 'Margaret');
  assert.equal(cleanName('Bob 07700900123'), 'Bob');
  assert.equal(cleanName('<script>'), 'script');
});

test('secrets are hashed and checked', () => {
  const h = hashSecret('2468');
  assert.ok(checkSecret('2468', h));
  assert.ok(!checkSecret('2469', h));
});
