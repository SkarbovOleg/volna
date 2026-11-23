/**
 * Общая база для двух процессов: server.js (переписка) и media.js (фотографии).
 * Здесь же схема и мягкие миграции — чтобы оба сервиса видели одинаковые таблицы.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(ROOT, 'data');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const DB_FILE = path.join(DATA_DIR, 'volna.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash       TEXT NOT NULL,
  salt            TEXT NOT NULL,
  hue             INTEGER NOT NULL,
  avatar_media_id TEXT,
  created_at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body         TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL DEFAULT 'text',
  media_id     TEXT,
  created_at   INTEGER NOT NULL,
  read_at      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, read_at);
CREATE TABLE IF NOT EXISTS media (
  id         TEXT PRIMARY KEY,
  owner_id   INTEGER NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER,
  height     INTEGER,
  created_at INTEGER NOT NULL
);
`;

/** Добавляет колонку, если её ещё нет (для баз, созданных до обновления). */
function addColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`  миграция: ${table}.${column}`);
}

export function openDb() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  addColumn(db, 'users', 'avatar_media_id', 'TEXT');
  addColumn(db, 'messages', 'kind', "TEXT NOT NULL DEFAULT 'text'");
  addColumn(db, 'messages', 'media_id', 'TEXT');
  addColumn(db, 'messages', 'sticker_id', 'TEXT');
  return db;
}
