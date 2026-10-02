// Group chats about a shared hobby or topic ("rooms"). People say they're
// free for a room's group chat, by phone or by text, just as for a one-to-one
// chat. Once enough people are waiting, the service rings (or texts) them all
// and joins them together. Later arrivals join a chat that's already going if
// there's room. Numbers stay private, text messages are screened, and anyone
// can report someone, exactly as in one-to-one chats.

import { tx } from './db.js';
import { screenMessage } from './screening.js';
import { cleanName } from './security.js';
import { UserError } from './service.js';

const LIVE = `status IN ('dialing','in_progress')`;
const PRESENT = `state IN ('dialing','joined')`;

export const STARTER_ROOMS = [
  ['Gardening', 'Flowers, vegetables, allotments and what to plant next.'],
  ['Books and reading', 'What you are reading, old favourites and recommendations.'],
  ['Music and songs', 'The music you love, from big bands to the Beatles.'],
  ['Sport', 'Football, cricket, tennis, horse racing and the old days.'],
  ['Cooking and baking', 'Recipes, cakes and family favourites.'],
  ['Pets and animals', 'Dogs, cats, birds and other animals in your life.'],
  ['Travel and memories', 'Places you have been and stories from the past.'],
  ['Quizzes and puzzles', 'Crosswords, quizzes and brain teasers.'],
  ['Just a natter', 'A friendly chat about anything at all.'],
];

export class Groups {
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

  // ---------- rooms ----------

  ensureStarterRooms() {
    if (this.q('SELECT COUNT(*) AS n FROM rooms').get().n) return;
    for (const [name, description] of STARTER_ROOMS) {
      this.q('INSERT INTO rooms (name, description, created_at) VALUES (?, ?, ?)').run(name, description, this.service.now());
    }
  }

  getRoom(id) {
    return this.q('SELECT * FROM rooms WHERE id = ?').get(id);
  }

  // Visible rooms, most active first, with who is waiting and any chat going on now.
  listRooms({ includeHidden = false } = {}) {
    const now = this.service.now();
    return this.q(`SELECT r.*,
        (SELECT COUNT(*) FROM users u WHERE u.available_room = r.id AND u.available_until > ?) AS waiting,
        (SELECT COUNT(*) FROM group_chats g WHERE g.room_id = r.id AND g.started_at IS NOT NULL) AS chats_held,
        (SELECT MAX(g.created_at) FROM group_chats g WHERE g.room_id = r.id) AS last_chat
      FROM rooms r ${includeHidden ? '' : 'WHERE r.hidden = 0'}
      ORDER BY chats_held DESC, r.id`).all(now)
      .map((room) => ({ ...room, live: this.liveChats(room.id) }));
  }

  liveChats(roomId) {
    return this.q(`SELECT g.*, (SELECT COUNT(*) FROM group_participants p WHERE p.chat_id = g.id AND p.state = 'joined') AS people
      FROM group_chats g WHERE g.room_id = ? AND g.${LIVE}`).all(roomId);
  }

