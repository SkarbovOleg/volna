/**
 * Проверка сохранности аккаунтов: регистрация → жёсткая остановка сервера →
 * запуск заново → вход тем же паролем → сверка профиля, аватара и переписки.
 *
 *   node tools/persistence-test.mjs [путь-к-server.js]
 *
 * Скрипт сам поднимает и гасит сервер на свободном порту, базу не трогает
 * (работает с копией data/ во временной папке).
 */
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8899);
const BASE = `http://127.0.0.1:${PORT}`;
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms));

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'volna-persist-'));
cpSync(ROOT, sandbox, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src);
    if (!rel) return true;
    const top = rel.split(path.sep)[0];
    return top !== 'data' && top !== '.git';
  },
});

let proc = null;
let passed = 0;
let failed = 0;

function check(name, ok, extra = '') {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function startServer() {
  proc = spawn(process.execPath, [path.join(sandbox, 'server.js')], {
    cwd: sandbox,
    env: { ...process.env, PORT: String(PORT), MEDIA_PORT: String(PORT + 1) },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* ещё поднимается */
    }
    await WAIT(200);
  }
  throw new Error('сервер не поднялся');
}

async function stopServer(hard) {
  if (!proc) return;
  if (hard) {
    // имитируем аварийное завершение: SIGKILL всему дереву, без чекпоинта и закрытия базы
    const args = process.platform === 'win32'
      ? ['/PID', String(proc.pid), '/T', '/F']
      : ['-9', String(proc.pid)];
    execFileSync(process.platform === 'win32' ? 'taskkill' : 'kill', args, { stdio: 'ignore' });
  } else {
    proc.kill('SIGTERM');
  }
  await WAIT(900);
  proc = null;
}

async function api(p, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

console.log('\nВолна · сохранность аккаунтов\n');

try {
  await startServer();

  const name = `друг${String(Date.now()).slice(-5)}`;
  const reg = await api('/api/auth/register', { method: 'POST', body: { name, password: 'parol-123' } });
  check('аккаунт зарегистрирован', reg.status === 201 && !!reg.data.token, `(${reg.status})`);
  const token = reg.data.token;
  const me = reg.data.user;
  check('имя вернулось без искажений', me.name === name, `(${me.name})`);

  const peer = (await api('/api/users', { token })).data.users[0];
  const upload = await fetch(`${BASE}/api/media`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'image/png',
      'x-image-width': '1',
      'x-image-height': '1',
    },
    body: PNG,
  });
  const media = await upload.json();
  check('фото загружено', upload.status === 201 && !!media.id);

  const avatar = await api('/api/me', { method: 'PATCH', token, body: { avatarMediaId: media.id } });
  check('аватар привязан', avatar.status === 200 && avatar.data.user.avatarId === media.id);

  const msg = await api('/api/messages', {
    method: 'POST',
    token,
    body: { to: peer.id, body: 'это сообщение должно пережить перезапуск' },
  });
  check('сообщение отправлено', msg.status === 201);

  // аварийная остановка: как будто выдернули питание
  await stopServer(true);
  const dbAfterKill = existsSync(path.join(sandbox, 'data', 'volna.db'));
  check('файл базы на месте после жёсткой остановки', dbAfterKill);

  await startServer();

  const login = await api('/api/auth/login', { method: 'POST', body: { name, password: 'parol-123' } });
  check('вход тем же паролем после перезапуска', login.status === 200 && !!login.data.token, `(${login.status})`);

  const token2 = login.data.token;
  const meAfter = await api('/api/me', { token: token2 });
  check('профиль сохранился, аватар на месте', meAfter.data.user.avatarId === media.id);
  check('старая сессия тоже жива', (await api('/api/me', { token })).status === 200);

  const hist = await api(`/api/messages?userId=${peer.id}`, { token: token2 });
  const found = hist.data.messages.find((m) => m.body === 'это сообщение должно пережить перезапуск');
  check('переписка сохранилась', !!found);

  const photo = await fetch(`${BASE}/f/${media.id}`);
  check('файл фото отдаётся после перезапуска', photo.status === 200 && photo.headers.get('content-type') === 'image/png');

  const dup = await api('/api/auth/register', { method: 'POST', body: { name, password: 'parol-123' } });
  check('повторная регистрация того же имени → 409', dup.status === 409, `(${dup.status})`);

  const wrong = await api('/api/auth/login', { method: 'POST', body: { name, password: 'неверный' } });
  check('чужой пароль не пускает', wrong.status === 401);

  // штатная остановка и снова старт — для проверки чекпоинта
  await stopServer(false);
  await startServer();
  const login3 = await api('/api/auth/login', { method: 'POST', body: { name, password: 'parol-123' } });
  check('аккаунт жив после штатного перезапуска', login3.status === 200);

  const backups = existsSync(path.join(sandbox, 'backups'))
    ? execFileSync(process.platform === 'win32' ? 'cmd' : 'ls', process.platform === 'win32' ? ['/c', 'dir', '/b', path.join(sandbox, 'backups')] : [path.join(sandbox, 'backups')])
        .toString()
        .split(/\r?\n/)
        .filter(Boolean)
    : [];
  check('автобэкап базы создаётся', backups.length >= 1, `(${backups.length})`);
} catch (err) {
  failed += 1;
  console.log('  FAIL исключение:', err.message);
} finally {
  await stopServer(false);
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* временную папку уберёт система */
  }
}

console.log(`\n  итого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
