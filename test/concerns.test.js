import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, completeCall } from './helpers.js';

async function chat(t, a, b) {
  t.service.setAvailable(a, true);
  t.service.setAvailable(b, true);
  const [call] = await t.service.runMatchmaker();
  return completeCall(t, call);
}

const legOf = (call, userId) => (call.user_a === userId ? 'a' : 'b');
const TEAM = { authorization: `Basic ${Buffer.from('team:team-secret').toString('base64')}` };

// A tiny browser: keeps cookies, finds the form token, and can send the team password.
function browser(t, headers = {}) {
  let cookies = '';
  const keep = (res) => {
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookies = set.map((c) => c.split(';')[0]).join('; ');
  };
  return {
    async get(path) {
      const res = await fetch(t.base + path, { headers: { cookie: cookies, ...headers }, redirect: 'manual' });
      keep(res);
      return { status: res.status, text: await res.text(), location: res.headers.get('location') };
    },
    async post(path, body) {
      const page = await this.get(path.split('/').slice(0, 2).join('/'));
      const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)?.[1];
      const res = await fetch(t.base + path, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ ...body, _csrf: csrf }),
      });
      keep(res);
      return { status: res.status, location: res.headers.get('location') };
    },
  };
}

async function signIn(t, phone) {
  const b = browser(t);
  await b.post('/signin', { phone, pin: '2468' });
  return b;
}

