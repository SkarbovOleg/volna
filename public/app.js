/* Волна — клиент. Без фреймворков: состояние + DOM. */

const $ = (sel) => document.querySelector(sel);

const MEDIA_URL = ((window.VOLNA_CONFIG && window.VOLNA_CONFIG.mediaUrl) || '').replace(/\/+$/, '');
const mediaSrc = (id) => (id ? `${MEDIA_URL}/f/${encodeURIComponent(id)}` : '');
const INVITE_REQUIRED = Boolean(window.VOLNA_CONFIG && window.VOLNA_CONFIG.inviteRequired);

const state = {
  token: localStorage.getItem('volna.token') || '',
  me: null,
  users: [],
  activeId: null,
  online: new Set(),
  threads: new Map(), // peerId → { messages: [], hasMore: false }
  filter: '',
  es: null,
  typingUntil: 0,
  typingSentAt: 0,
  typingTimer: null,
  streamErrors: 0,
  audio: null,
  pending: null, // фото, готовое к отправке
  authAvatar: null, // фото, выбранное при регистрации
  lastEventAt: Date.now(), // когда последний раз что-то пришло по SSE
  polling: false, // SSE молчит (прокси/туннель) → добираем опросом
};

/* ───────────────────────── сеть ───────────────────────── */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* пустой ответ */
  }
  if (!res.ok) {
    const message = (data && data.error) || `Ошибка ${res.status}`;
    if (res.status === 401 && state.me) signOut(false);
    throw new ApiError(res.status, message);
  }
  return data;
}

/* ───────────────────────── мелочи ───────────────────────── */

const initials = (name) => (name || '?').trim().charAt(0).toUpperCase();

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (dayKey(ts) === dayKey(today)) return 'Сегодня';
  if (dayKey(ts) === dayKey(yesterday)) return 'Вчера';
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

function shortTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  if (dayKey(ts) === dayKey(today)) return timeOf(ts);
  if (dayKey(ts) === dayKey(new Date(Date.now() - 86400000))) return 'вчера';
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function paintAvatar(el, user) {
  el.replaceChildren();
  el.style.setProperty('--hue', String(user.hue ?? 232));
  if (user.avatarId) {
    const img = document.createElement('img');
    img.src = mediaSrc(user.avatarId);
    img.alt = '';
    img.loading = 'lazy';
    el.append(img);
  } else {
    el.textContent = initials(user.name);
  }
}

function makeAvatar(user, extraClass = '') {
  const el = document.createElement('div');
  el.className = `avatar ${extraClass}`.trim();
  paintAvatar(el, user);
  return el;
}

function banner(show, text) {
  const el = $('#conn-banner');
  if (text) el.textContent = text;
  el.hidden = !show;
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    state.audio ||= new Ctx();
    const ctx = state.audio;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.09, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    gain.connect(ctx.destination);
    for (const [freq, delay] of [[784, 0], [1175, 0.075]]) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t + delay);
      osc.connect(gain);
      osc.start(t + delay);
      osc.stop(t + delay + 0.2);
    }
  } catch {
    /* звук не критичен */
  }
}

/* ───────────────────────── фото ───────────────────────── */

const MAX_SIDE = 1600;
const MAX_PICK_BYTES = 12 * 1024 * 1024;

