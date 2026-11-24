/**
 * Волна — маленький мессенджер без зависимостей.
 * Node.js 22+ (используется встроенный node:sqlite).
 *
 *   node server.js          → http://127.0.0.1:8787  (сам поднимает фото-сервер на 8788)
 *   PORT=9000 node server.js
 *   MEDIA_EXTERNAL=1 node server.js   — не запускать media.js, использовать внешний
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, DATA_DIR, MEDIA_DIR, openDb } from './db.js';

const PUBLIC = path.join(ROOT, 'public');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const MEDIA_HOST = process.env.MEDIA_HOST || '127.0.0.1';
const MEDIA_PORT = Number(process.env.MEDIA_PORT || 8788);
const MAX_BODY = 256 * 1024;
const MAX_TEXT = 4000;

/** Если задан — зарегистрироваться можно только с этим кодом. */
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();

/** Набор стикеров лежит в public/stickers — id должны совпадать с именами файлов. */
const STICKERS = new Set(['smile', 'laugh', 'love', 'sad', 'angry', 'sleepy', 'cool', 'party', 'wink', 'think', 'shock', 'cry', 'star', 'fire', 'devil', 'angel']);

/* ─────────────────────────── база ─────────────────────────── */

const db = openDb();

const q = {
  userByName: db.prepare('SELECT * FROM users WHERE name = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (name, pass_hash, salt, hue, created_at) VALUES (?, ?, ?, ?, ?)'),
  insertSession: db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  setAvatar: db.prepare('UPDATE users SET avatar_media_id = ? WHERE id = ?'),
  mediaOwner: db.prepare('SELECT owner_id FROM media WHERE id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (sender_id, recipient_id, body, kind, media_id, sticker_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ),
  messageById: db.prepare('SELECT * FROM messages WHERE id = ?'),
  markRead: db.prepare('UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL'),
  maxFromPair: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE sender_id = ? AND recipient_id = ?'),
  contacts: db.prepare(`
    SELECT u.id, u.name, u.hue, u.avatar_media_id,
      lm.body     AS last_body,
      lm.kind     AS last_kind,
      lm.created_at AS last_at,
      lm.sender_id  AS last_from,
      (SELECT COUNT(*) FROM messages m
        WHERE m.sender_id = u.id AND m.recipient_id = ? AND m.read_at IS NULL) AS unread
    FROM users u
    LEFT JOIN (
      SELECT m.* FROM messages m
      JOIN (
        SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS peer_id,
               MAX(id) AS id
        FROM messages
        WHERE sender_id = ? OR recipient_id = ?
        GROUP BY peer_id
      ) t ON t.id = m.id
    ) lm ON lm.sender_id = u.id OR lm.recipient_id = u.id
    WHERE u.id != ?
    ORDER BY (last_at IS NULL) ASC, last_at DESC, u.name COLLATE NOCASE ASC
  `),
};

/* ─────────────────────── группы ─────────────────────── */

const gq = {
  byId: db.prepare('SELECT * FROM groups WHERE id = ?'),
  mine: db.prepare('SELECT g.* FROM groups g JOIN group_members m ON m.group_id = g.id AND m.user_id = ?'),
  members: db.prepare(
    `SELECT u.id, u.name, u.hue, u.avatar_media_id
     FROM group_members gm JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? ORDER BY gm.joined_at, u.id`,
  ),
  memberIds: db.prepare('SELECT user_id FROM group_members WHERE group_id = ?'),
  isMember: db.prepare('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?'),
  create: db.prepare('INSERT INTO groups (title, hue, owner_id, created_at) VALUES (?, ?, ?, ?)'),
  addMember: db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)'),
  removeMember: db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO group_messages (group_id, sender_id, body, kind, media_id, sticker_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ),
  messageById: db.prepare('SELECT * FROM group_messages WHERE id = ?'),
  last: db.prepare('SELECT * FROM group_messages WHERE group_id = ? ORDER BY id DESC LIMIT 1'),
  maxId: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM group_messages WHERE group_id = ?'),
  unread: db.prepare(
    `SELECT COUNT(*) AS c FROM group_messages m
     WHERE m.group_id = ? AND m.sender_id != ? AND m.id > COALESCE(
       (SELECT up_to FROM group_reads WHERE group_id = ? AND user_id = ?), 0)`,
  ),
  markRead: db.prepare(
    `INSERT INTO group_reads (group_id, user_id, up_to) VALUES (?, ?, ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET up_to = MAX(up_to, excluded.up_to)`,
  ),
};