test('the report screen offers "I\'m worried about them" separately from reporting', async () => {
  const t = await setup();
  try {
    const joan = t.addUser('Joan', '+447700900101');
    const stan = t.addUser('Stanley', '+447700900102');
    const call = await chat(t, joan, stan);
    const b = await signIn(t, '07700900101');
    const me = await b.get('/me');
    assert.match(me.text, /I'm worried about Stanley/);
    const page = await b.get(`/me/report?call=${call.id}`);
    assert.match(page.text, /action="\/me\/concern"/);
    assert.match(page.text, /action="\/me\/report"/);
    assert.match(page.text, /never tell them it was you/);
    assert.ok(page.text.indexOf('id="worried"') < page.text.indexOf('id="problem"'));
  } finally {
    t.close();
  }
});

test('a wellbeing concern never blocks, pauses or tells the person it is about', async () => {
  const t = await setup();
  try {
    const stan = t.addUser('Stanley', '+447700900111');
    const joan = t.addUser('Joan', '+447700900112');
    const edna = t.addUser('Edna', '+447700900113');
    const ivy = t.addUser('Ivy', '+447700900114');

    const call1 = await chat(t, stan, joan);
    const b = await signIn(t, '07700900112');
    const res = await b.post('/me/concern', { call: call1.id, details: 'He said he has not left the house in weeks.' });
    assert.equal(res.location, '/me');
    assert.match((await b.get('/me')).text, /Thank you for looking out for Stanley/);

    // Joan can still say she'd like to talk to Stanley again.
    assert.ok(t.service.pendingFeedback(joan).some((c) => c.id === call1.id));
    assert.equal((await t.service.submitFeedback(call1.id, stan, true)).connected, false);
    assert.equal((await t.service.submitFeedback(call1.id, joan, true)).connected, true);

    // Two more people are worried too: still nothing happens to Stanley's account.
    for (const other of [edna, ivy]) {
      t.clock.t += 8 * 24 * 60 * 60 * 1000;
      const call = await chat(t, stan, other);
      t.service.raiseConcern(other, call.id, 'Sounded very low');
    }

    assert.equal(t.service.getUser(stan).status, 'active');
    for (const other of [joan, edna, ivy]) assert.ok(!t.service.isBlockedPair(other, stan));
    assert.equal(t.service.q('SELECT COUNT(*) AS n FROM reports').get().n, 0, 'a concern is not a report');
    assert.equal(t.telephony.sms.filter((m) => /worried|concern/i.test(m.body)).length, 0, 'nobody is sent a text about it');
    assert.deepEqual(t.service.listFriends(joan).map((f) => f.name), ['Stanley'], 'and they stay friends');

    // Stanley's own page says nothing about it.
    const stanPage = await (await signIn(t, '07700900111')).get('/me');
    assert.doesNotMatch(stanPage.text, /concern|paused|is worried|looking out/i);
  } finally {
    t.close();
  }
});

test('a concern can be raised by phone, after the chat or from the menu, with a voice message', async () => {
  const t = await setup();
  try {
    const joan = t.addUser('Joan', '+447700900121');
    const stan = t.addUser('Stanley', '+447700900122');
    const call = await chat(t, joan, stan);

    const after = await t.post(`/voice/after?call=${call.id}&leg=${legOf(call, joan)}`, {});
    assert.match(after.text, /worried about how Stanley is doing, press 8/);

    const res = await t.post(`/voice/feedback?call=${call.id}&leg=${legOf(call, joan)}`, { Digits: '8' });
    assert.match(res.text, /never tell them it was you/);
    assert.match(res.text, /<Record/);
    assert.ok(!t.service.isBlockedPair(joan, stan));
    const concern = t.service.q('SELECT * FROM concerns').get();
    assert.equal(concern.about, stan);
    assert.equal(concern.raised_by, joan);

    await t.post(`/voice/concern-done?concern=${concern.id}`, { CallSid: call[`${legOf(call, joan)}_sid`], To: '+447700900121', RecordingUrl: 'https://rec.example/1' });
    assert.match(t.service.q('SELECT details FROM concerns WHERE id = ?').get(concern.id).details, /Voice message: https:\/\/rec.example\/1/);

    // From the phone menu: 8, then 8 again to confirm. It's added to the same open concern.
    t.service.ivrSet('CAmenu', { userId: joan });
    const menu = await t.post('/voice/menu', { CallSid: 'CAmenu' });
    assert.match(menu.text, /worried about how the person from your last chat is doing, press 8/);
    const confirm = await t.post('/voice/menu-choice', { CallSid: 'CAmenu', Digits: '8' });
    assert.match(confirm.text, /worried about Stanley, press 8/);
    const back = await t.post(`/voice/feedback?call=${call.id}&leg=${legOf(call, joan)}&worried=1`, { CallSid: 'CAmenu', Digits: '1' });
    assert.match(back.text, /\/voice\/menu/, 'pressing 1 goes back without raising anything');
    await t.post(`/voice/feedback?call=${call.id}&leg=${legOf(call, joan)}&worried=1`, { CallSid: 'CAmenu', Digits: '8' });
    assert.equal(t.service.q('SELECT COUNT(*) AS n FROM concerns').get().n, 1);
  } finally {
    t.close();
  }
});

test('you can only raise a concern about someone you actually spoke to', async () => {
  const t = await setup();
  try {
    const a = t.addUser('Joan', '+447700900131');
    const b = t.addUser('Stanley', '+447700900132');
    const c = t.addUser('Edna', '+447700900133');
    const call = await chat(t, a, b);
    assert.throws(() => t.service.raiseConcern(c, call.id, 'x'), /could not find/);
    assert.throws(() => t.service.raiseConcern(a, 9999, 'x'), /could not find/);
  } finally {
    t.close();
  }
});

test('the team sees concerns first, and can move them through review with a note', async () => {
  const t = await setup();
  try {
    const joan = t.addUser('Joan', '+447700900141');
    const stan = t.addUser('Stanley', '+447700900142');
    const rogue = t.addUser('Rogue', '+447700900143');
    const call = await chat(t, joan, stan);
    t.clock.t += 8 * 24 * 60 * 60 * 1000;
    const call2 = await chat(t, joan, rogue);
    await t.service.report(joan, call2.id, 'Asked for my bank details');
    const { concernId } = t.service.raiseConcern(joan, call.id, 'Said he feels nobody would notice if he was gone');

    const team = browser(t, TEAM);
    let admin = (await team.get('/admin')).text;
    assert.ok(admin.indexOf('Wellbeing concerns') < admin.indexOf('Open reports'), 'concerns are listed above reports');
    assert.match(admin, /priority/);
    assert.match(admin, /nobody would notice/);
    assert.match(admin, /\+447700900142/, 'the team can see how to reach Stanley');

    await team.post('/admin/concern', { id: concernId, status: 'in_review', note: 'Rang Stanley, he is OK, will ring again Friday' });
    let row = t.service.q('SELECT * FROM concerns WHERE id = ?').get(concernId);
    assert.equal(row.status, 'in_review');
    assert.match(row.team_note, /ring again Friday/);
    admin = (await team.get('/admin')).text;
    assert.match(admin, /ring again Friday/);
    assert.match(admin, /<option value="in_review" selected>/);

    assert.equal((await team.post('/admin/concern', { id: concernId, status: 'nonsense' })).location, '/admin');
    assert.equal(t.service.q('SELECT status FROM concerns WHERE id = ?').get(concernId).status, 'in_review');

    await team.post('/admin/concern', { id: concernId, status: 'closed', note: 'Put in touch with local befriending group' });
    row = t.service.q('SELECT * FROM concerns WHERE id = ?').get(concernId);
    assert.equal(row.status, 'closed');
    assert.match((await team.get('/admin')).text, /No open concerns/);

    // Once closed, a new worry starts a fresh concern.
    const again = t.service.raiseConcern(joan, call.id, 'Sounded low again');
    assert.notEqual(again.concernId, concernId);

    // Without the team password, concerns can't be changed.
    const res = await t.post('/admin/concern', { id: again.concernId, status: 'closed' });
    assert.notEqual(res.status, 302);
    assert.equal(t.service.q('SELECT status FROM concerns WHERE id = ?').get(again.concernId).status, 'new');
  } finally {
    t.close();
  }
});

const text = (t, from, body) => t.post('/sms/incoming', { From: from, Body: body });
const lastTo = (t, phone) => t.telephony.sms.filter((m) => m.to === phone).at(-1)?.body ?? '';

test('a concern can be raised by text, during or after a text chat, and is never passed on', async () => {
  const t = await setup();
  try {
    const M = '+447700900151';
    const A = '+447700900152';
    const m = t.addUser('Margaret', M);
    const a = t.addUser('Arthur', A);
    t.service.setAvailable(m, true, 'sms');
    t.service.setAvailable(a, true, 'sms');
    const [chat] = await t.service.runMatchmaker();
    const toArthur = () => t.telephony.sms.filter((x) => x.to === A).length;
    const before = toArthur();

    await text(t, M, 'Worried');
    assert.equal(toArthur(), before, 'Arthur is not sent anything');
    assert.match(lastTo(t, M), /thank you for looking out for Arthur/);
    assert.equal(t.service.getCall(chat.id).status, 'in_progress', 'the chat carries on');
    assert.ok(!t.service.isBlockedPair(m, a));

    await text(t, M, 'END');
    await text(t, M, 'WORRIED');
    const rows = t.service.q('SELECT * FROM concerns').all();
    assert.equal(rows.length, 1, 'the second is added to the first');
    assert.equal(rows[0].about, a);
    assert.match(rows[0].details, /Raised by text message.\nRaised by text message./);
    assert.match(t.service.adminOverview().concerns[0].medium, /sms/);
  } finally {
    t.close();
  }
});

test('a concern can be raised about someone in a group chat, by text or on the website', async () => {
  const t = await setup();
  try {
    const phones = ['+447700900161', '+447700900162', '+447700900163'];
    const [m, a, j] = ['Margaret', 'Arthur', 'Joan'].map((n, i) => t.addUser(n, phones[i]));
    const garden = t.service.groups.listRooms().find((r) => r.name === 'Gardening');
    for (const id of [m, a, j]) await t.service.groups.join(id, garden.id, 'sms');
    const chat = t.service.groups.activeFor(m);
    const toOthers = () => t.telephony.sms.filter((x) => x.to !== phones[0]).length;
    const before = toOthers();

    await text(t, phones[0], 'WORRIED');
    assert.match(lastTo(t, phones[0]), /WORRIED and a number: 1 for Arthur, 2 for Joan/);
    await text(t, phones[0], 'worried arthur');
    assert.match(lastTo(t, phones[0]), /looking out for Arthur/);
    assert.equal(toOthers(), before, 'nothing was passed on to the group');
    assert.equal(t.service.groups.participant(chat.id, a).state, 'joined', 'Arthur stays in the chat');
    assert.ok(!t.service.isBlockedPair(m, a));

    // On the website, Joan picks who she's worried about from the people in the group.
    const b = await signIn(t, '07700900163');
    const page = await b.get(`/me/report-group?chat=${chat.id}`);
    assert.match(page.text, /action="\/me\/concern-group"/);
    await b.post('/me/concern-group', { chat: chat.id, person: a, details: 'Said he has nobody since his wife died' });
    const overview = t.service.adminOverview().concerns;
    assert.equal(overview.length, 2);
    assert.ok(overview.every((c) => c.about === a && c.room_name === 'Gardening'));
    assert.equal(overview[0].people_worried, 2);
    assert.throws(() => t.service.raiseGroupConcern(m, chat.id, m, 'x'), /could not find/);
  } finally {
    t.close();
  }
});
