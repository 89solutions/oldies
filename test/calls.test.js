import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, completeCall } from './helpers.js';

test('a random chat masks both numbers and needs both people to agree to talk again', async () => {
  const t = await setup();
  try {
    const a = t.addUser('Margaret', '+447700900001', { available: true });
    const b = t.addUser('Arthur', '+447700900002', { available: true });
    const [call] = await t.service.runMatchmaker();
    assert.ok(call, 'a call was started');
    assert.deepEqual(t.telephony.calls.map((c) => c.to).sort(), ['+447700900001', '+447700900002']);

    // What each person hears never contains the other's number.
    const greeting = await t.post(`/voice/leg?call=${call.id}&leg=a`, { CallSid: call.a_sid });
    assert.match(greeting.text, /Arthur/);
    assert.doesNotMatch(greeting.text, /7700900002/);

    const joinA = await t.post(`/voice/leg-answer?call=${call.id}&leg=a`, { Digits: '1', CallSid: call.a_sid });
    assert.match(joinA.text, /startConferenceOnEnter="false"/, 'first person waits on hold');
    const joinB = await t.post(`/voice/leg-answer?call=${call.id}&leg=b`, { Digits: '1', CallSid: call.b_sid });
    assert.match(joinB.text, /startConferenceOnEnter="true"/);
    assert.match(joinB.text, /hangupOnStar="true"/);
    assert.doesNotMatch(joinA.text + joinB.text, /7700900001|7700900002/);
    assert.equal(t.service.getCall(call.id).status, 'in_progress');

    for (const leg of ['a', 'b']) await t.post(`/voice/leg-status?call=${call.id}&leg=${leg}`, { CallStatus: 'completed' });
    assert.equal(t.service.getCall(call.id).status, 'completed');

    // Only one says yes: not friends yet.
    const yesA = await t.post(`/voice/feedback?call=${call.id}&leg=a`, { Digits: '1' });
    assert.match(yesA.text, /we'll send you a text/);
    assert.equal(t.service.listFriends(a).length, 0);

    // Both say yes: now they can ring each other, and both get a text.
    const yesB = await t.post(`/voice/feedback?call=${call.id}&leg=b`, { Digits: '1' });
    assert.match(yesB.text, /Wonderful/);
    assert.deepEqual(t.service.listFriends(a).map((f) => f.name), ['Arthur']);
    assert.deepEqual(t.service.listFriends(b).map((f) => f.name), ['Margaret']);
    assert.equal(t.telephony.sms.filter((m) => /both like to talk again/.test(m.body)).length, 2);
    assert.ok(t.telephony.sms.every((m) => !m.body.includes('7700900001') && !m.body.includes('7700900002')));
  } finally {
    t.close();
  }
});

test('one "no" means no friendship', async () => {
  const t = await setup();
  try {
    const a = t.addUser('Joan', '+447700900003', { available: true });
    t.addUser('Stanley', '+447700900004', { available: true });
    const [call] = await t.service.runMatchmaker();
    await completeCall(t, call);
    await t.post(`/voice/feedback?call=${call.id}&leg=a`, { Digits: '1' });
    await t.post(`/voice/feedback?call=${call.id}&leg=b`, { Digits: '2' });
    assert.equal(t.service.listFriends(a).length, 0);
    await assert.rejects(t.service.callFriend(a, call.user_b), /cannot call/);
  } finally {
    t.close();
  }
});

test('if one person says "not now", the other is told and put back in the queue', async () => {
  const t = await setup();
  try {
    const a = t.addUser('Edna', '+447700900005', { available: true });
    t.addUser('Harold', '+447700900006', { available: true });
    const [call] = await t.service.runMatchmaker();
    const [first, second] = call.user_a === a ? ['a', 'b'] : ['b', 'a'];
    await t.post(`/voice/leg-answer?call=${call.id}&leg=${first}`, { Digits: '1', CallSid: call[`${first}_sid`] });
    await t.post(`/voice/leg-answer?call=${call.id}&leg=${second}`, { Digits: '2', CallSid: call[`${second}_sid`] });
    assert.equal(t.service.getCall(call.id).status, 'failed');
    const redirect = t.telephony.events.find((e) => e.type === 'redirect');
    assert.match(redirect.url, /partner-unavailable/);
    assert.ok(t.service.isAvailable(t.service.getUser(a)), 'Edna is waiting again');
  } finally {
    t.close();
  }
});

test('nobody answering cancels the other ring', async () => {
  const t = await setup();
  try {
    t.addUser('Wilfred', '+447700900007', { available: true });
    t.addUser('Dorothy', '+447700900008', { available: true });
    const [call] = await t.service.runMatchmaker();
    await t.post(`/voice/leg-status?call=${call.id}&leg=a`, { CallStatus: 'no-answer' });
    assert.equal(t.service.getCall(call.id).status, 'failed');
    assert.ok(t.telephony.events.some((e) => e.type === 'hangup' && e.sid === call.b_sid));
  } finally {
    t.close();
  }
});

test('friends can ring each other again, from the website or the phone menu', async () => {
  const t = await setup();
  try {
    const a = t.addUser('Margaret', '+447700900011', { available: true });
    const b = t.addUser('Arthur', '+447700900012', { available: true });
    const [call] = await t.service.runMatchmaker();
    await completeCall(t, call);
    await t.service.submitFeedback(call.id, a, true);
    await t.service.submitFeedback(call.id, b, true);

    // Phone menu: Margaret rings in, enters PIN, presses 2 then 1.
    const sid = 'CAinbound1';
    await t.post('/voice/pin', { From: '+447700900011', CallSid: sid, Digits: '2468' });
    const menu = await t.post('/voice/menu', { CallSid: sid });
    assert.match(menu.text, /ring one of your friends, press 2/);
    const list = await t.post('/voice/friends', { CallSid: sid });
    assert.match(list.text, /To ring Arthur, press 1/);
    const choice = await t.post('/voice/friend-choice', { CallSid: sid, Digits: '1' });
    const legUrl = choice.text.match(/<Redirect method="POST">([^<]+)</)[1].replace(/&amp;/g, '&');
    const hold = await t.post(legUrl, { CallSid: sid });
    assert.match(hold.text, /ringing Arthur for you now/);
    assert.match(hold.text, /<Conference/);
    const reconnect = t.service.activeCall(a);
    assert.equal(reconnect.kind, 'reconnect');
    assert.equal(t.telephony.calls.at(-1).to, '+447700900012', 'only Arthur is rung');

    const arthurHears = await t.post(`/voice/leg?call=${reconnect.id}&leg=b`, { CallSid: reconnect.b_sid });
    assert.match(arthurHears.text, /Your friend Margaret would like to have a chat/);

    // When Margaret hangs up the phone-menu call, the call is closed.
    await t.post(`/voice/leg-status?call=${reconnect.id}&leg=b`, { CallStatus: 'no-answer' });
    await t.post('/voice/incoming-status', { CallSid: sid, CallStatus: 'completed' });
    assert.equal(t.service.activeCall(a), undefined);
  } finally {
    t.close();
  }
});
