import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, completeCall } from './helpers.js';

async function chat(t, a, b) {
  t.service.setAvailable(a, true);
  t.service.setAvailable(b, true);
  const [call] = await t.service.runMatchmaker();
  return completeCall(t, call);
}

test('blocked people are never matched again', async () => {
  const t = await setup();
  try {
    const a = t.addUser('Joan', '+447700900021', { available: true });
    const b = t.addUser('Stanley', '+447700900022', { available: true });
    t.service.block(a, b);
    assert.deepEqual(t.service.findPairs(), []);
    const c = t.addUser('Edna', '+447700900023', { available: true });
    const pairs = t.service.findPairs();
    assert.equal(pairs.length, 1);
    assert.ok(pairs[0].includes(c));
  } finally {
    t.close();
  }
});

test('people who spoke recently are only re-paired when nobody else is free', async () => {
  const t = await setup();
  try {
    const a = t.addUser('Joan', '+447700900031');
    const b = t.addUser('Stanley', '+447700900032');
    await chat(t, a, b);
    const c = t.addUser('Edna', '+447700900033');
    const d = t.addUser('Harold', '+447700900034');
    for (const id of [a, b, c, d]) t.service.setAvailable(id, true);
    for (let i = 0; i < 20; i++) {
      for (const pair of t.service.findPairs()) {
        assert.ok(!(pair.includes(a) && pair.includes(b)), 'Joan and Stanley are not re-paired');
      }
    }
  } finally {
    t.close();
  }
});

test('reporting blocks the person, and reports from two people pause their account', async () => {
  const t = await setup();
  try {
    const bad = t.addUser('Rogue', '+447700900041');
    const v1 = t.addUser('Joan', '+447700900042');
    const v2 = t.addUser('Edna', '+447700900043');

    const call1 = await chat(t, bad, v1);
    // Joan reports by pressing 9 after the call.
    const res = await t.post(`/voice/feedback?call=${call1.id}&leg=${call1.user_a === v1 ? 'a' : 'b'}`, { Digits: '9' });
    assert.match(res.text, /We've blocked Rogue/);
    assert.match(res.text, /<Record/);
    assert.ok(t.service.isBlockedPair(v1, bad));
    assert.equal(t.service.getUser(bad).status, 'active', 'one report alone does not pause them');

    t.clock.t += 8 * 24 * 60 * 60 * 1000;
    const call2 = await chat(t, bad, v2);
    await t.service.report(v2, call2.id, 'Asked for my bank details');
    assert.equal(t.service.getUser(bad).status, 'suspended');
    assert.throws(() => t.service.setAvailable(bad, true), /paused/);

    // The team bans them: the number can never sign up again.
    await t.service.ban(bad, 'Scam attempt');
    await assert.rejects(t.service.register({ name: 'Rogue', phone: '07700 900041', pin: '2468' }), /cannot use/);
    const ring = await t.post('/voice/incoming', { From: '+447700900041', CallSid: 'CAx' });
    assert.match(ring.text, /cannot use Lonely Oldies/);
  } finally {
    t.close();
  }
});

test('you can only report someone you actually spoke to', async () => {
  const t = await setup();
  try {
    const a = t.addUser('Joan', '+447700900051');
    const b = t.addUser('Stanley', '+447700900052');
    const c = t.addUser('Edna', '+447700900053');
    const call = await chat(t, a, b);
    await assert.rejects(t.service.report(c, call.id, 'x'), /could not find/);
  } finally {
    t.close();
  }
});

test('too many wrong PINs locks the account for a while', async () => {
  const t = await setup();
  try {
    t.addUser('Joan', '+447700900061');
    for (let i = 0; i < 4; i++) assert.throws(() => t.service.login('07700900061', '9999'), /do not match/);
    assert.throws(() => t.service.login('07700900061', '9999'), /Too many/);
    assert.throws(() => t.service.login('07700900061', '2468'), /Too many/);
    t.clock.t += 16 * 60 * 1000;
    assert.equal(t.service.login('07700900061', '2468').name, 'Joan');
  } finally {
    t.close();
  }
});

test('a daily limit stops anyone being called over and over', async () => {
  const t = await setup({ maxCallsPerDay: 1 });
  try {
    const a = t.addUser('Joan', '+447700900071');
    const b = t.addUser('Stanley', '+447700900072');
    await chat(t, a, b);
    assert.throws(() => t.service.setAvailable(a, true), /lots of chats today/);
  } finally {
    t.close();
  }
});

test('Twilio webhooks are rejected without a valid signature in live mode', async () => {
  const t = await setup({ telephony: 'twilio', sessionSecret: 'test-secret', twilio: { authToken: 'x', validateWebhooks: true } });
  try {
    const res = await t.post('/voice/incoming', { From: '+447700900081' });
    assert.equal(res.status, 403);
  } finally {
    t.close();
  }
});
