import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const text = (t, from, body) => t.post('/sms/incoming', { From: from, Body: body });
const lastTo = (t, phone) => t.telephony.sms.filter((m) => m.to === phone).at(-1)?.body ?? '';
const phones = ['+447700900201', '+447700900202', '+447700900203', '+447700900204', '+447700900205'];
const names = ['Margaret', 'Arthur', 'Joan', 'Stanley', 'Dorothy'];

function people(t, n = 3) {
  return names.slice(0, n).map((name, i) => t.addUser(name, phones[i]));
}
const room = (t, name = 'Gardening') => t.service.groups.listRooms().find((r) => r.name === name);

test('starter groups are there, and members can start a new one', async () => {
  const t = await setup();
  try {
    const { groups } = t.service;
    assert.ok(room(t, 'Gardening'));
    assert.ok(room(t, 'Just a natter'));
    const [m] = people(t, 1);
    const knitting = groups.createRoom(m, { name: '  Knitting ', description: 'Patterns and wool' });
    assert.equal(knitting.name, 'Knitting');
    assert.throws(() => groups.createRoom(m, { name: 'knitting' }), /already a group/);
    assert.throws(() => groups.createRoom(m, { name: 'Ring me on 07700 900123' }), /phone number/);
    assert.throws(() => groups.createRoom(m, { name: 'x' }), /give your group a name/);
    groups.createRoom(m, { name: 'Classic films' });
    assert.throws(() => groups.createRoom(m, { name: 'Jigsaws' }), /two new groups today/);
  } finally {
    t.close();
  }
});

test('a phone group chat rings everyone once enough people are free, and keeps numbers private', async () => {
  const t = await setup();
  try {
    const [m, a, j] = people(t);
    const garden = room(t);
    assert.deepEqual(await t.service.groups.join(m, garden.id, 'voice'), { waiting: true });
    await t.service.groups.join(a, garden.id, 'voice');
    assert.equal(t.telephony.calls.length, 0, 'two is not enough for a group');
    const joined = await t.service.groups.join(j, garden.id, 'voice');
    assert.ok(joined.chatId);
    assert.equal(t.telephony.calls.length, 3);
    const chat = t.service.groups.getChat(joined.chatId);
    assert.equal(chat.status, 'dialing');

    // Each person hears the group's name and who else is in it, never a number.
    let res = await t.post(`/voice/group-leg?chat=${chat.id}&user=${m}`, { CallSid: 'x' });
    assert.match(res.text, /Gardening group chat is starting, with Arthur and Joan/);
    assert.ok(!phones.some((p) => res.text.includes(p)));

    res = await t.post(`/voice/group-answer?chat=${chat.id}&user=${m}`, { Digits: '1' });
    assert.match(res.text, /startConferenceOnEnter="false"/, 'the first one waits on hold');
    assert.match(res.text, /endConferenceOnExit="false"/);
    assert.match(res.text, new RegExp(`lonely-oldies-group-${chat.id}`));
    res = await t.post(`/voice/group-answer?chat=${chat.id}&user=${a}`, { Digits: '1' });
    assert.match(res.text, /startConferenceOnEnter="true"/);
    assert.equal(t.service.groups.getChat(chat.id).status, 'in_progress');

    // Joan says not now; the other two carry on.
    await t.post(`/voice/group-answer?chat=${chat.id}&user=${j}`, { Digits: '2' });
    assert.equal(t.service.groups.getChat(chat.id).status, 'in_progress');
    assert.equal(t.service.groups.participant(chat.id, j).state, 'declined');

    // Arthur leaves, so Margaret is told everyone else has gone.
    await t.post(`/voice/group-leg-status?chat=${chat.id}&user=${a}`, { CallStatus: 'completed' });
    assert.equal(t.service.groups.getChat(chat.id).status, 'completed');
    const redirect = t.telephony.events.find((e) => e.type === 'redirect');
    assert.match(redirect.url, /group-alone/);
    res = await t.post(`/voice/group-after?chat=${chat.id}&user=${m}&alone=1`, {});
    assert.match(res.text, /Everyone else has left/);
    assert.match(res.text, /press 9/);
    assert.equal(t.service.callsToday(m), 1, 'counts towards the daily limit');
  } finally {
    t.close();
  }
});

