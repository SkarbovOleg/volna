/**
 * Служебный скриншотер для проверки интерфейса без глаз:
 * запускает Chrome/Edge в headless-режиме по CDP, открывает страницу,
 * при необходимости кликает по чату и сохраняет PNG.
 *
 *   node tools/shot.mjs <url> <out.png> [--click=.chat-item] [--size=1440x900]
 *
 * Нужен установленный Edge или Chrome (ищется автоматически).
 */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync } from 'node:fs';

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const args = process.argv.slice(2);
const url = args[0] || 'http://127.0.0.1:8787/';
const out = args[1] || 'shot.png';
const clickArg = args.find((a) => a.startsWith('--click='));
const evalArg = args.find((a) => a.startsWith('--eval='));
const evalFileArg = args.find((a) => a.startsWith('--eval-file='));
const fileArg = args.find((a) => a.startsWith('--file='));
const sizeArg = args.find((a) => a.startsWith('--size='));
const [width, height] = (sizeArg ? sizeArg.split('=')[1] : '1440x900').split('x').map(Number);

const browserPath = CANDIDATES.find((p) => existsSync(p));
if (!browserPath) {
  console.error('Не найден Chrome/Edge.');
  process.exit(1);
}

const port = 9333;
const profile = mkdtempSync(path.join(os.tmpdir(), 'volna-cdp-'));
const child = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function endpoint() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* ещё не поднялся */
    }
    await wait(250);
  }
  throw new Error('CDP не отвечает');
}

async function main() {
  const browserWs = await endpoint();

  // создаём вкладку
  const tab = await (
    await fetch(`http://127.0.0.1:${port}/json/new?url=about:blank`, { method: 'PUT' })
  ).json();

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      seq += 1;
      pending.set(seq, { resolve, reject });
      ws.send(JSON.stringify({ id: seq, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await send('Page.navigate', { url });
  await wait(3500);

  if (clickArg) {
    const selector = clickArg.slice('--click='.length);
    await send('Runtime.evaluate', {
      expression: `(function(){const el=document.querySelector(${JSON.stringify(selector)}); if(el){el.click(); return 'clicked';} return 'not found';})()`,
      returnByValue: true,
    });
    await wait(1500);
  }

  if (fileArg) {
    const [selector, filePath] = fileArg.slice('--file='.length).split('|');
    const { root } = await send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) console.error('�� ������ input:', selector);
    else {
      await send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(filePath)] });
      console.log('���� ������:', filePath);
    }
    await wait(1500);
  }

  const code = evalFileArg
    ? readFileSync(evalFileArg.slice('--eval-file='.length), 'utf8')
    : evalArg
      ? evalArg.slice('--eval='.length)
      : '';
  if (code) {
    const result = await send('Runtime.evaluate', {
      expression: code,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) console.error('eval:', result.exceptionDetails.text);
    else console.log('eval →', JSON.stringify(result.result?.value));
    await wait(1200);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('saved', out, `(${width}x${height})`);

  ws.close();
  void browserWs;
}

main()
  .catch((err) => {
    console.error('Ошибка:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await wait(200);
    child.kill();
  });