/* ─────────────────────── утилиты ─────────────────────── */

const hashPass = (password, salt) => crypto.scryptSync(password, salt, 32).toString('hex');
const randomToken = () => crypto.randomBytes(24).toString('base64url');
const now = () => Date.now();

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function publicUser(row) {
  return { id: row.id, name: row.name, hue: row.hue, avatarId: row.avatar_media_id || null };
}

function publicMessage(row) {
  return {
    id: row.id,
    from: row.sender_id,
    to: row.recipient_id,
    body: row.body,
    kind: row.kind || 'text',
    mediaId: row.media_id || null,
    stickerId: row.sticker_id || null,
    at: row.created_at,
    readAt: row.read_at,
    editedAt: row.edited_at || null,
  };
}

/* ─────────────────────── группы: данные и операции ─────────────────────── */

function publicGroupMessage(row) {
  const sender = q.userById.get(row.sender_id);
  return {
    id: row.id,
    from: row.sender_id,
    group: row.group_id,
    body: row.body,
    kind: row.kind || 'text',
    mediaId: row.media_id || null,
    stickerId: row.sticker_id || null,
    at: row.created_at,
    editedAt: row.edited_at || null,
    fromName: sender ? sender.name : '?',
    fromHue: sender ? sender.hue : 232,
    fromAvatarId: sender ? sender.avatar_media_id || null : null,
  };
}

function groupInfo(groupId) {
  const row = gq.byId.get(groupId);
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    hue: row.hue,
    avatarId: row.avatar_media_id || null,
    ownerId: row.owner_id,
    members: gq.members.all(groupId).map(publicUser),
  };
}

function myGroups(userId) {
  return gq.mine
    .all(userId)
    .map((row) => {
      const last = gq.last.get(row.id);
      const members = gq.members.all(row.id).map(publicUser);
      const sender = last ? members.find((m) => m.id === last.sender_id) : null;
      return {
        id: row.id,
        title: row.title,
        hue: row.hue,
        avatarId: row.avatar_media_id || null,
        members: members.length,
        lastBody: last ? last.body : null,
        lastKind: last ? last.kind || 'text' : null,
        lastAt: last ? last.created_at : null,
        lastFrom: last ? last.sender_id : null,
        lastFromName: sender ? sender.name : null,
        unread: gq.unread.get(row.id, userId, row.id, userId).c,
      };
    })
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
}

function broadcastGroup(groupId, event, data) {
  for (const row of gq.memberIds.all(groupId)) broadcastTo(row.user_id, event, data);
}

function requireGroup(userId, groupId) {
  const id = Number(groupId);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Не указана группа');
  const group = groupInfo(id);
  if (!group) throw new HttpError(404, 'Группа не найдена');
  if (!gq.isMember.get(id, userId)) throw new HttpError(403, 'Ты не участник этой группы');
  return group;
}

