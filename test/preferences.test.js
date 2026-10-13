import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setup, completeCall } from './helpers.js';
import { openDb } from '../src/db.js';

const MIN = 60 * 1000;

// Adds a member with their gender and who they'd like to chat with.
function person(t, name, phone, gender, wants, { available = true } = {}) {
  const id = t.addUser(name, phone);
  t.service.setChoices(id, { gender, wants });
  if (available) t.service.setAvailable(id, true);
  return id;
}

const partnerOf = (call, id) => (call.user_a === id ? call.user_b : call.user_a);
const offerCalls = (t) => t.telephony.calls.filter((c) => c.url.includes('/voice/offer'));
const text = (t, from, body) => t.post('/sms/incoming', { From: from, Body: body });
const lastTo = (t, phone) => t.telephony.sms.filter((m) => m.to === phone).at(-1)?.body ?? '';
const redirectTo = (text) => text.match(/<Redirect method="POST">([^<]+)</)?.[1].replace(/&amp;/g, '&');

test('matching only pairs people whose choices fit each other', async () => {
  const t = await setup();
  try {
    const margaret = person(t, 'Margaret', '+447700900201', 'female', 'women');
    person(t, 'Arthur', '+447700900202', 'male', 'anyone');
    assert.deepEqual(await t.service.runMatchmaker(), [], 'Margaret only wants to chat with women');

    // Joan only wants men, so she and Margaret don't fit either, even though Margaret would like Joan.
    const joan = person(t, 'Joan', '+447700900203', 'female', 'men');
    const [call] = await t.service.runMatchmaker();
    assert.deepEqual([call.user_a, call.user_b].sort(), [joan, t.service.getUserByPhone('+447700900202').id].sort());
    assert.ok(t.service.isAvailable(t.service.getUser(margaret)), 'Margaret is still waiting');

    // "Rather not say" only fits people happy to chat with anyone.
    const sam = person(t, 'Sam', '+447700900204', 'unsaid', 'anyone');
    assert.deepEqual(await t.service.runMatchmaker(), []);
    t.service.setAvailable(sam, false);
    const edna = person(t, 'Edna', '+447700900205', 'female', 'anyone');
    const [next] = await t.service.runMatchmaker();
    assert.equal(partnerOf(next, margaret), edna);
  } finally {
    t.close();
  }
});