  // Members can start a new group. The name and description are screened like text messages.
  createRoom(userId, { name, description }) {
    const user = this.service.getUser(userId);
    if (!this.service.canUse(user)) throw new UserError(this.service.blockedReason(user));
    const cleanTitle = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const about = String(description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (cleanTitle.length < 3) throw new UserError('Please give your group a name, for example "Knitting" or "Classic films".');
    for (const text of [cleanTitle, about].filter(Boolean)) {
      const check = screenMessage(text);
      if (!check.ok) throw new UserError(`Sorry, we can't use that because it looked like it had ${check.reason}.`);
    }
    if (this.q('SELECT 1 FROM rooms WHERE lower(name) = lower(?) AND hidden = 0').get(cleanTitle)) {
      throw new UserError('There is already a group with that name. You can join it from the list.');
    }
    const today = this.q('SELECT COUNT(*) AS n FROM rooms WHERE created_by = ? AND created_at > ?')
      .get(userId, this.service.now() - 24 * 60 * 60 * 1000).n;
    if (today >= 2) throw new UserError("You've started two new groups today. Please try again tomorrow.");
    const id = Number(this.q('INSERT INTO rooms (name, description, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run(cleanTitle, about, userId, this.service.now()).lastInsertRowid);
    return this.getRoom(id);
  }

  setHidden(roomId, hidden) {
    this.q('UPDATE rooms SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, roomId);
    if (hidden) this.q('UPDATE users SET available_until = NULL, available_room = NULL WHERE available_room = ?').run(roomId);
  }

  // ---------- who is where ----------

  activeFor(userId) {
    return this.q(`SELECT g.* FROM group_chats g JOIN group_participants p ON p.chat_id = g.id
      WHERE p.user_id = ? AND p.${PRESENT} AND g.${LIVE}`).get(userId);
  }

  participant(chatId, userId) {
    return this.q('SELECT * FROM group_participants WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
  }

  // Everyone in a chat (optionally only in some states), with their first names, in the order they arrived.
  people(chatId, states = ['dialing', 'joined']) {
    return this.q(`SELECT p.*, u.name, u.phone FROM group_participants p JOIN users u ON u.id = p.user_id
      WHERE p.chat_id = ? AND p.state IN (${states.map(() => '?').join(',')}) ORDER BY p.rowid`).all(chatId, ...states);
  }

  everyone(chatId) {
    return this.people(chatId, ['dialing', 'joined', 'declined', 'left', 'removed']);
  }

  getChat(id) {
    return this.q('SELECT * FROM group_chats WHERE id = ?').get(id);
  }

  clashes(userId, others) {
    return others.some((o) => o.user_id !== userId && this.service.isBlockedPair(userId, o.user_id));
  }

  // ---------- joining ----------

  // Called when someone asks to join a room's group chat.
  async join(userId, roomId, medium = 'voice') {
    const s = this.service;
    const room = this.getRoom(roomId);
    if (!room || room.hidden) throw new UserError('Sorry, that group is no longer running.');
    if (s.busy(userId)) throw new UserError("You're already in a chat. Please finish it first.");
    s.setAvailable(userId, true, medium, room.id);
    const added = await this.match();
    return added.find((x) => x.userId === userId) ?? { waiting: true };
  }

  // Puts waiting people into group chats: into one already going if there's space,
  // or a new one once enough people are waiting for the same room.
  async match() {
    const s = this.service;
    const results = [];
    const waiting = this.q(`SELECT id, available_room AS room, available_medium AS medium FROM users
      WHERE available_room IS NOT NULL AND available_until > ? AND status = 'active' AND verified = 1
      ORDER BY available_until`).all(s.now()).filter((u) => !s.busy(u.id));
    const groups = new Map();
    for (const u of waiting) {
      const key = `${u.room}:${u.medium}`;
      if (!groups.has(key)) groups.set(key, { room: u.room, medium: u.medium, ids: [] });
      groups.get(key).ids.push(u.id);
    }
    for (const { room, medium, ids } of groups.values()) {
      const left = [...ids];
      // First, top up a chat that's already going.
      for (const chat of this.liveChats(room).filter((c) => c.medium === medium)) {
        for (const id of [...left]) {
          const present = this.people(chat.id);
          if (present.length >= this.config.groupMaxSize) break;
          if (this.clashes(id, present)) continue;
          await this.addParticipant(chat, id);
          left.splice(left.indexOf(id), 1);
          results.push({ userId: id, chatId: chat.id });
        }
      }
      // Then start a new chat if enough people are left, never putting together people who've blocked each other.
      if (left.length >= this.config.groupMinSize) {
        const chosen = [];
        for (const id of left) {
          if (chosen.length >= this.config.groupMaxSize) break;
          if (!chosen.some((c) => s.isBlockedPair(c, id))) chosen.push(id);
        }
        if (chosen.length >= this.config.groupMinSize) {
          const chat = await this.start(room, medium, chosen);
          for (const id of chosen) results.push({ userId: id, chatId: chat.id });
        }
      }
    }
    return results;
  }

  async start(roomId, medium, userIds) {
    const s = this.service;
    const now = s.now();
    const chatId = tx(s.db, () => {
      const id = Number(this.q(`INSERT INTO group_chats (room_id, medium, status, started_at, last_activity_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(roomId, medium, medium === 'sms' ? 'in_progress' : 'dialing', medium === 'sms' ? now : null, now, now)
        .lastInsertRowid);
      for (const userId of userIds) {
        this.q(`INSERT INTO group_participants (chat_id, user_id, state, joined_at) VALUES (?, ?, ?, ?)`)
          .run(id, userId, medium === 'sms' ? 'joined' : 'dialing', medium === 'sms' ? now : null);
        this.q('UPDATE users SET available_until = NULL, available_room = NULL WHERE id = ?').run(userId);
      }
      return id;
    });
    const chat = this.getChat(chatId);
    if (medium === 'sms') {
      for (const p of this.people(chatId)) await this.send(p, this.textWelcome(chat, p.user_id));
    } else {
      for (const userId of userIds) await this.ring(chat, userId);
    }
    return this.getChat(chatId);
  }

  async addParticipant(chat, userId) {
    const s = this.service;
    const now = s.now();
    const isText = chat.medium === 'sms';
    this.q(`INSERT OR REPLACE INTO group_participants (chat_id, user_id, state, joined_at) VALUES (?, ?, ?, ?)`)
      .run(chat.id, userId, isText ? 'joined' : 'dialing', isText ? now : null);
    this.q('UPDATE users SET available_until = NULL, available_room = NULL WHERE id = ?').run(userId);
    if (isText) {
      const newcomer = s.getUser(userId);
      await this.send(newcomer, this.textWelcome(chat, userId));
      for (const p of this.people(chat.id, ['joined'])) {
        if (p.user_id !== userId) await this.send(p, `${this.roomName(chat)} group: ${newcomer.name} has joined the chat.`);
      }
    } else {
      await this.ring(chat, userId);
    }
  }

  roomName(chat) {
    return this.getRoom(chat.room_id)?.name ?? 'Lonely Oldies';
  }

  names(list) {
    const n = list.map((p) => p.name);
    return n.length <= 1 ? (n[0] ?? '') : `${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
  }

  textWelcome(chat, userId) {
    const others = this.people(chat.id, ['joined']).filter((p) => p.user_id !== userId);
    return `Lonely Oldies: welcome to the ${this.roomName(chat)} group chat${others.length ? ` with ${this.names(others)}` : ''}. Reply to this number and everyone in the group will see your message. Never share your address, phone number or bank details. Text LEAVE to leave the chat. If someone upsets you, text REPORT and their name.`;
  }

  // ---------- phone group chats ----------

  legUrl(path, chatId, userId) {
    return `${this.config.baseUrl}${path}?chat=${chatId}&user=${userId}`;
  }

  async ring(chat, userId) {
    const s = this.service;
    try {
      const sid = await s.telephony.placeCall({
        to: s.getUser(userId).phone,
        url: this.legUrl('/voice/group-leg', chat.id, userId),
        statusCallback: this.legUrl('/voice/group-leg-status', chat.id, userId),
      });
      this.q('UPDATE group_participants SET sid = ? WHERE chat_id = ? AND user_id = ?').run(sid, chat.id, userId);
    } catch (err) {
      s.log.error?.('Could not ring for group chat', err);
      this.q(`UPDATE group_participants SET state = 'declined' WHERE chat_id = ? AND user_id = ?`).run(chat.id, userId);
    }
  }

  // Someone pressed 1 to join a phone group chat.
  joined(chatId, userId) {
    const now = this.service.now();
    this.q(`UPDATE group_participants SET state = 'joined', joined_at = ? WHERE chat_id = ? AND user_id = ? AND state = 'dialing'`)
      .run(now, chatId, userId);
    const here = this.people(chatId, ['joined']).length;
    if (here >= 2) {
      this.q(`UPDATE group_chats SET status = 'in_progress', started_at = COALESCE(started_at, ?), last_activity_at = ? WHERE id = ?`)
        .run(now, now, chatId);
    }
    return here;
  }

  // Someone said "not now", didn't answer, hung up, or left. Ends the chat
  // if fewer than two people are left in it.
  async leftCall(chatId, userId, { declined = false } = {}) {
    const s = this.service;
    const me = this.participant(chatId, userId);
    if (!me || !['dialing', 'joined'].includes(me.state)) return;
    this.q(`UPDATE group_participants SET state = ?, left_at = ? WHERE chat_id = ? AND user_id = ?`)
      .run(declined || me.state === 'dialing' ? 'declined' : 'left', s.now(), chatId, userId);
    await this.checkStillGoing(chatId);
  }

  async checkStillGoing(chatId) {
    const s = this.service;
    const chat = this.getChat(chatId);
    if (!chat || !['dialing', 'in_progress'].includes(chat.status)) return;
    const joined = this.people(chatId, ['joined']);
    const ringing = this.people(chatId, ['dialing']);
    if (joined.length >= 2 || (joined.length + ringing.length >= 2 && ringing.length)) return;
    // Not enough people left to carry on.
    this.q(`UPDATE group_chats SET status = ?, ended_at = ? WHERE id = ?`).run(chat.started_at ? 'completed' : 'failed', s.now(), chatId);
    for (const p of [...joined, ...ringing]) {
      this.q(`UPDATE group_participants SET state = 'left', left_at = ? WHERE chat_id = ? AND user_id = ?`).run(s.now(), chatId, p.user_id);
      if (chat.medium === 'sms') {
        await this.send(p, `${this.roomName(chat)} group: everyone else has left, so the chat has finished. Thank you for joining in! Text GROUPS to find another group.`);
      } else if (p.sid) {
        if (p.state === 'joined') {
          // Nobody else came, or everyone else has gone: let them know, and keep them on the list if it never started.
          if (!chat.started_at) {
            try { s.setAvailable(p.user_id, true, 'voice', chat.room_id); } catch { /* daily limit reached */ }
          }
          await s.telephony.redirectCall(p.sid, this.legUrl('/voice/group-alone', chatId, p.user_id));
        } else {
          await s.telephony.hangUp(p.sid);
        }
      }
    }
  }

  // ---------- text group chats ----------

  async leaveText(chat, user, note) {
    const s = this.service;
    this.q(`UPDATE group_participants SET state = 'left', left_at = ? WHERE chat_id = ? AND user_id = ?`).run(s.now(), chat.id, user.id);
    await this.send(user, note ?? `${this.roomName(chat)} group: you've left the chat. Thank you for joining in!`);
    for (const p of this.people(chat.id, ['joined'])) await this.send(p, `${this.roomName(chat)} group: ${user.name} has left the chat.`);
    await this.checkStillGoing(chat.id);
  }

  // A text from someone who is in a text group chat.
  async incomingText(chat, user, body, word) {
    const s = this.service;
    const others = () => this.people(chat.id, ['joined']).filter((p) => p.user_id !== user.id);
    if (word === 'LEAVE' || word === 'END' || word === 'BYE') return this.leaveText(chat, user);
    if (word === 'WHO') {
      const list = others();
      return this.send(user, `${this.roomName(chat)} group: ${list.length ? `also here: ${list.map((p, i) => `${i + 1} ${p.name}`).join(', ')}` : "nobody else is here at the moment"}.`);
    }
    if (word === 'HELP') {
      return this.send(user, `${this.roomName(chat)} group: reply to send a message to everyone. Text WHO to see who's here, LEAVE to leave, or REPORT and a name if someone upsets you.`);
    }
    if (/^REPORT\b/i.test(body.trim())) {
      const target = body.trim().replace(/^report\b[\s:,-]*/i, '').trim();
      const list = others();
      const match = /^\d+$/.test(target) ? list[Number(target) - 1]
        : list.filter((p) => p.name.toLowerCase() === cleanName(target).toLowerCase());
      const person = Array.isArray(match) ? (match.length === 1 ? match[0] : null) : match;
      if (!person) {
        return this.send(user, `Lonely Oldies: who would you like to report? Reply REPORT and a number: ${list.map((p, i) => `${i + 1} for ${p.name}`).join(', ') || 'nobody else is here'}.`);
      }
      await this.report(user.id, chat.id, person.user_id, 'Reported by text message during a group chat.');
      return this.send(user, `Lonely Oldies: thank you for telling us. ${person.name} has been removed from this chat and will never be put in touch with you again. Our team will look into it.`);
    }
    return this.relay(chat, user, body);
  }

  async relay(chat, sender, body) {
    const s = this.service;
    const check = screenMessage(body);
    this.q(`INSERT INTO group_messages (chat_id, sender, body, delivered, screen_reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(chat.id, sender.id, body.slice(0, 2000), check.ok ? 1 : 0, check.ok ? null : `${check.category}: ${check.reason}`, s.now());
    this.q('UPDATE group_chats SET last_activity_at = ? WHERE id = ?').run(s.now(), chat.id);
    if (check.ok) {
      for (const p of this.people(chat.id, ['joined'])) {
        if (p.user_id !== sender.id) await this.send(p, `${this.roomName(chat)} group, ${sender.name}: ${body}`);
      }
      return;
    }
    const stopped = this.q(`SELECT COUNT(*) AS n FROM group_messages WHERE chat_id = ? AND sender = ? AND delivered = 0
      AND screen_reason NOT LIKE 'empty%' AND screen_reason NOT LIKE 'length%'`).get(chat.id, sender.id).n;
    if (stopped >= this.config.screenStrikesBeforeReport) {
      await this.report(sender.id, chat.id, sender.id, `Automatic report: ${stopped} messages from ${sender.name} in a group chat were stopped by screening.`);
      return;
    }
    await this.send(sender, `Lonely Oldies: sorry, that message wasn't passed on because it looked like it had ${check.reason}. ${check.category === 'length' ? 'Please send it in smaller parts.' : "To keep everyone safe we don't pass on phone numbers, addresses, links, or anything about money."}`);
  }

  // ---------- safety ----------

  // Reporting someone in a group blocks them for the reporter, removes them
  // from the chat, and counts towards pausing their account. When the
  // reporter is the reported person, it's an automatic report from screening.
  async report(reporterId, chatId, reportedId, reason) {
    const s = this.service;
    const chat = this.getChat(chatId);
    const them = this.participant(chatId, reportedId);
    if (!chat || !them || (reporterId !== reportedId && !this.participant(chatId, reporterId))) {
      throw new UserError('We could not find that person in your chat.');
    }
    const reportId = Number(this.q(`INSERT INTO reports (group_chat_id, reporter, reported, reason, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(chatId, reporterId, reportedId, String(reason || 'No details given').slice(0, 1000), s.now()).lastInsertRowid);
    if (reporterId !== reportedId) s.block(reporterId, reportedId);
    await this.remove(chat, reportedId);
    await s.checkReports(reportedId);
    return { reportId, reported: s.getUser(reportedId) };
  }

  async remove(chat, userId) {
    const s = this.service;
    const p = this.participant(chat.id, userId);
    if (!p || !['dialing', 'joined'].includes(p.state) || !['dialing', 'in_progress'].includes(chat.status)) return;
    if (chat.medium === 'sms') {
      return this.leaveText(chat, s.getUser(userId), `Lonely Oldies: you have been removed from the ${this.roomName(chat)} group chat. Our team will look into what happened.`);
    }
    this.q(`UPDATE group_participants SET state = 'removed', left_at = ? WHERE chat_id = ? AND user_id = ?`).run(s.now(), chat.id, userId);
    if (p.sid) await s.telephony.hangUp(p.sid);
    await this.checkStillGoing(chat.id);
  }

  // Ends text group chats nobody has written in for a while, and deletes old messages.
  async closeStale() {
    const s = this.service;
    const now = s.now();
    const idle = now - this.config.smsChatIdleHours * 60 * 60 * 1000;
    for (const chat of this.q(`SELECT * FROM group_chats WHERE medium = 'sms' AND ${LIVE} AND last_activity_at < ?`).all(idle)) {
      for (const p of this.people(chat.id, ['joined'])) {
        this.q(`UPDATE group_participants SET state = 'left', left_at = ? WHERE chat_id = ? AND user_id = ?`).run(now, chat.id, p.user_id);
        await this.send(p, `${this.roomName(chat)} group: the chat has gone quiet, so it has finished. Thank you for joining in! Text GROUPS to find another group.`);
      }
      this.q(`UPDATE group_chats SET status = 'completed', ended_at = ? WHERE id = ?`).run(now, chat.id);
    }
    // Phone group chats: safety net in case Twilio's "call finished" messages never arrive.
    this.q(`UPDATE group_chats SET status = CASE WHEN started_at IS NULL THEN 'failed' ELSE 'completed' END, ended_at = ?
      WHERE medium = 'voice' AND ${LIVE} AND created_at < ?`).run(now, now - (this.config.maxCallMinutes + 10) * 60 * 1000);
    this.q(`UPDATE group_participants SET state = 'left' WHERE state IN ('dialing','joined')
      AND chat_id IN (SELECT id FROM group_chats WHERE status IN ('completed','failed'))`).run();
    this.q('DELETE FROM group_messages WHERE created_at < ?').run(now - this.config.messageRetentionDays * 24 * 60 * 60 * 1000);
  }

  transcript(chatId) {
    return this.q(`SELECT m.*, u.name AS sender_name FROM group_messages m JOIN users u ON u.id = m.sender
      WHERE m.chat_id = ? ORDER BY m.created_at, m.id`).all(chatId);
  }

  // Groups a person can choose from by phone or text (numbered 1 to 9).
  menuRooms() {
    return this.listRooms().slice(0, 9);
  }
}