/** Приводит выбранный файл к разумному размеру: не больше 1600 px по длинной стороне. */
async function prepareImage(file) {
  if (!file || !/^image\//.test(file.type)) throw new Error('Это не изображение');
  if (file.size > MAX_PICK_BYTES) throw new Error('Файл больше 12 МБ');
  if (file.type === 'image/gif') return { blob: file, width: 0, height: 0 };

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
  if (!blob) throw new Error('Не удалось обработать фото');
  return { blob, width, height };
}

async function uploadImage(prepared) {
  if (!MEDIA_URL) throw new Error('Фото-сервер не настроен');
  const res = await fetch(`${MEDIA_URL}/api/media`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${state.token}`,
      'content-type': prepared.blob.type || 'image/jpeg',
      'x-image-width': String(prepared.width || 0),
      'x-image-height': String(prepared.height || 0),
    },
    body: prepared.blob,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Фото не загрузилось');
  return data;
}

function clearAttachment() {
  if (state.pending && state.pending.preview) URL.revokeObjectURL(state.pending.preview);
  state.pending = null;
  $('#attach-preview').hidden = true;
  $('#attach-img').removeAttribute('src');
  $('#attach-state').textContent = '';
  updateSendState();
}

function setAttachment(prepared) {
  if (state.pending && state.pending.preview) URL.revokeObjectURL(state.pending.preview);
  prepared.preview = URL.createObjectURL(prepared.blob);
  state.pending = prepared;
  $('#attach-img').src = prepared.preview;
  $('#attach-name').textContent = prepared.width
    ? `Фото ${prepared.width}×${prepared.height}`
    : 'GIF-анимация';
  $('#attach-preview').hidden = false;
  updateSendState();
}

$('#attach').addEventListener('click', () => $('#attach-input').click());

$('#attach-input').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    setAttachment(await prepareImage(file));
  } catch (err) {
    showToast(err.message);
  }
});

$('#attach-remove').addEventListener('click', clearAttachment);

/* ───────────────────────── лайтбокс ───────────────────────── */

function openLightbox(src) {
  $('#lightbox-img').src = src;
  $('#lightbox').hidden = false;
}

function closeLightbox() {
  $('#lightbox').hidden = true;
  $('#lightbox-img').removeAttribute('src');
}

$('#lightbox').addEventListener('click', closeLightbox);
$('#lightbox-close').addEventListener('click', (event) => {
  event.stopPropagation();
  closeLightbox();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#lightbox').hidden) closeLightbox();
});

/* ───────────────────────── своё фото ───────────────────────── */

$('#me-avatar').addEventListener('click', () => $('#me-avatar-input').click());

$('#me-avatar-input').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const prepared = await prepareImage(file);
    const media = await uploadImage(prepared);
    const data = await api('/api/me', { method: 'PATCH', body: { avatarMediaId: media.id } });
    state.me = { ...state.me, ...data.user };
    paintAvatar($('#me-avatar'), state.me);
    showToast('Фото профиля обновлено');
  } catch (err) {
    showToast(err.message);
  }
});

/* ───────────────────────── авторизация ───────────────────────── */

let authMode = 'login';

function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.mode === mode);
  });
  $('#auth-submit').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('#auth-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-avatar-row').hidden = mode !== 'register';
  $('#invite-field').hidden = !(mode === 'register' && INVITE_REQUIRED);
  $('#confirm-field').hidden = mode !== 'register';
  if (mode !== 'register') clearAuthAvatar();
  $('#auth-error').hidden = true;
}

function clearAuthAvatar() {
  state.authAvatar = null;
  const img = $('#auth-avatar-img');
  img.hidden = true;
  img.removeAttribute('src');
  $('#auth-avatar-letter').hidden = false;
  $('#auth-avatar-letter').textContent = '+';
  $('#auth-avatar-btn').style.removeProperty('--hue');
  $('#auth-avatar-btn').style.background = '';
}

$('#auth-avatar-btn').addEventListener('click', () => $('#auth-avatar-input').click());

$('#auth-avatar-input').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    const prepared = await prepareImage(file);
    state.authAvatar = prepared;
    const img = $('#auth-avatar-img');
    img.src = URL.createObjectURL(prepared.blob);
    img.hidden = false;
    $('#auth-avatar-letter').hidden = true;
    $('#auth-avatar-btn').style.background = 'transparent';
  } catch (err) {
    showAuthError(err.message);
  }
});

function showAuthError(text) {
  const box = $('#auth-error');
  box.textContent = text;
  box.hidden = !text;
}

async function doAuth(name, password) {
  const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
  const body = { name, password };
  if (authMode === 'register' && INVITE_REQUIRED) body.invite = $('#auth-invite').value.trim();
  const data = await api(path, { method: 'POST', body });
  state.token = data.token;
  localStorage.setItem('volna.token', data.token);

  if (state.authAvatar) {
    try {
      const media = await uploadImage(state.authAvatar);
      await api('/api/me', { method: 'PATCH', body: { avatarMediaId: media.id } });
    } catch (err) {
      console.warn('фото профиля не загрузилось:', err.message);
    }
    clearAuthAvatar();
  }

  await enterChat();
}

$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#auth-name').value.trim();
  const password = $('#auth-pass').value;

  if (authMode === 'register' && password !== $('#auth-pass2').value) {
    showAuthError('Пароли не совпадают');
    return;
  }

  const btn = $('#auth-submit');
  btn.disabled = true;
  showAuthError('');
  try {
    await doAuth(name, password);
    $('#auth-pass').value = '';
    $('#auth-pass2').value = '';
  } catch (err) {
    if (err.status === 409) {
      // имя занято — значит аккаунт уже есть: отправляем входить, пароль не стираем
      setAuthMode('login');
      showAuthError('Такое имя уже занято — похоже, ты уже регистрировался. Нажми «Войти».');
    } else {
      showAuthError(err.message);
    }
  } finally {
    btn.disabled = false;
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => setAuthMode(tab.dataset.mode));
});

/* ───────────────────────── вход в чат ───────────────────────── */

async function enterChat() {
  const data = await api('/api/me');
  state.me = data.user;
  state.online = new Set(data.online || []);

  $('#auth-view').hidden = true;
  $('#chat-view').hidden = false;
  document.body.classList.remove('mobile-chat');

  paintAvatar($('#me-avatar'), state.me);
  $('#me-name').textContent = state.me.name;

  await loadUsers();
  connectStream();

  const desktop = window.matchMedia('(min-width: 881px)').matches;
  if (desktop && !state.activeId && state.users.length) openChat(state.users[0].id);
}

function signOut(notifyServer = true) {
  if (notifyServer && state.token) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  state.es?.close();
  state.es = null;
  state.token = '';
  state.me = null;
  state.users = [];
  state.activeId = null;
  state.threads.clear();
  state.online.clear();
  localStorage.removeItem('volna.token');
  $('#chat-view').hidden = true;
  $('#auth-view').hidden = false;
  document.body.classList.remove('mobile-chat');
  document.title = 'Волна';
  banner(false);
  $('#user-list').replaceChildren();
  setAuthMode('login');
}

$('#logout').addEventListener('click', () => signOut());

/* ───────────────────────── события сервера ───────────────────────── */

function connectStream() {
  state.es?.close();
  const es = new EventSource(`/api/events?token=${encodeURIComponent(state.token)}`);
  state.es = es;

  // любой пришедший пакет — признак, что поток жив
  for (const name of ['ready', 'message', 'typing', 'read', 'presence', 'profile']) {
    es.addEventListener(name, markStreamAlive);
  }

  es.addEventListener('ready', (event) => {
    const data = JSON.parse(event.data);
    if (data.me) state.me = { ...state.me, ...data.me };
    state.online = new Set(data.online || []);
    banner(false);
    renderOnline();
    renderList();
  });

  es.addEventListener('message', (event) => onIncoming(JSON.parse(event.data)));

  es.addEventListener('typing', (event) => {
    const data = JSON.parse(event.data);
    if (data.from !== state.activeId) return;
    state.typingUntil = Date.now() + 3200;
    $('#typing-text').textContent = `${data.name} печатает…`;
    $('#typing').hidden = false;
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      $('#typing').hidden = true;
    }, 3200);
  });

  es.addEventListener('read', (event) => {
    const data = JSON.parse(event.data);
    if (data.by !== state.activeId) return;
    const thread = state.threads.get(data.by);
    if (!thread) return;
    let changed = false;
    for (const m of thread.messages) {
      if (m.from === state.me.id && m.id <= data.upTo && !m.readAt) {
        m.readAt = data.at;
        changed = true;
      }
    }
    if (changed) renderMessages({ keepScroll: true });
  });

  es.addEventListener('presence', (event) => {
    const data = JSON.parse(event.data);
    if (data.online) state.online.add(data.userId);
    else state.online.delete(data.userId);
    renderOnline();
    renderList();
  });

  es.addEventListener('profile', (event) => {
    const data = JSON.parse(event.data);
    if (state.me && data.userId === state.me.id) {
      state.me.avatarId = data.avatarId;
      paintAvatar($('#me-avatar'), state.me);
    }
    const user = state.users.find((u) => u.id === data.userId);
    if (user) {
      user.avatarId = data.avatarId;
      renderList();
      if (state.activeId === data.userId) renderHead(user);
    }
  });

  es.addEventListener('error', () => {
    banner(true);
    state.streamErrors = (state.streamErrors || 0) + 1;
    if (state.streamErrors >= 5) {
      state.streamErrors = 0;
      signOut(false);
    }
  });
  es.onopen = () => {
    state.streamErrors = 0;
    banner(false);
  };
}

function onIncoming(message) {
  const peerId = message.from === state.me.id ? message.to : message.from;
  const thread = ensureThread(peerId);
  if (thread.messages.some((m) => m.id === message.id)) return;
  thread.messages.push(message);
  thread.messages.sort((a, b) => a.id - b.id);

  if (peerId === state.activeId) {
    renderMessages();
    scrollToBottom();
  }

  if (message.from !== state.me.id) {
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    if (peerId === state.activeId && focused) {
      markRead(peerId);
    } else {
      beep();
    }
  }
  loadUsers();
}

/* ───────────────────────── данные ───────────────────────── */

function markStreamAlive() {
  state.lastEventAt = Date.now();
  if (state.polling) {
    state.polling = false;
    banner(false);
  }
}

/**
 * Некоторые прокси (например, Cloudflare) держат SSE в буфере и не отдают ни байта.
 * Если поток молчит — переходим на опрос раз в 1.5 секунды, и всё равно всё доезжает.
 */
async function pollOnce() {
  await loadUsers();
  const peerId = state.activeId;
  if (!peerId) return;
  const thread = state.threads.get(peerId);
  if (!thread) return;

  const lastId = thread.messages.length ? thread.messages[thread.messages.length - 1].id : 0;
  const data = await api(`/api/messages?userId=${peerId}&limit=40`);
  const fresh = data.messages.filter((message) => message.id > lastId);
  if (!fresh.length) return;

  thread.messages.push(...fresh);
  thread.messages.sort((a, b) => a.id - b.id);
  renderMessages();
  scrollToBottom();
  if (fresh.some((message) => message.from !== state.me.id)) {
    beep();
    markRead(peerId);
  }
}

setInterval(async () => {
  if (!state.me) return;
  if (Date.now() - state.lastEventAt > 8000) {
    if (!state.polling) {
      state.polling = true;
      banner(true, 'Поток событий недоступен — обновляю опросом');
      setTimeout(() => {
        if (state.polling) banner(false);
      }, 6000);
    }
    try {
      await pollOnce();
    } catch {
      /* сеть моргнула, попробуем на следующем тике */
    }
  }
}, 1500);

async function loadUsers() {
  try {
    const data = await api('/api/users');
    state.users = data.users;
    if (Array.isArray(data.online)) state.online = new Set(data.online);
    for (const user of data.users) {
      if (user.online) state.online.add(user.id);
      else state.online.delete(user.id);
    }
    renderList();
    renderOnline();
    if (state.activeId) {
      const peer = state.users.find((u) => u.id === state.activeId);
      if (peer) renderHead(peer);
    }
  } catch (err) {
    if (err.status !== 401) console.error(err);
  }
}

function ensureThread(peerId) {
  let thread = state.threads.get(peerId);
  if (!thread) {
    thread = { messages: [], hasMore: false, loaded: false };
    state.threads.set(peerId, thread);
  }
  return thread;
}

async function openChat(peerId) {
  if (!peerId) return;
  const peer = state.users.find((u) => u.id === peerId);
  state.activeId = peerId;
  document.body.classList.add('mobile-chat');
  $('#empty-state').hidden = true;
  $('#conversation').hidden = false;
  if (peer) renderHead(peer);
  renderList();
  $('#typing').hidden = true;

  const thread = ensureThread(peerId);
  if (!thread.loaded) {
    try {
      const data = await api(`/api/messages?userId=${peerId}&limit=40`);
      thread.messages = data.messages;
      thread.hasMore = data.hasMore;
      thread.loaded = true;
    } catch (err) {
      console.error(err);
    }
  }
  renderMessages();
  scrollToBottom();
  markRead(peerId);
  $('#input').value = '';
  autoGrow();
  if (window.matchMedia('(min-width: 881px)').matches) $('#input').focus();
}

async function loadOlder() {
  const peerId = state.activeId;
  const thread = state.threads.get(peerId);
  if (!thread || !thread.hasMore || !thread.messages.length) return;
  const before = thread.messages[0].id;
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  const data = await api(`/api/messages?userId=${peerId}&before=${before}&limit=40`);
  thread.messages = [...data.messages, ...thread.messages];
  thread.hasMore = data.hasMore;
  renderMessages({ keepScroll: true });
  box.scrollTop = box.scrollHeight - prevHeight;
}

async function send(text) {
  const body = text.trim();
  const photo = state.pending;
  if ((!body && !photo) || !state.activeId) return;
  const peerId = state.activeId;

  $('#input').value = '';
  autoGrow();
  $('#send').disabled = true;

  try {
    let mediaId = null;
    if (photo) {
      $('#attach-state').textContent = 'Загружаю…';
      const media = await uploadImage(photo);
      mediaId = media.id;
      $('#attach-state').textContent = 'Отправляю…';
    }
    const data = await api('/api/messages', {
      method: 'POST',
      body: { to: peerId, body, mediaId },
    });
    onIncoming(data.message);
    scrollToBottom();
    clearAttachment();
  } catch (err) {
    showToast(err.message);
    $('#input').value = text;
    autoGrow();
    if (!photo) $('#send').disabled = false;
  } finally {
    $('#attach-state').textContent = '';
    autoGrow();
  }
}

async function markRead(peerId) {
  const thread = state.threads.get(peerId);
  if (thread) {
    const at = Date.now();
    let changed = false;
    for (const m of thread.messages) {
      if (m.from === peerId && !m.readAt) {
        m.readAt = at;
        changed = true;
      }
    }
    const user = state.users.find((u) => u.id === peerId);
    if (user && user.unread) {
      user.unread = 0;
      renderList();
    }
    if (changed && peerId === state.activeId) renderMessages({ keepScroll: true });
  }
  api('/api/read', { method: 'POST', body: { userId: peerId } }).catch(() => {});
}

/* ───────────────────────── отрисовка ───────────────────────── */

function renderList() {
  const list = $('#user-list');
  const filter = state.filter.toLowerCase();
  const users = state.users.filter(
    (u) =>
      !filter ||
      u.name.toLowerCase().includes(filter) ||
      (u.lastBody || '').toLowerCase().includes(filter),
  );

  list.replaceChildren();
  if (!users.length) {
    const empty = document.createElement('li');
    empty.className = 'list-empty';
    empty.textContent = state.users.length ? 'Ничего не найдено' : 'Пока никого нет — позови друга';
    list.append(empty);
  }

  for (const user of users) {
    const item = document.createElement('li');
    item.className = 'chat-item' + (user.id === state.activeId ? ' is-active' : '');
    item.dataset.id = String(user.id);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(user.id === state.activeId));

    const avatar = makeAvatar(user, state.online.has(user.id) ? 'online' : '');
    item.append(avatar);

    const body = document.createElement('div');
    body.className = 'chat-body';

    const top = document.createElement('div');
    top.className = 'chat-top';
    const name = document.createElement('div');
    name.className = 'chat-name';
    name.textContent = user.name;
    const time = document.createElement('div');
    time.className = 'chat-time';
    time.textContent = shortTime(user.lastAt);
    top.append(name, time);

    const preview = document.createElement('div');
    preview.className = 'chat-preview';
    if (user.lastAt && user.lastFrom === state.me.id) {
      const prefix = document.createElement('span');
      prefix.className = 'prefix';
      prefix.textContent = 'Вы:';
      preview.append(prefix);
    }
    const isPhoto = user.lastKind === 'photo';
    const text = document.createElement('span');
    if (user.lastBody) text.textContent = isPhoto ? `📷 ${user.lastBody}` : user.lastBody;
    else if (isPhoto) text.textContent = '📷 Фото';
    else {
      text.textContent = 'Нет сообщений';
      text.style.color = 'var(--muted-dim)';
    }
    preview.append(text);

    body.append(top, preview);
    item.append(body);

    if (user.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = user.unread > 99 ? '99+' : String(user.unread);
      item.append(badge);
    }

    item.addEventListener('click', () => openChat(user.id));
    list.append(item);
  }

  const total = state.users.reduce((sum, u) => sum + (u.unread || 0), 0);
  document.title = total > 0 ? `(${total}) Волна` : 'Волна';
}

function renderOnline() {
  $('#online-count').textContent = String(state.online.size);
  if (!state.activeId) return;
  const peer = state.users.find((u) => u.id === state.activeId);
  if (peer) renderHead(peer);
}

function renderHead(peer) {
  const online = state.online.has(peer.id) || peer.online;
  paintAvatar($('#peer-avatar'), peer);
  $('#peer-avatar').classList.toggle('online', online);
  $('#peer-name').textContent = peer.name;
  const status = $('#peer-status');
  status.textContent = online ? 'в сети' : 'не в сети';
  status.classList.toggle('is-online', online);
}

const GROUP_MS = 5 * 60 * 1000;

function renderMessages({ keepScroll = false } = {}) {
  const box = $('#messages');
  const peerId = state.activeId;
  const thread = state.threads.get(peerId);
  const stick = isNearBottom();
  const prevHeight = box.scrollHeight;
  const prevTop = box.scrollTop;

  box.replaceChildren();
  if (!thread) return;

  const list = thread.messages;
  if (thread.hasMore) {
    const btn = document.createElement('button');
    btn.className = 'load-more';
    btn.type = 'button';
    btn.textContent = 'Показать более ранние';
    btn.addEventListener('click', loadOlder);
    box.append(btn);
  }

  let lastDay = '';
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    const prev = list[i - 1];
    const next = list[i + 1];
    const mine = m.from === state.me.id;

    const day = dayKey(m.at);
    if (day !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day';
      const span = document.createElement('span');
      span.textContent = dayLabel(m.at);
      sep.append(span);
      box.append(sep);
      lastDay = day;
    }

    const sameAsPrev =
      prev && prev.from === m.from && dayKey(prev.at) === day && m.at - prev.at < GROUP_MS;
    const sameAsNext =
      next && next.from === m.from && dayKey(next.at) === day && next.at - m.at < GROUP_MS;

    const row = document.createElement('div');
    row.className = [
      'row',
      mine ? 'mine' : 'other',
      sameAsPrev ? 'group-mid' : 'group-start',
      sameAsNext ? '' : 'group-end',
    ]
      .filter(Boolean)
      .join(' ');
    row.dataset.id = String(m.id);

    if (!mine) {
      const peer = state.users.find((u) => u.id === peerId) || { name: '?', hue: 232 };
      const avatar = makeAvatar(peer, sameAsPrev ? 'hidden' : '');
      row.append(avatar);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (m.kind === 'photo' && m.mediaId) {
      bubble.classList.add('is-photo');
      if (m.body) bubble.classList.add('has-caption');
      const img = document.createElement('img');
      img.className = 'photo';
      img.src = mediaSrc(m.mediaId);
      img.alt = m.body || 'Фото';
      img.loading = 'lazy';
      const meta = m.media;
      if (meta && meta.width && meta.height) {
        img.width = meta.width;
        img.height = meta.height;
        img.style.aspectRatio = `${meta.width} / ${meta.height}`;
      }
      img.addEventListener('click', () => openLightbox(img.src));
      bubble.append(img);
    }

    if (m.body) {
      const text = document.createElement('span');
      text.className = 'text';
      text.textContent = m.body;
      bubble.append(text);
    }

    if (!sameAsNext) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      const time = document.createElement('span');
      time.textContent = timeOf(m.at);
      meta.append(time);
      if (mine) {
        const ticks = document.createElement('span');
        ticks.className = 'ticks' + (m.readAt ? ' read' : '');
        ticks.textContent = m.readAt ? '✓✓' : '✓';
        meta.append(ticks);
      }
      bubble.append(meta);
    }

    row.append(bubble);
    box.append(row);
  }

  if (!list.length) {
    const hello = document.createElement('div');
    hello.className = 'empty';
    hello.style.flex = '1';
    const h = document.createElement('h2');
    h.textContent = 'Начни разговор';
    const p = document.createElement('p');
    p.textContent = 'Это первый чат с этим человеком. Напиши что-нибудь тёплое.';
    hello.append(h, p);
    box.append(hello);
  }

  if (keepScroll) {
    box.scrollTop = prevTop;
  } else if (stick) {
    scrollToBottom();
  } else {
    box.scrollTop = box.scrollHeight - prevHeight + prevTop;
  }
}

function isNearBottom() {
  const box = $('#messages');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function scrollToBottom() {
  const box = $('#messages');
  requestAnimationFrame(() => {
    box.scrollTop = box.scrollHeight;
  });
}

function showToast(text) {
  const box = $('#conn-banner');
  const prev = box.textContent;
  box.textContent = text;
  box.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    box.textContent = prev;
    box.hidden = true;
  }, 3200);
}

/* ───────────────────────── ввод ───────────────────────── */

function autoGrow() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  updateSendState();
}

function updateSendState() {
  const hasText = $('#input').value.trim().length > 0;
  $('#send').disabled = !hasText && !state.pending;
}

$('#composer').addEventListener('submit', (event) => {
  event.preventDefault();
  send($('#input').value);
});

$('#input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send($('#input').value);
  }
});

$('#input').addEventListener('input', () => {
  autoGrow();
  if (!state.activeId) return;
  if (Date.now() - state.typingSentAt < 1600) return;
  state.typingSentAt = Date.now();
  api('/api/typing', { method: 'POST', body: { to: state.activeId } }).catch(() => {});
});

$('#search').addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderList();
});

document.addEventListener('paste', async (event) => {
  const items = Array.from((event.clipboardData && event.clipboardData.items) || []);
  const item = items.find((it) => it.type && it.type.startsWith('image/'));
  if (!item) return;
  const file = item.getAsFile();
  if (!file) return;
  event.preventDefault();
  try {
    setAttachment(await prepareImage(file));
  } catch (err) {
    showToast(err.message);
  }
});

$('#back').addEventListener('click', () => {
  document.body.classList.remove('mobile-chat');
  state.activeId = null;
  $('#conversation').hidden = true;
  $('#empty-state').hidden = false;
  renderList();
});

window.addEventListener('focus', () => {
  if (state.activeId && document.visibilityState === 'visible') markRead(state.activeId);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.activeId) markRead(state.activeId);
});

/* ───────────────────────── старт ───────────────────────── */

async function boot() {
  setAuthMode('login');
  autoGrow();

  // в закрытом режиме демо-аккаунты не афишируем и быстрый вход отключаем
  if (INVITE_REQUIRED) $('#auth-hint').hidden = true;
  else if (location.hash === '#demo') {
    try {
      await doAuth('anya', '1234');
      return;
    } catch (err) {
      showAuthError(err.message);
    }
  }

  if (!state.token) return;
  try {
    await enterChat();
  } catch {
    state.token = '';
    localStorage.removeItem('volna.token');
  }
}

// отладочная ручка: из консоли видно состояние (и удобно проверять автотестами)
window.__volna = state;

boot();
