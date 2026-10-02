// Core rules of the service: accounts, availability, matching, calls,
// "talk again" opt-ins, blocking and reporting. Web pages and phone menus
// both go through this class, so the rules are the same either way.

import { tx } from './db.js';
import { TextChats } from './textchat.js';
import { Groups } from './groups.js';
import {
  hashSecret, checkSecret, isValidPin, isWeakPin, sixDigitCode, normalizePhone, cleanName,
} from './security.js';

export class UserError extends Error {}

const DAY = 24 * 60 * 60 * 1000;
const ACTIVE_CALL = `status IN ('dialing','in_progress')`;

export class Service {
  constructor({ db, config, telephony, log = console, now = () => Date.now() }) {
    this.db = db;
    this.config = config;
    this.telephony = telephony;
    this.log = log;
    this.now = now;
    this.texts = new TextChats(this);
    this.groups = new Groups(this);
    this.groups.ensureStarterRooms();
    this.onAvailable = null; // set by the app so matching runs straight away
  }

  q(sql) {
    return this.db.prepare(sql);
  }

  // ---------- accounts ----------

  phone(input) {
    const phone = normalizePhone(input, this.config.defaultCountryCode);
    if (!phone) throw new UserError('Please enter a full phone number, for example 07700 900123.');
    return phone;
  }

  checkNotBanned(phone) {
    if (this.q('SELECT 1 FROM banned_phones WHERE phone = ?').get(phone)) {
      throw new UserError('Sorry, this number cannot use Lonely Oldies.');
    }
  }

  validatePin(pin) {
    if (!isValidPin(pin)) throw new UserError('Your PIN must be exactly 4 numbers.');
    if (isWeakPin(pin)) throw new UserError('That PIN is too easy to guess. Please choose different numbers.');
  }