function createGroup(user, payload) {
  const title = String(payload.title || '').trim().replace(/\s+/g, ' ');
  if (title.length < 2 || title.length > 60) throw new HttpError(400, 'Название: от 2 до 60 символов');

  const raw = Array.isArray(payload.memberIds) ? payload.memberIds : [];
  const memberIds = [...new Set(raw.map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0 && id !== user.id && q.userById.get(id),
  );
  if (!memberIds.length) throw new HttpError(400, 'Добавь хотя бы одного участника');

  const hue = Math.floor(Math.random() * 360);
  const info = gq.create.run(title, hue, user.id, now());
  const groupId = Number(info.lastInsertRowid);
  gq.addMember.run(groupId, user.id, now());
  for (const id of memberIds) gq.addMember.run(groupId, id, now());

  for (const id of [user.id, ...memberIds]) broadcastTo(id, 'chats', { groupId });
  return groupInfo(groupId);
}

function addGroupMembers(user, group, payload) {
  if (group.ownerId !== user.id) throw new HttpError(403, 'Добавлять участников может создатель');
  const raw = Array.isArray(payload.userIds) ? payload.userIds : [];
  const ids = [...new Set(raw.map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0 && q.userById.get(id) && !gq.isMember.get(group.id, id),
  );
  if (!ids.length) throw new HttpError(400, 'Некого добавлять');

  for (const id of ids) gq.addMember.run(group.id, id, now());
  for (const row of gq.memberIds.all(group.id)) broadcastTo(row.user_id, 'chats', { groupId: group.id });
  return groupInfo(group.id);
}

function leaveGroup(user, group) {
  gq.removeMember.run(group.id, user.id);
  broadcastTo(user.id, 'chats', { groupId: group.id });
  for (const row of gq.memberIds.all(group.id)) broadcastTo(row.user_id, 'chats', { groupId: group.id });
  return { ok: true };
}

function groupHistory(userId, groupId, before, limit) {
  const group = requireGroup(userId, groupId);
  const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const rows = before
    ? db
        .prepare('SELECT * FROM group_messages WHERE group_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(group.id, before, lim)
    : db.prepare('SELECT * FROM group_messages WHERE group_id = ? ORDER BY id DESC LIMIT ?').all(group.id, lim);

  return {
    group,
    messages: withMedia(rows.map(publicGroupMessage).reverse()),
    hasMore: rows.length === lim,
  };
}

function sendGroupMessage(user, groupId, body, mediaId, stickerId) {
  const group = requireGroup(user.id, groupId);
  const kind = stickerId ? 'sticker' : mediaId ? 'photo' : 'text';
  const info = gq.insertMessage.run(group.id, user.id, body, kind, mediaId, stickerId, now());
  const message = withMedia([publicGroupMessage(gq.messageById.get(Number(info.lastInsertRowid)))])[0];
  broadcastGroup(group.id, 'message', message);
  return message;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Подмешивает к сообщениям размеры фотографии, чтобы клиент не «прыгал» при загрузке. */
function withMedia(messages) {
  const ids = [...new Set(messages.filter((m) => m.mediaId).map((m) => m.mediaId))];
  if (!ids.length) return messages;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, mime, width, height FROM media WHERE id IN (${placeholders})`).all(...ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const message of messages) {
    const row = message.mediaId ? byId.get(message.mediaId) : null;
    if (row) message.media = { mime: row.mime, width: row.width, height: row.height };
  }
  return messages;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function tokenFrom(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return url.searchParams.get('token') || '';
}

function requireUser(req, url) {
  const token = tokenFrom(req, url);
  if (!token) throw new HttpError(401, 'Нужен вход');
  const row = q.session.get(token);
  if (!row) throw new HttpError(401, 'Сессия истекла');
  touchPresence(row.id);
  return { token, user: publicUser(row) };
}

/* ─────────────────────── онлайн: WebSocket + SSE ─────────────────────── */

/** userId → Set<ServerResponse> (SSE, несколько вкладок — нормально) */
const streams = new Map();
/** userId → Set<net.Socket> (WebSocket — основной канал: Cloudflare пропускает его, а SSE нет) */
const sockets = new Map();
/** userId → время последнего запроса; работает, когда поток вообще недоступен */
const presence = new Map();
const PRESENCE_TTL = 45000;

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

/** Кадр WebSocket (сервер → клиент, без маски). */
function wsFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function wsSend(userId, event, data) {
  const set = sockets.get(userId);
  if (!set) return;
  const frame = wsFrame(0x1, JSON.stringify({ event, data }));
  for (const socket of set) {
    try {
      socket.write(frame);
    } catch {
      /* соединение закроется само */
    }
  }
}

function wsBroadcastAll(event, data) {
  const frame = wsFrame(0x1, JSON.stringify({ event, data }));
  for (const set of sockets.values()) {
    for (const socket of set) {
      try {
        socket.write(frame);
      } catch {
        /* ignore */
      }
    }
  }
}

function wsRegister(userId, socket) {
  let set = sockets.get(userId);
  if (!set) {
    set = new Set();
    sockets.set(userId, set);
  }
  set.add(socket);
}

function wsUnregister(userId, socket) {
  const set = sockets.get(userId);
  if (!set) return false;
  set.delete(socket);
  if (set.size === 0) {
    sockets.delete(userId);
    return true;
  }
  return false;
}

/** Разбор входящих кадров: клиент присылает только короткие JSON-сообщения. */
function wsOnData(socket, onText) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let len = buffer[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        len = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + len) return;

      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + maskLen + len);

      if (opcode === 0x8) {
        try {
          socket.end(wsFrame(0x8, Buffer.alloc(0)));
        } catch {
          /* ignore */
        }
        return;
      }
      if (opcode === 0x9) {
        try {
          socket.write(wsFrame(0xa, payload));
        } catch {
          /* ignore */
        }
        continue;
      }
      if (opcode === 0x1) onText(payload.toString('utf8'));
    }
  };
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcastTo(userId, event, data) {
  wsSend(userId, event, data);

  const set = streams.get(userId);
  if (!set) return;
  for (const res of set) {
    try {
      sseSend(res, event, data);
    } catch {
      /* оборванный поток уберётся по close */
    }
  }
}

function broadcastAll(event, data) {
  wsBroadcastAll(event, data);

  for (const set of streams.values()) {
    for (const res of set) {
      try {
        sseSend(res, event, data);
      } catch {
        /* ignore */
      }
    }
  }
}

const onlineIds = () => {
  const nowTs = Date.now();
  const ids = new Set([...streams.keys(), ...sockets.keys()]);
  for (const [id, ts] of presence) {
    if (nowTs - ts <= PRESENCE_TTL) ids.add(id);
    else presence.delete(id);
  }
  return [...ids];
};

/** Клиент без SSE (прокси держит поток) всё равно «онлайн», пока ходит запросами. */
function touchPresence(userId) {
  presence.set(Number(userId), Date.now());
}

function setOnline(userId, res) {
  let set = streams.get(userId);
  if (!set) {
    set = new Set();
    streams.set(userId, set);
  }
  set.add(res);
}

function setOffline(userId, res) {
  const set = streams.get(userId);
  if (!set) return false;
  set.delete(res);
  if (set.size === 0) {
    streams.delete(userId);
    return true; // последняя вкладка закрылась
  }
  return false;
}

/* ─────────────────────── демо-данные отключены ─────────────────────── */

// Аккаунты создаёт только регистрация: никаких демо-пользователей в базе нет.
// Если нужен демо-набор для тестов — см. tools/ui-test.mjs, он поднимает свою копию.


/* ─────────────────────── бэкап базы ─────────────────────── */

/**
 * Снимок базы при каждом старте: VACUUM INTO даёт целостную копию
 * вместе с данными из WAL. Держим последние 10 снимков.
 * Копии лежат в backups/ — отдельно от data/, чтобы не пропасть вместе с ней.
 */
function backupDatabase() {
  try {
    const dir = path.join(ROOT, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(dir, `volna-${stamp}.db`);
    if (!fs.existsSync(file)) db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const snapshots = fs.readdirSync(dir).filter((name) => name.endsWith('.db')).sort();
    while (snapshots.length > 10) fs.unlinkSync(path.join(dir, snapshots.shift()));
    return path.relative(ROOT, file);
  } catch (err) {
    console.error('  бэкап не сделался:', err.message);
    return null;
  }
}

const lastBackup = backupDatabase();

/* ─────────────────────── API ─────────────────────── */

function register({ name, password, invite }) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ');
  const pass = String(password || '');
  if (INVITE_CODE && String(invite || '').trim() !== INVITE_CODE) {
    throw new HttpError(403, 'Неверный код приглашения');
  }
  if (clean.length < 2 || clean.length > 20) throw new HttpError(400, 'Имя: от 2 до 20 символов');
  if (!/^[\p{L}\p{N} ._-]+$/u.test(clean)) throw new HttpError(400, 'В имени только буквы, цифры, пробел, . _ -');
  if (pass.length < 4) throw new HttpError(400, 'Пароль: минимум 4 символа');
  if (q.userByName.get(clean)) throw new HttpError(409, 'Такое имя уже занято');

  const salt = crypto.randomBytes(16).toString('hex');
  const hue = Math.floor(Math.random() * 360);
  const info = q.insertUser.run(clean, hashPass(pass, salt), salt, hue, now());
  const user = publicUser(q.userById.get(Number(info.lastInsertRowid)));
  const token = randomToken();
  q.insertSession.run(token, user.id, now());
  return { token, user };
}

function login({ name, password }) {
  const clean = String(name || '').trim();
  const row = q.userByName.get(clean);
  const salt = row ? row.salt : 'no-such-user-salt';
  const expected = row ? row.pass_hash : hashPass('invalid', salt);
  const actual = hashPass(String(password || ''), salt);
  if (!row || !safeEqual(expected, actual)) throw new HttpError(401, 'Неверное имя или пароль');
  const user = publicUser(row);
  const token = randomToken();
  q.insertSession.run(token, user.id, now());
  return { token, user };
}

function contacts(userId) {
  const rows = q.contacts.all(userId, userId, userId, userId, userId);
  const online = new Set(onlineIds());
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    hue: r.hue,
    avatarId: r.avatar_media_id || null,
    lastBody: r.last_body,
    lastKind: r.last_kind || null,
    lastAt: r.last_at,
    lastFrom: r.last_from,
    unread: r.unread,
    online: online.has(r.id),
  }));
}

function history(userId, otherId, before, limit) {
  const other = q.userById.get(otherId);
  if (!other) throw new HttpError(404, 'Нет такого пользователя');
  const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const rows = before
    ? db
        .prepare(
          `SELECT * FROM messages
           WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)) AND id < ?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(userId, otherId, otherId, userId, before, lim)
    : db
        .prepare(
          `SELECT * FROM messages
           WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
           ORDER BY id DESC LIMIT ?`,
        )
        .all(userId, otherId, otherId, userId, lim);

  const messages = withMedia(rows.map(publicMessage).reverse());
  const hasMore = rows.length === lim;
  return { peer: publicUser(other), messages, hasMore };
}

function sendMessage(user, payload) {
  const stickerId = payload.sticker ? String(payload.sticker) : null;
  let body = String(payload.body || '').replace(/\r\n/g, '\n').trim();
  const mediaId = payload.mediaId ? String(payload.mediaId) : null;

  if (stickerId) {
    if (!STICKERS.has(stickerId)) throw new HttpError(400, 'Неизвестный стикер');
    if (mediaId) throw new HttpError(400, 'Стикер отправляется без фото');
    body = '';
  }

  if (!body && !mediaId && !stickerId) throw new HttpError(400, 'Пустое сообщение');
  if (body.length > MAX_TEXT) throw new HttpError(400, `Максимум ${MAX_TEXT} символов`);

  // вложение проверяем одинаково для личных и групповых сообщений
  if (mediaId) {
    const media = q.mediaOwner.get(mediaId);
    if (!media) throw new HttpError(400, 'Фотография не найдена');
    if (media.owner_id !== user.id) throw new HttpError(403, 'Это чужое фото');
  }

  if (payload.group) {
    return sendGroupMessage(user, payload.group, body, mediaId, stickerId);
  }

  const to = Number(payload.to);
  if (!Number.isInteger(to) || to <= 0) throw new HttpError(400, 'Не указан получатель');
  if (!q.userById.get(to)) throw new HttpError(404, 'Нет такого пользователя');
  if (to === user.id) throw new HttpError(400, 'Нельзя писать самому себе');

  const kind = stickerId ? 'sticker' : mediaId ? 'photo' : 'text';
  const info = q.insertMessage.run(user.id, to, body, kind, mediaId, stickerId, now());
  const message = withMedia([publicMessage(q.messageById.get(Number(info.lastInsertRowid)))])[0];
  broadcastTo(to, 'message', message);
  broadcastTo(user.id, 'message', message);
  return message;
}

function setAvatar(user, payload) {
  const mediaId = payload.avatarMediaId ? String(payload.avatarMediaId) : null;
  if (mediaId) {
    const media = q.mediaOwner.get(mediaId);
    if (!media) throw new HttpError(400, 'Фотография не найдена');
    if (media.owner_id !== user.id) throw new HttpError(403, 'Это чужое фото');
  }
  q.setAvatar.run(mediaId, user.id);
  const fresh = publicUser(q.userById.get(user.id));
  broadcastAll('profile', { userId: fresh.id, avatarId: fresh.avatarId });
  return fresh;
}

/** Ищет сообщение в личных и групповых, возвращает таблицу и строку. */
function findMessage(id) {
  const direct = q.messageById.get(id);
  if (direct) return { table: 'direct', row: direct };
  const grouped = gq.messageById.get(id);
  if (grouped) return { table: 'group', row: grouped };
  return null;
}

function editMessage(user, id, payload) {
  const found = findMessage(id);
  if (!found) throw new HttpError(404, 'Сообщение не найдено');
  const { table, row } = found;
  if (row.sender_id !== user.id) throw new HttpError(403, 'Можно изменять только свои сообщения');
  if ((row.kind || 'text') !== 'text') throw new HttpError(400, 'Можно изменять только текст');

  const body = String(payload.body || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new HttpError(400, 'Пустое сообщение');
  if (body.length > MAX_TEXT) throw new HttpError(400, `Максимум ${MAX_TEXT} символов`);

  const at = now();
  if (table === 'direct') {
    db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, at, id);
  } else {
    db.prepare('UPDATE group_messages SET body = ?, edited_at = ? WHERE id = ?').run(body, at, id);
  }

  const event = { id, body, editedAt: at, from: user.id };
  if (table === 'direct') {
    event.to = row.recipient_id;
    broadcastTo(row.recipient_id, 'messageEdited', event);
    broadcastTo(user.id, 'messageEdited', event);
  } else {
    event.group = row.group_id;
    broadcastGroup(row.group_id, 'messageEdited', event);
  }
  return event;
}

function deleteMessage(user, id) {
  const found = findMessage(id);
  if (!found) throw new HttpError(404, 'Сообщение не найдено');
  const { table, row } = found;
  if (row.sender_id !== user.id) throw new HttpError(403, 'Можно удалять только свои сообщения');

  if (table === 'direct') {
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  } else {
    db.prepare('DELETE FROM group_messages WHERE id = ?').run(id);
  }

  const event = { id, from: user.id };
  if (table === 'direct') {
    event.to = row.recipient_id;
    broadcastTo(row.recipient_id, 'messageDeleted', event);
    broadcastTo(user.id, 'messageDeleted', event);
  } else {
    event.group = row.group_id;
    broadcastGroup(row.group_id, 'messageDeleted', event);
  }
  return event;
}

function markRead(user, payload) {
  if (payload.groupId) {
    const group = requireGroup(user.id, payload.groupId);
    const { id } = gq.maxId.get(group.id);
    gq.markRead.run(group.id, user.id, id);
    return { changed: 1, upTo: id };
  }

  const peer = Number(payload.userId);
  if (!Number.isInteger(peer) || peer <= 0) throw new HttpError(400, 'Не указан собеседник');
  const at = now();
  const { changes } = q.markRead.run(at, peer, user.id);
  if (changes > 0) {
    const { id } = q.maxFromPair.get(peer, user.id);
    broadcastTo(peer, 'read', { by: user.id, upTo: id, at });
  }
  return { changed: changes, upTo: q.maxFromPair.get(peer, user.id).id };
}

/* ─────────────────────── статика ─────────────────────── */

/**
 * Проксирует запрос фото-сервису. Нужен, чтобы фото и чат жили на одном адресе:
 * иначе через туннель/HTTPS браузер блокирует картинки с другого порта.
 */
function proxyMedia(req, res) {
  const upstream = http.request(
    {
      host: MEDIA_HOST,
      port: MEDIA_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${MEDIA_HOST}:${MEDIA_PORT}` },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    console.error('[фото-прокси]', err.message);
    if (!res.headersSent) sendJson(res, 502, { error: 'Фото-сервер недоступен' });
    else res.end();
  });

  req.pipe(upstream);
}


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не найдено');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/* ─────────────────────── сервер ─────────────────────── */

/** WebSocket-канал: тот же токен, что и у остального API. */
function handleUpgrade(req, socket) {
  const url = new URL(req.url, 'http://localhost');
  const key = req.headers['sec-websocket-key'];

  if (url.pathname !== '/api/ws' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token') || '';
  const row = token ? q.session.get(token) : null;
  if (!row) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${wsAccept(key)}`,
      '',
      '',
    ].join('\r\n'),
  );
  socket.setNoDelay(true);

  const user = publicUser(row);
  const wasOnline = onlineIds().includes(user.id);
  wsRegister(user.id, socket);
  touchPresence(user.id);
  wsSend(user.id, 'ready', { me: user, online: onlineIds() });
  if (!wasOnline) broadcastAll('presence', { userId: user.id, online: true });

  // чтобы прокси не рвал простаивающее соединение
  const ping = setInterval(() => {
    try {
      socket.write(wsFrame(0x9, Buffer.alloc(0)));
    } catch {
      /* закрывается */
    }
  }, 30000);

  socket.on(
    'data',
    wsOnData(socket, (text) => {
      try {
        const msg = JSON.parse(text);
        if (msg && msg.type === 'ping') wsSend(user.id, 'pong', { at: Date.now() });
      } catch {
        /* мусор игнорируем */
      }
    }),
  );

  const cleanup = () => {    clearInterval(ping);
    const last = wsUnregister(user.id, socket);
    if (last && !streams.has(user.id)) {
      presence.delete(user.id);
      broadcastAll('presence', { userId: user.id, online: false });
    }
  };

  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    /* интерфейс может жить на другом домене (GitHub Pages) — разрешаем кросс-доменные запросы */
    if (req.headers.origin) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, PATCH, OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    /* фото-сервис живёт на том же адресе, что и чат: так работает и через туннель */
    if (pathname.startsWith('/f/') || pathname.startsWith('/api/media')) {
      return proxyMedia(req, res);
    }

    if (pathname.startsWith('/api/')) {
      /* ── поток событий ── */
      if (pathname === '/api/events' && req.method === 'GET') {
        const { user } = requireUser(req, url);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        // Cloudflare и другие прокси копят ответ, пока буфер мал: отдаём «пустой» блок,
        // чтобы браузер сразу получил поток. Клиент эти строки-комментарии игнорирует.
        res.write(`: ${'·'.repeat(2048)}\n\n`);
        const fresh = !streams.has(user.id);
        setOnline(user.id, res);
        touchPresence(user.id);
        sseSend(res, 'ready', { me: user, online: onlineIds() });
        if (fresh) broadcastAll('presence', { userId: user.id, online: true });

        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n');
          } catch {
            /* ignore */
          }
        }, 10000);

        req.on('close', () => {
          clearInterval(ping);
          const wasLast = setOffline(user.id, res);
          if (wasLast) {
            presence.delete(user.id);
            broadcastAll('presence', { userId: user.id, online: false });
          }
        });
        return;
      }

      /* ── авторизация ── */
      if (pathname === '/api/auth/register' && req.method === 'POST') {
        return sendJson(res, 201, register(await readJson(req)));
      }
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        return sendJson(res, 200, login(await readJson(req)));
      }
      if (pathname === '/api/auth/logout' && req.method === 'POST') {
        const { token } = requireUser(req, url);
        q.deleteSession.run(token);
        return sendJson(res, 200, { ok: true });
      }
      if (pathname === '/api/me' && req.method === 'GET') {
        const { user } = requireUser(req, url);
        return sendJson(res, 200, { user, online: onlineIds() });
      }
      if (pathname === '/api/me' && req.method === 'PATCH') {
        const { user } = requireUser(req, url);
        return sendJson(res, 200, { user: setAvatar(user, await readJson(req)) });
      }

      /* ── чаты ── */
      if (pathname === '/api/users' && req.method === 'GET') {
        const { user } = requireUser(req, url);
        return sendJson(res, 200, {
          users: contacts(user.id),
          groups: myGroups(user.id),
          online: onlineIds(),
        });
      }
      if (pathname === '/api/messages' && req.method === 'GET') {
        const { user } = requireUser(req, url);
        const before = Number(url.searchParams.get('before')) || 0;
        const limit = Number(url.searchParams.get('limit')) || 40;

        const groupId = Number(url.searchParams.get('groupId'));
        if (Number.isInteger(groupId) && groupId > 0) {
          return sendJson(res, 200, groupHistory(user.id, groupId, before, limit));
        }

        const peer = Number(url.searchParams.get('userId'));
        if (!Number.isInteger(peer) || peer <= 0) throw new HttpError(400, 'Нужен userId или groupId');
        return sendJson(res, 200, history(user.id, peer, before, limit));
      }
      if (pathname === '/api/messages' && req.method === 'POST') {
        const { user } = requireUser(req, url);
        return sendJson(res, 201, { message: sendMessage(user, await readJson(req)) });
      }

      /* ── изменить или удалить своё сообщение ── */
      const messageMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
      if (messageMatch) {
        const { user } = requireUser(req, url);
        const id = Number(messageMatch[1]);
        if (req.method === 'PATCH') {
          return sendJson(res, 200, { message: editMessage(user, id, await readJson(req)) });
        }
        if (req.method === 'DELETE') {
          return sendJson(res, 200, deleteMessage(user, id));
        }
      }
      if (pathname === '/api/read' && req.method === 'POST') {
        const { user } = requireUser(req, url);
        return sendJson(res, 200, markRead(user, await readJson(req)));
      }
      if (pathname === '/api/typing' && req.method === 'POST') {
        const { user } = requireUser(req, url);
        const payload = await readJson(req);
        const to = Number(payload.to);
        const group = Number(payload.group);
        const at = now();

        if (Number.isInteger(group) && group > 0 && gq.isMember.get(group, user.id)) {
          broadcastGroup(group, 'typing', { from: user.id, name: user.name, group, at });
        } else if (Number.isInteger(to) && to > 0) {
          broadcastTo(to, 'typing', { from: user.id, name: user.name, at });
        }
        return sendJson(res, 200, { ok: true });
      }

      /* ── группы ── */
      if (pathname === '/api/groups' && req.method === 'POST') {
        const { user } = requireUser(req, url);
        return sendJson(res, 201, { group: createGroup(user, await readJson(req)) });
      }

      const groupMatch = pathname.match(/^\/api\/groups\/(\d+)(\/members|\/leave)?$/);
      if (groupMatch) {
        const { user } = requireUser(req, url);
        const groupId = Number(groupMatch[1]);
        const action = groupMatch[2] || '';

        if (action === '' && req.method === 'GET') {
          return sendJson(res, 200, { group: requireGroup(user.id, groupId) });
        }
        if (action === '/members' && req.method === 'POST') {
          const group = requireGroup(user.id, groupId);
          return sendJson(res, 200, { group: addGroupMembers(user, group, await readJson(req)) });
        }
        if (action === '/leave' && req.method === 'POST') {
          const group = requireGroup(user.id, groupId);
          return sendJson(res, 200, leaveGroup(user, group));
        }
      }
      if (pathname === '/api/health' && req.method === 'GET') {
        const { users } = db.prepare('SELECT COUNT(*) AS users FROM users').get();
        return sendJson(res, 200, {
          ok: true,
          online: onlineIds().length,
          users,
          uptime: process.uptime(),
        });
      }

      throw new HttpError(404, 'Неизвестный метод API');
    }

    /* настройки клиента: фото идут через этот же сервер (/f/...), поэтому mediaUrl пустой */
    if (pathname === '/config.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      const mediaUrl = process.env.MEDIA_PUBLIC_URL ?? '';
      const body = `window.VOLNA_CONFIG = ${JSON.stringify({
        mediaUrl,
        inviteRequired: Boolean(INVITE_CODE),
      })};\n`;
      res.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }

    /* фото-сервис на том же адресе */
    if (pathname.startsWith('/f/') || pathname.startsWith('/api/media')) {
      return proxyMedia(req, res);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'Только GET');
    }
    serveStatic(res, pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error('[волна]', err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Ошибка сервера' });
    else res.end();
  }
});

/* ─────────────────────── фото-сервер рядом ─────────────────────── */

let mediaChild = null;

if (process.env.MEDIA_EXTERNAL !== '1') {
  mediaChild = spawn(process.execPath, [path.join(ROOT, 'media.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, MEDIA_PORT: String(MEDIA_PORT) },
  });
  mediaChild.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') console.error(`  фото-сервер остановился (code ${code})`);
    mediaChild = null;
  });
}

function shutdown() {
  // переносим WAL в основной файл, чтобы копия базы была целой даже без бэкапа
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* уже закрыта */
  }
  mediaChild?.kill();
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => mediaChild?.kill());

server.on('upgrade', handleUpgrade);

server.listen(PORT, HOST, () => {
  const { users } = db.prepare('SELECT COUNT(*) AS users FROM users').get();
  console.log(`\n  Волна запущена → http://${HOST}:${PORT}`);
  console.log(`  Фотографии     → http://${HOST}:${PORT}/f/<id>`);
  console.log(`  Аккаунтов в базе: ${users} (${path.relative(ROOT, path.join(DATA_DIR, 'volna.db'))})`);
  if (lastBackup) console.log(`  Копия базы:      ${lastBackup}\n`);
  else console.log('');
});
