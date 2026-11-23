/**
 * Дымовой тест: поднимает API на 127.0.0.1:8787 и проверяет основные сценарии.
 *   node tools/smoke.mjs
 * Ожидает уже запущенный сервер (node server.js).
 */
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

let passed = 0;
let failed = 0;

function check(name, condition, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function call(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, data };
}

const suffix = String(Date.now()).slice(-6);
const alice = `alice${suffix}`;
const bob = `bob${suffix}`;

console.log('\nВолна · дымовой тест\n');

// статика
const page = await fetch(BASE + '/');
const html = await page.text();
check('GET / отдаёт страницу', page.status === 200 && html.includes('Волна'));
const css = await fetch(BASE + '/style.css');
check('GET /style.css', css.status === 200);
const traversal = await fetch(BASE + '/../server.js');
check('обход каталога закрыт', traversal.status === 403 || traversal.status === 404, `(${traversal.status})`);

// регистрация и вход
const reg = await call('/api/auth/register', { method: 'POST', body: { name: alice, password: 'qwerty' } });
check('регистрация', reg.status === 201 && !!reg.data.token, `(${reg.status})`);
const aliceToken = reg.data.token;
const aliceId = reg.data.user.id;

const dup = await call('/api/auth/register', { method: 'POST', body: { name: alice.toUpperCase(), password: 'qwerty' } });
check('повтор имени отклонён', dup.status === 409, `(${dup.status})`);

const badLogin = await call('/api/auth/login', { method: 'POST', body: { name: alice, password: 'wrong' } });
check('неверный пароль → 401', badLogin.status === 401, `(${badLogin.status})`);

const noToken = await call('/api/users');
check('без токена → 401', noToken.status === 401, `(${noToken.status})`);

// второй участник
const reg2 = await call('/api/auth/register', { method: 'POST', body: { name: bob, password: 'qwerty' } });
check('регистрация второго', reg2.status === 201);
const bobToken = reg2.data.token;
const bobId = reg2.data.user.id;

// список чатов
const users = await call('/api/users', { token: aliceToken });
check('список контактов', users.status === 200 && users.data.users.length >= 1);
const bobCard = users.data.users.find((u) => u.id === bobId);
check('в списке есть новый собеседник', !!bobCard);
check('у нового чата нет сообщений', bobCard && bobCard.lastBody === null);

// отправка
const sent = await call('/api/messages', { method: 'POST', token: bobToken, body: { to: aliceId, body: 'Привет от боба' } });
check('отправка сообщения', sent.status === 201 && sent.data.message.body === 'Привет от боба', `(${sent.status})`);
const msgId = sent.data.message.id;

const empty = await call('/api/messages', { method: 'POST', token: bobToken, body: { to: aliceId, body: '   ' } });
check('пустое сообщение отклонено', empty.status === 400);

const selfy = await call('/api/messages', { method: 'POST', token: bobToken, body: { to: bobId, body: 'себе' } });
check('письмо себе отклонено', selfy.status === 400);

// история и непрочитанные
const users2 = await call('/api/users', { token: aliceToken });
const bobCard2 = users2.data.users.find((u) => u.id === bobId);
check('непрочитанное = 1', bobCard2 && bobCard2.unread === 1, `(${bobCard2 && bobCard2.unread})`);
check('превью последнего сообщения', bobCard2 && bobCard2.lastBody === 'Привет от боба');
check('lastFrom = боб', bobCard2 && bobCard2.lastFrom === bobId);

const hist = await call(`/api/messages?userId=${bobId}`, { token: aliceToken });
check('история отдаётся', hist.status === 200 && hist.data.messages.length === 1 && hist.data.messages[0].id === msgId);
check('hasMore = false на короткой истории', hist.data.hasMore === false);

// прочтение
const read = await call('/api/read', { method: 'POST', token: aliceToken, body: { userId: bobId } });
check('отметка о прочтении', read.status === 200 && read.data.changed === 1);

const users3 = await call('/api/users', { token: aliceToken });
const bobCard3 = users3.data.users.find((u) => u.id === bobId);
check('непрочитанных не осталось', bobCard3 && bobCard3.unread === 0);

// ответ
await call('/api/messages', { method: 'POST', token: aliceToken, body: { to: bobId, body: 'Привет, боб!' } });
const histBob = await call(`/api/messages?userId=${aliceId}`, { token: bobToken });
check('переписка видна обеим сторонам', histBob.data.messages.length === 2);
check('порядок по возрастанию id', histBob.data.messages[0].id < histBob.data.messages[1].id);

// пагинация
for (let i = 0; i < 5; i += 1) {
  await call('/api/messages', { method: 'POST', token: bobToken, body: { to: aliceId, body: `пачка ${i}` } });
}
const page1 = await call(`/api/messages?userId=${bobId}&limit=3`, { token: aliceToken });
check('лимит соблюдается', page1.data.messages.length === 3);
const page2 = await call(`/api/messages?userId=${bobId}&limit=3&before=${page1.data.messages[0].id}`, { token: aliceToken });
check('пагинация в прошлое', page2.data.messages.length === 3 && page2.data.messages.at(-1).id < page1.data.messages[0].id);

