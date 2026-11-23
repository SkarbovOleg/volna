/**
 * Проверка интерфейса в настоящем браузере: вход, выбор фото, отправка, доставка.
 * Ловит поломки, которые не видит API-тест (например, «Фото-сервер не настроен»).
 *
 *   node tools/ui-test.mjs
 *
 * Поднимает копию сервера на свободном порту (рабочие данные не трогает)
 * и управляет headless Chrome/Edge через CDP.
 */
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;
const CDP_PORT = PORT + 10;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

let passed = 0;
let failed = 0;
const check = (name, ok, extra = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

const sandbox = mkdtempSync(path.join(os.tmpdir(), 'volna-ui-'));
cpSync(ROOT, sandbox, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(ROOT, src);
    if (!rel) return true;
    const top = rel.split(path.sep)[0];
    return top !== 'data' && top !== '.git' && top !== 'backups' && top !== 'tools';
  },
});

let server = null;
let browser = null;
let ws = null;

async function startServer() {
  server = spawn(process.execPath, [path.join(sandbox, 'server.js')], {
    cwd: sandbox,
    env: { ...process.env, PORT: String(PORT), MEDIA_PORT: String(PORT + 1), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch {
      /* поднимается */
    }
    await wait(200);
  }
  throw new Error('сервер не поднялся');
}

async function startBrowser() {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error('не найден Chrome/Edge');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'volna-ui-prof-'));
  browser = spawn(
    exe,
    ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: 'ignore' },
  );

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* ещё не поднялся */
    }
    if (!wsUrl) await wait(250);
  }
  if (!wsUrl) throw new Error('CDP не отвечает');

  const tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?url=about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const job = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) job.reject(new Error(msg.error.message));
      else job.resolve(msg.result);
    }
  });
  send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      seq += 1;
      pending.set(seq, { resolve, reject });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
}

let send = null;

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.text || 'ошибка в браузере');
  return res.result && res.result.value;
}

/** Регистрирует аккаунт через API: демо-пользователей в базе больше нет. */
async function register(name, password = 'test-1234') {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`регистрация ${name}: ${data.error}`);
  return data;
}

console.log('\nВолна · проверка интерфейса\n');

try {
  await startServer();

  // два аккаунта и одно сообщение, чтобы в интерфейсе был открытый чат
  const suffix = String(Date.now()).slice(-5);
  const alice = await register(`тест${suffix}`);
  const bob = await register(`друг${suffix}`);
  await fetch(`${BASE}/api/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
    body: JSON.stringify({ to: alice.user.id, body: 'привет от друга' }),
  });

  await startBrowser();
  await send('Page.navigate', { url: `${BASE}/` });
  await wait(2500);

  await evaluate(`
    (function () {
      const name = document.querySelector('#auth-name');
      const pass = document.querySelector('#auth-pass');
      name.value = ${JSON.stringify(`тест${suffix}`)};
      pass.value = 'test-1234';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      pass.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#auth-submit').click();
      return 'ok';
    })()
  `);
  await wait(3500);

  const logged = await evaluate('!!document.querySelector("#conversation:not([hidden])") && document.querySelector("#me-name").textContent');
  check('вход в аккаунт и открытый чат', Boolean(logged), String(logged));

  // выбираем файл в настоящем <input type=file>
  const file = path.join(ROOT, 'assets', 'demo-photo.jpg');
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#attach-input' });
  await send('DOM.setFileInputFiles', { nodeId, files: [file] });
  await wait(1800);

  const preview = await evaluate('!document.querySelector("#attach-preview").hidden');
  check('превью выбранного фото появилось', preview === true);

  await evaluate('document.querySelector("#input").value = "фото из теста"; document.querySelector("#send").click(); "ok"');
  await wait(3000);

  const result = await evaluate(`JSON.stringify({
    bubbles: document.querySelectorAll('.bubble.is-photo').length,
    hasError: document.body.innerText.includes('не настроен'),
    banner: document.querySelector('#conn-banner').hidden,
    caption: [...document.querySelectorAll('.bubble .text')].some(el => el.textContent.includes('фото из теста')),
    imgLoaded: [...document.querySelectorAll('.photo')].every(img => img.complete && img.naturalWidth > 0)
  })`);
  const state = JSON.parse(result);
  check('сообщение с фото появилось', state.bubbles >= 1, JSON.stringify(state));
  check('подпись к фото на месте', state.caption === true);
  check('картинка реально загрузилась', state.imgLoaded === true);
  check('нет ошибки «фото-сервер не настроен»', state.hasError === false);
  check('баннер переподключения скрыт', state.banner === true);

  const health = await (await fetch(`${BASE}/api/health`)).json();
  check('на сервере есть аккаунты', health.users >= 2, String(health.users));
} catch (err) {
  failed += 1;
  console.log('  FAIL исключение:', err.message);
} finally {
  try {
    ws && ws.close();
  } catch {
    /* ignore */
  }
  try {
    browser && browser.kill();
  } catch {
    /* ignore */
  }
  if (server) {
    try {
      execFileSync(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32' ? ['/PID', String(server.pid), '/T', '/F'] : ['-9', String(server.pid)], { stdio: 'ignore' });
    } catch {
      /* уже остановлен */
    }
  }
  await wait(500);
  try {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* временную папку уберёт система */
  }
}

console.log(`\n  итого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
