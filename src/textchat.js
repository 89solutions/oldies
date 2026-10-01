// Text-message chats. Everyone texts the service's own number; the service
// screens each message and passes it on, so nobody sees the other's number.
//
// A text chat is a row in `calls` with medium = 'sms', so matching, the daily
// limit, "talk again", blocking and reporting all work exactly as for calls.

import { tx } from './db.js';
import { screenMessage } from './screening.js';
import { UserError } from './service.js';

const SAFETY = 'Never share your address, phone number, bank details or passwords.';

export class TextChats {
  constructor(service) {
    this.service = service;
  }

  get config() { return this.service.config; }
  q(sql) { return this.service.q(sql); }

  async send(user, body) {
    try {
      await this.service.telephony.sendSms(user.phone, body);
    } catch (err) {
      this.service.log.error?.('Could not send text', err);
    }
  }

  // Starts a text chat. Random chats start straight away (both asked for one);
  // a friend is asked first and must reply YES.
  async start(kind, a, b) {
    const s = this.service;
    const now = s.now();
    const callId = tx(s.db, () => {
      if (s.activeCall(a) || s.activeCall(b)) throw new UserError('One of you is already in a chat.');
      this.q('UPDATE users SET available_until = NULL WHERE id IN (?, ?)').run(a, b);
      const started = kind === 'random';
      return Number(this.q(`INSERT INTO calls (kind, medium, user_a, user_b, status, a_state, b_state, started_at,
          last_activity_at, created_at) VALUES (?, 'sms', ?, ?, ?, 'joined', ?, ?, ?, ?)`)
        .run(kind, a, b, started ? 'in_progress' : 'dialing', started ? 'joined' : 'dialing', started ? now : null, now, now)
        .lastInsertRowid);
    });
    const userA = s.getUser(a);
    const userB = s.getUser(b);
    if (kind === 'random') {
      await this.send(userA, this.welcome(userB));
      await this.send(userB, this.welcome(userA));
    } else {
      await this.send(userA, `Lonely Oldies: we've asked ${userB.name} if they'd like a text chat. We'll text you when they reply.`);
      await this.send(userB, `Lonely Oldies: your friend ${userA.name} would like a text chat. Reply YES to start, or NO if now isn't a good time.`);
    }
    return s.getCall(callId);
  }

  welcome(other) {
    return `Lonely Oldies: you're now in a text chat with ${other.name}. Just reply to this number and we'll pass your messages on. ${SAFETY} Text END to finish, or REPORT if anything upsets you.`;
  }

  // Ends a text chat and asks both people whether they'd like to chat again.
  // `say` can replace what a particular person is told (userId -> text, or null for nothing).
  async end(call, { say = {} } = {}) {
    const s = this.service;
    const fresh = s.getCall(call.id);
    if (!fresh || !['dialing', 'in_progress'].includes(fresh.status)) return fresh;
    this.q(`UPDATE calls SET status = ?, a_state = 'ended', b_state = 'ended', ended_at = ? WHERE id = ?`)
      .run(fresh.started_at ? 'completed' : 'failed', s.now(), call.id);
    for (const leg of ['a', 'b']) {
      const me = s.partyOf(fresh, leg);
      const them = s.partyOf(fresh, leg === 'a' ? 'b' : 'a');
      if (me.id in say) {
        if (say[me.id]) await this.send(me, say[me.id]);
        continue;
      }
      await this.send(me, fresh.started_at
        ? `Lonely Oldies: your text chat with ${them.name} has finished. Would you like to chat with ${them.name} again? Reply YES or NO. If anything upset you, reply REPORT.`
        : `Lonely Oldies: your text chat with ${them.name} has finished.`);
    }
    return s.getCall(call.id);
  }

  // Closes text chats nobody has written in for a while, and deletes old messages.
  async closeQuiet() {
    const s = this.service;
    const idle = s.now() - this.config.smsChatIdleHours * 60 * 60 * 1000;
    const quiet = this.q(`SELECT * FROM calls WHERE medium = 'sms' AND status IN ('dialing','in_progress')
      AND last_activity_at < ?`).all(idle);
    for (const call of quiet) await this.end(call);
    this.q('DELETE FROM messages WHERE created_at < ?').run(s.now() - this.config.messageRetentionDays * 24 * 60 * 60 * 1000);
  }

  helpText() {
    return `Lonely Oldies: text FREE to be put in touch with someone for a text chat. To chat on the phone instead, ring ${this.config.publicPhoneNumber}.`;
  }

