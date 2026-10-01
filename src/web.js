import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { UserError } from './service.js';
import { page, field, errorBox, noticeBox, esc, when } from './views.js';

export function webRouter({ service, config, log = console, onAvailable = () => {} }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  // Every form carries a token tied to the visitor's session.
  router.use((req, res, next) => {
    req.session.csrf ||= randomBytes(16).toString('hex');
    if (req.method === 'POST' && req.body._csrf !== req.session.csrf) {
      return res.status(403).send(page({ title: 'Please try again', body: '<h1>Please go back and try again.</h1>' }));
    }
    next();
  });

  const render = (req, res, opts) => {
    const flash = req.session.flash;
    delete req.session.flash;
    res.send(page({ ...opts, csrf: req.session.csrf, body: noticeBox(flash) + opts.body }));
  };
  const flash = (req, msg) => { req.session.flash = msg; };
  const currentUser = (req) => (req.session.userId ? service.getUser(req.session.userId) : null);

  function requireUser(req, res, next) {
    const user = currentUser(req);
    if (!user) return res.redirect('/signin');
    if (!user.verified) return res.redirect('/verify');
    if (user.status === 'banned') { req.session = null; return res.redirect('/'); }
    req.user = user;
    next();
  }

  // Turns friendly errors into a message on the page they came from.
  const handle = (fn, back) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (!(err instanceof UserError)) log.error?.(err);
      flash(req, err instanceof UserError ? err.message : 'Sorry, something went wrong. Please try again.');
      res.redirect(back);
    }
  };

  // ---------- public pages ----------

  router.get('/', (req, res) => {
    if (currentUser(req)) return res.redirect('/me');
    render(req, res, {
      title: 'Welcome',
      body: `
<h1>A friendly chat, whenever you'd like one</h1>
<p>Lonely Oldies puts you in touch with another person for a chat, on the phone or by text message.</p>
<p><strong>Your phone number is always kept private.</strong> We ring you both from our own number, so nobody ever sees yours.</p>
<a class="button" href="/join">Join Lonely Oldies</a>
<a class="button secondary" href="/signin">I've already joined</a>
<h2>Prefer the phone?</h2>
<p>Ring us any time and follow the instructions. You can join, or say you're free for a chat.</p>
<p class="phone">${esc(config.publicPhoneNumber)}</p>`,
    });
  });

  router.get('/safety', (req, res) => render(req, res, {
    title: 'Staying safe', user: currentUser(req),
    body: `
<h1>Staying safe</h1>
<ul class="tips">
<li>We never give anyone your phone number, and you never see theirs.</li>
<li>Only your first name is shared.</li>
<li>Never tell anyone your address, bank details, PIN or passwords.</li>
<li>Nobody from Lonely Oldies will ever ask you for money or your PIN.</li>
<li>If a phone chat makes you uncomfortable, press the <strong>star key (*)</strong> to end it straight away.</li>
<li>In a text chat, text <strong>END</strong> to finish or <strong>REPORT</strong> if anything upsets you.</li>
<li>Every text message is checked before it is passed on. Messages with phone numbers, addresses, web links, anything about money, or unkind words are stopped.</li>
<li>After a chat you can report someone. They are blocked from ever reaching you again, and our team will look into it.</li>
<li>If someone is reported by more than one person, their account is paused straight away.</li>
<li>If you are ever in danger, ring the emergency services.</li>
</ul>
<a class="button secondary" href="/">Back</a>`,
  }));

  router.get('/join', (req, res) => render(req, res, {
    title: 'Join',
    body: `
<h1>Join Lonely Oldies</h1>
<form method="post" action="/join">${field(req.session.csrf)}
<label for="name">Your first name <span class="hint">(this is all anyone else sees)</span></label>
<input id="name" name="name" type="text" autocomplete="given-name" required>
<label for="phone">Your phone number <span class="hint">(we'll ring you on this)</span></label>
<input id="phone" name="phone" type="tel" autocomplete="tel" required>
<label for="pin">Choose a 4 number PIN <span class="hint">(you'll use it to sign in and when you ring us)</span></label>
<input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required>
<label><input type="checkbox" name="agree" value="1" required> I have read <a href="/safety" target="_blank">staying safe</a> and agree to be kind to the people I talk to.</label>
<button>Join</button>
</form>`,
  }));

  router.post('/join', handle(async (req, res) => {
    if (req.body.agree !== '1') throw new UserError('Please tick the box to agree to be kind.');
    const user = await service.register(req.body);
    req.session.userId = user.id;
    res.redirect('/verify');
  }, '/join'));

  router.get('/verify', (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect('/join');
    if (user.verified) return res.redirect('/me');
    render(req, res, {
      title: 'Check your phone',
      body: `
<h1>We've sent you a text message</h1>
<p>Please type in the 6 number code we sent to your phone.</p>
${config.telephony === 'mock' ? '<p class="notice">Test mode: no real text was sent. The code is shown on the <a href="/dev/simulator">simulator page</a>.</p>' : ''}
<form method="post" action="/verify">${field(req.session.csrf)}
<label for="code">Code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required>
<button>Carry on</button>
</form>
<form method="post" action="/verify/resend">${field(req.session.csrf)}<button class="secondary">Send me a new code</button></form>`,
    });
  });

  router.post('/verify', handle(async (req, res) => {
    service.verifyPhone(req.session.userId, req.body.code);
    flash(req, "You're all set up. Welcome!");
    res.redirect('/me');
  }, '/verify'));

  router.post('/verify/resend', handle(async (req, res) => {
    await service.resendCode(req.session.userId);
    flash(req, "We've sent a new code.");
    res.redirect('/verify');
  }, '/verify'));

  router.get('/signin', (req, res) => render(req, res, {
    title: 'Sign in',
    body: `
<h1>Sign in</h1>
<form method="post" action="/signin">${field(req.session.csrf)}
<label for="phone">Your phone number</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" required>
<label for="pin">Your 4 number PIN</label>
<input id="pin" name="pin" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" required>
<button>Sign in</button>
</form>
<a class="button secondary" href="/forgot">I've forgotten my PIN</a>`,
  }));

  router.post('/signin', handle(async (req, res) => {
    const user = service.login(req.body.phone, req.body.pin);
    req.session.userId = user.id;
    res.redirect(user.verified ? '/me' : '/verify');
  }, '/signin'));

  router.get('/forgot', (req, res) => render(req, res, {
    title: 'Forgotten PIN',
    body: req.session.resetPhone ? `
<h1>Choose a new PIN</h1>
<p>We've sent a text message with a 6 number code to your phone.</p>
${config.telephony === 'mock' ? '<p class="notice">Test mode: the code is shown on the <a href="/dev/simulator">simulator page</a>.</p>' : ''}
<form method="post" action="/forgot/finish">${field(req.session.csrf)}
<label for="code">Code from the text message</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required>
<label for="pin">Your new 4 number PIN</label>
<input id="pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required>
<button>Save my new PIN</button>
</form>` : `
<h1>Forgotten your PIN?</h1>
<p>Type in your phone number and we'll send you a text message with a code.</p>
<form method="post" action="/forgot">${field(req.session.csrf)}
<label for="phone">Your phone number</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" required>
<button>Send me a code</button>
</form>`,
  }));

  router.post('/forgot', handle(async (req, res) => {
    await service.startPinReset(req.body.phone);
    req.session.resetPhone = req.body.phone;
    res.redirect('/forgot');
  }, '/forgot'));

  router.post('/forgot/finish', handle(async (req, res) => {
    const user = service.finishPinReset(req.session.resetPhone, req.body.code, req.body.pin);
    delete req.session.resetPhone;
    req.session.userId = user.id;
    flash(req, 'Your new PIN is saved. Please keep it somewhere safe.');
    res.redirect('/me');
  }, '/forgot'));

  router.post('/signout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });

  // ---------- signed-in pages ----------

  router.get('/me', requireUser, (req, res) => {
    const user = req.user;
    const available = service.isAvailable(user);
    const live = service.activeCall(user.id);
    const friends = service.listFriends(user.id);
    const pending = service.pendingFeedback(user.id);
    const csrf = req.session.csrf;

    let status;
    if (user.status !== 'active') {
      status = `<div class="card status"><p>${esc(service.blockedReason(user))}</p></div>`;
    } else if (live?.medium === 'sms') {
      const other = service.otherPartyFor(live, user.id);
      status = `<div class="card status">
<h1>${live.status === 'dialing' ? `Waiting for ${esc(other.name)} to reply` : `You're in a text chat with ${esc(other.name)}`}</h1>
<p>Reply to our text messages on your phone, and we'll pass them on. Your numbers stay private.</p>
<form method="post" action="/me/end-text-chat">${field(csrf)}<button class="secondary">End the text chat</button></form>
<a href="/me/report?call=${live.id}">Something's not right in this chat</a>
</div>`;
    } else if (live) {
      status = `<div class="card status"><h1>We're ringing you now</h1><p>Please answer your phone.</p></div>`;
    } else if (available) {
      const byText = user.available_medium === 'sms';
      status = `<div class="card status">
<h1>You're on the list for a ${byText ? 'text message chat' : 'chat'}</h1>
<p>${byText ? "We'll send you a text message as soon as someone is free." : "We'll ring you as soon as someone is free. Keep your phone nearby."}</p>
<p class="muted">We'll stop trying at ${esc(new Date(user.available_until).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' }))}.</p>
<form method="post" action="/me/available">${field(csrf)}<input type="hidden" name="on" value="0"><button class="secondary">I don't want a call now</button></form>
</div>`;
    } else {
      status = `<div class="card status">
<h1>Hello ${esc(user.name)}</h1>
<p>Would you like a chat with someone new?</p>
<form method="post" action="/me/available">${field(csrf)}<input type="hidden" name="on" value="1">
<button name="medium" value="voice">Yes, ring me for a chat</button>
<button name="medium" value="sms" class="secondary">Yes, a chat by text message</button></form>
<p class="muted">With a text chat, you send text messages to our number and we pass them on.</p>
</div>`;
    }

    const feedback = pending.map((c) => `
<div class="card">
<p><strong>You talked to ${esc(c.other_name)}</strong> <span class="muted">on ${esc(when(c.started_at))}</span></p>
<p>Would you like to talk to ${esc(c.other_name)} again?</p>
<form method="post" action="/me/feedback">${field(csrf)}<input type="hidden" name="call" value="${c.id}">
<div class="row"><button name="answer" value="yes">Yes please</button><button name="answer" value="no" class="secondary">No thank you</button></div>
</form>
<a href="/me/report?call=${c.id}">Something wasn't right in this chat</a>
</div>`).join('');

    const friendList = friends.length
      ? friends.map((f) => `
<div class="card">
<p><strong>${esc(f.name)}</strong>${f.last_spoke ? ` <span class="muted">· last chat ${esc(when(f.last_spoke))}</span>` : ''}</p>
<form method="post" action="/me/call-friend">${field(csrf)}<input type="hidden" name="friend" value="${f.id}">
<div class="row"><button name="medium" value="voice">Ring ${esc(f.name)}</button>
<button name="medium" value="sms" class="secondary">Text ${esc(f.name)}</button></div></form>
<details><summary>More</summary>
<form method="post" action="/me/block" onsubmit="return confirm('Block ${esc(f.name)}? You will never be put through to them again.')">${field(csrf)}
<input type="hidden" name="user" value="${f.id}"><button class="danger small">Block ${esc(f.name)}</button></form>
</details>
</div>`).join('')
      : '<p class="muted">After a chat, if you both say you\'d like to talk again, they will appear here and you can ring them.</p>';

    render(req, res, {
      title: 'Your page', user, refresh: available || live ? 30 : undefined,
      body: `${status}
${feedback ? `<h2>Your recent chats</h2>${feedback}` : ''}
<h2>Friends</h2>
<p class="muted">Ring or text them through us, so your numbers stay private.</p>
${friendList}
<h2>Ringing us instead</h2>
<p>You can do all of this by phone too. Ring <span class="phone">${esc(config.publicPhoneNumber)}</span> and use your PIN.</p>
${lastCallReport(user, csrf)}`,
    });
  });

  function lastCallReport(user) {
    const last = service.lastCall(user.id);
    if (!last || service.pendingFeedback(user.id).some((c) => c.id === last.id)) return '';
    const other = service.otherPartyFor(last, user.id);
    return `<p><a href="/me/report?call=${last.id}">Report a problem with ${esc(other.name)} (your last chat)</a></p>`;
  }

  router.post('/me/available', requireUser, handle(async (req, res) => {
    const on = req.body.on === '1';
    service.setAvailable(req.user.id, on, req.body.medium);
    if (on) setImmediate(onAvailable);
    res.redirect('/me');
  }, '/me'));

  router.post('/me/feedback', requireUser, handle(async (req, res) => {
    const result = await service.submitFeedback(Number(req.body.call), req.user.id, req.body.answer === 'yes');
    if (req.body.answer !== 'yes') flash(req, 'Thank you for letting us know.');
    else if (result.connected) flash(req, `Wonderful! ${result.other.name} would like to talk again too. You can ring them below.`);
    else flash(req, "Lovely. If they'd like to talk again too, we'll send you a text and they'll appear below.");
    res.redirect('/me');
  }, '/me'));

  router.get('/me/report', requireUser, (req, res) => {
    const call = service.getCall(Number(req.query.call));
    const other = call && service.otherPartyFor(call, req.user.id);
    if (!other) return res.redirect('/me');
    render(req, res, {
      title: 'Report a problem', user: req.user,
      body: `
<h1>Report a problem with ${esc(other.name)}</h1>
<p>We're sorry something went wrong. When you send this, <strong>${esc(other.name)} is blocked</strong> and you will never be put through to them again. Our team will look into what happened.</p>
<form method="post" action="/me/report">${field(req.session.csrf)}<input type="hidden" name="call" value="${call.id}">
<label for="reason">What happened? <span class="hint">(optional)</span></label>
<textarea id="reason" name="reason" rows="5"></textarea>
<button class="danger">Report and block ${esc(other.name)}</button>
</form>
<a class="button secondary" href="/me">Go back</a>`,
    });
  });

  router.post('/me/report', requireUser, handle(async (req, res) => {
    const { reported } = await service.report(req.user.id, Number(req.body.call), req.body.reason);
    flash(req, `Thank you for telling us. ${reported.name} has been blocked and our team will look into it.`);
    res.redirect('/me');
  }, '/me'));

  router.post('/me/block', requireUser, handle(async (req, res) => {
    const other = service.getUser(Number(req.body.user));
    // Only people you've actually spoken to can be blocked from here.
    if (!other || !service.q(`SELECT 1 FROM calls WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)`)
      .get(req.user.id, other.id, other.id, req.user.id)) throw new UserError('Sorry, something went wrong.');
    service.block(req.user.id, other.id);
    flash(req, `${other.name} has been blocked.`);
    res.redirect('/me');
  }, '/me'));

  router.post('/me/call-friend', requireUser, handle(async (req, res) => {
    const medium = req.body.medium === 'sms' ? 'sms' : 'voice';
    const call = await service.callFriend(req.user.id, Number(req.body.friend), { medium });
    const name = service.getUser(call.user_b).name;
    flash(req, medium === 'sms'
      ? `We've sent ${name} a text to ask if they'd like to chat. We'll text you when they reply.`
      : `We're ringing you now, then we'll ring ${name}.`);
    res.redirect('/me');
  }, '/me'));

  router.post('/me/end-text-chat', requireUser, handle(async (req, res) => {
    const live = service.activeCall(req.user.id);
    if (live?.medium === 'sms') await service.texts.end(live);
    res.redirect('/me');
  }, '/me'));

  // ---------- team page ----------

  const adminAuth = (req, res, next) => {
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    const password = scheme === 'Basic' ? Buffer.from(encoded || '', 'base64').toString().split(':').slice(1).join(':') : '';
    const want = Buffer.from(config.adminPassword);
    const got = Buffer.from(password);
    if (config.adminPassword && got.length === want.length && timingSafeEqual(got, want)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Lonely Oldies team"').status(401).send('Team sign-in needed.');
  };

  router.get('/admin', adminAuth, (req, res) => {
    const { reports, suspended, stats } = service.adminOverview();
    const stopped = service.texts.recentlyStopped();
    const csrf = req.session.csrf;
    const action = (path, id, label, cls = 'small') => `<form method="post" action="${path}" style="display:inline">${field(csrf)}
      <input type="hidden" name="id" value="${id}"><button class="${cls}">${label}</button></form>`;
    render(req, res, {
      title: 'Team',
      body: `
<h1>Team page</h1>
<p>${stats.users} members · ${stats.waiting} waiting · ${stats.live_calls} live calls · ${stats.total_calls} chats so far · ${stats.friendships} friendships</p>
<h2>Open reports</h2>
${reports.length ? `<table><tr><th>When</th><th>Reported</th><th>By</th><th>What happened</th><th></th></tr>
${reports.map((r) => `<tr><td>${esc(when(r.created_at))}</td>
<td>${esc(r.reported_name)} (#${r.reported})<br>${esc(r.reported_status)} · ${r.total_against} report(s) in total</td>
<td>${esc(r.reporter_name)} (#${r.reporter})</td><td><pre>${esc(r.reason)}</pre>${r.medium === 'sms' ? `<a href="/admin/chat/${r.call_id}">Read the text chat</a>` : ''}</td>
<td>${action('/admin/ban', r.reported, 'Ban', 'danger small')}${action('/admin/reinstate', r.reported, 'Clear all')}${action('/admin/dismiss', r.id, 'Dismiss this one', 'secondary small')}</td></tr>`).join('')}</table>`
    : '<p>No open reports.</p>'}
<h2>Paused accounts</h2>
${suspended.length ? suspended.map((u) => `<p>${esc(u.name)} (#${u.id}, ${esc(u.phone)}) ${action('/admin/ban', u.id, 'Ban', 'danger small')}${action('/admin/reinstate', u.id, 'Reinstate')}</p>`).join('') : '<p>None.</p>'}
<h2>Text messages stopped by screening</h2>
${stopped.length ? `<table><tr><th>When</th><th>From</th><th>Message</th><th>Why</th></tr>
${stopped.map((m) => `<tr><td>${esc(when(m.created_at))}</td><td>${esc(m.sender_name)} (#${m.sender})</td>
<td>${esc(m.body)}</td><td>${esc(m.screen_reason)}<br><a href="/admin/chat/${m.call_id}">Whole chat</a></td></tr>`).join('')}</table>`
    : '<p>None.</p>'}`,
    });
  });

  router.get('/admin/chat/:id', adminAuth, (req, res) => {
    const call = service.getCall(Number(req.params.id));
    if (!call) return res.redirect('/admin');
    const a = service.getUser(call.user_a);
    const b = service.getUser(call.user_b);
    const lines = service.texts.transcript(call.id);
    render(req, res, {
      title: 'Text chat',
      body: `
<h1>Text chat between ${esc(a.name)} (#${a.id}) and ${esc(b.name)} (#${b.id})</h1>
<p class="muted">Started ${esc(when(call.started_at || call.created_at))} · ${esc(call.status)}. Messages are deleted after ${config.messageRetentionDays} days.</p>
${lines.length ? `<table><tr><th>When</th><th>From</th><th>Message</th><th>Passed on?</th></tr>
${lines.map((m) => `<tr><td>${esc(when(m.created_at))}</td><td>${esc(m.sender_name)}</td><td>${esc(m.body)}</td>
<td>${m.delivered ? 'Yes' : `No: ${esc(m.screen_reason)}`}</td></tr>`).join('')}</table>` : '<p>No messages kept.</p>'}
<a class="button secondary" href="/admin">Back</a>`,
    });
  });

  router.post('/admin/ban', adminAuth, handle(async (req, res) => {
    await service.ban(Number(req.body.id), 'Banned by team');
    flash(req, 'Banned. Their number can never be used again.');
    res.redirect('/admin');
  }, '/admin'));

  router.post('/admin/reinstate', adminAuth, (req, res) => {
    service.reinstate(Number(req.body.id));
    flash(req, 'Reinstated and reports cleared. Anyone who reported them still has them blocked.');
    res.redirect('/admin');
  });

  router.post('/admin/dismiss', adminAuth, (req, res) => {
    service.dismissReport(Number(req.body.id));
    res.redirect('/admin');
  });

  return router;
}
