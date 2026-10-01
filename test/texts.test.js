import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const text = (t, from, body) => t.post('/sms/incoming', { From: from, Body: body });
const lastTo = (t, phone) => t.telephony.sms.filter((m) => m.to === phone).at(-1)?.body ?? '';
const M = '+447700900101';
const A = '+447700900102';

async function startTextChat(t) {
  const m = t.addUser('Margaret', M);
  const a = t.addUser('Arthur', A);
  await text(t, M, 'FREE');
  assert.match(lastTo(t, M), /on the list for a text chat/);
  t.service.setAvailable(a, true, 'sms');
  const [chat] = await t.service.runMatchmaker();
  return { m, a, chat };
}

test('a text chat relays messages through the service without revealing numbers', async () => {
  const t = await setup();
  try {
    const { chat } = await startTextChat(t);
    assert.equal(chat.medium, 'sms');
    assert.equal(chat.status, 'in_progress');
    assert.equal(t.telephony.calls.length, 0, 'nobody is rung');
    assert.match(lastTo(t, M), /text chat with Arthur/);
    assert.match(lastTo(t, A), /text chat with Margaret/);

    await text(t, M, 'Hello Arthur, how are you today?');
    assert.equal(lastTo(t, A), 'Margaret: Hello Arthur, how are you today?');
    await text(t, A, "Very well thanks, I've been in the garden.");
    assert.equal(lastTo(t, M), "Arthur: Very well thanks, I've been in the garden.");
    for (const m of t.telephony.sms) {
      assert.ok(!m.body.includes(M) && !m.body.includes(A), 'no numbers in any text');
    }
    assert.equal(t.service.texts.transcript(chat.id).length, 2);
  } finally {
    t.close();
  }
});

test('screened messages are not passed on, and repeated ones end the chat and go to the team', async () => {
  const t = await setup();
  try {
    const { m, a, chat } = await startTextChat(t);
    const before = t.telephony.sms.filter((x) => x.to === A).length;
    await text(t, M, 'ring me on 07700 900123');
    assert.equal(t.telephony.sms.filter((x) => x.to === A).length, before, 'Arthur got nothing');
    assert.match(lastTo(t, M), /wasn't passed on because it looked like it had a phone number/);

    await text(t, M, 'can you send me money');
    await text(t, M, 'what is your sort code');
    assert.equal(t.service.getCall(chat.id).status, 'completed', 'chat ended');
    assert.ok(t.service.isBlockedPair(a, m));
    const report = t.service.q('SELECT * FROM reports WHERE reported = ?').get(m);
    assert.match(report.reason, /Automatic report: 3 messages/);
    assert.match(lastTo(t, A), /broke our safety rules/);
    assert.equal(t.service.texts.recentlyStopped().length, 3);
  } finally {
    t.close();
  }
});

test('after a text chat, both replying YES makes them friends who can text again', async () => {
  const t = await setup();
  try {
    const { m, a, chat } = await startTextChat(t);
    await text(t, M, 'END');
    assert.equal(t.service.getCall(chat.id).status, 'completed');
    assert.match(lastTo(t, A), /chat with Margaret has finished.*Reply YES or NO/);
    await text(t, M, 'YES');
    await text(t, A, 'yes');
    assert.deepEqual(t.service.listFriends(m).map((f) => f.name), ['Arthur']);

    // Margaret asks to text Arthur again; he has to say yes first.
    const again = await t.service.callFriend(m, a, { medium: 'sms' });
    assert.equal(again.status, 'dialing');
    assert.match(lastTo(t, A), /Margaret would like a text chat. Reply YES/);
    await text(t, M, 'Are you there?');
    assert.match(lastTo(t, M), /still waiting for Arthur/);
    await text(t, A, 'YES');
    assert.equal(t.service.getCall(again.id).status, 'in_progress');
    await text(t, A, 'Hello again!');
    assert.equal(lastTo(t, M), 'Arthur: Hello again!');
  } finally {
    t.close();
  }
});

test('one NO after a text chat means no friendship, and a friend can say no to a chat', async () => {
  const t = await setup();
  try {
    const { m, a } = await startTextChat(t);
    await text(t, A, 'END');
    await text(t, M, 'YES');
    await text(t, A, 'NO');
    assert.equal(t.service.listFriends(m).length, 0);
    await assert.rejects(t.service.callFriend(m, a, { medium: 'sms' }), /cannot call/);
  } finally {
    t.close();
  }
});

test('REPORT during a text chat ends it, blocks the other person and files a report', async () => {
  const t = await setup();
  try {
    const { m, a, chat } = await startTextChat(t);
    await text(t, A, 'REPORT');
    assert.equal(t.service.getCall(chat.id).status, 'completed');
    assert.ok(t.service.isBlockedPair(a, m));
    assert.match(lastTo(t, A), /Margaret has been blocked/);
    assert.match(lastTo(t, M), /has finished\.$/);
    assert.equal(t.service.q('SELECT COUNT(*) AS n FROM reports WHERE reported = ?').get(m).n, 1);
    // Messages after the chat has ended are not passed on.
    const before = t.telephony.sms.filter((x) => x.to === A).length;
    await text(t, M, 'hello?');
    assert.equal(t.service.q('SELECT COUNT(*) AS n FROM messages WHERE body = ?').get('hello?').n, 0);
    assert.equal(t.telephony.sms.filter((x) => x.to === A).length, before);
  } finally {
    t.close();
  }
});

test('people only get matched with someone who wants the same kind of chat', async () => {
  const t = await setup();
  try {
    const caller = t.addUser('Joan', '+447700900111', { available: true });
    const texter = t.addUser('Stanley', '+447700900112');
    t.service.setAvailable(texter, true, 'sms');
    assert.deepEqual(t.service.findPairs(), []);
    const caller2 = t.addUser('Edna', '+447700900113', { available: true });
    const [pair] = t.service.findPairs();
    assert.deepEqual([...pair.slice(0, 2)].sort(), [caller, caller2].sort());
    assert.equal(pair[2], 'voice');
  } finally {
    t.close();
  }
});

test('quiet text chats close on their own and old messages are deleted', async () => {
  const t = await setup();
  try {
    const { chat } = await startTextChat(t);
    await text(t, M, 'Hello!');
    t.clock.t += 13 * 60 * 60 * 1000;
    await t.service.runMatchmaker();
    assert.equal(t.service.getCall(chat.id).status, 'completed');
    t.clock.t += 31 * 24 * 60 * 60 * 1000;
    await t.service.runMatchmaker();
    assert.equal(t.service.texts.transcript(chat.id).length, 0);
  } finally {
    t.close();
  }
});

test('unregistered numbers are told how to join; the phone menu offers text chats', async () => {
  const t = await setup();
  try {
    await text(t, '+447700900199', 'hello');
    assert.match(lastTo(t, '+447700900199'), /isn't registered/);
    const m = t.addUser('Margaret', M);
    await t.post('/voice/pin', { From: M, CallSid: 'CAmenu', Digits: '2468' });
    const menu = await t.post('/voice/menu', { CallSid: 'CAmenu' });
    assert.match(menu.text, /text message instead, press 5/);
    await t.post('/voice/menu-choice', { CallSid: 'CAmenu', Digits: '5' });
    assert.equal(t.service.getUser(m).available_medium, 'sms');
  } finally {
    t.close();
  }
});
