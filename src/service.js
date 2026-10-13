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
export const CONCERN_STATUSES = ['new', 'in_review', 'actioned', 'closed'];
export const GENDERS = ['female', 'male', 'unsaid'];
export const WANTS = ['anyone', 'women', 'men'];

// Would someone who wants `wants` be happy to chat with someone of `gender`?
// "Rather not say" only fits people who are happy to chat with anyone.
export function fits(wants, gender) {
  if (wants === 'women') return gender === 'female';
  if (wants === 'men') return gender === 'male';
  return true;
}

// Whether two people can be matched: each person's choice must fit the other.
// With `relaxed`, someone who said "yes, anyone this time" (one_off = 'accepted')
// is relaxed about their own choice for this one chat, but the other person's still counts.
export function suits(a, b, { relaxed = false } = {}) {
  const ok = (me, them) => fits(me.wants, them.gender) || (relaxed && me.one_off === 'accepted');
  return ok(a, b) && ok(b, a);
}

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
      throw new UserError('Sorry, this number cannot use Tea and Company.');
    }
  }

  validatePin(pin) {
    if (!isValidPin(pin)) throw new UserError('Your PIN must be exactly 4 numbers.');
    if (isWeakPin(pin)) throw new UserError('That PIN is too easy to guess. Please choose different numbers.');
  }

  async register({ name, phone: rawPhone, pin, gender, wants }) {
    const firstName = cleanName(name);
    if (!firstName) throw new UserError('Please tell us your first name.');
    const phone = this.phone(rawPhone);
    this.validatePin(pin);
    const choices = this.checkChoices({ gender, wants });
    this.checkNotBanned(phone);
    const existing = this.getUserByPhone(phone);
    if (existing?.verified) throw new UserError('That number is already registered. Please sign in instead.');

    const code = sixDigitCode();
    const fields = [firstName, hashSecret(pin), hashSecret(code), this.now() + 15 * 60 * 1000, choices.gender, choices.wants];
    let id;
    if (existing) {
      // Unverified sign-up being retried: start again.
      this.q('UPDATE users SET name = ?, pin_hash = ?, verify_code = ?, verify_expires = ?, gender = ?, wants = ? WHERE id = ?')
        .run(...fields, existing.id);
      id = existing.id;
    } else {
      id = Number(this.q(`INSERT INTO users (name, pin_hash, verify_code, verify_expires, gender, wants, phone, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...fields, phone, this.now()).lastInsertRowid);
    }
    await this.telephony.sendSms(phone, `Your Tea and Company code is ${code}. Nobody from Tea and Company will ever ask you for it.`);
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
    await this.telephony.sendSms(user.phone, `Your Tea and Company code is ${code}.`);
  }

  // Someone ringing in from their own phone has shown they hold that number.
  registerByPhone({ phone, name, pin, gender, wants }) {
    this.checkNotBanned(phone);
    const choices = this.checkChoices({ gender, wants });
    this.validatePin(pin);
    const firstName = cleanName(name) || 'Friend';
    const existing = this.getUserByPhone(phone);
    if (existing?.verified) throw new UserError('That number is already registered.');
    if (existing) {
      this.q('UPDATE users SET name = ?, pin_hash = ?, verified = 1, verify_code = NULL, gender = ?, wants = ? WHERE id = ?')
        .run(firstName, hashSecret(pin), choices.gender, choices.wants, existing.id);
      return this.getUser(existing.id);
    }
    const id = this.q('INSERT INTO users (phone, name, pin_hash, verified, gender, wants, created_at) VALUES (?, ?, ?, 1, ?, ?, ?)')
      .run(phone, firstName, hashSecret(pin), choices.gender, choices.wants, this.now()).lastInsertRowid;
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
    if (user.status === 'banned') throw new UserError('Sorry, this number cannot use Tea and Company.');
    return user;
  }

  // Forgotten PIN: we text a code to the registered phone.
  async startPinReset(rawPhone) {
    const user = this.getUserByPhone(this.phone(rawPhone));
    if (!user?.verified || user.status === 'banned') return; // say nothing either way
    const code = sixDigitCode();
    this.q('UPDATE users SET verify_code = ?, verify_expires = ? WHERE id = ?')
      .run(hashSecret(code), this.now() + 15 * 60 * 1000, user.id);
    await this.telephony.sendSms(user.phone, `Your Tea and Company code to choose a new PIN is ${code}. Nobody from Tea and Company will ever ask you for it.`);
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

  // ---------- who you'd like to chat with ----------
  // Applies to one-to-one chats (phone and text). Group chats are about a
  // hobby and are open to everyone in that group.

  checkChoices({ gender, wants }) {
    const g = gender || 'unsaid';
    const w = wants || 'anyone';
    if (!GENDERS.includes(g)) throw new UserError('Please choose whether you are a woman or a man, or would rather not say.');
    if (!WANTS.includes(w)) throw new UserError('Please choose who you would like to chat with.');
    return { gender: g, wants: w };
  }

  // Changing your choice starts afresh: any "anyone this time" answer is forgotten.
  setChoices(userId, choices) {
    const { gender, wants } = this.checkChoices(choices);
    this.q('UPDATE users SET gender = ?, wants = ?, one_off = NULL WHERE id = ?').run(gender, wants, userId);
    return this.getUser(userId);
  }

  // When someone has waited a while for the kind of person they asked for, and
  // nobody like that is free but someone else is (who'd be happy to chat with
  // them, in the same way: phone or text), we offer them that person just this
  // once. Returns who we'd offer, or null.
  choiceOffer(user, waiting) {
    if (!user || user.wants === 'anyone' || !this.isAvailable(user) || user.available_room) return null;
    if (user.one_off === 'declined' || user.one_off === 'accepted') return null;
    if (!user.waiting_since || this.now() - user.waiting_since < this.config.preferenceWaitMinutes * 60 * 1000) return null;
    const others = (waiting ?? this.waitingUsers(user.available_medium))
      .filter((o) => o.id !== user.id && !this.isBlockedPair(user.id, o.id));
    if (!others.length || others.some((o) => suits(user, o))) return null; // someone suitable is free
    return others.find((o) => suits({ ...user, one_off: 'accepted' }, o, { relaxed: true })) ?? null;
  }

  // The words for the offer, for example "No female callers are available right
  // now. Would you like to speak to a man this time?"
  offerWords(user, other) {
    const byText = user.available_medium === 'sms';
    const wanted = user.wants === 'women' ? 'female' : 'male';
    const instead = other.gender === 'male' ? 'a man' : other.gender === 'female' ? 'a woman' : 'someone else';
    return {
      none: byText ? `No ${user.wants} are free for a text chat right now.` : `No ${wanted} callers are available right now.`,
      question: `Would you like to ${byText ? 'text with' : 'speak to'} ${instead} this time?`,
      instead,
      keepWaiting: user.wants === 'women' ? 'a woman' : 'a man',
    };
  }

  // "Yes please, anyone this time." Only lasts until this person's next chat
  // starts; their saved choice never changes.
  acceptOffer(userId) {
    const user = this.getUser(userId);
    if (!this.isAvailable(user)) throw new UserError("You're not on the list for a chat at the moment.");
    this.q(`UPDATE users SET one_off = 'accepted' WHERE id = ?`).run(userId);
  }

  // "No thanks, I'll keep waiting." We won't ask again while they wait this time.
  declineOffer(userId) {
    this.q(`UPDATE users SET one_off = 'declined' WHERE id = ?`).run(userId);
  }

  // Asks each person who has waited long enough, once per wait: we ring
  // people waiting for a phone chat, and text people waiting for a text chat.
  async sendChoiceOffers() {
    const offered = [];
    for (const medium of ['voice', 'sms']) {
      const waiting = this.waitingUsers(medium);
      for (const user of waiting) {
        if (user.one_off) continue;
        const other = this.choiceOffer(user, waiting);
        if (!other) continue;
        this.q(`UPDATE users SET one_off = 'offered' WHERE id = ?`).run(user.id);
        try {
          if (medium === 'sms') {
            const words = this.offerWords(user, other);
            await this.telephony.sendSms(user.phone, `Tea and Company: ${words.none} ${words.question} Reply YES for ${words.instead} this time, or WAIT to keep waiting for ${words.keepWaiting}.`);
          } else {
            await this.telephony.placeCall({
              to: user.phone,
              url: `${this.config.baseUrl}/voice/offer?user=${user.id}`,
              statusCallback: `${this.config.baseUrl}/voice/offer-status?user=${user.id}`,
            });
          }
          offered.push(user.id);
        } catch (err) {
          this.log.error?.('Could not send an offer', err);
        }
      }
    }
    return offered;
  }

  // Someone said yes to the offer while on the phone: find them a partner now,
  // so they can stay on the line. Returns the new call, or null if the person
  // we had in mind has gone (they stay on the list either way).
  async matchNow(userId, { aSid } = {}) {
    const user = this.getUser(userId);
    if (!this.isAvailable(user) || user.available_medium !== 'voice' || user.available_room) return null;
    const others = this.waitingUsers('voice').filter((o) => o.id !== userId && !this.isBlockedPair(userId, o.id)
      && suits(user, o, { relaxed: true }));
    // Someone they chose first, then someone they haven't spoken to lately.
    others.sort((x, y) => Number(!suits(user, x)) - Number(!suits(user, y))
      || Number(this.spokeRecently(userId, x.id)) - Number(this.spokeRecently(userId, y.id)));
    for (const other of others) {
      try {
        return await this.startCall('random', userId, other.id, { aSid });
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
      }
    }
    return null;
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
      // Saying "I'm free" again while already waiting keeps your place (and
      // your answer to any offer); a new wait starts afresh.
      const now = this.now();
      this.q(`UPDATE users SET available_until = ?, available_medium = ?, available_room = ?,
          waiting_since = CASE WHEN available_until > ? THEN waiting_since ELSE ? END,
          one_off = CASE WHEN available_until > ? THEN one_off ELSE NULL END
        WHERE id = ?`).run(until, medium === 'sms' ? 'sms' : 'voice', roomId ?? null, now, now, now, userId);
    } else {
      this.q('UPDATE users SET available_until = NULL, available_room = NULL, waiting_since = NULL, one_off = NULL WHERE id = ?').run(userId);
    }
    return until;
  }

  blockedReason(user) {
    if (!user?.verified) return 'Please confirm your phone number first.';
    if (user.status === 'suspended') return 'Your account is paused while our team looks into a report. We will be in touch.';
    if (user.status === 'banned') return 'Sorry, this number cannot use Tea and Company.';
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
  // People are only paired with someone who wants the same kind of chat, and
  // whose choice of who to chat with (anyone, women, men) fits each other.
  findPairs(random = Math.random) {
    const pairs = [];
    for (const medium of ['voice', 'sms']) {
      for (const [a, b] of this.pairUp(this.waitingUsers(medium), random)) pairs.push([a, b, medium]);
    }
    return pairs;
  }

  waitingFor(medium) {
    return this.waitingUsers(medium).map((u) => u.id);
  }

  // People waiting for a one-to-one chat of this kind, and not already in a chat.
  waitingUsers(medium) {
    return this.q(`SELECT * FROM users WHERE status = 'active' AND verified = 1 AND available_until > ?
      AND available_medium = ? AND available_room IS NULL
      AND id NOT IN (SELECT user_a FROM calls WHERE ${ACTIVE_CALL})
      AND id NOT IN (SELECT user_b FROM calls WHERE ${ACTIVE_CALL})
      AND id NOT IN (SELECT p.user_id FROM group_participants p JOIN group_chats g ON g.id = p.chat_id
        WHERE p.state IN ('dialing','joined') AND g.status IN ('dialing','in_progress'))`).all(this.now(), medium);
  }

  // Someone who said "anyone this time" is paired with someone they chose if possible.
  pairUp(people, random) {
    const users = new Map(people.map((u) => [u.id, u]));
    const waiting = [...users.keys()];
    const blocked = new Set();
    const recent = new Set();
    const offChoice = new Set(); // only allowed because one of them said "anyone this time"
    const key = (x, y) => (x < y ? `${x}:${y}` : `${y}:${x}`);
    for (const a of waiting) {
      for (const b of waiting) {
        if (a >= b) continue;
        const [ua, ub] = [users.get(a), users.get(b)];
        if (this.isBlockedPair(a, b) || !suits(ua, ub, { relaxed: true })) {
          blocked.add(key(a, b));
          continue;
        }
        if (!suits(ua, ub)) offChoice.add(key(a, b));
        if (this.spokeRecently(a, b)) recent.add(key(a, b));
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
      let offChoices = 0;
      for (const [allowOffChoice, allowRepeat] of [[false, false], [false, true], [true, false], [true, true]]) {
        for (const a of order) {
          if (used.has(a)) continue;
          const b = order.find((c) => c !== a && !used.has(c) && !blocked.has(key(a, c))
            && (allowRepeat || !recent.has(key(a, c))) && (allowOffChoice || !offChoice.has(key(a, c))));
          if (b === undefined) continue;
          if (recent.has(key(a, b))) repeats++;
          if (offChoice.has(key(a, b))) offChoices++;
          used.add(a).add(b);
          pairs.push([a, b]);
        }
      }
      const score = pairs.length * 1000 - offChoices * 10 - repeats;
      if (score > best.score) best = { pairs, score };
      if (!repeats && !offChoices) break;
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
    await this.sendChoiceOffers();
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
      // Matched people stop waiting, so they aren't matched twice. Any "anyone
      // this time" answer was for this chat only.
      this.q('UPDATE users SET available_until = NULL, waiting_since = NULL, one_off = NULL WHERE id IN (?, ?)').run(a, b);
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
        await this.telephony.sendSms(me.phone, `Good news from Tea and Company: you and ${them.name} would both like to talk again. To ring ${them.name}, ${how}.`);
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
          [userId]: `Tea and Company: thank you for telling us. ${other.name} has been blocked, the chat has ended, and our team will look into it.`,
          [other.id]: `Tea and Company: your text chat with ${this.getUser(userId).name} has finished.`,
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

  // "I'm worried about them": a wellbeing concern, not a complaint. Unlike a
  // report it never blocks, pauses or penalises the person, and they are never
  // told who raised it. A second concern from the same person about the same
  // person, while the first is still open, is added to the first.
  raiseConcern(userId, callId, details) {
    const call = this.getCall(callId);
    const other = call?.started_at ? this.otherPartyFor(call, userId) : null;
    if (!other) throw new UserError('We could not find that chat.');
    return this.saveConcern({ callId, groupChatId: null, userId, about: other, details });
  }

  raiseGroupConcern(userId, chatId, aboutId, details) {
    const me = this.groups.participant(chatId, userId);
    const them = userId !== aboutId && this.groups.participant(chatId, aboutId);
    if (!me?.joined_at || !them?.joined_at) throw new UserError('We could not find that person in the group chat.');
    return this.saveConcern({ callId: null, groupChatId: chatId, userId, about: this.getUser(aboutId), details });
  }

  saveConcern({ callId, groupChatId, userId, about, details }) {
    const text = String(details ?? '').trim().slice(0, 1000) || 'No details given';
    const open = this.q(`SELECT id FROM concerns WHERE raised_by = ? AND about = ? AND status != 'closed'`).get(userId, about.id);
    if (open) {
      this.addToConcern(open.id, userId, text);
      return { concernId: open.id, about };
    }
    const concernId = Number(this.q(`INSERT INTO concerns (call_id, group_chat_id, raised_by, about, details, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(callId, groupChatId, userId, about.id, text, this.now(), this.now()).lastInsertRowid);
    this.log.warn?.(`Wellbeing concern ${concernId} raised about user ${about.id}`);
    return { concernId, about };
  }

  addToConcern(concernId, userId, extra) {
    this.q(`UPDATE concerns SET details = details || ?, updated_at = ? WHERE id = ? AND raised_by = ?`)
      .run(`\n${extra}`, this.now(), concernId, userId);
  }

  // The most recent chat two people actually had, for raising a concern about a friend.
  lastCallBetween(a, b) {
    return this.q(`SELECT * FROM calls WHERE started_at IS NOT NULL
      AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))
      ORDER BY created_at DESC LIMIT 1`).get(a, b, b, a);
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
      // Wellbeing concerns come first on the team page: new ones, then those being looked at.
      concerns: this.q(`SELECT c.*, a.name AS raised_by_name, b.name AS about_name, b.phone AS about_phone,
          b.status AS about_status,
          (SELECT COUNT(DISTINCT x.raised_by) FROM concerns x WHERE x.about = c.about) AS people_worried,
          COALESCE((SELECT medium FROM calls k WHERE k.id = c.call_id),
            (SELECT medium FROM group_chats g WHERE g.id = c.group_chat_id)) AS medium,
          (SELECT x.name FROM group_chats g JOIN rooms x ON x.id = g.room_id WHERE g.id = c.group_chat_id) AS room_name
        FROM concerns c JOIN users a ON a.id = c.raised_by JOIN users b ON b.id = c.about
        WHERE c.status != 'closed'
        ORDER BY CASE c.status WHEN 'new' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END, c.created_at DESC`).all(),
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

  updateConcern(concernId, { status, note }) {
    if (!CONCERN_STATUSES.includes(status)) throw new UserError('Please choose a status.');
    const changed = this.q(`UPDATE concerns SET status = ?, team_note = ?, updated_at = ? WHERE id = ?`)
      .run(status, String(note ?? '').trim().slice(0, 2000) || null, this.now(), concernId).changes;
    if (!changed) throw new UserError('We could not find that concern.');
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