test('existing members default to chatting with anyone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lo-'));
  try {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, phone TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pin_hash TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0, verify_code TEXT, verify_expires INTEGER, status TEXT NOT NULL DEFAULT 'active',
      available_until INTEGER, failed_pins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, created_at INTEGER NOT NULL);
      INSERT INTO users (phone, name, pin_hash, verified, created_at) VALUES ('+447700900299', 'Harold', 'x', 1, 0);`);
    old.close();
    const db = openDb(path);
    const harold = db.prepare('SELECT * FROM users').get();
    assert.equal(harold.wants, 'anyone');
    assert.equal(harold.gender, 'unsaid');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after a short wait with nobody suitable, we ring to offer someone else just this once', async () => {
  const t = await setup({ preferenceWaitMinutes: 5 });
  try {
    const margaret = person(t, 'Margaret', '+447700900211', 'female', 'women');
    const arthur = person(t, 'Arthur', '+447700900212', 'male', 'anyone');

    await t.service.runMatchmaker();
    assert.equal(offerCalls(t).length, 0, 'no offer before the wait is up');

    t.clock.t += 6 * MIN;
    assert.deepEqual(await t.service.runMatchmaker(), [], 'still no match without saying yes');
    assert.equal(offerCalls(t).length, 1);
    const ring = offerCalls(t)[0];
    assert.equal(ring.to, '+447700900211');
    await t.service.runMatchmaker();
    assert.equal(offerCalls(t).length, 1, 'only asked once per wait');

    const offerUrl = ring.url.replace('http://test.local', '');
    const offer = await t.post(offerUrl, { CallSid: ring.sid, To: ring.to });
    assert.match(offer.text, /No female callers are available right now\./);
    assert.match(offer.text, /Would you like to speak to a man this time\?/);
    assert.match(offer.text, /To keep waiting for a woman, press 2/);
    assert.doesNotMatch(offer.text, /7700900212/);

    // Yes: she stays on the line and only Arthur is rung.
    const yes = await t.post(offerUrl.replace('/voice/offer', '/voice/offer-answer'), { CallSid: ring.sid, To: ring.to, Digits: '1' });
    const hold = await t.post(redirectTo(yes.text), { CallSid: ring.sid });
    assert.match(hold.text, /ringing Arthur for you now/);
    const call = t.service.activeCall(margaret);
    assert.equal(call.kind, 'random');
    assert.equal(partnerOf(call, margaret), arthur);
    assert.equal(t.telephony.calls.at(-1).to, '+447700900212');

    // Her saved choice never changes, and the "yes" was for that chat only.
    const saved = t.service.getUser(margaret);
    assert.equal(saved.wants, 'women');
    assert.equal(saved.one_off, null);
    await t.post(`/voice/leg-answer?call=${call.id}&leg=b`, { Digits: '1', CallSid: call.b_sid });
    t.clock.t += 10 * MIN;
    await t.post(`/voice/leg-status?call=${call.id}&leg=b`, { CallStatus: 'completed' });
    await t.post('/voice/offer-status', { CallSid: ring.sid, CallStatus: 'completed' });
    assert.equal(t.service.getCall(call.id).status, 'completed');

    t.service.setAvailable(margaret, true);
    t.service.setAvailable(arthur, true);
    assert.deepEqual(await t.service.runMatchmaker(), [], 'next time she is looking for a woman again');
  } finally {
    t.close();
  }
});

test('saying "keep waiting" keeps the choice and we do not ask again this time', async () => {
  const t = await setup({ preferenceWaitMinutes: 5 });
  try {
    const margaret = person(t, 'Margaret', '+447700900221', 'female', 'women');
    person(t, 'Arthur', '+447700900222', 'male', 'anyone');
    t.clock.t += 6 * MIN;
    await t.service.runMatchmaker();
    const ring = offerCalls(t)[0];
    const no = await t.post(`/voice/offer-answer?user=${margaret}`, { CallSid: ring.sid, To: ring.to, Digits: '2' });
    assert.match(no.text, /keep looking for a woman for you/);
    t.clock.t += 20 * MIN;
    assert.deepEqual(await t.service.runMatchmaker(), []);
    assert.equal(offerCalls(t).length, 1);
    assert.equal(t.service.choiceOffer(t.service.getUser(margaret)), null);

    // A woman who'd like to chat with women comes along: they're matched as normal.
    const joan = person(t, 'Joan', '+447700900223', 'female', 'women');
    const [call] = await t.service.runMatchmaker();
    assert.equal(partnerOf(call, margaret), joan);
  } finally {
    t.close();
  }
});

test('no offer when nobody else free would be happy to chat with them', async () => {
  const t = await setup({ preferenceWaitMinutes: 5 });
  try {
    person(t, 'Margaret', '+447700900231', 'female', 'women');
    person(t, 'Arthur', '+447700900232', 'male', 'men');
    t.clock.t += 6 * MIN;
    await t.service.runMatchmaker();
    assert.equal(offerCalls(t).length, 0, 'Arthur only wants men, so offering him would not help');
  } finally {
    t.close();
  }
});

test('after saying "anyone this time", someone they chose is still picked first if free', async () => {
  const t = await setup();
  try {
    const margaret = person(t, 'Margaret', '+447700900241', 'female', 'women');
    t.service.acceptOffer(margaret);
    const arthur = person(t, 'Arthur', '+447700900242', 'male', 'anyone');
    person(t, 'Joan', '+447700900243', 'female', 'anyone');
    for (let i = 0; i < 20; i++) {
      const pairs = t.service.findPairs();
      assert.equal(pairs.length, 1);
      assert.notDeepEqual(pairs[0].slice(0, 2).sort(), [margaret, arthur].sort(), 'Margaret is not given a man while Joan is free');
    }
    // With only Arthur free, her "yes" lets them be matched.
    t.service.setAvailable(t.service.getUserByPhone('+447700900243').id, false);
    assert.deepEqual(t.service.findPairs()[0].slice(0, 2).sort(), [margaret, arthur].sort());
  } finally {
    t.close();
  }
});

// A tiny browser: keeps cookies and finds the form token.
function browser(t) {
  let cookies = '';
  const keep = (res) => {
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookies = set.map((c) => c.split(';')[0]).join('; ');
  };
  return {
    async get(path) {
      const res = await fetch(t.base + path, { headers: { cookie: cookies }, redirect: 'manual' });
      keep(res);
      return { status: res.status, text: await res.text(), location: res.headers.get('location') };
    },
    async post(path, body) {
      const page = await this.get(path.split('/').slice(0, 2).join('/'));
      const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)?.[1];
      const res = await fetch(t.base + path, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...body, _csrf: csrf }),
      });
      keep(res);
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}

test('on the website: choose at sign-up, see the offer as a button, and change your choice later', async () => {
  const t = await setup({ preferenceWaitMinutes: 5 });
  try {
    const b = browser(t);
    const join = await b.get('/join');
    assert.match(join.text, /Who would you like to chat with\?/);
    await b.post('/join', { name: 'Dorothy', phone: '07700 900251', pin: '2468', pin2: '2468', agree: '1', gender: 'female', wants: 'women' });
    await b.post('/verify', { code: t.telephony.sms.at(-1).body.match(/\d{6}/)[0] });
    const dorothy = t.service.getUserByPhone('+447700900251');
    assert.equal(dorothy.wants, 'women');
    assert.equal(dorothy.gender, 'female');

    await b.post('/me/available', { on: '1' });
    const stanley = person(t, 'Stanley', '+447700900252', 'male', 'anyone');
    let me = await b.get('/me');
    assert.doesNotMatch(me.text, /speak to a man this time/);

    t.clock.t += 6 * MIN;
    me = await b.get('/me');
    assert.match(me.text, /No female callers are available right now\./);
    assert.match(me.text, /Would you like to speak to a man this time\?/);

    await b.post('/me/offer', { answer: 'yes' });
    await t.service.runMatchmaker(); // the website starts matching straight away too
    const call = t.service.activeCall(dorothy.id);
    assert.equal(partnerOf(call, dorothy.id), stanley);
    assert.equal(t.service.getUser(dorothy.id).wants, 'women');

    await completeCall(t, call);
    await b.post('/me/choices', { gender: 'female', wants: 'anyone' });
    assert.equal(t.service.getUser(dorothy.id).wants, 'anyone');
    me = await b.get('/me');
    assert.match(me.text, /chat with <strong>anyone<\/strong>/);
  } finally {
    t.close();
  }
});

test('by phone: press 7 on the menu to choose who you chat with', async () => {
  const t = await setup();
  try {
    const id = t.addUser('Wilfred', '+447700900261');
    const sid = 'CAprefs1';
    await t.post('/voice/pin', { From: '+447700900261', CallSid: sid, Digits: '2468' });
    const menu = await t.post('/voice/menu', { CallSid: sid });
    assert.match(menu.text, /women, men or anyone, press 7/);
    const go = await t.post('/voice/menu-choice', { CallSid: sid, Digits: '7' });
    const ask = await t.post(redirectTo(go.text), { CallSid: sid });
    assert.match(ask.text, /are you a woman or a man/);
    const next = await t.post('/voice/choices-gender', { CallSid: sid, Digits: '2' });
    assert.match(next.text, /men only, press 3/);
    const done = await t.post('/voice/choices-wants', { CallSid: sid, Digits: '2' });
    assert.match(done.text, /women only/);
    const saved = t.service.getUser(id);
    assert.equal(saved.gender, 'male');
    assert.equal(saved.wants, 'women');
  } finally {
    t.close();
  }
});

test('text chats: the offer arrives by text, YES is for this one chat, and WAIT keeps waiting', async () => {
  const t = await setup({ preferenceWaitMinutes: 5 });
  try {
    const M = '+447700900271';
    const A = '+447700900272';
    const margaret = t.addUser('Margaret', M);
    t.service.setChoices(margaret, { gender: 'female', wants: 'women' });
    const arthur = person(t, 'Arthur', A, 'male', 'anyone', { available: false });
    await text(t, M, 'FREE');
    t.service.setAvailable(arthur, true, 'sms');
    assert.deepEqual(await t.service.runMatchmaker(), []);

    t.clock.t += 6 * MIN;
    await t.service.runMatchmaker();
    assert.equal(t.telephony.calls.length, 0, 'nobody is rung for a text chat');
    assert.match(lastTo(t, M), /No women are free for a text chat right now\. Would you like to text with a man this time\? Reply YES/);
    assert.doesNotMatch(lastTo(t, M), /7700900272/);

    await text(t, M, 'yes');
    await t.service.runMatchmaker();
    const chat = t.service.activeCall(margaret);
    assert.equal(chat.medium, 'sms');
    assert.equal(partnerOf(chat, margaret), arthur);
    assert.equal(t.service.getUser(margaret).wants, 'women');
    assert.equal(t.service.getUser(margaret).one_off, null);

    // Next time she waits, she's asked again, and can say WAIT.
    await text(t, M, 'END');
    await text(t, M, 'FREE');
    t.service.setAvailable(arthur, true, 'sms');
    t.clock.t += 6 * MIN;
    await t.service.runMatchmaker();
    assert.match(lastTo(t, M), /Reply YES for a man this time, or WAIT/);
    await text(t, M, 'WAIT');
    assert.match(lastTo(t, M), /keep looking for a woman/);
    t.clock.t += 20 * MIN;
    assert.deepEqual(await t.service.runMatchmaker(), []);
    assert.equal(t.service.getUser(margaret).one_off, 'declined');
  } finally {
    t.close();
  }
});

test('group chats are open to everyone, whatever people chose for one-to-one chats', async () => {
  const t = await setup();
  try {
    const margaret = person(t, 'Margaret', '+447700900281', 'female', 'women', { available: false });
    const arthur = person(t, 'Arthur', '+447700900282', 'male', 'men', { available: false });
    const stanley = person(t, 'Stanley', '+447700900283', 'male', 'anyone', { available: false });
    const room = t.service.groups.menuRooms()[0];
    for (const id of [margaret, arthur, stanley]) await t.service.groups.join(id, room.id, 'sms');
    await t.service.runMatchmaker();
    for (const id of [margaret, arthur, stanley]) assert.ok(t.service.groups.activeFor(id), 'everyone is in the group');
  } finally {
    t.close();
  }
});