  async register({ name, phone: rawPhone, pin }) {
    const firstName = cleanName(name);
    if (!firstName) throw new UserError('Please tell us your first name.');
    const phone = this.phone(rawPhone);
    this.validatePin(pin);
    this.checkNotBanned(phone);
    const existing = this.getUserByPhone(phone);
    if (existing?.verified) throw new UserError('That number is already registered. Please sign in instead.');

    const code = sixDigitCode();
    const fields = [firstName, hashSecret(pin), hashSecret(code), this.now() + 15 * 60 * 1000];
    let id;
    if (existing) {
      // Unverified sign-up being retried: start again.
      this.q('UPDATE users SET name = ?, pin_hash = ?, verify_code = ?, verify_expires = ? WHERE id = ?')
        .run(...fields, existing.id);
      id = existing.id;
    } else {
      id = Number(this.q(`INSERT INTO users (name, pin_hash, verify_code, verify_expires, phone, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(...fields, phone, this.now()).lastInsertRowid);
    }
    await this.telephony.sendSms(phone, `Your Lonely Oldies code is ${code}. Nobody from Lonely Oldies will ever ask you for it.`);
    return this.getUser(id);
  }

  verifyPhone(userId, code) {
    const user = this.getUser(userId);
    if (!user) throw new UserError('Please start again.');
    if (user.verified) return user;
    if (!user.verify_code || user.verify_expires < this.now()) {
      throw new UserError('That code has expired. Please ask for a new one.');
    }
    if (!checkSecret(String(code ?? '').replace(/\D/g, ''), user.verify_code)) {
      throw new UserError('That code is not right. Please check the text message and try again.');
    }
    this.q('UPDATE users SET verified = 1, verify_code = NULL, verify_expires = NULL WHERE id = ?').run(userId);
    return this.getUser(userId);
  }

  async resendCode(userId) {
    const user = this.getUser(userId);
    if (!user || user.verified) return;
    const code = sixDigitCode();
    this.q('UPDATE users SET verify_code = ?, verify_expires = ? WHERE id = ?')
      .run(hashSecret(code), this.now() + 15 * 60 * 1000, userId);
    await this.telephony.sendSms(user.phone, `Your Lonely Oldies code is ${code}.`);
  }

  // Someone ringing in from their own phone has shown they hold that number.
  registerByPhone({ phone, name, pin }) {
    this.checkNotBanned(phone);
    this.validatePin(pin);
    const firstName = cleanName(name) || 'Friend';
    const existing = this.getUserByPhone(phone);
    if (existing?.verified) throw new UserError('That number is already registered.');
    if (existing) {
      this.q('UPDATE users SET name = ?, pin_hash = ?, verified = 1, verify_code = NULL WHERE id = ?')
        .run(firstName, hashSecret(pin), existing.id);
      return this.getUser(existing.id);
    }
    const id = this.q('INSERT INTO users (phone, name, pin_hash, verified, created_at) VALUES (?, ?, ?, 1, ?)')
      .run(phone, firstName, hashSecret(pin), this.now()).lastInsertRowid;
    return this.getUser(Number(id));
  }

  // Checks a PIN, locking the account for a while after too many wrong tries.
  checkPin(user, pin) {
    if (!user) return { ok: false };
    if (user.locked_until && user.locked_until > this.now()) return { ok: false, locked: true };
    if (checkSecret(String(pin ?? ''), user.pin_hash)) {
      this.q('UPDATE users SET failed_pins = 0, locked_until = NULL WHERE id = ?').run(user.id);
      return { ok: true };
    }
    const failed = user.failed_pins + 1;
    const lock = failed >= this.config.maxPinAttempts;
    this.q('UPDATE users SET failed_pins = ?, locked_until = ? WHERE id = ?')
      .run(lock ? 0 : failed, lock ? this.now() + this.config.pinLockMinutes * 60 * 1000 : null, user.id);
    return { ok: false, locked: lock };
  }

  login(rawPhone, pin) {
    const phone = this.phone(rawPhone);
    const user = this.getUserByPhone(phone);
    const result = this.checkPin(user, pin);
    if (result.locked) throw new UserError('Too many wrong PINs. Please wait 15 minutes and try again.');
    if (!result.ok) throw new UserError('That phone number and PIN do not match.');
    if (user.status === 'banned') throw new UserError('Sorry, this number cannot use Lonely Oldies.');
    return user;
  }

  // Forgotten PIN: we text a code to the registered phone.
  async startPinReset(rawPhone) {
    const user = this.getUserByPhone(this.phone(rawPhone));
    if (!user?.verified || user.status === 'banned') return; // say nothing either way
    const code = sixDigitCode();
    this.q('UPDATE users SET verify_code = ?, verify_expires = ? WHERE id = ?')
      .run(hashSecret(code), this.now() + 15 * 60 * 1000, user.id);
    await this.telephony.sendSms(user.phone, `Your Lonely Oldies code to choose a new PIN is ${code}. Nobody from Lonely Oldies will ever ask you for it.`);
  }

  finishPinReset(rawPhone, code, pin) {
    const user = this.getUserByPhone(this.phone(rawPhone));
    const wrong = new UserError('That code is not right, or it has expired. Please ask for a new one.');
    if (!user?.verify_code || user.verify_expires < this.now()) throw wrong;
    if (user.locked_until && user.locked_until > this.now()) throw new UserError('Too many tries. Please wait 15 minutes.');
    this.validatePin(pin);
    if (!checkSecret(String(code ?? '').replace(/\D/g, ''), user.verify_code)) {
      this.checkPin(user, null); // counts towards the lock-out
      throw wrong;
    }
    this.q(`UPDATE users SET pin_hash = ?, verify_code = NULL, verify_expires = NULL, failed_pins = 0, locked_until = NULL
      WHERE id = ?`).run(hashSecret(pin), user.id);
    return this.getUser(user.id);
  }

  getUser(id) {
    return this.q('SELECT * FROM users WHERE id = ?').get(id);
  }

  getUserByPhone(phone) {
    return this.q('SELECT * FROM users WHERE phone = ?').get(phone);
  }

  canUse(user) {
    return user && user.verified && user.status === 'active';
  }

  // ---------- availability ----------

  isAvailable(user) {
    return Boolean(user.available_until && user.available_until > this.now());
  }

  // medium: 'voice' for a phone call, 'sms' for a text-message chat.
  // roomId: set when they're waiting for a group chat rather than a one-to-one chat.
  setAvailable(userId, on, medium = 'voice', roomId = null) {
    const user = this.getUser(userId);
    if (on) {
      if (!this.canUse(user)) throw new UserError(this.blockedReason(user));
      if (this.callsToday(userId) >= this.config.maxCallsPerDay) {
        throw new UserError("You've had lots of chats today. Please come back tomorrow.");
      }
    }
    const until = on ? this.now() + this.config.availableForMinutes * 60 * 1000 : null;
    if (on) {
      this.q('UPDATE users SET available_until = ?, available_medium = ?, available_room = ? WHERE id = ?')
        .run(until, medium === 'sms' ? 'sms' : 'voice', roomId ?? null, userId);
    } else {
      this.q('UPDATE users SET available_until = NULL, available_room = NULL WHERE id = ?').run(userId);
    }
    return until;
  }

  blockedReason(user) {
    if (!user?.verified) return 'Please confirm your phone number first.';
    if (user.status === 'suspended') return 'Your account is paused while our team looks into a report. We will be in touch.';
    if (user.status === 'banned') return 'Sorry, this number cannot use Lonely Oldies.';
    return 'Sorry, something went wrong.';
  }

  // One-to-one chats and group chats both count towards the daily limit.
  callsToday(userId) {
    const since = this.now() - DAY;
    return this.q(`SELECT
        (SELECT COUNT(*) FROM calls WHERE (user_a = ? OR user_b = ?) AND started_at > ?)
      + (SELECT COUNT(*) FROM group_participants WHERE user_id = ? AND joined_at > ?) AS n`)
      .get(userId, userId, since, userId, since).n;
  }

  activeCall(userId) {
    return this.q(`SELECT * FROM calls WHERE (user_a = ? OR user_b = ?) AND ${ACTIVE_CALL}`).get(userId, userId);
  }

  // In any chat at all: one-to-one or group.
  busy(userId) {
    return this.activeCall(userId) || this.groups.activeFor(userId);
  }

  isBlockedPair(a, b) {
    return Boolean(this.q('SELECT 1 FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)')
      .get(a, b, b, a));
  }

  spokeRecently(a, b) {
    return Boolean(this.q(`SELECT 1 FROM calls WHERE ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))
      AND created_at > ?`).get(a, b, b, a, this.now() - this.config.avoidRepeatDays * DAY));
  }

  // ---------- matching ----------

  // Pairs up people who are waiting, at random, never pairing anyone with
  // someone they've blocked (or who blocked them). People who've spoken in the
  // last few days are only paired again if there's nobody new for them.
  // People are only paired with someone who wants the same kind of chat.
  findPairs(random = Math.random) {
    const pairs = [];
    for (const medium of ['voice', 'sms']) {
      for (const [a, b] of this.pairUp(this.waitingFor(medium), random)) pairs.push([a, b, medium]);
    }
    return pairs;
  }

  waitingFor(medium) {
    return this.q(`SELECT id FROM users WHERE status = 'active' AND verified = 1 AND available_until > ?
      AND available_medium = ? AND available_room IS NULL
      AND id NOT IN (SELECT user_a FROM calls WHERE ${ACTIVE_CALL})
      AND id NOT IN (SELECT user_b FROM calls WHERE ${ACTIVE_CALL})
      AND id NOT IN (SELECT p.user_id FROM group_participants p JOIN group_chats g ON g.id = p.chat_id
        WHERE p.state IN ('dialing','joined') AND g.status IN ('dialing','in_progress'))`).all(this.now(), medium).map((r) => r.id);
  }

  pairUp(waiting, random) {
    const blocked = new Set();
    const recent = new Set();
    const key = (x, y) => (x < y ? `${x}:${y}` : `${y}:${x}`);
    for (const a of waiting) {
      for (const b of waiting) {
        if (a >= b) continue;
        if (this.isBlockedPair(a, b)) blocked.add(key(a, b));
        else if (this.spokeRecently(a, b)) recent.add(key(a, b));
      }
    }
    // Try a few random orders and keep the one with the most chats and fewest repeats.
    let best = { pairs: [], score: -1 };
    for (let attempt = 0; attempt < 25; attempt++) {
      const order = [...waiting];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const pairs = [];
      const used = new Set();
      let repeats = 0;
      for (const allowRepeat of [false, true]) {
        for (const a of order) {
          if (used.has(a)) continue;
          const b = order.find((c) => c !== a && !used.has(c) && !blocked.has(key(a, c))
            && (allowRepeat || !recent.has(key(a, c))));
          if (b === undefined) continue;
          if (recent.has(key(a, b))) repeats++;
          used.add(a).add(b);
          pairs.push([a, b]);
        }
      }
      const score = pairs.length * 1000 - repeats;
      if (score > best.score) best = { pairs, score };
      if (!repeats) break;
    }
    return best.pairs;
  }

  // Safety net in case a "call finished" message from Twilio never arrives,
  // and closes text chats that have gone quiet.
  async closeStaleCalls() {
    const now = this.now();
    this.q(`UPDATE calls SET status = 'failed', ended_at = ? WHERE medium = 'voice' AND status = 'dialing' AND created_at < ?`)
      .run(now, now - 10 * 60 * 1000);
    this.q(`UPDATE calls SET status = 'completed', ended_at = ? WHERE medium = 'voice' AND status = 'in_progress' AND started_at < ?`)
      .run(now, now - (this.config.maxCallMinutes + 10) * 60 * 1000);
    await this.texts.closeQuiet();
    await this.groups.closeStale();
  }

  async runMatchmaker(random) {
    await this.closeStaleCalls();
    const started = [];
    for (const [a, b, medium] of this.findPairs(random)) {
      try {
        started.push(medium === 'sms' ? await this.texts.start('random', a, b) : await this.startCall('random', a, b));
      } catch (err) {
        this.log.error?.('Could not start call', err);
      }
    }
    try {
      await this.groups.match();
    } catch (err) {
      this.log.error?.('Could not start group chat', err);
    }
    return started;
  }

  // ---------- calls ----------

  legUrl(path, callId, leg) {
    return `${this.config.baseUrl}${path}?call=${callId}&leg=${leg}`;
  }

  // Rings both people from the service's own number. If `aSid` is given,
  // person A is already on the line (they rang the phone menu), so only B is rung.
  async startCall(kind, a, b, { aSid } = {}) {
    const callId = tx(this.db, () => {
      if (this.busy(a) || this.busy(b)) throw new UserError('One of you is already on a call.');
      // Matched people stop waiting, so they aren't matched twice.
      this.q('UPDATE users SET available_until = NULL WHERE id IN (?, ?)').run(a, b);
      return Number(this.q('INSERT INTO calls (kind, user_a, user_b, a_sid, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(kind, a, b, aSid ?? null, this.now()).lastInsertRowid);
    });
    try {
      for (const [leg, userId] of aSid ? [['b', b]] : [['a', a], ['b', b]]) {
        const sid = await this.telephony.placeCall({
          to: this.getUser(userId).phone,
          url: this.legUrl('/voice/leg', callId, leg),
          statusCallback: this.legUrl('/voice/leg-status', callId, leg),
        });
        this.q(`UPDATE calls SET ${leg}_sid = ? WHERE id = ?`).run(sid, callId);
      }
    } catch (err) {
      this.q(`UPDATE calls SET status = 'failed', ended_at = ? WHERE id = ?`).run(this.now(), callId);
      const placed = this.getCall(callId);
      for (const sid of [placed.a_sid, placed.b_sid]) if (sid) await this.telephony.hangUp(sid);
      throw err;
    }
    return this.getCall(callId);
  }

  getCall(id) {
    return this.q('SELECT * FROM calls WHERE id = ?').get(id);
  }

  otherLeg(leg) {
    return leg === 'a' ? 'b' : 'a';
  }

  partyOf(call, leg) {
    return this.getUser(leg === 'a' ? call.user_a : call.user_b);
  }

  otherPartyFor(call, userId) {
    if (call.user_a === userId) return this.getUser(call.user_b);
    if (call.user_b === userId) return this.getUser(call.user_a);
    return null;
  }

  legJoined(callId, leg) {
    this.q(`UPDATE calls SET ${leg}_state = 'joined' WHERE id = ? AND ${leg}_state = 'dialing'`).run(callId);
    const call = this.getCall(callId);
    if (call.a_state === 'joined' && call.b_state === 'joined' && call.status === 'dialing') {
      this.q(`UPDATE calls SET status = 'in_progress', started_at = ? WHERE id = ?`).run(this.now(), callId);
    }
    return this.getCall(callId);
  }

  // A leg said "not now", didn't answer, or hung up before joining.
  async legDeclined(callId, leg) {
    const call = this.getCall(callId);
    if (!call || call[`${leg}_state`] !== 'dialing') return call;
    this.q(`UPDATE calls SET ${leg}_state = 'declined' WHERE id = ?`).run(callId);
    if (call.status !== 'dialing') return this.finishIfDone(callId);

    this.q(`UPDATE calls SET status = 'failed', ended_at = ? WHERE id = ?`).run(this.now(), callId);
    const other = this.otherLeg(leg);
    const otherSid = call[`${other}_sid`];
    if (call[`${other}_state`] === 'joined') {
      // They're waiting on hold: explain, and (for random chats) keep looking for someone else.
      if (call.kind === 'random') {
        try { this.setAvailable(call[`user_${other}`], true); } catch { /* daily limit reached */ }
      }
      if (otherSid) await this.telephony.redirectCall(otherSid, this.legUrl('/voice/partner-unavailable', callId, other));
    } else if (call[`${other}_state`] === 'dialing' && otherSid) {
      await this.telephony.hangUp(otherSid);
    }
    return this.getCall(callId);
  }

  // Twilio tells us each leg has finished (answered or not).
  async legEnded(callId, leg) {
    const call = this.getCall(callId);
    if (!call) return null;
    if (call[`${leg}_state`] === 'dialing') return this.legDeclined(callId, leg);
    if (call[`${leg}_state`] === 'joined') this.q(`UPDATE calls SET ${leg}_state = 'ended' WHERE id = ?`).run(callId);
    return this.finishIfDone(callId);
  }

  finishIfDone(callId) {
    const call = this.getCall(callId);
    const done = (s) => s === 'ended' || s === 'declined';
    if (done(call.a_state) && done(call.b_state) && (call.status === 'in_progress' || call.status === 'dialing')) {
      this.q(`UPDATE calls SET status = ?, ended_at = ? WHERE id = ?`)
        .run(call.started_at ? 'completed' : 'failed', this.now(), callId);
    }
    return this.getCall(callId);
  }

  // ---------- talk again ----------

  // Records whether someone wants to speak to their call partner again. When
  // both have said yes, they become "friends" and can ring each other through
  // the service (still without seeing each other's number).
  async submitFeedback(callId, userId, talkAgain) {
    const call = this.getCall(callId);
    if (!call || !call.started_at) throw new UserError('We could not find that call.');
    const other = this.otherPartyFor(call, userId);
    if (!other) throw new UserError('We could not find that call.');
    this.q(`INSERT INTO feedback (call_id, user_id, talk_again, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (call_id, user_id) DO UPDATE SET talk_again = excluded.talk_again`)
      .run(callId, userId, talkAgain ? 1 : 0, this.now());
    const [low, high] = [userId, other.id].sort((x, y) => x - y);
    if (!talkAgain) {
      this.q('DELETE FROM connections WHERE user_low = ? AND user_high = ?').run(low, high);
      return { connected: false };
    }
    const theirs = this.q('SELECT talk_again FROM feedback WHERE call_id = ? AND user_id = ?').get(callId, other.id);
    if (theirs?.talk_again && !this.isBlockedPair(userId, other.id)) {
      const added = this.q('INSERT OR IGNORE INTO connections (user_low, user_high, created_at) VALUES (?, ?, ?)')
        .run(low, high, this.now()).changes;
      if (added) await this.announceFriendship(this.getUser(userId), other);
      return { connected: true, other };
    }
    return { connected: false, waiting: !theirs };
  }

  // Calls this person had in the last week that they haven't given an answer for.
  pendingFeedback(userId) {
    return this.q(`SELECT c.*, CASE WHEN c.user_a = ? THEN ub.name ELSE ua.name END AS other_name
      FROM calls c JOIN users ua ON ua.id = c.user_a JOIN users ub ON ub.id = c.user_b
      WHERE (c.user_a = ? OR c.user_b = ?) AND c.started_at IS NOT NULL AND c.status = 'completed'
        AND c.created_at > ?
        AND NOT EXISTS (SELECT 1 FROM feedback f WHERE f.call_id = c.id AND f.user_id = ?)
        AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.call_id = c.id AND r.reporter = ?)
      ORDER BY c.created_at DESC`).all(userId, userId, userId, this.now() - 7 * DAY, userId, userId);
  }

  lastCall(userId) {
    return this.q(`SELECT * FROM calls WHERE (user_a = ? OR user_b = ?) AND started_at IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`).get(userId, userId);
  }

  async announceFriendship(a, b) {
    const how = `ring ${this.config.publicPhoneNumber} and press 2, or visit ${this.config.baseUrl}`;
    for (const [me, them] of [[a, b], [b, a]]) {
      try {
        await this.telephony.sendSms(me.phone, `Good news from Lonely Oldies: you and ${them.name} would both like to talk again. To ring ${them.name}, ${how}.`);
      } catch (err) {
        this.log.error?.('Could not send text', err);
      }
    }
  }

  listFriends(userId) {
    return this.q(`SELECT u.id, u.name, u.status, u.available_until, c.created_at AS since,
        (SELECT MAX(created_at) FROM calls WHERE started_at IS NOT NULL
          AND ((user_a = ? AND user_b = u.id) OR (user_b = ? AND user_a = u.id))) AS last_spoke
      FROM connections c JOIN users u ON u.id = CASE WHEN c.user_low = ? THEN c.user_high ELSE c.user_low END
      WHERE (c.user_low = ? OR c.user_high = ?) AND u.status = 'active'
      ORDER BY last_spoke DESC`).all(userId, userId, userId, userId, userId)
      .filter((f) => !this.isBlockedPair(userId, f.id));
  }

  areFriends(a, b) {
    const [low, high] = [a, b].sort((x, y) => x - y);
    return Boolean(this.q('SELECT 1 FROM connections WHERE user_low = ? AND user_high = ?').get(low, high));
  }

  async callFriend(userId, friendId, { medium = 'voice', ...opts } = {}) {
    const user = this.getUser(userId);
    const friend = this.getUser(friendId);
    if (!this.canUse(user)) throw new UserError(this.blockedReason(user));
    if (!friend || !this.areFriends(userId, friendId) || this.isBlockedPair(userId, friendId) || friend.status !== 'active') {
      throw new UserError('Sorry, you cannot call that person.');
    }
    if (this.callsToday(userId) >= this.config.maxCallsPerDay) {
      throw new UserError("You've had lots of chats today. Please come back tomorrow.");
    }
    if (this.busy(userId)) throw new UserError("You're already in a chat. Please finish it first.");
    if (this.busy(friendId)) throw new UserError(`${friend.name} is in another chat. Please try again later.`);
    return medium === 'sms' ? this.texts.start('reconnect', userId, friendId) : this.startCall('reconnect', userId, friendId, opts);
  }

  // ---------- safety ----------

  block(userId, otherId) {
    if (userId === otherId) return;
    this.q('INSERT OR IGNORE INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)').run(userId, otherId, this.now());
    const [low, high] = [userId, otherId].sort((x, y) => x - y);
    this.q('DELETE FROM connections WHERE user_low = ? AND user_high = ?').run(low, high);
  }

  // Reporting always blocks the person too. Once enough different people have
  // reported someone, their account is paused until the team reviews it.
  // `say` (for text chats) replaces what each person is told when the chat ends.
  async report(userId, callId, reason, { say } = {}) {
    const call = this.getCall(callId);
    const other = call && this.otherPartyFor(call, userId);
    if (!other) throw new UserError('We could not find that call.');
    const text = String(reason || 'No details given').slice(0, 1000);
    const reportId = Number(this.q('INSERT INTO reports (call_id, reporter, reported, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(callId, userId, other.id, text, this.now()).lastInsertRowid);
    this.block(userId, other.id);
    if (call.medium === 'sms' && ['dialing', 'in_progress'].includes(call.status)) {
      await this.texts.end(call, {
        say: say ?? {
          [userId]: `Lonely Oldies: thank you for telling us. ${other.name} has been blocked, the chat has ended, and our team will look into it.`,
          [other.id]: `Lonely Oldies: your text chat with ${this.getUser(userId).name} has finished.`,
        },
      });
    }
    await this.checkReports(other.id);
    return { reportId, reported: other };
  }

  // Pauses an account once enough different people have reported it. Automatic
  // reports from message screening count as one extra reporter.
  async checkReports(userId) {
    const user = this.getUser(userId);
    const { people, automatic } = this.q(`SELECT
        COUNT(DISTINCT CASE WHEN reporter != reported THEN reporter END) AS people,
        MAX(CASE WHEN reporter = reported THEN 1 ELSE 0 END) AS automatic
      FROM reports WHERE reported = ? AND status = 'open'`).get(userId);
    if (people + (automatic ?? 0) >= this.config.reportSuspendThreshold && user?.status === 'active') {
      await this.suspend(userId);
    }
  }

  addToReport(reportId, userId, extra) {
    this.q(`UPDATE reports SET reason = reason || ? WHERE id = ? AND reporter = ?`).run(`\n${extra}`, reportId, userId);
  }

  async suspend(userId) {
    this.q(`UPDATE users SET status = 'suspended', available_until = NULL, available_room = NULL WHERE id = ?`).run(userId);
    const group = this.groups.activeFor(userId);
    if (group) await this.groups.remove(group, userId);
    const live = this.activeCall(userId);
    if (live?.medium === 'sms') await this.texts.end(live);
    else if (live) for (const sid of [live.a_sid, live.b_sid]) if (sid) await this.telephony.hangUp(sid);
    this.log.warn?.(`User ${userId} suspended pending review`);
  }

  // ---------- admin ----------

  adminOverview() {
    return {
      reports: this.q(`SELECT r.*, a.name AS reporter_name, b.name AS reported_name, b.status AS reported_status,
          (SELECT COUNT(*) FROM reports x WHERE x.reported = r.reported) AS total_against,
          COALESCE((SELECT medium FROM calls c WHERE c.id = r.call_id),
            (SELECT medium FROM group_chats g WHERE g.id = r.group_chat_id)) AS medium,
          (SELECT x.name FROM group_chats g JOIN rooms x ON x.id = g.room_id WHERE g.id = r.group_chat_id) AS room_name
        FROM reports r JOIN users a ON a.id = r.reporter JOIN users b ON b.id = r.reported
        WHERE r.status = 'open' ORDER BY r.created_at DESC`).all(),
      suspended: this.q(`SELECT id, name, phone, created_at FROM users WHERE status = 'suspended'`).all(),
      stats: this.q(`SELECT
          (SELECT COUNT(*) FROM users WHERE verified = 1) AS users,
          (SELECT COUNT(*) FROM users WHERE available_until > ?) AS waiting,
          (SELECT COUNT(*) FROM calls WHERE ${ACTIVE_CALL}) AS live_calls,
          (SELECT COUNT(*) FROM group_chats WHERE ${ACTIVE_CALL}) AS live_groups,
          (SELECT COUNT(*) FROM calls WHERE started_at IS NOT NULL) AS total_calls,
          (SELECT COUNT(*) FROM connections) AS friendships`).get(this.now()),
    };
  }

  async ban(userId, reason) {
    const user = this.getUser(userId);
    if (!user) return;
    await this.suspend(userId);
    this.q(`UPDATE users SET status = 'banned' WHERE id = ?`).run(userId);
    this.q('INSERT OR REPLACE INTO banned_phones (phone, reason, created_at) VALUES (?, ?, ?)').run(user.phone, reason || null, this.now());
    this.q(`UPDATE reports SET status = 'actioned' WHERE reported = ? AND status = 'open'`).run(userId);
  }

  reinstate(userId) {
    this.q(`UPDATE users SET status = 'active' WHERE id = ? AND status = 'suspended'`).run(userId);
    this.q(`UPDATE reports SET status = 'dismissed' WHERE reported = ? AND status = 'open'`).run(userId);
  }

  dismissReport(reportId) {
    this.q(`UPDATE reports SET status = 'dismissed' WHERE id = ?`).run(reportId);
  }

  // ---------- phone menu sessions ----------

  ivrUser(callSid) {
    const row = this.q('SELECT user_id FROM ivr_sessions WHERE call_sid = ?').get(callSid);
    return row?.user_id ? this.getUser(row.user_id) : null;
  }

  ivrData(callSid) {
    const row = this.q('SELECT data FROM ivr_sessions WHERE call_sid = ?').get(callSid);
    return row?.data ? JSON.parse(row.data) : {};
  }

  ivrSet(callSid, { userId, data } = {}) {
    this.q(`INSERT INTO ivr_sessions (call_sid, user_id, data, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (call_sid) DO UPDATE SET user_id = COALESCE(excluded.user_id, user_id), data = COALESCE(excluded.data, data)`)
      .run(callSid, userId ?? null, data ? JSON.stringify(data) : null, this.now());
  }
}
