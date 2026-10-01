import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { MockTelephony } from '../src/telephony.js';
import { createApp } from '../src/server.js';
import { hashSecret } from '../src/security.js';

export const quiet = { info() {}, warn() {}, error() {} };

export async function setup(overrides = {}) {
  const clock = { t: Date.UTC(2026, 9, 1, 10) };
  const config = loadConfig({ telephony: 'mock', dbPath: ':memory:', baseUrl: 'http://test.local', adminPassword: 'team-secret', ...overrides });
  const telephony = new MockTelephony(quiet);
  const { app, service } = createApp({ config, db: openDb(':memory:'), telephony, log: quiet, now: () => clock.t });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Webhooks are built with config.baseUrl; point that at the test server for the simulator.
  const post = async (path, body = {}, headers = {}) => {
    const res = await fetch(base + path, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body),
    });
    return { status: res.status, text: await res.text(), headers: res.headers };
  };
  const addUser = (name, phone, { available = false, pin = '2468' } = {}) => {
    const id = Number(service.q('INSERT INTO users (phone, name, pin_hash, verified, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(phone, name, hashSecret(pin), clock.t).lastInsertRowid);
    if (available) service.setAvailable(id, true);
    return id;
  };
  return { config, service, telephony, server, base, post, addUser, clock, close: () => server.close() };
}

// Plays a whole chat: both answer, both join, both hang up.
export async function completeCall(t, call) {
  await t.post(`/voice/leg-answer?call=${call.id}&leg=a`, { Digits: '1', CallSid: call.a_sid });
  await t.post(`/voice/leg-answer?call=${call.id}&leg=b`, { Digits: '1', CallSid: call.b_sid });
  t.clock.t += 10 * 60 * 1000;
  for (const leg of ['a', 'b']) await t.post(`/voice/leg-status?call=${call.id}&leg=${leg}`, { CallStatus: 'completed' });
  return t.service.getCall(call.id);
}
