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
    const last = req.session.lastTwiml;
    delete req.session.lastTwiml;
    res.send(page({
      title: 'Simulator', csrf,
      body: `
<h1>Test-mode simulator</h1>
<p class="muted">No real calls or texts are made. Use this page to play both people on a call.</p>
${noticeBox(req.session.flash)}${(delete req.session.flash, '')}
<form method="post" action="/dev/simulator/demo">${field(csrf)}<button>Add two demo people who are free to chat</button></form>
<form method="post" action="/dev/simulator/match">${field(csrf)}<button class="secondary">Run matching now</button></form>
<h2>Waiting for a chat (${waiting.length})</h2>
<p>${waiting.map((u) => `${esc(u.name)} <span class="muted">${esc(u.phone)}</span>`).join(', ') || 'Nobody'}</p>
<h2>Calls</h2>
${calls.length ? `<table><tr><th>#</th><th>Type / status</th><th>Person A</th><th>Person B</th></tr>
${calls.map((c) => `<tr><td>${c.id}</td><td>${c.kind}<br><strong>${c.status}</strong></td>
<td>${esc(c.a_name)} (${c.a_state})<br>${legButtons(c, 'a')}</td>
<td>${esc(c.b_name)} (${c.b_state})<br>${legButtons(c, 'b')}</td></tr>
${c.status === 'in_progress' ? `<tr><td></td><td colspan="3">Chat in progress ${btn(c.id, 'a', 'hangup', 'Both hang up')}</td></tr>` : ''}`).join('')}</table>`
    : '<p>No calls yet.</p>'}
${last ? `<h2>What the phone service was told to do</h2><pre>${esc(last)}</pre>` : ''}
<h2>Text messages that would have been sent</h2>
${telephony.sms.slice(-8).reverse().map((m) => `<p><strong>${esc(m.to)}</strong>: ${esc(m.body)}</p>`).join('') || '<p>None yet.</p>'}
<h2>Telephone actions</h2>
<pre>${esc(telephony.events.slice(-8).map((e) => `${e.type} ${e.sid} ${e.url || ''}`).join('\n') || 'None yet.')}</pre>
<a class="button secondary" href="/">Go to the website</a>`,
    }));
  });

  router.post('/simulator/demo', (req, res) => {
    const names = ['Margaret', 'Arthur', 'Joan', 'Stanley', 'Dorothy', 'Harold', 'Edna', 'Wilfred'];
    for (let added = 0; added < 2;) {
      const phone = `+447700900${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
      if (service.getUserByPhone(phone)) continue;
      added++;
      const id = Number(service.q(`INSERT INTO users (phone, name, pin_hash, verified, created_at) VALUES (?, ?, ?, 1, ?)`)
        .run(phone, names[Math.floor(Math.random() * names.length)], hashSecret('2468'), service.now()).lastInsertRowid);
      service.setAvailable(id, true);
    }
    req.session.flash = 'Added two demo people (PIN 2468). Now press "Run matching now".';
    res.redirect('/dev/simulator');
  });

  router.post('/simulator/match', async (req, res) => {
    const started = await service.runMatchmaker();
    req.session.flash = started.length ? `Started ${started.length} call(s).` : 'Nobody to match right now.';
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

  return router;
}