test('people join a group chat that is already going, up to the limit, but never with someone they blocked', async () => {
  const t = await setup({ groupMaxSize: 4 });
  try {
    const [m, a, j, s, d] = people(t, 5);
    const garden = room(t);
    t.service.block(d, m);
    for (const id of [m, a, j]) await t.service.groups.join(id, garden.id, 'sms');
    const chat = t.service.groups.activeFor(m);
    assert.equal(chat.medium, 'sms');

    const blocked = await t.service.groups.join(d, garden.id, 'sms');
    assert.deepEqual(blocked, { waiting: true }, 'Dorothy blocked Margaret, so she waits');
    const added = await t.service.groups.join(s, garden.id, 'sms');
    assert.equal(added.chatId, chat.id);
    assert.match(lastTo(t, phones[0]), /Stanley has joined/);
    assert.match(lastTo(t, phones[3]), /welcome to the Gardening group chat with Margaret, Arthur and Joan/);
  } finally {
    t.close();
  }
});

test('a text group chat passes messages to everyone, screens them, and lets people leave', async () => {
  const t = await setup();
  try {
    const [m] = people(t);
    await text(t, phones[0], 'GROUPS');
    assert.match(lastTo(t, phones[0]), /JOIN and a number/);
    const n = t.service.groups.menuRooms().findIndex((r) => r.name === 'Gardening') + 1;
    await text(t, phones[0], `JOIN ${n}`);
    assert.match(lastTo(t, phones[0]), /on the list for the Gardening group chat/);
    await text(t, phones[1], `join ${n}`);
    await text(t, phones[2], `JOIN ${n}`);
    const chat = t.service.groups.activeFor(m);
    assert.ok(chat);
    assert.equal(t.telephony.calls.length, 0);

    await text(t, phones[0], 'My roses are doing well this year');
    assert.equal(lastTo(t, phones[1]), 'Gardening group, Margaret: My roses are doing well this year');
    assert.equal(lastTo(t, phones[2]), 'Gardening group, Margaret: My roses are doing well this year');

    const before = t.telephony.sms.length;
    await text(t, phones[1], 'Ring me on 07700 900555');
    assert.equal(t.telephony.sms.length, before + 1, 'only Arthur is told');
    assert.match(lastTo(t, phones[1]), /wasn't passed on/);

    await text(t, phones[2], 'WHO');
    assert.match(lastTo(t, phones[2]), /1 Margaret, 2 Arthur/);

    await text(t, phones[2], 'LEAVE');
    assert.match(lastTo(t, phones[2]), /you've left the chat/);
    assert.match(lastTo(t, phones[0]), /Joan has left/);
    await text(t, phones[1], 'BYE');
    assert.equal(t.service.groups.getChat(chat.id).status, 'completed');
    assert.match(lastTo(t, phones[0]), /everyone else has left/);
    for (const msg of t.telephony.sms) assert.ok(!phones.some((p) => msg.body.includes(p)));
  } finally {
    t.close();
  }
});

test('reporting someone in a group removes them, blocks them, and repeated reports pause their account', async () => {
  const t = await setup();
  try {
    const [m, a, j, s] = people(t, 4);
    const garden = room(t);
    for (const id of [m, a, j, s]) await t.service.groups.join(id, garden.id, 'sms');
    const chat = t.service.groups.activeFor(m);

    await text(t, phones[0], 'REPORT arthur');
    assert.match(lastTo(t, phones[0]), /Arthur has been removed/);
    assert.equal(t.service.groups.participant(chat.id, a).state, 'left');
    assert.match(lastTo(t, phones[1]), /removed from the Gardening group chat/);
    assert.ok(t.service.isBlockedPair(m, a));
    assert.equal(t.service.getUser(a).status, 'active', 'one report is not enough to pause');
    assert.equal(t.service.groups.activeFor(j).id, chat.id, 'the others carry on');

    await text(t, phones[2], 'REPORT');
    assert.match(lastTo(t, phones[2]), /REPORT and a number: 1 for Margaret, 2 for Stanley/);

    // A second person reports Arthur after the chat, on the website route.
    await t.service.groups.report(j, chat.id, a, 'Rude');
    assert.equal(t.service.getUser(a).status, 'suspended');
    const overview = t.service.adminOverview();
    assert.equal(overview.reports[0].room_name, 'Gardening');
  } finally {
    t.close();
  }
});

test('screening strikes in a group remove the sender and go to the team', async () => {
  const t = await setup();
  try {
    const [m, a, j] = people(t);
    for (const id of [m, a, j]) await t.service.groups.join(id, room(t).id, 'sms');
    const chat = t.service.groups.activeFor(m);
    for (const msg of ['my number is 07700 900555', 'email me at a@b.com', 'send me £50 by bank transfer']) {
      await text(t, phones[0], msg);
    }
    assert.equal(t.service.groups.participant(chat.id, m).state, 'left');
    const report = t.service.q('SELECT * FROM reports WHERE reported = ?').get(m);
    assert.equal(report.reporter, m);
    assert.match(report.reason, /Automatic report/);
    // Arthur and Joan are still chatting.
    assert.equal(t.service.groups.getChat(chat.id).status, 'in_progress');
  } finally {
    t.close();
  }
});

test('people waiting for a group are not paired for a one-to-one chat', async () => {
  const t = await setup();
  try {
    const [m, a] = people(t, 2);
    await t.service.groups.join(m, room(t).id, 'voice');
    t.service.setAvailable(a, true, 'voice');
    assert.deepEqual(t.service.findPairs(), []);
  } finally {
    t.close();
  }
});

test('the phone menu offers group chats and puts you on the list', async () => {
  const t = await setup();
  try {
    const [m] = people(t, 1);
    t.service.ivrSet('CAmenu', { userId: m });
    let res = await t.post('/voice/menu', { CallSid: 'CAmenu' });
    assert.match(res.text, /group chat about a hobby.*press 6/);
    res = await t.post('/voice/groups', { CallSid: 'CAmenu' });
    assert.match(res.text, /For Gardening, press 1/);
    res = await t.post('/voice/group-choice', { CallSid: 'CAmenu', Digits: '1' });
    assert.match(res.text, /on the list for the Gardening group chat/);
    const user = t.service.getUser(m);
    assert.equal(user.available_room, room(t).id);
    res = await t.post('/voice/menu', { CallSid: 'CAmenu' });
    assert.match(res.text, /on the list for the Gardening group chat/);
  } finally {
    t.close();
  }
});

test('reporting someone by phone after a group chat', async () => {
  const t = await setup();
  try {
    const [m, a, j] = people(t);
    for (const id of [m, a, j]) await t.service.groups.join(id, room(t).id, 'voice');
    const chat = t.service.groups.activeFor(m);
    for (const id of [m, a, j]) await t.post(`/voice/group-answer?chat=${chat.id}&user=${id}`, { Digits: '1' });
    let res = await t.post(`/voice/group-after?chat=${chat.id}&user=${m}`, {});
    assert.match(res.text, /unkind or upset you, press 9/);
    res = await t.post(`/voice/group-report?chat=${chat.id}&user=${m}`, { Digits: '9' });
    assert.match(res.text, /To report Arthur, press 1.*To report Joan, press 2/);
    res = await t.post(`/voice/group-report-who?chat=${chat.id}&user=${m}`, { Digits: '2' });
    assert.match(res.text, /blocked Joan/);
    assert.ok(t.service.isBlockedPair(m, j));
    assert.equal(t.service.groups.participant(chat.id, j).state, 'removed');
    // Margaret left and Joan was removed, so Arthur is on his own and the chat ends.
    assert.equal(t.service.groups.getChat(chat.id).status, 'completed');
  } finally {
    t.close();
  }
});

test('the group chats page lists groups, and members can join from it', async () => {
  const t = await setup();
  try {
    let res = await fetch(`${t.base}/groups`);
    let html = await res.text();
    assert.match(html, /Gardening/);
    assert.match(html, /please <a href="\/signin">sign in<\/a>/);
    assert.match(html, /aria-current="page">Group chats/);

    // Sign in and join.
    t.addUser('Margaret', phones[0]);
    let cookies = '';
    const keep = (r) => { const c = r.headers.getSetCookie(); if (c.length) cookies = c.map((x) => x.split(';')[0]).join('; '); };
    const token = async (path) => {
      const r = await fetch(t.base + path, { headers: { cookie: cookies } });
      keep(r);
      return (await r.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
    };
    const send = async (path, body, from) => {
      const csrf = await token(from);
      const r = await fetch(t.base + path, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ...body, _csrf: csrf }),
      });
      keep(r);
      return r.headers.get('location');
    };
    assert.equal(await send('/signin', { phone: phones[0], pin: '2468' }, '/signin'), '/me');
    const gardenId = room(t).id;
    assert.equal(await send('/groups/join', { room: gardenId, medium: 'voice' }, '/groups'), '/me');
    res = await fetch(`${t.base}/me`, { headers: { cookie: cookies } });
    html = await res.text();
    assert.match(html, /on the list for the Gardening group chat/);

    assert.match(await send('/groups/new', { name: 'Knitting', description: 'Wool and patterns' }, '/groups'), /\/groups#room-\d+/);
    res = await fetch(`${t.base}/groups`, { headers: { cookie: cookies } });
    html = await res.text();
    assert.match(html, /Knitting/);
    assert.match(html, /1 person is waiting to chat/);

    // Team can hide a group.
    const auth = { authorization: `Basic ${Buffer.from('team:team-secret').toString('base64')}` };
    const admin = await (await fetch(`${t.base}/admin`, { headers: { ...auth, cookie: cookies } })).text();
    assert.match(admin, /Knitting/);
  } finally {
    t.close();
  }
});
