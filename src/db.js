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

-- Links a phone-menu call (Twilio CallSid) to the person who entered their PIN.
CREATE TABLE IF NOT EXISTS ivr_sessions (
  call_sid   TEXT PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id),
  data       TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_available ON users(available_until);
CREATE INDEX IF NOT EXISTS idx_calls_users ON calls(user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported, status);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
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