  // Every text sent to the service number arrives here.
  async incoming(from, text) {
    const s = this.service;
    const user = s.getUserByPhone(from);
    if (!user || !user.verified) {
      if (!s.q('SELECT 1 FROM banned_phones WHERE phone = ?').get(from)) {
        await s.telephony.sendSms(from, `Lonely Oldies: this number isn't registered. To join, ring ${this.config.publicPhoneNumber} or visit ${this.config.baseUrl}.`);
      }
      return;
    }
    if (user.status === 'banned') return;
    const body = String(text ?? '').trim();
    const word = body.toUpperCase().replace(/[^A-Z]/g, '');
    const live = s.activeCall(user.id);

    if (live?.medium === 'voice') {
      return this.send(user, "Lonely Oldies: you're on a phone chat at the moment. Text us again afterwards.");
    }
    if (live) return this.inChat(live, user, body, word);

    if (word === 'REPORT') {
      const last = s.lastCall(user.id);
      if (!last) return this.send(user, this.helpText());
      const { reported } = await s.report(user.id, last.id, 'Reported by text message.');
      return this.send(user, `Lonely Oldies: thank you for telling us. ${reported.name} has been blocked and our team will look into it.`);
    }
    if (word === 'YES' || word === 'NO') {
      const pending = s.pendingFeedback(user.id)[0];
      if (!pending) return this.send(user, this.helpText());
      const result = await s.submitFeedback(pending.id, user.id, word === 'YES');
      if (word === 'NO') return this.send(user, 'Lonely Oldies: thank you for letting us know.');
      if (!result.connected) return this.send(user, `Lonely Oldies: lovely. If ${pending.other_name} would like to chat again too, we'll let you know.`);
      return; // announceFriendship has texted them both
    }
    if (['FREE', 'CHAT', 'START', 'TEXT'].includes(word)) {
      try {
        s.setAvailable(user.id, true, 'sms');
      } catch (err) {
        if (err instanceof UserError) return this.send(user, `Lonely Oldies: ${err.message}`);
        throw err;
      }
      await this.send(user, `Lonely Oldies: you're on the list for a text chat. We'll text you as soon as someone is free. Text BUSY if you change your mind.`);
      setImmediate(() => s.onAvailable?.());
      return;
    }
    if (word === 'BUSY') {
      s.setAvailable(user.id, false);
      return this.send(user, "Lonely Oldies: that's fine, you're off the list for now.");
    }
    return this.send(user, this.helpText());
  }

  async inChat(call, user, body, word) {
    const s = this.service;
    const other = s.otherPartyFor(call, user.id);
    const isInvitee = call.status === 'dialing' && call.user_b === user.id;

    if (word === 'REPORT') {
      await s.report(user.id, call.id, 'Reported by text message during a text chat.');
      return; // report() ends the chat and lets them know
    }
    if (word === 'END' || word === 'BYE' || (isInvitee && word === 'NO')) {
      return this.end(call);
    }
    if (isInvitee && word === 'YES') {
      this.q(`UPDATE calls SET status = 'in_progress', b_state = 'joined', started_at = ?, last_activity_at = ? WHERE id = ?`)
        .run(s.now(), s.now(), call.id);
      await this.send(user, this.welcome(other));
      return this.send(other, this.welcome(user));
    }
    if (call.status === 'dialing') {
      return this.send(user, isInvitee
        ? `Lonely Oldies: ${other.name} would like a text chat. Reply YES to start, or NO if now isn't a good time.`
        : `Lonely Oldies: we're still waiting for ${other.name} to reply. Text END to stop waiting.`);
    }
    if (word === 'HELP') {
      return this.send(user, `Lonely Oldies: you're in a text chat with ${other.name}. Just reply to send a message. Text END to finish, or REPORT if anything upsets you.`);
    }
    return this.relay(call, user, other, body);
  }

  // Screens a message and, if it's fine, passes it on.
  async relay(call, sender, recipient, body) {
    const s = this.service;
    const check = screenMessage(body);
    this.q(`INSERT INTO messages (call_id, sender, body, delivered, screen_reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(call.id, sender.id, body.slice(0, 2000), check.ok ? 1 : 0, check.ok ? null : `${check.category}: ${check.reason}`, s.now());
    this.q('UPDATE calls SET last_activity_at = ? WHERE id = ?').run(s.now(), call.id);

    if (check.ok) return this.send(recipient, `${sender.name}: ${body}`);

    // Repeatedly trying to send contact details, money talk or abuse ends the chat and goes to the team.
    const stopped = this.q(`SELECT COUNT(*) AS n FROM messages WHERE call_id = ? AND sender = ? AND delivered = 0
      AND screen_reason NOT LIKE 'empty%' AND screen_reason NOT LIKE 'length%'`).get(call.id, sender.id).n;
    if (stopped >= this.config.screenStrikesBeforeReport) {
      await s.report(recipient.id, call.id, `Automatic report: ${stopped} messages from ${sender.name} were stopped by screening.`, {
        say: {
          [sender.id]: "Lonely Oldies: that message wasn't passed on. Several of your messages have been stopped, so this chat has ended and our team will review it.",
          [recipient.id]: `Lonely Oldies: we've ended your text chat with ${sender.name} because some of their messages broke our safety rules. They won't be put in touch with you again.`,
        },
      });
      return;
    }
    await this.send(sender, `Lonely Oldies: sorry, that message wasn't passed on because it looked like it had ${check.reason}. ${check.category === 'length' ? 'Please send it in smaller parts.' : `To keep everyone safe we don't pass on phone numbers, addresses, links, or anything about money.`}`);
  }

  transcript(callId) {
    return this.q(`SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender
      WHERE m.call_id = ? ORDER BY m.created_at, m.id`).all(callId);
  }

  recentlyStopped(limit = 20) {
    return this.q(`SELECT m.*, u.name AS sender_name FROM messages m JOIN users u ON u.id = m.sender
      WHERE m.delivered = 0 ORDER BY m.created_at DESC LIMIT ?`).all(limit);
  }
}
