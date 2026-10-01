import test from 'node:test';
import assert from 'node:assert/strict';
import { screenMessage } from '../src/screening.js';

test('ordinary chat gets through', () => {
  for (const msg of [
    'Hello Arthur! How are you today?',
    "I'm 82 and I was born in 1943. We had a lovely garden.",
    'I watched the match at 3:30, it finished 2-1.',
    'My grandson visited on Sunday, he is 12 now.',
    'Do you like gardening? My roses are doing well this year.',
  ]) assert.ok(screenMessage(msg).ok, msg);
});

test('contact details are stopped', () => {
  for (const msg of [
    'ring me on 07700 900123', 'my number is +44 7700-900-123', 'email me at joan@example.com',
    'look at www.example.com', 'I live at 12 Acacia Avenue', 'come to SW1A 1AA',
    'add me on WhatsApp', "what's your address?", 'shall we meet up?',
  ]) assert.equal(screenMessage(msg).category, 'contact', msg);
});

test('money and scam talk is stopped', () => {
  for (const msg of [
    'could you send me money?', 'what is your sort code', 'buy me a gift card', 'I need £200 urgently',
    'great investment in bitcoin', 'tell me your bank details',
  ]) assert.equal(screenMessage(msg).category, 'money', msg);
});

test('abuse is stopped', () => {
  assert.equal(screenMessage('shut up you old bitch').category, 'abuse');
  assert.equal(screenMessage('I will hurt you').category, 'abuse');
});

test('empty and very long messages are stopped', () => {
  assert.equal(screenMessage('   ').ok, false);
  assert.equal(screenMessage('a'.repeat(601)).ok, false);
});
