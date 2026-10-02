import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { UserError } from './service.js';
import { page, field, errorBox, noticeBox, esc, when, timeOfDay } from './views.js';

// The words on these pages are written for people who don't use computers
// much: short sentences, everyday words, no technical terms.

export function webRouter({ service, config, log = console, onAvailable = () => {} }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  const phone = config.publicPhoneNumber;

  // Every form carries a token tied to the visitor's session.
  router.use((req, res, next) => {
    req.session.csrf ||= randomBytes(16).toString('hex');
    if (req.method === 'POST' && req.body._csrf !== req.session.csrf) {
      return res.status(403).send(page({
        title: 'Please try again', phone,
        body: '<h1>Sorry, that didn\'t work</h1><p>Please go back to the page before and try again.</p><a class="button" href="/">Go to the first page</a>',
      }));
    }
    next();
  });

  const render = (req, res, opts) => {
    const message = req.session.flash;
    delete req.session.flash;
    const box = message ? (message.bad ? errorBox(message.text) : noticeBox(message.text ?? message)) : '';
    res.send(page({ ...opts, csrf: req.session.csrf, big: Boolean(req.session.big), phone, path: opts.path ?? req.path, body: box + opts.body }));
  };
  const flash = (req, text, { bad = false } = {}) => { req.session.flash = { text, bad }; };
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
      flash(req, err instanceof UserError ? err.message : 'Sorry, something went wrong. Please try again.', { bad: true });
      res.redirect(back);
    }
  };

  const pic = (name) => `<img src="/images/${name}.svg" alt="">`;
  const practiceNote = (what) => (config.telephony === 'mock'
    ? `<p class="message good">Practice mode: no real text message was sent. ${what} is shown on the <a href="/dev/simulator">practice page</a>.</p>` : '');

  // "Make the text bigger" link, remembered for this visitor.
  router.get('/text-size', (req, res) => {
    req.session.big = req.query.big === '1';
    const back = String(req.query.back || '/');
    res.redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/');
  });

  // ---------- pages anyone can see ----------

  router.get('/', (req, res) => {
    if (currentUser(req)) return res.redirect('/me');
    render(req, res, {
      title: 'A friendly chat',
      body: `
<div class="hero">
<h1>A friendly chat, whenever you'd like one</h1>
<p class="lead">Lonely Oldies puts you in touch with someone new for a friendly chat, on the phone or by text message.</p>
<img src="/images/hero.svg" alt="Two older people smiling as they chat on the phone from their armchairs">
</div>
<div class="card sage with-pic">${pic('shield')}<div>
<p><strong>Your phone number stays private.</strong></p>
<p>We ring you both from our own number, so nobody ever sees yours.</p>
</div></div>
<a class="button" href="/join">Join Lonely Oldies</a>
<a class="button secondary" href="/signin">I've joined before. Sign in</a>

<h2>How it works</h2>
<ol class="steps">
<li>${pic('hand')}<div><h3>Tell us you're free</h3><p>Press one button, or ring us.</p></div></li>
<li>${pic('ring')}<div><h3>We ring you</h3><p>When someone else is free, we ring you both and put you through.</p></div></li>
<li>${pic('heart')}<div><h3>Chat again if you like</h3><p>If you both enjoyed it, you can chat again another day.</p></div></li>
</ol>
<a class="button secondary" href="/how-it-works">Find out more</a>

<h2>Rather use the telephone?</h2>
<p>You don't need a computer. Ring us on</p>
<p class="phone">${esc(phone)}</p>
<p>A friendly recorded voice will guide you. You can join, and say you're free for a chat, just by pressing the numbers on your phone.</p>`,
    });
  });

  router.get('/how-it-works', (req, res) => render(req, res, {
    title: 'How it works', user: currentUser(req),
    body: `
<h1>How it works</h1>
<p class="lead">It's simple, and you can do it all with an ordinary telephone.</p>
<ol class="steps">
<li>${pic('hand')}<div><h3>1. Tell us you're free</h3>
<p>Press the button on your page, or ring us. Choose a chat on the phone or a chat by text message.</p></div></li>
<li>${pic('ring')}<div><h3>2. We put you in touch</h3>
<p>When someone else is free, we ring you. We tell you their first name. Press 1 on your phone to start chatting, or 2 if now isn't a good time.</p></div></li>
<li>${pic('chat')}<div><h3>3. Have a chat</h3>
<p>Chat for as long as you like, up to ${Math.round(config.maxCallMinutes)} minutes. When you've finished, just put the phone down.</p></div></li>
<li>${pic('heart')}<div><h3>4. Chat again if you both want to</h3>
<p>Afterwards, we ask if you'd like to chat to them again. If you both say yes, you can ring each other through us whenever you like.</p></div></li>
</ol>

<div class="card sky with-pic">${pic('text')}<div>
<h2>Prefer writing to talking?</h2>
<p>Choose a chat by text message. You send your messages to our number, and we pass them on with your first name.</p>
<p>When you've finished, send a text that just says <strong>END</strong>.</p>
</div></div>

<div class="card peach with-pic">${pic('group')}<div>
<h2>Chat with a group</h2>
<p>Would you like to chat with a few people who enjoy the same things as you? Choose a group, such as gardening, music or books.</p>
<p>When ${config.groupMinSize} or more people are free, we ring you all, or text you all, and put you together. Up to ${config.groupMaxSize} people can chat at once.</p>
<p><a href="/groups">See the group chats</a></p>
</div></div>

<div class="card sage with-pic">${pic('shield')}<div>
<h2>Your number stays private</h2>
<p>Every call and text message goes through Lonely Oldies. The other person never sees your phone number, and you never see theirs. They only know your first name.</p>
</div></div>

<h2>What you need</h2>
<ul class="tips">
<li>A telephone. A landline is fine for phone chats.</li>
<li>A mobile phone if you'd like to chat by text message.</li>
</ul>
<p>That's all. A family member or friend is very welcome to help you join.</p>
<a class="button" href="${currentUser(req) ? '/me' : '/join'}">${currentUser(req) ? 'Go to your page' : 'Join Lonely Oldies'}</a>`,
  }));

  router.get('/safety', (req, res) => render(req, res, {
    title: 'Staying safe', user: currentUser(req),
    body: `
<h1>Staying safe</h1>
<div class="card sage with-pic">${pic('shield')}<div>
<p class="lead">We've made Lonely Oldies as safe as we can. Here's how we look after you, and how you can look after yourself.</p>
</div></div>
<h2>How we look after you</h2>
<ul class="tips">
<li>Nobody ever sees your phone number, and you never see theirs.</li>
<li>Only your first name is shared.</li>
<li>Every text message is checked before we pass it on. Messages with phone numbers, addresses, anything about money, or unkind words are stopped.</li>
<li>If you tell us someone upset you, you will never be put in touch with them again, and our team will look into it.</li>
<li>If more than one person tells us about someone, we stop them using Lonely Oldies straight away.</li>
</ul>
<h2>How to look after yourself</h2>
<ul class="tips">
<li>Never tell anyone your address, your bank details, your PIN or any passwords.</li>
<li>Never send money to anyone you meet here, whatever reason they give.</li>
<li><strong>Nobody from Lonely Oldies will ever ask you for money or your PIN.</strong></li>
</ul>
<h2>If a chat doesn't feel right</h2>
<ul class="tips">
<li>On the phone: press the <strong>star key (*)</strong>, or just put the phone down. Afterwards, press <strong>9</strong> to tell us.</li>
<li>By text message: send a text that just says <strong>REPORT</strong>. In a group chat, send <strong>REPORT</strong> and the person's name.</li>
<li>On your page: press "Something wasn't right" under the chat.</li>
</ul>
<p>If you are ever in danger, ring 999.</p>`,
  }));

  router.get('/questions', (req, res) => {
    const qa = [
      ['Will anyone see my phone number?', 'No. We ring you both from our own number, and text messages go through us too. The other person never sees your number.'],
      ['What will the other person know about me?', 'Only your first name. Everything else is up to you, and we suggest you keep your address and money matters to yourself.'],
      ['Who will I be chatting to?', 'Another member of Lonely Oldies who is free for a chat at the same time as you. We choose at random, so it may be someone new each time.'],
      ['What if I miss the call?', "That's fine. Nobody minds. Just tell us you're free again when it suits you."],
      ["What if I don't want to chat when you ring?", "Press 2 when we ring and we'll say goodbye politely. The other person isn't told why."],
      ['How do I end a chat?', 'On the phone, just put the phone down, or press the star key (*). In a text chat, send a text that just says END.'],
      ['Can I chat to the same person again?', "Yes, if you both want to. After each chat we ask you both. If you both say yes, they'll appear on your page and you can ring or text them through us."],
      ['What if someone is unkind to me?', "Tell us straight away. After a phone chat, press 9. In a text chat, send REPORT. You'll never be put in touch with them again, and our team will look into it."],
      ['Do you listen to the calls?', 'No. Phone calls are not recorded.'],
      ['Do you read the text messages?', 'Every text message is checked by our system to keep everyone safe. They are kept for 30 days, so our team can look into it if someone tells us about a problem, and then deleted.'],
      ["I've forgotten my PIN", 'No problem. Press "Sign in", then "I\'ve forgotten my PIN", and we\'ll send you a text message to help you choose a new one.'],
      ['Can a family member help me?', "Of course. They're very welcome to help you join and to show you how it works."],
      ['What is a group chat?', `A friendly chat with a few people who share a hobby or interest, such as gardening or music. When ${config.groupMinSize} or more people are free, we put you all together, on the phone or by text message. Your number stays private, just like in a chat with one person.`],
      ['How do I leave a group chat?', 'On the phone, press the star key (*) or just put the phone down. The others carry on without you. By text message, send a text that just says LEAVE.'],
      ['What if someone in a group is unkind?', "On the phone, put the phone down and then press 9 to tell us who it was. By text message, send REPORT and their name, for example REPORT JOHN. We'll take them out of the chat, you will never be put in touch with them again, and our team will look into it."],
      ['Can I start a new group?', 'Yes. On the "Group chats" page, press "Start a new group" and give it a name, such as "Knitting" or "Classic films". Other members can then join in.'],
      ['Can I use a landline?', 'Yes, for phone chats. To chat by text message you need a mobile phone.'],
    ];
    render(req, res, {
      title: 'Questions', user: currentUser(req),
      body: `
<h1>Questions</h1>
<p class="lead">Press a question to see the answer.</p>
<div class="faq">${qa.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>
<p>Can't find your answer? Ring us on <span class="phone">${esc(phone)}</span></p>`,
    });
  });

  // ---------- joining and signing in ----------

  router.get('/join', (req, res) => render(req, res, {
    title: 'Join',
    body: `
<h1>Join Lonely Oldies</h1>
<p class="muted">Step 1 of 2</p>
<p>It only takes a few minutes. A family member or friend is welcome to help.</p>
<form method="post" action="/join">${field(req.session.csrf)}
<label for="name">Your first name <span class="hint">This is the only thing other people will know about you.</span></label>
<input id="name" name="name" type="text" autocomplete="given-name" required>
<label for="phone">Your phone number <span class="hint">This is the number we'll ring. Nobody else will see it.</span></label>
<input id="phone" name="phone" type="tel" autocomplete="tel" required>
<label for="pin">Choose a PIN of 4 numbers <span class="hint">Like the PIN for a bank card. You'll use it to sign in, and when you ring us. Please don't use one that's easy to guess, like 1234.</span></label>
<input id="pin" name="pin" class="short" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required>
<label for="pin2">Type the same 4 numbers again</label>
<input id="pin2" name="pin2" class="short" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required>
<label class="tick"><input type="checkbox" name="agree" value="1" required><span>I have read <a href="/safety" target="_blank">Staying safe</a>, and I'll be kind to the people I chat to.</span></label>
<button>Carry on</button>
</form>`,
  }));

  router.post('/join', handle(async (req, res) => {
    if (req.body.agree !== '1') throw new UserError('Please tick the box to say you will be kind.');
    if (req.body.pin2 !== undefined && req.body.pin2 !== req.body.pin) {
      throw new UserError("The two PINs you typed are different. Please type them again.");
    }
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
<h1>Please check your phone</h1>
<p class="muted">Step 2 of 2</p>
<div class="card sky with-pic">${pic('text')}<div>
<p>We have just sent a text message to your phone. It has <strong>6 numbers</strong> in it.</p>
<p>This lets us check the phone is yours.</p>
</div></div>
${practiceNote('The message')}
<form method="post" action="/verify">${field(req.session.csrf)}
<label for="code">Type the 6 numbers here</label>
<input id="code" name="code" class="short" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required>
<button>Carry on</button>
</form>
<p>Not arrived yet? It can take a minute or two.</p>
<form method="post" action="/verify/resend">${field(req.session.csrf)}<button class="secondary">Send it again</button></form>`,
    });
  });

  router.post('/verify', handle(async (req, res) => {
    service.verifyPhone(req.session.userId, req.body.code);
    flash(req, "That's it, you've joined. Welcome to Lonely Oldies!");
    res.redirect('/me');
  }, '/verify'));

  router.post('/verify/resend', handle(async (req, res) => {
    await service.resendCode(req.session.userId);
    flash(req, "We've sent you another text message.");
    res.redirect('/verify');
  }, '/verify'));

  router.get('/signin', (req, res) => render(req, res, {
    title: 'Sign in',
    body: `
<h1>Sign in</h1>
<p>Welcome back. Please type in your phone number and your PIN.</p>
<form method="post" action="/signin">${field(req.session.csrf)}
<label for="phone">Your phone number</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" required>
<label for="pin">Your PIN <span class="hint">The 4 numbers you chose when you joined.</span></label>
<input id="pin" name="pin" class="short" type="password" inputmode="numeric" maxlength="4" autocomplete="current-password" required>
<button>Sign in</button>
</form>
<a class="button secondary" href="/forgot">I've forgotten my PIN</a>
<p>Not joined yet? <a href="/join">Join Lonely Oldies</a></p>`,
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
<div class="card sky with-pic">${pic('text')}<div>
<p>We have just sent a text message to your phone. It has <strong>6 numbers</strong> in it.</p>
</div></div>
${practiceNote('The message')}
<form method="post" action="/forgot/finish">${field(req.session.csrf)}
<label for="code">Type the 6 numbers here</label>
<input id="code" name="code" class="short" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required>
<label for="pin">Choose a new PIN of 4 numbers</label>
<input id="pin" name="pin" class="short" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required>
<button>Save my new PIN</button>
</form>` : `
<h1>Forgotten your PIN?</h1>
<p>Don't worry, it happens to everyone. Type in your phone number and we'll send you a text message to help you choose a new one.</p>
<form method="post" action="/forgot">${field(req.session.csrf)}
<label for="phone">Your phone number</label>
<input id="phone" name="phone" type="tel" autocomplete="tel" required>
<button>Send me a text message</button>
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
    flash(req, 'Your new PIN is saved. Please keep it somewhere safe and never tell it to anyone.');
    res.redirect('/me');
  }, '/forgot'));

  router.post('/signout', (req, res) => {
    req.session = null;
    res.redirect('/');
  });

  // ---------- the member's own page ----------

  router.get('/me', requireUser, (req, res) => {
    const user = req.user;
    const available = service.isAvailable(user);
    const live = service.activeCall(user.id);
    const group = live ? null : service.groups.activeFor(user.id);
    const waitingRoom = available && user.available_room ? service.groups.getRoom(user.available_room) : null;
    const friends = service.listFriends(user.id);
    const pending = service.pendingFeedback(user.id);
    const csrf = req.session.csrf;
    const form = (action, inner, extra = '') => `<form method="post" action="${action}">${field(csrf)}${extra}${inner}</form>`;

    let status;
    if (user.status !== 'active') {
      status = `<div class="card peach"><p>${esc(service.blockedReason(user))}</p></div>`;
    } else if (group) {
      const roomName = service.groups.roomName(group);
      const others = service.groups.people(group.id, ['joined']).filter((p) => p.user_id !== user.id);
      const byText = group.medium === 'sms';
      status = `<div class="card sky with-pic">${pic('group')}<div>
<h2>${byText ? `You're in the ${esc(roomName)} group chat` : group.status === 'dialing' ? `We're ringing you for the ${esc(roomName)} group chat` : `You're in the ${esc(roomName)} group chat`}</h2>
${others.length ? `<p>Also here: ${esc(service.groups.names(others))}.</p>` : ''}
${byText ? `<p>Reply to our text messages on your phone. Everyone in the group will see what you write, with your first name. Your number stays private.</p>
<p>To leave, send a text that just says <strong>LEAVE</strong>, or press the button below.</p>` : '<p>Please answer your phone. To leave the chat, press the star key (*) or put the phone down.</p>'}
</div></div>
${byText ? form('/me/leave-group', '<button class="secondary">Leave the group chat</button>') : ''}
<p><a href="/me/report-group?chat=${group.id}">Someone in this group upset me</a></p>`;
    } else if (live?.medium === 'sms') {
      const other = service.otherPartyFor(live, user.id);
      status = `<div class="card sky with-pic">${pic('text')}<div>
<h2>${live.status === 'dialing' ? `We're waiting for ${esc(other.name)} to reply` : `You're in a text chat with ${esc(other.name)}`}</h2>
<p>Reply to our text messages on your phone, and we'll pass them on. Your numbers stay private.</p>
<p>When you've finished, send a text that just says <strong>END</strong>, or press the button below.</p>
</div></div>
${form('/me/end-text-chat', '<button class="secondary">End the text chat</button>')}
<p><a href="/me/report?call=${live.id}">Something's not right in this chat</a></p>`;
    } else if (live) {
      status = `<div class="card sage with-pic">${pic('ring')}<div><h2>We're ringing you now</h2><p>Please answer your phone.</p></div></div>`;
    } else if (waitingRoom) {
      const byText = user.available_medium === 'sms';
      status = `<div class="card peach with-pic">${pic('tea')}<div>
<h2>You're on the list for the ${esc(waitingRoom.name)} group chat</h2>
<p>When ${config.groupMinSize} or more people are free, we'll ${byText ? 'send you a text' : 'ring you'} and put you together. If a group chat is already going on, we'll add you to it.</p>
<p>We'll keep trying until ${esc(timeOfDay(user.available_until))}.</p>
</div></div>
${form('/me/available', `<button class="secondary">I don't want a chat now</button>`, '<input type="hidden" name="on" value="0">')}`;
    } else if (available) {
      const byText = user.available_medium === 'sms';
      status = `<div class="card peach with-pic">${pic('tea')}<div>
<h2>We're finding someone for you</h2>
<p>${byText ? "You're on the list for a text message chat. We'll send you a text as soon as someone is free." : "You're on the list for a chat. We'll ring you as soon as someone is free, so please keep your phone nearby."}</p>
<p>Why not put the kettle on? We'll keep looking until ${esc(timeOfDay(user.available_until))}.</p>
</div></div>
${form('/me/available', `<button class="secondary">I don't want a chat now</button>`, '<input type="hidden" name="on" value="0">')}`;
    } else {
      status = `<div class="card sage">
<h2>Would you like a chat?</h2>
<p>Choose how you'd like to chat:</p>
${form('/me/available', `
<button class="choice" name="medium" value="voice">${pic('ring')}<span>Ring me for a chat<small>We'll ring you when someone is free.</small></span></button>
<button class="choice secondary" name="medium" value="sms">${pic('text')}<span>Chat by text message<small>We'll send you a text when someone is free.</small></span></button>`,
  '<input type="hidden" name="on" value="1">')}
<a class="button secondary choice" href="/groups">${pic('group')}<span>Join a group chat<small>Chat with a few people about a hobby.</small></span></a>
</div>`;
    }

    const feedback = pending.map((c) => `
<div class="card">
<p><strong>You chatted with ${esc(c.other_name)}</strong><br><span class="muted">${esc(when(c.started_at))}</span></p>
<p>Would you like to chat with ${esc(c.other_name)} again?</p>
${form('/me/feedback', `<div class="row"><button name="answer" value="yes">Yes please</button><button name="answer" value="no" class="secondary">No thank you</button></div>`,
    `<input type="hidden" name="call" value="${c.id}">`)}
<p class="muted">We'll only put you back in touch if ${esc(c.other_name)} says yes too.</p>
<p><a href="/me/report?call=${c.id}">Something wasn't right in this chat</a></p>
</div>`).join('');

    const friendList = friends.length
      ? friends.map((f) => `
<div class="card">
<h3>${esc(f.name)}</h3>
${f.last_spoke ? `<p class="muted">Your last chat: ${esc(when(f.last_spoke))}</p>` : ''}
${form('/me/call-friend', `<div class="row"><button name="medium" value="voice">Ring ${esc(f.name)}</button>
<button name="medium" value="sms" class="secondary">Text ${esc(f.name)}</button></div>`, `<input type="hidden" name="friend" value="${f.id}">`)}
<details><summary>Don't want to hear from ${esc(f.name)} any more?</summary>
<p>If you press this, you will never be put in touch with ${esc(f.name)} again. They won't be told.</p>
${form('/me/block', `<button class="danger small">Stop all contact with ${esc(f.name)}</button>`, `<input type="hidden" name="user" value="${f.id}">`)}
</details>
</div>`).join('')
      : `<p class="muted">When you and someone you've chatted with both say you'd like to chat again, they'll appear here.</p>`;

    render(req, res, {
      title: 'Your page', user, path: '/me', refresh: available || live || group ? 30 : undefined,
      body: `<h1>Hello ${esc(user.name)}</h1>
${status}
${feedback ? `<h2>Your recent chats</h2>${feedback}` : ''}
<h2>Your friends</h2>
<p>People you've both said you'd like to chat with again. We still keep your numbers private.</p>
${friendList}
<h2>Rather use the telephone?</h2>
<p>You can do all of this by ringing us on <span class="phone">${esc(phone)}</span> and typing in your PIN.</p>
${lastCallReport(user)}
${lastGroupReport(user, group)}`,
    });
  });

  function lastGroupReport(user, live) {
    const last = service.q(`SELECT g.* FROM group_chats g JOIN group_participants p ON p.chat_id = g.id
      WHERE p.user_id = ? AND p.joined_at IS NOT NULL AND g.created_at > ? ORDER BY g.created_at DESC LIMIT 1`)
      .get(user.id, service.now() - 7 * 24 * 60 * 60 * 1000);
    if (!last || last.id === live?.id) return '';
    return `<p><a href="/me/report-group?chat=${last.id}">Tell us about a problem in the ${esc(service.groups.roomName(last))} group chat</a></p>`;
  }

  function lastCallReport(user) {
    const last = service.lastCall(user.id);
    if (!last || service.pendingFeedback(user.id).some((c) => c.id === last.id)) return '';
    const other = service.otherPartyFor(last, user.id);
    return `<p><a href="/me/report?call=${last.id}">Tell us about a problem with ${esc(other.name)}, your last chat</a></p>`;
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
    else if (result.connected) flash(req, `Wonderful! ${result.other.name} would like to chat again too. You'll find them under "Your friends".`);
    else flash(req, "Lovely. If they'd like to chat again too, we'll send you a text message and they'll appear under \"Your friends\".");
    res.redirect('/me');
  }, '/me'));

  router.get('/me/report', requireUser, (req, res) => {
    const call = service.getCall(Number(req.query.call));
    const other = call && service.otherPartyFor(call, req.user.id);
    if (!other) return res.redirect('/me');
    render(req, res, {
      title: 'Tell us what happened', user: req.user, path: '/me',
      body: `
<h1>Tell us what happened</h1>
<p>We're sorry something wasn't right with ${esc(other.name)}. Thank you for telling us.</p>
<div class="card sage with-pic">${pic('shield')}<div>
<p>When you press the button, <strong>you will never be put in touch with ${esc(other.name)} again</strong>, and our team will look into it.</p>
</div></div>
<form method="post" action="/me/report">${field(req.session.csrf)}<input type="hidden" name="call" value="${call.id}">
<label for="reason">What happened? <span class="hint">You don't have to write anything, but it helps us.</span></label>
<textarea id="reason" name="reason" rows="5"></textarea>
<button class="danger">Send, and stop all contact with ${esc(other.name)}</button>
</form>
<a class="button secondary" href="/me">Go back</a>`,
    });
  });

  router.post('/me/report', requireUser, handle(async (req, res) => {
    const { reported } = await service.report(req.user.id, Number(req.body.call), req.body.reason);
    flash(req, `Thank you for telling us. You won't be put in touch with ${reported.name} again, and our team will look into it.`);
    res.redirect('/me');
  }, '/me'));

  router.post('/me/block', requireUser, handle(async (req, res) => {
    const other = service.getUser(Number(req.body.user));
    // Only people you've actually chatted with can be blocked from here.
    if (!other || !service.q(`SELECT 1 FROM calls WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)`)
      .get(req.user.id, other.id, other.id, req.user.id)) throw new UserError('Sorry, something went wrong.');
    service.block(req.user.id, other.id);
    flash(req, `Done. You won't be put in touch with ${other.name} again.`);
    res.redirect('/me');
  }, '/me'));

  router.post('/me/call-friend', requireUser, handle(async (req, res) => {
    const medium = req.body.medium === 'sms' ? 'sms' : 'voice';
    const call = await service.callFriend(req.user.id, Number(req.body.friend), { medium });
    const name = service.getUser(call.user_b).name;
    flash(req, medium === 'sms'
      ? `We've sent ${name} a text message to ask if they'd like to chat. We'll let you know when they reply.`
      : `We're ringing you now. Then we'll ring ${name}.`);
    res.redirect('/me');
  }, '/me'));

  router.post('/me/end-text-chat', requireUser, handle(async (req, res) => {
    const live = service.activeCall(req.user.id);
    if (live?.medium === 'sms') await service.texts.end(live);
    res.redirect('/me');
  }, '/me'));

  // ---------- group chats ----------

  router.get('/groups', (req, res) => {
    const user = currentUser(req);
    const member = user?.verified && user.status === 'active' ? user : null;
    const csrf = req.session.csrf;
    const rooms = service.groups.listRooms();
    const roomCard = (room, i) => {
      const live = room.live.reduce((n, c) => n + c.people, 0);
      const news = [
        live ? `${live} ${live === 1 ? 'person is' : 'people are'} chatting now.` : '',
        room.waiting ? `${room.waiting} ${room.waiting === 1 ? 'person is' : 'people are'} waiting to chat.` : '',
      ].filter(Boolean).join(' ');
      return `<div class="card ${['sage', 'sky', 'peach'][i % 3]}" id="room-${room.id}">
<h2>${esc(room.name)}</h2>
${room.description ? `<p>${esc(room.description)}</p>` : ''}
${news ? `<p><strong>${news}</strong></p>` : ''}
${member ? `<form method="post" action="/groups/join">${field(csrf)}<input type="hidden" name="room" value="${room.id}">
<div class="row"><button name="medium" value="voice">Join in by phone</button>
<button name="medium" value="sms" class="secondary">Join in by text message</button></div></form>` : ''}
</div>`;
    };
    render(req, res, {
      title: 'Group chats', user, path: '/groups',
      body: `
<h1>Group chats</h1>
<div class="with-pic">${pic('group')}<div>
<p class="lead">Chat with a few people who enjoy the same things as you.</p>
</div></div>
<ol class="steps">
<li><div><h3>1. Choose a group</h3><p>Pick a hobby or topic below, and choose to chat on the phone or by text message.</p></div></li>
<li><div><h3>2. We put you together</h3><p>When ${config.groupMinSize} or more people are free, we ring you all, or text you all. Up to ${config.groupMaxSize} people can chat at once.</p></div></li>
<li><div><h3>3. Leave whenever you like</h3><p>On the phone, just put the phone down. By text, send <strong>LEAVE</strong>. The others carry on.</p></div></li>
</ol>
<div class="card sage with-pic">${pic('shield')}<div>
<p>Just like a chat with one person, <strong>nobody sees your phone number</strong>, and every text message is checked before it is passed on. If someone is unkind, tell us and you'll never be put together again.</p>
</div></div>
${member ? '' : `<p class="message good">To join in, please <a href="/signin">sign in</a> or <a href="/join">join Lonely Oldies</a> first. You can also ring us on <span class="phone" style="font-size:1.1rem">${esc(phone)}</span> and press 6.</p>`}
${rooms.map(roomCard).join('')}
${member ? `<h2 id="new">Start a new group</h2>
<p>Can't see your hobby? Start a group for it, and other members can join in.</p>
<form method="post" action="/groups/new">${field(csrf)}
<label for="name">What is the group about? <span class="hint">For example "Knitting" or "Classic films".</span></label>
<input type="text" id="name" name="name" maxlength="40" required>
<label for="description">Say a little more <span class="hint">You don't have to.</span></label>
<input type="text" id="description" name="description" maxlength="200">
<button>Start the group</button>
</form>` : ''}`,
    });
  });

  router.post('/groups/join', requireUser, handle(async (req, res) => {
    const medium = req.body.medium === 'sms' ? 'sms' : 'voice';
    const room = service.groups.getRoom(Number(req.body.room));
    const result = await service.groups.join(req.user.id, Number(req.body.room), medium);
    if (result.waiting) {
      flash(req, `You're on the list for the ${room.name} group chat. We'll ${medium === 'sms' ? 'send you a text' : 'ring you'} when enough people are free.`);
    } else {
      flash(req, medium === 'sms' ? `You're in the ${room.name} group chat. We've sent you a text message.` : `We're ringing you now for the ${room.name} group chat.`);
    }
    res.redirect('/me');
  }, '/groups'));

  router.post('/groups/new', requireUser, handle(async (req, res) => {
    const room = service.groups.createRoom(req.user.id, { name: req.body.name, description: req.body.description });
    flash(req, `Your new group, ${room.name}, is ready. Press "Join in" to be the first on the list.`);
    res.redirect(`/groups#room-${room.id}`);
  }, '/groups#new'));

  router.post('/me/leave-group', requireUser, handle(async (req, res) => {
    const group = service.groups.activeFor(req.user.id);
    if (group?.medium === 'sms') await service.groups.leaveText(group, req.user);
    res.redirect('/me');
  }, '/me'));

  // People you were in a group chat with, so you can say which one upset you.
  const groupOthers = (chatId, userId) => service.groups.everyone(chatId)
    .filter((p) => p.user_id !== userId && p.joined_at);

  router.get('/me/report-group', requireUser, (req, res) => {
    const chat = service.groups.getChat(Number(req.query.chat));
    if (!chat || !service.groups.participant(chat.id, req.user.id)) return res.redirect('/me');
    const others = groupOthers(chat.id, req.user.id);
    if (!others.length) return res.redirect('/me');
    render(req, res, {
      title: 'Tell us what happened', user: req.user, path: '/me',
      body: `
<h1>Tell us what happened</h1>
<p>We're sorry something wasn't right in the ${esc(service.groups.roomName(chat))} group chat. Thank you for telling us.</p>
<form method="post" action="/me/report-group">${field(req.session.csrf)}<input type="hidden" name="chat" value="${chat.id}">
<fieldset style="border:none;padding:0;margin:0"><legend><strong>Who upset you?</strong></legend>
${others.map((p, i) => `<label class="tick"><input type="radio" name="person" value="${p.user_id}"${i ? '' : ' required'}> ${esc(p.name)}</label>`).join('')}
</fieldset>
<div class="card sage with-pic">${pic('shield')}<div>
<p>When you press the button, <strong>you will never be put in touch with them again</strong>. If the chat is still going on, we'll take them out of it. Our team will look into it.</p>
</div></div>
<label for="reason">What happened? <span class="hint">You don't have to write anything, but it helps us.</span></label>
<textarea id="reason" name="reason" rows="5"></textarea>
<button class="danger">Send, and stop all contact with them</button>
</form>
<a class="button secondary" href="/me">Go back</a>`,
    });
  });

  router.post('/me/report-group', requireUser, handle(async (req, res) => {
    const chatId = Number(req.body.chat);
    const person = groupOthers(chatId, req.user.id).find((p) => p.user_id === Number(req.body.person));
    if (!person) throw new UserError('Please choose the person who upset you.');
    await service.groups.report(req.user.id, chatId, person.user_id, req.body.reason || 'Reported on the website after a group chat.');
    flash(req, `Thank you for telling us. You won't be put in touch with ${person.name} again, and our team will look into it.`);
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
    const groupStopped = service.q(`SELECT m.*, u.name AS sender_name FROM group_messages m JOIN users u ON u.id = m.sender
      WHERE m.delivered = 0 ORDER BY m.created_at DESC LIMIT 20`).all();
    const rooms = service.groups.listRooms({ includeHidden: true });
    const csrf = req.session.csrf;
    const action = (path, id, label, cls = 'small') => `<form method="post" action="${path}" style="display:inline">${field(csrf)}
      <input type="hidden" name="id" value="${id}"><button class="${cls}">${label}</button></form>`;
    render(req, res, {
      title: 'Team',
      body: `
<h1>Team page</h1>
<p>${stats.users} members · ${stats.waiting} waiting · ${stats.live_calls} live calls · ${stats.live_groups} live group chats · ${stats.total_calls} chats so far · ${stats.friendships} friendships</p>
<h2>Open reports</h2>
${reports.length ? `<table><tr><th>When</th><th>Reported</th><th>By</th><th>What happened</th><th></th></tr>
${reports.map((r) => `<tr><td>${esc(when(r.created_at))}</td>
<td>${esc(r.reported_name)} (#${r.reported})<br>${esc(r.reported_status)} · ${r.total_against} report(s) in total</td>
<td>${r.reporter === r.reported ? 'Automatic (screening)' : `${esc(r.reporter_name)} (#${r.reporter})`}</td><td>${r.room_name ? `<p>${esc(r.room_name)} group chat (${r.medium === 'sms' ? 'text' : 'phone'})</p>` : ''}<pre>${esc(r.reason)}</pre>${r.group_chat_id ? `<a href="/admin/group/${r.group_chat_id}">See the group chat</a>` : r.medium === 'sms' ? `<a href="/admin/chat/${r.call_id}">Read the text chat</a>` : ''}</td>
<td>${action('/admin/ban', r.reported, 'Ban', 'danger small')}${action('/admin/reinstate', r.reported, 'Clear all')}${action('/admin/dismiss', r.id, 'Dismiss this one', 'secondary small')}</td></tr>`).join('')}</table>`
    : '<p>No open reports.</p>'}
<h2>Paused accounts</h2>
${suspended.length ? suspended.map((u) => `<p>${esc(u.name)} (#${u.id}, ${esc(u.phone)}) ${action('/admin/ban', u.id, 'Ban', 'danger small')}${action('/admin/reinstate', u.id, 'Reinstate')}</p>`).join('') : '<p>None.</p>'}
<h2>Text messages stopped by screening</h2>
${stopped.length ? `<table><tr><th>When</th><th>From</th><th>Message</th><th>Why</th></tr>
${stopped.map((m) => `<tr><td>${esc(when(m.created_at))}</td><td>${esc(m.sender_name)} (#${m.sender})</td>
<td>${esc(m.body)}</td><td>${esc(m.screen_reason)}<br><a href="/admin/chat/${m.call_id}">Whole chat</a></td></tr>`).join('')}</table>`
    : '<p>None.</p>'}
<h2>Group chats stopped by screening</h2>
${groupStopped.length ? `<table><tr><th>When</th><th>From</th><th>Message</th><th>Why</th></tr>
${groupStopped.map((m) => `<tr><td>${esc(when(m.created_at))}</td><td>${esc(m.sender_name)} (#${m.sender})</td>
<td>${esc(m.body)}</td><td>${esc(m.screen_reason)}<br><a href="/admin/group/${m.chat_id}">Whole chat</a></td></tr>`).join('')}</table>`
    : '<p>None.</p>'}
<h2>Groups</h2>
<table><tr><th>Group</th><th>Started by</th><th>Chats held</th><th></th></tr>
${rooms.map((room) => `<tr><td><strong>${esc(room.name)}</strong><br>${esc(room.description)}</td>
<td>${room.created_by ? `#${room.created_by}` : 'Lonely Oldies'}</td><td>${room.chats_held}${room.live.length ? ` (${room.live.length} live)` : ''}</td>
<td>${room.hidden ? action('/admin/room-show', room.id, 'Show again') : action('/admin/room-hide', room.id, 'Hide', 'danger small')}</td></tr>`).join('')}</table>`,
    });
  });

  router.post('/admin/room-hide', adminAuth, (req, res) => {
    service.groups.setHidden(Number(req.body.id), true);
    flash(req, 'Hidden. Members can no longer see or join this group.');
    res.redirect('/admin');
  });

  router.post('/admin/room-show', adminAuth, (req, res) => {
    service.groups.setHidden(Number(req.body.id), false);
    res.redirect('/admin');
  });

  router.get('/admin/group/:id', adminAuth, (req, res) => {
    const groups = service.groups;
    const chat = groups.getChat(Number(req.params.id));
    if (!chat) return res.redirect('/admin');
    const lines = groups.transcript(chat.id);
    render(req, res, {
      title: 'Group chat',
      body: `
<h1>${esc(groups.roomName(chat))} group chat (${chat.medium === 'sms' ? 'text' : 'phone'})</h1>
<p class="muted">Started ${esc(when(chat.started_at || chat.created_at))} · ${esc(chat.status)}. Messages are deleted after ${config.messageRetentionDays} days.</p>
<p>People: ${groups.everyone(chat.id).map((p) => `${esc(p.name)} (#${p.user_id}, ${esc(p.state)})`).join(', ')}</p>
${chat.medium === 'sms' ? (lines.length ? `<table><tr><th>When</th><th>From</th><th>Message</th><th>Passed on?</th></tr>
${lines.map((m) => `<tr><td>${esc(when(m.created_at))}</td><td>${esc(m.sender_name)}</td><td>${esc(m.body)}</td>
<td>${m.delivered ? 'Yes' : `No: ${esc(m.screen_reason)}`}</td></tr>`).join('')}</table>` : '<p>No messages kept.</p>') : '<p>Phone chats are not recorded.</p>'}
<a class="button secondary" href="/admin">Back</a>`,
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
