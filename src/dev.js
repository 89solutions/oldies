// Test-mode simulator (only mounted when no Twilio credentials are set).
// Lets you play both people on a call from a browser: it sends the same
// webhook requests Twilio would, and shows what each person would hear.

import express from 'express';
import { page, field, esc, noticeBox } from './views.js';
import { hashSecret } from './security.js';

export function devRouter({ service, telephony, onAvailable }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  router.use((req, res, next) => {
    if (req.method === 'POST' && req.body._csrf !== req.session.csrf) return res.status(403).send('Please go back and try again.');
    next();
  });

  async function hook(req, path, params, body) {
    const res = await fetch(`${req.protocol}://${req.get('host')}${path}?${new URLSearchParams(params)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
    return `POST ${path} → ${res.status}\n${(await res.text()).replace(/></g, '>\n<')}`;
  }

  router.get('/simulator', (req, res) => {
    req.session.csrf ||= Math.random().toString(36).slice(2);
    const csrf = req.session.csrf;
    const calls = service.q(`SELECT c.*, a.name AS a_name, b.name AS b_name FROM calls c
      JOIN users a ON a.id = c.user_a JOIN users b ON b.id = c.user_b ORDER BY c.id DESC LIMIT 10`).all();
    const waiting = service.q('SELECT id, name, phone FROM users WHERE available_until > ?').all(service.now());
    const btn = (call, leg, act, label) => `<form method="post" action="/dev/simulator/act" style="display:inline">${field(csrf)}
      <input type="hidden" name="call" value="${call}"><input type="hidden" name="leg" value="${leg}">
      <button class="small" name="act" value="${act}">${label}</button></form>`;
    const legButtons = (c, leg) => {
      if (c.medium === 'sms') return '';
      const state = c[`${leg}_state`];
      if (c.status === 'dialing' && state === 'dialing') {
        return btn(c.id, leg, 'ring', 'Hear greeting') + btn(c.id, leg, 'answer', 'Press 1 (join)')
          + btn(c.id, leg, 'decline', 'Press 2 (not now)') + btn(c.id, leg, 'noanswer', "Don't answer");
      }
      if (c.status === 'completed') {
        return btn(c.id, leg, 'fb1', '1: talk again') + btn(c.id, leg, 'fb2', '2: no thanks') + btn(c.id, leg, 'fb9', '9: report');
      }
      return '';
    };
    const groupChats = service.q('SELECT * FROM group_chats ORDER BY id DESC LIMIT 6').all();
    const gbtn = (chat, user, act, label) => `<form method="post" action="/dev/simulator/group-act" style="display:inline">${field(csrf)}
      <input type="hidden" name="chat" value="${chat}"><input type="hidden" name="user" value="${user}">
      <button class="small" name="act" value="${act}">${label}</button></form>`;
    const groupButtons = (g, p) => {
      if (!['dialing', 'in_progress'].includes(g.status)) return '';
      if (p.state === 'dialing') return gbtn(g.id, p.user_id, 'ring', 'Hear greeting') + gbtn(g.id, p.user_id, 'answer', 'Press 1 (join)') + gbtn(g.id, p.user_id, 'decline', 'Press 2 (not now)');
      if (p.state === 'joined') return gbtn(g.id, p.user_id, 'leave', 'Hang up');
      return '';
    };
    const last = req.session.lastTwiml;
    delete req.session.lastTwiml;
    res.send(page({
      title: 'Simulator', csrf,
      body: `
<h1>Test-mode simulator</h1>
<p class="muted">No real calls or texts are made. Use this page to play both people on a call.</p>
${noticeBox(req.session.flash)}${(delete req.session.flash, '')}
<form method="post" action="/dev/simulator/demo">${field(csrf)}
<button name="medium" value="voice">Add two demo people who are free for a phone chat</button>
<button name="medium" value="sms" class="secondary">Add two demo people who are free for a text chat</button>
<button name="group" value="voice" class="secondary">Add three demo people for the first group chat, by phone</button>
<button name="group" value="sms" class="secondary">Add three demo people for the first group chat, by text</button></form>
<h2>Send a text to the service</h2>
<form method="post" action="/dev/simulator/sms">${field(csrf)}
<label for="from">From</label>
<select id="from" name="from" style="font-size:1rem;padding:.4rem">${service.q('SELECT name, phone FROM users WHERE verified = 1 ORDER BY id DESC LIMIT 30').all()
    .map((u) => `<option value="${esc(u.phone)}">${esc(u.name)} ${esc(u.phone)}</option>`).join('')}</select>
<label for="body">Message <span class="hint">(try FREE, YES, NO, END, REPORT, or a chat message)</span></label>
<input id="body" name="body" type="text">
<button class="secondary">Send text</button></form>
<form method="post" action="/dev/simulator/match">${field(csrf)}<button class="secondary">Run matching now</button></form>
<h2>Waiting for a chat (${waiting.length})</h2>
<p>${waiting.map((u) => `${esc(u.name)} <span class="muted">${esc(u.phone)}</span>`).join(', ') || 'Nobody'}</p>
<h2>Calls</h2>
${calls.length ? `<table><tr><th>#</th><th>Type / status</th><th>Person A</th><th>Person B</th></tr>
${calls.map((c) => `<tr><td>${c.id}</td><td>${c.medium === 'sms' ? 'text' : 'phone'} · ${c.kind}<br><strong>${c.status}</strong></td>
<td>${esc(c.a_name)} (${c.a_state})<br>${legButtons(c, 'a')}</td>
<td>${esc(c.b_name)} (${c.b_state})<br>${legButtons(c, 'b')}</td></tr>
${c.status === 'in_progress' ? `<tr><td></td><td colspan="3">Chat in progress ${btn(c.id, 'a', 'hangup', 'Both hang up')}</td></tr>` : ''}`).join('')}</table>`
    : '<p>No calls yet.</p>'}
<h2>Group chats</h2>
${groupChats.length ? `<table><tr><th>#</th><th>Group / status</th><th>People</th></tr>
${groupChats.map((g) => `<tr><td>${g.id}</td><td>${esc(service.groups.roomName(g))} · ${g.medium === 'sms' ? 'text' : 'phone'}<br><strong>${g.status}</strong></td>
<td>${service.groups.everyone(g.id).map((p) => `<p>${esc(p.name)} (${p.state}) ${g.medium === 'voice' ? groupButtons(g, p) : ''}</p>`).join('')}</td></tr>`).join('')}</table>`
    : '<p>No group chats yet.</p>'}
${last ? `<h2>What the phone service was told to do</h2><pre>${esc(last)}</pre>` : ''}
<h2>Text messages that would have been sent</h2>
${telephony.sms.slice(-12).reverse().map((m) => `<p><strong>${esc(m.to)}</strong>: ${esc(m.body)}</p>`).join('') || '<p>None yet.</p>'}
<h2>Telephone actions</h2>
<pre>${esc(telephony.events.slice(-8).map((e) => `${e.type} ${e.sid} ${e.url || ''}`).join('\n') || 'None yet.')}</pre>
<a class="button secondary" href="/">Go to the website</a>`,
    }));
  });

  router.post('/simulator/demo', (req, res) => {
    const names = ['Margaret', 'Arthur', 'Joan', 'Stanley', 'Dorothy', 'Harold', 'Edna', 'Wilfred'];
    const room = req.body.group ? service.groups.menuRooms()[0] : null;
    for (let added = 0; added < (room ? 3 : 2);) {
      const phone = `+447700900${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
      if (service.getUserByPhone(phone)) continue;
      added++;
      const id = Number(service.q(`INSERT INTO users (phone, name, pin_hash, verified, created_at) VALUES (?, ?, ?, 1, ?)`)
        .run(phone, names[Math.floor(Math.random() * names.length)], hashSecret('2468'), service.now()).lastInsertRowid);
      if (room) service.setAvailable(id, true, req.body.group, room.id);
      else service.setAvailable(id, true, req.body.medium);
    }
    req.session.flash = room ? `Added three demo people for the ${room.name} group (PIN 2468). Now press "Run matching now".`
      : 'Added two demo people (PIN 2468). Now press "Run matching now".';
    res.redirect('/dev/simulator');
  });

  router.post('/simulator/sms', async (req, res) => {
    req.session.lastTwiml = await hook(req, '/sms/incoming', {}, { From: req.body.from, Body: req.body.body ?? '' });
    res.redirect('/dev/simulator');
  });

  router.post('/simulator/match', async (req, res) => {
    const groupsBefore = service.q('SELECT COUNT(*) AS n FROM group_participants').get().n;
    const started = await service.runMatchmaker();
    const groupJoins = service.q('SELECT COUNT(*) AS n FROM group_participants').get().n - groupsBefore;
    req.session.flash = started.length || groupJoins
      ? `Started ${started.length} call(s)${groupJoins ? ` and put ${groupJoins} people into group chats` : ''}.` : 'Nobody to match right now.';
    res.redirect('/dev/simulator');
  });

  router.post('/simulator/act', async (req, res) => {
    const { call: id, leg, act } = req.body;
    const call = service.getCall(Number(id));
    if (!call) return res.redirect('/dev/simulator');
    const q = { call: id, leg };
    const sid = call[`${leg}_sid`] || 'CAsimulated';
    const out = [];
    if (act === 'ring') out.push(await hook(req, '/voice/leg', q, { CallSid: sid }));
    if (act === 'answer') out.push(await hook(req, '/voice/leg-answer', q, { CallSid: sid, Digits: '1' }));
    if (act === 'decline') out.push(await hook(req, '/voice/leg-answer', q, { CallSid: sid, Digits: '2' }));
    if (act === 'noanswer') out.push(await hook(req, '/voice/leg-status', q, { CallSid: sid, CallStatus: 'no-answer' }));
    if (act === 'hangup') {
      out.push(await hook(req, '/voice/after', { call: id, leg: 'a' }, { CallSid: call.a_sid }));
      for (const l of ['a', 'b']) out.push(await hook(req, '/voice/leg-status', { call: id, leg: l }, { CallSid: call[`${l}_sid`], CallStatus: 'completed' }));
    }
    if (act?.startsWith('fb')) out.push(await hook(req, '/voice/feedback', q, { CallSid: sid, Digits: act.slice(2) }));
    req.session.lastTwiml = out.join('\n\n');
    onAvailable();
    res.redirect('/dev/simulator');
  });

  router.post('/simulator/group-act', async (req, res) => {
    const { chat, user, act } = req.body;
    const p = service.groups.participant(Number(chat), Number(user));
    if (!p) return res.redirect('/dev/simulator');
    const q = { chat, user };
    const sid = p.sid || 'CAsimulated';
    const out = [];
    if (act === 'ring') out.push(await hook(req, '/voice/group-leg', q, { CallSid: sid }));
    if (act === 'answer') out.push(await hook(req, '/voice/group-answer', q, { CallSid: sid, Digits: '1' }));
    if (act === 'decline') out.push(await hook(req, '/voice/group-answer', q, { CallSid: sid, Digits: '2' }));
    if (act === 'leave') {
      out.push(await hook(req, '/voice/group-after', q, { CallSid: sid }));
      out.push(await hook(req, '/voice/group-leg-status', q, { CallSid: sid, CallStatus: 'completed' }));
    }
    req.session.lastTwiml = out.join('\n\n');
    onAvailable();
    res.redirect('/dev/simulator');
  });

  return router;
}
