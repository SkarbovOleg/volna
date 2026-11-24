/**
 * Собирает статическую версию интерфейса для GitHub Pages в папку docs/.
 * Pages умеет отдавать только файлы, поэтому там лежит клиент, который
 * подключается к твоему серверу (адрес спрашивается один раз).
 *
 *   node tools/make-pages.mjs
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC = path.join(ROOT, 'public');
const DOCS = path.join(ROOT, 'docs');

rmSync(DOCS, { recursive: true, force: true });
mkdirSync(DOCS, { recursive: true });

// пути в интерфейсе относительные (./style.css) — на Pages сайт живёт в подпапке /volna/
const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace(/(href|src)="\//g, '$1="./')
  .replace('<title>Волна</title>', '<title>Волна — мессенджер</title>');

writeFileSync(path.join(DOCS, 'index.html'), html, 'utf8');
writeFileSync(
  path.join(DOCS, 'config.js'),
  '// версия для GitHub Pages: адрес сервера спрашивается при первом открытии\n' +
    'window.VOLNA_CONFIG = { pages: true, mediaUrl: "", inviteRequired: false };\n',
  'utf8',
);
// без .nojekyll Pages прогоняет файлы через Jekyll
writeFileSync(path.join(DOCS, '.nojekyll'), '', 'utf8');

for (const file of ['app.js', 'style.css', 'icon.svg', 'manifest.webmanifest', 'sw.js']) {
  copyFileSync(path.join(PUBLIC, file), path.join(DOCS, file));
}
cpSync(path.join(PUBLIC, 'icons'), path.join(DOCS, 'icons'), { recursive: true });
cpSync(path.join(PUBLIC, 'stickers'), path.join(DOCS, 'stickers'), { recursive: true });

// адрес живого сервера: его обновляет online.cmd, страница читает при загрузке
const serverJson = path.join(ROOT, 'server.json');
if (existsSync(serverJson)) {
  copyFileSync(serverJson, path.join(DOCS, 'server.json'));
} else {
  writeFileSync(path.join(DOCS, 'server.json'), '{"api":""}\n', 'utf8');
}

console.log('docs/ собрана:');
for (const file of ['index.html', 'config.js', 'app.js', 'style.css', 'icon.svg', 'manifest.webmanifest', 'sw.js', 'icons/', 'stickers/', 'server.json']) {
  console.log('  ' + file);
}
