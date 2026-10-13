import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  phone           TEXT NOT NULL UNIQUE,          -- E.164, never shown to other users
  name            TEXT NOT NULL,                 -- first name only, shown to call partners
  pin_hash        TEXT NOT NULL,
  verified        INTEGER NOT NULL DEFAULT 0,    -- phone ownership confirmed (SMS code or phoned in)
  verify_code     TEXT,
  verify_expires  INTEGER,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  available_until INTEGER,                       -- epoch ms; NULL = not available
  failed_pins     INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER,
  created_at      INTEGER NOT NULL
);

-- Numbers that may never register again (kept even if the user row is deleted).
CREATE TABLE IF NOT EXISTS banned_phones (
  phone      TEXT PRIMARY KEY,
  reason     TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('random','reconnect')),
  user_a      INTEGER NOT NULL REFERENCES users(id),   -- for reconnects, the person asking
  user_b      INTEGER NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'dialing' CHECK (status IN ('dialing','in_progress','completed','failed')),
  a_sid       TEXT,
  b_sid       TEXT,
  a_state     TEXT NOT NULL DEFAULT 'dialing',          -- dialing | joined | declined | ended
  b_state     TEXT NOT NULL DEFAULT 'dialing',
  started_at  INTEGER,                                  -- both joined
  ended_at    INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
  call_id    INTEGER NOT NULL REFERENCES calls(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  talk_again INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (call_id, user_id)
);

-- Pairs who both said "yes, let's talk again". user_low < user_high.
CREATE TABLE IF NOT EXISTS connections (
  user_low   INTEGER NOT NULL REFERENCES users(id),
  user_high  INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_low, user_high)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker    INTEGER NOT NULL REFERENCES users(id),
  blocked    INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker, blocked)
);

CREATE TABLE IF NOT EXISTS reports (
  id         INTEGER PRIMARY KEY,
  call_id    INTEGER REFERENCES calls(id),
  reporter   INTEGER NOT NULL REFERENCES users(id),
  reported   INTEGER NOT NULL REFERENCES users(id),
  reason     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  created_at INTEGER NOT NULL
);

-- "I'm worried about them": wellbeing concerns about someone a member chatted with.
-- Kept apart from reports: a concern never blocks, pauses or penalises anyone,
-- and the person it's about is never told who raised it.
CREATE TABLE IF NOT EXISTS concerns (
  id            INTEGER PRIMARY KEY,
  call_id       INTEGER REFERENCES calls(id),          -- set for a one-to-one chat
  group_chat_id INTEGER REFERENCES group_chats(id),    -- set for a group chat
  raised_by     INTEGER NOT NULL REFERENCES users(id),
  about         INTEGER NOT NULL REFERENCES users(id),
  details       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_review','actioned','closed')),
  team_note     TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Links a phone-menu call (Twilio CallSid) to the person who entered their PIN.
CREATE TABLE IF NOT EXISTS ivr_sessions (
  call_sid   TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  data       TEXT,
  created_at INTEGER NOT NULL
);

-- Every text-chat message, kept so the team can review reports.
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY,
  call_id       INTEGER NOT NULL REFERENCES calls(id),
  sender        INTEGER NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,
  delivered     INTEGER NOT NULL,                     -- 0 = stopped by screening
  screen_reason TEXT,
  created_at    INTEGER NOT NULL
);

-- Group chats about a shared hobby or topic.
CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id),           -- NULL = set up by the team
  hidden      INTEGER NOT NULL DEFAULT 0,               -- hidden by the team
  created_at  INTEGER NOT NULL
);

-- One group conversation in a room, by phone or by text.
CREATE TABLE IF NOT EXISTS group_chats (
  id               INTEGER PRIMARY KEY,
  room_id          INTEGER NOT NULL REFERENCES rooms(id),
  medium           TEXT NOT NULL CHECK (medium IN ('voice','sms')),
  status           TEXT NOT NULL DEFAULT 'dialing' CHECK (status IN ('dialing','in_progress','completed','failed')),
  started_at       INTEGER,                              -- two people joined
  ended_at         INTEGER,
  last_activity_at INTEGER,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_participants (
  chat_id   INTEGER NOT NULL REFERENCES group_chats(id),
  user_id   INTEGER NOT NULL REFERENCES users(id),
  state     TEXT NOT NULL DEFAULT 'dialing',            -- dialing | joined | declined | left | removed
  sid       TEXT,
  joined_at INTEGER,
  left_at   INTEGER,
  PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_messages (
  id            INTEGER PRIMARY KEY,
  chat_id       INTEGER NOT NULL REFERENCES group_chats(id),
  sender        INTEGER NOT NULL REFERENCES users(id),
  body          TEXT NOT NULL,
  delivered     INTEGER NOT NULL,
  screen_reason TEXT,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_available ON users(available_until);
CREATE INDEX IF NOT EXISTS idx_group_participants_user ON group_participants(user_id, state);
CREATE INDEX IF NOT EXISTS idx_group_messages_chat ON group_messages(chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_call ON messages(call_id, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_users ON calls(user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported, status);
CREATE INDEX IF NOT EXISTS idx_concerns_status ON concerns(status, created_at);
`;

// Columns added after the first release. Each is added if an older database lacks it.
const ADDED_COLUMNS = [
  ['users', 'available_medium', "TEXT NOT NULL DEFAULT 'voice'"],   // voice | sms: how they want this chat
  ['calls', 'medium', "TEXT NOT NULL DEFAULT 'voice'"],             // voice = phone call, sms = text chat
  ['calls', 'last_activity_at', 'INTEGER'],
  ['users', 'available_room', 'INTEGER'],                           // set when waiting for a group chat
  ['reports', 'group_chat_id', 'INTEGER'],                          // set for reports about a group chat
  // Who you'd like to chat with. 'unsaid' gender only matches people happy to chat with anyone.
  ['users', 'gender', "TEXT NOT NULL DEFAULT 'unsaid' CHECK (gender IN ('female','male','unsaid'))"],
  ['users', 'wants', "TEXT NOT NULL DEFAULT 'anyone' CHECK (wants IN ('anyone','women','men'))"],
  ['users', 'waiting_since', 'INTEGER'],                            // when this wait for a one-to-one chat began
  // "Would you like to speak to a man this time?" for this wait only: offered | declined | accepted
  ['users', 'one_off', "TEXT CHECK (one_off IN ('offered','declined','accepted'))"],
];

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

// Runs fn inside a transaction, rolling back if it throws.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
