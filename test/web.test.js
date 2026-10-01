import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

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

test('joining on the website, confirming by text, and saying you are free', async () => {
  const t = await setup();
  try {
    const b = browser(t);
    let res = await b.post('/join', { name: 'Margaret', phone: '07700 900091', pin: '2468', agree: '1' });
    assert.equal(res.location, '/verify');
    const code = t.telephony.sms.at(-1).body.match(/\d{6}/)[0];
    res = await b.post('/verify', { code });
    assert.equal(res.location, '/me');
    let me = await b.get('/me');
    assert.match(me.text, /Hello Margaret/);
    await b.post('/me/available', { on: '1' });
    me = await b.get('/me');
    assert.match(me.text, /on the list for a chat/);
  } finally {
    t.close();
  }
});

test('forms without the page token are refused', async () => {
  const t = await setup();
  try {
    const res = await t.post('/join', { name: 'X', phone: '07700900092', pin: '2468', agree: '1' });
    assert.equal(res.status, 403);
  } finally {
    t.close();
  }
});

test('the team page needs the team password', async () => {
  const t = await setup();
  try {
    let res = await fetch(`${t.base}/admin`);
    assert.equal(res.status, 401);
    res = await fetch(`${t.base}/admin`, { headers: { authorization: `Basic ${Buffer.from('team:team-secret').toString('base64')}` } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Open reports/);
  } finally {
    t.close();
  }
});

test('a forgotten PIN can be reset with a texted code', async () => {
  const t = await setup();
  try {
    t.addUser('Joan', '+447700900093');
    const b = browser(t);
    await b.post('/forgot', { phone: '07700 900093' });
    const code = t.telephony.sms.at(-1).body.match(/\d{6}/)[0];
    const bad = await b.post('/forgot/finish', { code: '000000', pin: '3579' });
    assert.equal(bad.location, '/forgot');
    const ok = await b.post('/forgot/finish', { code, pin: '3579' });
    assert.equal(ok.location, '/me');
    assert.equal(t.service.login('07700900093', '3579').name, 'Joan');
  } finally {
    t.close();
  }
});

test('choosing a text chat on the website, and ending it from there', async () => {
  const t = await setup();
  try {
    const b = browser(t);
    await b.post('/join', { name: 'Margaret', phone: '07700 900094', pin: '2468', agree: '1' });
    await b.post('/verify', { code: t.telephony.sms.at(-1).body.match(/\d{6}/)[0] });
    await b.post('/me/available', { on: '1', medium: 'sms' });
    let me = await b.get('/me');
    assert.match(me.text, /on the list for a text message chat/);
    t.addUser('Arthur', '+447700900095');
    t.service.setAvailable(t.service.getUserByPhone('+447700900095').id, true, 'sms');
    await t.service.runMatchmaker();
    me = await b.get('/me');
    assert.match(me.text, /in a text chat with Arthur/);
    await b.post('/me/end-text-chat', {});
    me = await b.get('/me');
    assert.match(me.text, /Would you like to talk to Arthur again/);
  } finally {
    t.close();
  }
});