// поток событий
const controller = new AbortController();
const stream = await fetch(`${BASE}/api/events?token=${aliceToken}`, { signal: controller.signal });
check('SSE-поток открыт', stream.status === 200 && stream.headers.get('content-type').includes('text/event-stream'));
const reader = stream.body.getReader();
const firstChunk = new TextDecoder().decode((await reader.read()).value);
check('SSE прислал ready', firstChunk.includes('event: ready') && firstChunk.includes('online'));
controller.abort();

// присутствие в списке
const onlineUsers = await call('/api/users', { token: bobToken });
const health = await call('/api/health');
check('health отвечает', health.status === 200 && health.data.ok === true);
void onlineUsers;

/* ─────────────── фото-сервер ─────────────── */

const config = await (await fetch(`${BASE}/config.js`)).text();
// пустой mediaUrl = фото идут через тот же адрес, что и чат (прокси)
const mediaUrl = (config.match(/"mediaUrl":"([^"]*)"/) || [])[1] ?? '';
const mediaBase = mediaUrl || BASE;
check('config.js отдаёт настройки', config.includes('inviteRequired'), config.trim());

// сам фото-сервис слушает отдельный порт; наружу его отдаёт прокси на mediaBase
const mediaHealth = await fetch(`${process.env.MEDIA_DIRECT || 'http://127.0.0.1:8788'}/health`).then((r) => r.json());
check('фото-сервис жив', mediaHealth.ok === true && mediaHealth.service === 'media');

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function uploadMedia(token, bytes, headers = {}) {
  const res = await fetch(`${mediaBase}/api/media`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'image/png',
      'x-image-width': '1',
      'x-image-height': '1',
      ...headers,
    },
    body: bytes,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const noAuthUpload = await uploadMedia(null, PNG_1X1);
check('загрузка без токена → 401', noAuthUpload.status === 401, `(${noAuthUpload.status})`);

const junk = await uploadMedia(aliceToken, Buffer.from('это не картинка, а текст'));
check('не-картинка отклонена → 415', junk.status === 415, `(${junk.status})`);

const uploaded = await uploadMedia(bobToken, PNG_1X1);
check('картинка загружена', uploaded.status === 201 && !!uploaded.data.id, `(${uploaded.status})`);
check('тип определён по содержимому', uploaded.data.mime === 'image/png');
const mediaId = uploaded.data.id;

const fetched = await fetch(`${mediaBase}/f/${mediaId}`);
const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
check('файл отдаётся обратно', fetched.status === 200 && fetchedBytes.equals(PNG_1X1));
check('обещан immutable-кэш', (fetched.headers.get('cache-control') || '').includes('immutable'));

const missingFile = await fetch(`${mediaBase}/f/AAAAAAAAAAAAAAAA`);
check('несуществующий файл → 404', missingFile.status === 404, `(${missingFile.status})`);

// фото-сообщение
const photoMsg = await call('/api/messages', {
  method: 'POST',
  token: bobToken,
  body: { to: aliceId, body: 'Смотри, какой пиксель', mediaId },
});
check('фото уходит сообщением', photoMsg.status === 201 && photoMsg.data.message.kind === 'photo');
check('в сообщении есть ссылка на файл', photoMsg.data.message.mediaId === mediaId);
check('размеры фото доехали до клиента', photoMsg.data.message.media && photoMsg.data.message.media.width === 1);

const histPhoto = await call(`/api/messages?userId=${bobId}&limit=5`, { token: aliceToken });
const photoInHistory = histPhoto.data.messages.find((m) => m.id === photoMsg.data.message.id);
check('фото в истории', !!photoInHistory && photoInHistory.kind === 'photo');

const foreignMedia = await call('/api/messages', {
  method: 'POST',
  token: aliceToken,
  body: { to: bobId, body: 'чужое фото', mediaId },
});
check('чужое фото отправить нельзя → 403', foreignMedia.status === 403, `(${foreignMedia.status})`);

const emptyPhoto = await call('/api/messages', {
  method: 'POST',
  token: aliceToken,
  body: { to: bobId, body: '   ' },
});
check('пустое сообщение без фото отклонено', emptyPhoto.status === 400);

// аватар
const avatar = await call('/api/me', { method: 'PATCH', token: bobToken, body: { avatarMediaId: mediaId } });
check('аватар сохранён', avatar.status === 200 && avatar.data.user.avatarId === mediaId);

const usersAfterAvatar = await call('/api/users', { token: aliceToken });
const bobCard4 = usersAfterAvatar.data.users.find((u) => u.id === bobId);
check('аватар виден собеседнику', bobCard4 && bobCard4.avatarId === mediaId);

const usersPreview = usersAfterAvatar.data.users.find((u) => u.id === bobId);
check('в превью чата отмечено фото', usersPreview.lastKind === 'photo', `(${usersPreview.lastKind})`);

console.log(`\n  итого: ${passed} ok, ${failed} fail\n`);
process.exit(failed ? 1 : 0);
