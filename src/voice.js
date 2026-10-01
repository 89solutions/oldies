// Twilio voice webhooks: the phone-in menu, and both sides of every chat.
//
// How masking works: the service rings each person FROM its own Twilio number
// and puts both calls into a private conference room. Each person only ever
// sees the service's number; the real numbers stay on the server.

import express from 'express';
import twilio from 'twilio';
import { UserError } from './service.js';
import { checkSecret, hashSecret, isValidPin, isWeakPin, cleanName } from './security.js';

const { VoiceResponse } = twilio.twiml;
const ENDED = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

export function voiceRouter({ service, config, log = console, onAvailable = () => {} }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  if (config.telephony === 'twilio' && config.twilio.validateWebhooks) router.use(validateTwilio(config));

  const xml = (res, vr) => res.type('text/xml').send(vr.toString());
  const sayer = (vr) => (text) => vr.say({ voice: config.voice, language: config.voiceLanguage }, text);
  const url = (path, params = {}) => `${path}?${new URLSearchParams(params)}`;

  // Asks a question, waits for a key press, and repeats once if nothing is pressed.
  function ask(res, { prompt, action, numDigits = 1, retryUrl, retry, giveUp = 'Sorry, I did not hear anything. Goodbye.' }) {
    const vr = new VoiceResponse();
    const say = sayer(vr);
    if (retry >= 2) {
      say(giveUp);
      vr.hangup();
      return xml(res, vr);
    }
    const gather = vr.gather({ numDigits, action, method: 'POST', timeout: 8, actionOnEmptyResult: false });
    for (const line of [].concat(prompt)) gather.say({ voice: config.voice, language: config.voiceLanguage }, line);
    vr.redirect({ method: 'POST' }, `${retryUrl}${retryUrl.includes('?') ? '&' : '?'}retry=${(retry || 0) + 1}`);
    return xml(res, vr);
  }

  function goodbye(res, text) {
    const vr = new VoiceResponse();
    sayer(vr)(text);
    vr.hangup();
    return xml(res, vr);
  }

  const wrap = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof UserError) return goodbye(res, `${err.message} Goodbye.`);
      log.error?.('Voice webhook failed', err);
      goodbye(res, 'Sorry, something went wrong. Please try again later. Goodbye.');
    }
  };

  const retryOf = (req) => Number(req.query.retry || 0);
  const menuUser = (req) => service.ivrUser(req.body.CallSid);

  // ---------- phoning in ----------

  router.post('/incoming', wrap(async (req, res) => {
    const from = req.body.From;
    if (!from || !/^\+\d{8,15}$/.test(from)) {
      return goodbye(res, "Hello, this is Lonely Oldies. We can't see your phone number. Please ring again without hiding your number. Goodbye.");
    }
    if (service.q('SELECT 1 FROM banned_phones WHERE phone = ?').get(from)) {
      return goodbye(res, 'Sorry, this number cannot use Lonely Oldies. Goodbye.');
    }
    const user = service.getUserByPhone(from);
    if (user?.verified) {
      return ask(res, {
        prompt: `Hello ${user.name}, welcome back to Lonely Oldies. Please type in your four number PIN.`,
        action: '/voice/pin', numDigits: 4, retryUrl: '/voice/incoming', retry: retryOf(req),
      });
    }
    ask(res, {
      prompt: ['Hello, and welcome to Lonely Oldies, where you can have a friendly chat on the phone with someone new.',
        'Your phone number is always kept private.', 'To join, press 1.'],
      action: '/voice/register-start', retryUrl: '/voice/incoming', retry: retryOf(req),
    });
  }));

  router.post('/pin', wrap(async (req, res) => {
    const user = service.getUserByPhone(req.body.From);
    const result = service.checkPin(user, req.body.Digits);
    if (result.locked) return goodbye(res, 'Too many wrong PINs. Please wait fifteen minutes and try again. Goodbye.');
    if (!result.ok) {
      return ask(res, {
        prompt: 'Sorry, that PIN is not right. Please try again.',
        action: '/voice/pin', numDigits: 4, retryUrl: '/voice/incoming', retry: 1,
      });
    }
    service.ivrSet(req.body.CallSid, { userId: user.id });
    const vr = new VoiceResponse();
    vr.redirect({ method: 'POST' }, '/voice/menu');
    xml(res, vr);
  }));

  router.post('/menu', wrap(async (req, res) => {
    const user = menuUser(req);
    if (!user) return goodbye(res, 'Sorry, please ring again. Goodbye.');
    if (!service.canUse(user)) return goodbye(res, `${service.blockedReason(user)} Goodbye.`);
    const prompt = [];
    if (service.isAvailable(user)) {
      prompt.push(user.available_medium === 'sms'
        ? "You're on the list for a text message chat, and we'll text you when someone is free."
        : "You're on the list for a chat, and we'll ring you when someone is free.");
    }
    prompt.push('To have a chat on the phone with someone new, press 1.');
    prompt.push('To chat by text message instead, press 5.');
    if (service.listFriends(user.id).length) prompt.push('To ring one of your friends, press 2.');
    if (service.isAvailable(user)) prompt.push("If you don't want any calls for now, press 3.");
    const pending = service.pendingFeedback(user.id)[0];
    if (pending) prompt.push(`To tell us if you'd like to talk to ${pending.other_name} again, press 4.`);
    if (service.lastCall(user.id)) prompt.push('If someone on your last call was unkind or upset you, press 9.');
    ask(res, { prompt, action: '/voice/menu-choice', retryUrl: '/voice/menu', retry: retryOf(req) });
  }));

  router.post('/menu-choice', wrap(async (req, res) => {
    const user = menuUser(req);
    if (!user) return goodbye(res, 'Sorry, please ring again. Goodbye.');
    const vr = new VoiceResponse();
    switch (req.body.Digits) {
      case '1':
        service.setAvailable(user.id, true);
        setImmediate(onAvailable);
        return goodbye(res, `Lovely. We'll ring you back as soon as someone else is free for a chat. It might take a little while, so keep your phone nearby. We'll stop trying in ${Math.round(config.availableForMinutes / 60)} hours. Goodbye for now.`);
      case '2':
        vr.redirect({ method: 'POST' }, '/voice/friends');
        return xml(res, vr);
      case '5':
        service.setAvailable(user.id, true, 'sms');
        setImmediate(onAvailable);
        return goodbye(res, "Lovely. We'll send you a text message as soon as someone else is free for a text chat. Just reply to our texts, and we'll pass your messages on. Your number stays private. Goodbye for now.");
      case '3':
        service.setAvailable(user.id, false);
        return goodbye(res, "That's fine, we won't ring you. Goodbye.");
      case '4': {
        const pending = service.pendingFeedback(user.id)[0];
        if (!pending) break;
        vr.redirect({ method: 'POST' }, url('/voice/after', { call: pending.id, leg: pending.user_a === user.id ? 'a' : 'b' }));
        return xml(res, vr);
      }
      case '9': {
        const last = service.lastCall(user.id);
        if (!last) break;
        const leg = last.user_a === user.id ? 'a' : 'b';
        const other = service.otherPartyFor(last, user.id);
        return ask(res, {
          prompt: `To report ${other.name}, press 9. To go back, press 1.`,
          action: url('/voice/feedback', { call: last.id, leg, reporting: 1 }), retryUrl: '/voice/menu', retry: 1,
        });
      }
    }
    vr.redirect({ method: 'POST' }, '/voice/menu');
    xml(res, vr);
  }));

  router.post('/friends', wrap(async (req, res) => {
    const user = menuUser(req);
    if (!user) return goodbye(res, 'Sorry, please ring again. Goodbye.');
    const friends = service.listFriends(user.id).slice(0, 8);
    if (!friends.length) return goodbye(res, "You don't have any friends to ring yet. After a chat, press 1 if you'd like to talk again. Goodbye.");
    service.ivrSet(req.body.CallSid, { data: { friends: friends.map((f) => f.id) } });
    ask(res, {
      prompt: [...friends.map((f, i) => `To ring ${f.name}, press ${i + 1}.`), 'To go back, press 0.'],
      action: '/voice/friend-choice', retryUrl: '/voice/friends', retry: retryOf(req),
    });
  }));

  router.post('/friend-choice', wrap(async (req, res) => {
    const user = menuUser(req);
    const vr = new VoiceResponse();
    const friendId = service.ivrData(req.body.CallSid).friends?.[Number(req.body.Digits) - 1];
    if (!user || !friendId) {
      vr.redirect({ method: 'POST' }, '/voice/menu');
      return xml(res, vr);
    }
    // This person is already on the line, so only their friend is rung.
    const call = await service.callFriend(user.id, friendId, { aSid: req.body.CallSid });
    vr.redirect({ method: 'POST' }, url('/voice/leg', { call: call.id, leg: 'a', onLine: 1 }));
    xml(res, vr);
  }));

  // ---------- joining by phone ----------

  router.post('/register-start', wrap(async (req, res) => {
    const vr = new VoiceResponse();
    if (req.body.Digits !== '1') {
      vr.redirect({ method: 'POST' }, '/voice/incoming?retry=1');
      return xml(res, vr);
    }
    const gather = vr.gather({
      input: 'speech', action: '/voice/register-name', method: 'POST', speechTimeout: 'auto',
      language: config.voiceLanguage, actionOnEmptyResult: true,
    });
    gather.say({ voice: config.voice, language: config.voiceLanguage },
      "Wonderful. First, please say your first name. We'll only share your first name with the people you chat to.");
    xml(res, vr);
  }));

  router.post('/register-name', wrap(async (req, res) => {
    const name = cleanName(req.body.SpeechResult) || 'Friend';
    service.ivrSet(req.body.CallSid, { data: { name } });
    ask(res, {
      prompt: [`Thank you, ${name}.`, 'Now choose a four number PIN. You will need it each time you ring us. Please type it in now.'],
      action: '/voice/register-pin', numDigits: 4, retryUrl: '/voice/register-name-retry', retry: retryOf(req),
    });
  }));

  router.post('/register-name-retry', wrap(async (req, res) => ask(res, {
    prompt: 'Please type in a four number PIN.', action: '/voice/register-pin', numDigits: 4,
    retryUrl: '/voice/register-name-retry', retry: retryOf(req),
  })));

  router.post('/register-pin', wrap(async (req, res) => {
    const pin = req.body.Digits;
    if (!isValidPin(pin) || isWeakPin(pin)) {
      return ask(res, {
        prompt: 'That PIN is too easy to guess. Please choose four different numbers.',
        action: '/voice/register-pin', numDigits: 4, retryUrl: '/voice/register-name-retry', retry: 1,
      });
    }
    const data = service.ivrData(req.body.CallSid);
    service.ivrSet(req.body.CallSid, { data: { ...data, pinHash: hashSecret(pin) } });
    ask(res, {
      prompt: 'Please type the same PIN again, to make sure.',
      action: '/voice/register-confirm', numDigits: 4, retryUrl: '/voice/register-name-retry', retry: 1,
    });
  }));

  router.post('/register-confirm', wrap(async (req, res) => {
    const data = service.ivrData(req.body.CallSid);
    if (!checkSecret(req.body.Digits, data.pinHash)) {
      return ask(res, {
        prompt: "Those PINs didn't match. Let's try again. Please choose a four number PIN.",
        action: '/voice/register-pin', numDigits: 4, retryUrl: '/voice/register-name-retry', retry: 1,
      });
    }
    const user = service.registerByPhone({ phone: req.body.From, name: data.name, pin: req.body.Digits });
    service.ivrSet(req.body.CallSid, { userId: user.id, data: {} });
    const vr = new VoiceResponse();
    sayer(vr)("You're all set up. Please write your PIN down and keep it somewhere safe. Never tell it to anyone, not even us.");
    vr.redirect({ method: 'POST' }, '/voice/menu');
    xml(res, vr);
  }));

  // ---------- each side of a chat ----------

  function loadLeg(req) {
    const call = service.getCall(Number(req.query.call));
    const leg = req.query.leg === 'b' ? 'b' : 'a';
    if (!call) throw new UserError('Sorry, this call has finished.');
    return { call, leg, me: service.partyOf(call, leg), them: service.partyOf(call, leg === 'a' ? 'b' : 'a') };
  }

  // What someone hears when we ring them (or, for friend calls from the menu, straight away).
  router.post('/leg', wrap(async (req, res) => {
    const { call, leg, me, them } = loadLeg(req);
    if (call.status !== 'dialing') return goodbye(res, 'Sorry, this call has finished. Goodbye.');
    const legUrl = url('/voice/leg', { call: call.id, leg });
    const action = url('/voice/leg-answer', { call: call.id, leg });
    const notNow = "If now isn't a good time, press 2.";

    if (call.kind === 'reconnect' && leg === 'a' && req.query.onLine && call.a_sid === req.body.CallSid) {
      // They chose this friend from the phone menu and are already on the line.
      service.legJoined(call.id, 'a');
      return joinConference(res, call.id, 'a', `We're ringing ${them.name} for you now. Please hold on.`);
    }
    const prompt = call.kind === 'random'
      ? [`Hello ${me.name}, this is Lonely Oldies.`, `We've found someone for you to have a chat with. Their name is ${them.name}.`,
        `To start chatting with ${them.name}, press 1.`, notNow]
      : leg === 'a'
        ? [`Hello ${me.name}, this is Lonely Oldies, ringing so you can talk to ${them.name}.`, 'To carry on, press 1.', notNow]
        : [`Hello ${me.name}, this is Lonely Oldies.`, `Your friend ${them.name} would like to have a chat.`,
          `To talk to ${them.name} now, press 1.`, notNow];
    // A missed answer (for example an answering machine) counts as "not now".
    if (Number(req.query.retry || 0) >= 2) {
      await service.legDeclined(call.id, leg);
      return goodbye(res, "We'll try again another time. Goodbye.");
    }
    ask(res, { prompt, action, retryUrl: `${legUrl}&rung=1`, retry: retryOf(req) });
  }));

  router.post('/leg-answer', wrap(async (req, res) => {
    const { call, leg, them } = loadLeg(req);
    if (req.body.Digits !== '1') {
      await service.legDeclined(call.id, leg);
      return goodbye(res, "That's fine. We hope to talk to you another time. Goodbye.");
    }
    if (call.status !== 'dialing' || call[`${leg}_state`] !== 'dialing') {
      return goodbye(res, `Sorry, ${them.name} isn't able to chat after all. Goodbye.`);
    }
    const updated = service.legJoined(call.id, leg);
    const otherHere = updated[`${leg === 'a' ? 'b' : 'a'}_state`] === 'joined';
    joinConference(res, call.id, leg, otherHere
      ? `Putting you through to ${them.name} now.`
      : `Thank you. Please hold on while we ring ${them.name}.`);
  }));

  function joinConference(res, callId, leg, intro) {
    const call = service.getCall(callId);
    const otherHere = call[`${leg === 'a' ? 'b' : 'a'}_state`] === 'joined';
    const vr = new VoiceResponse();
    const say = sayer(vr);
    say(intro);
    say('Remember, never share your address, your bank details or any passwords. To end the chat at any time, press the star key.');
    const dial = vr.dial({
      action: url('/voice/after', { call: callId, leg }),
      method: 'POST',
      hangupOnStar: true,
      timeLimit: config.maxCallMinutes * 60,
    });
    dial.conference({
      beep: 'false',
      // The first to arrive waits with hold music; the conference starts when the second joins.
      startConferenceOnEnter: otherHere,
      endConferenceOnExit: true,
    }, `lonely-oldies-call-${callId}`);
    xml(res, vr);
  }

  router.post('/partner-unavailable', wrap(async (req, res) => {
    const { call, them } = loadLeg(req);
    goodbye(res, call.kind === 'random'
      ? `I'm sorry, ${them.name} couldn't come to the phone after all. We'll keep looking for someone else for you to chat with, and ring you back. Goodbye for now.`
      : `I'm sorry, ${them.name} can't talk right now. Please try again another time. Goodbye.`);
  }));

  // After a chat finishes (the other person hung up, star was pressed, or the time limit was reached).
  router.post('/after', wrap(async (req, res) => {
    const { call, leg, them } = loadLeg(req);
    if (!call.started_at) return goodbye(res, 'Goodbye.');
    const retryUrl = url('/voice/after', { call: call.id, leg });
    ask(res, {
      prompt: [`Thank you for chatting with ${them.name}.`,
        `If you'd like to talk to ${them.name} again, press 1.`, 'If not, press 2.',
        `If ${them.name} was unkind or upset you, press 9.`],
      action: url('/voice/feedback', { call: call.id, leg }), retryUrl, retry: retryOf(req),
      giveUp: 'You can tell us later by ringing us or on the website. Goodbye.',
    });
  }));

  router.post('/feedback', wrap(async (req, res) => {
    const { call, me, them } = loadLeg(req);
    const digit = req.body.Digits;
    if (req.query.reporting === '1' && digit !== '9') {
      const vr = new VoiceResponse();
      vr.redirect({ method: 'POST' }, '/voice/menu');
      return xml(res, vr);
    }
    if (digit === '1') {
      const result = await service.submitFeedback(call.id, me.id, true);
      return goodbye(res, result.connected
        ? `Wonderful! ${them.name} would like to talk again too. You can ring ${them.name} any time by calling us and pressing 2. Goodbye.`
        : `Lovely. If ${them.name} would like to talk again too, we'll send you a text message. Goodbye.`);
    }
    if (digit === '2') {
      await service.submitFeedback(call.id, me.id, false);
      return goodbye(res, 'Thank you. Goodbye.');
    }
    if (digit === '9') {
      const { reportId } = await service.report(me.id, call.id, 'Reported by phone.');
      const vr = new VoiceResponse();
      const say = sayer(vr);
      say(`I'm sorry that happened. We've blocked ${them.name}, so you will never be put through to them again, and our team will look into it.`);
      say('If you would like to tell us what happened, please speak after the beep, and press the hash key when you have finished. Or you can just hang up.');
      vr.record({
        action: url('/voice/report-done', { report: reportId }),
        method: 'POST', maxLength: 120, finishOnKey: '#', playBeep: true,
      });
      return xml(res, vr);
    }
    const vr = new VoiceResponse();
    vr.redirect({ method: 'POST' }, '/voice/menu');
    xml(res, vr);
  }));

  router.post('/report-done', wrap(async (req, res) => {
    const user = service.ivrUser(req.body.CallSid) ?? service.getUserByPhone(req.body.To) ?? service.getUserByPhone(req.body.From);
    if (user && req.body.RecordingUrl) {
      service.addToReport(Number(req.query.report), user.id, `Voice message: ${req.body.RecordingUrl}`);
    }
    goodbye(res, 'Thank you for telling us. Take care. Goodbye.');
  }));

  // Twilio tells us when each call has finished, answered or not.
  router.post('/leg-status', wrap(async (req, res) => {
    if (ENDED.has(req.body.CallStatus)) {
      await service.legEnded(Number(req.query.call), req.query.leg === 'b' ? 'b' : 'a');
    }
    res.status(204).end();
  }));

  // Set as the phone number's "call status changes" webhook, so we know when
  // someone who rang a friend from the phone menu has hung up.
  router.post('/incoming-status', wrap(async (req, res) => {
    if (ENDED.has(req.body.CallStatus)) {
      const call = service.q(`SELECT id FROM calls WHERE a_sid = ? AND status IN ('dialing','in_progress')`).get(req.body.CallSid);
      if (call) await service.legEnded(call.id, 'a');
    }
    res.status(204).end();
  }));

  return router;
}

// Rejects requests that didn't really come from Twilio.
export function validateTwilio(config) {
  return (req, res, next) => {
    const signature = req.get('X-Twilio-Signature');
    const fullUrl = `${config.baseUrl}${req.originalUrl}`;
    if (signature && twilio.validateRequest(config.twilio.authToken, signature, fullUrl, req.body || {})) return next();
    res.status(403).send('Forbidden');
  };
}
