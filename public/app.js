/* Волна — клиент. Без фреймворков: состояние + DOM. */

const $ = (sel) => document.querySelector(sel);

const CONFIG = window.VOLNA_CONFIG || {};

/**
 * Интерфейс может открываться с чужого адреса (GitHub Pages): тогда сервер задаётся
 * ссылкой вида .../#api=https://твой-сервер. Адрес запоминается и переживает перезагрузку.
 */
const API_BASE_DEFAULT = (() => {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const fromHash = (hash.get('api') || '').replace(/\/+$/, '');
  if (fromHash) {
    try {
      localStorage.setItem('volna.apiBase', fromHash);
    } catch {
      /* приватный режим */
    }
    return fromHash;
  }
  try {
    return (localStorage.getItem('volna.apiBase') || '').replace(/\/+$/, '');
  } catch {
    return '';
  }
})();

let API_BASE = API_BASE_DEFAULT;

const IS_REMOTE_UI = Boolean(CONFIG.pages);
const mediaBase = () => ((CONFIG.mediaUrl || API_BASE) || '').replace(/\/+$/, '');
const mediaSrc = (id) => (id ? `${mediaBase()}/f/${encodeURIComponent(id)}` : '');
const INVITE_REQUIRED = Boolean(CONFIG.inviteRequired);
const apiUrl = (path) => `${API_BASE}${path}`;

/** Набор стикеров: id = имя файла в ./stickers (лежит рядом с интерфейсом). */
const STICKERS = ['smile', 'laugh', 'love', 'sad', 'angry', 'sleepy', 'cool', 'party', 'wink', 'think', 'shock', 'cry', 'star', 'fire', 'devil', 'angel'];
const stickerSrc = (id) => `./stickers/${id}.svg`;

/* Ключ чата: 'u:12' — человек, 'g:3' — группа. */
const keyOfUser = (id) => `u:${id}`;
const keyOfGroup = (id) => `g:${id}`;

function parseKey(key) {
  const type = key && key[0] === 'g' ? 'group' : 'user';
  return { type, id: Number(key ? key.slice(2) : 0) };
}

function historyPath(key, params = {}) {
  const { type, id } = parseKey(key);
  const search = new URLSearchParams({
    ...(type === 'group' ? { groupId: String(id) } : { userId: String(id) }),
    limit: '40',
    ...params,
  });
  return `/api/messages?${search}`;
}

function plural(n, one, few, many) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

const state = {
  token: localStorage.getItem('volna.token') || '',
  me: null,
  users: [],
  groups: [],
  activeKey: null,
  online: new Set(),
  threads: new Map(), // peerId → { messages: [], hasMore: false }
  filter: '',
  es: null,
  ws: null,
  typingUntil: 0,
  typingSentAt: 0,
  typingTimer: null,
  streamErrors: 0,
  audio: null,
  found: [], // найденные люди, с которыми ещё нет чата
  editing: null, // сообщение, которое правим
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
  let res;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Сервер не отвечает — проверь, запущен ли он');
  }
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

/**
 * Отметка о прочтении: контур глаза — отправлено, залитый зрачок — прочитано.
 * SVG собираем строкой, чтобы не плодить разметку в index.html.
 */
function eyeBadge(read) {
  const wrap = document.createElement('span');
  wrap.className = 'eye-badge' + (read ? ' read' : '');
  wrap.title = read ? 'Прочитано' : 'Отправлено';
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', read ? 'прочитано' : 'отправлено');
  wrap.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path class="eye-outline" d="M1.6 12c2.8-4.8 6.2-7.2 10.4-7.2S19.6 7.2 22.4 12c-2.8 4.8-6.2 7.2-10.4 7.2S4.4 16.8 1.6 12Z" />
      <circle class="eye-pupil" cx="12" cy="12" r="3.5" />
    </svg>`;
  return wrap;
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
  // пустой адрес — значит фото идут на тот же сервер (/api/media), это норма
  const res = await fetch(`${mediaBase()}/api/media`, {
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

/* ───────────────────────── стикеры ───────────────────────── */

let stickerPanelReady = false;

function buildStickerPanel() {
  const grid = $('#sticker-grid');
  grid.replaceChildren();
  for (const id of STICKERS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sticker-item';
    button.title = 'Отправить стикер';
    const img = document.createElement('img');
    img.src = stickerSrc(id);
    img.alt = id;
    img.loading = 'lazy';
    button.append(img);
    button.addEventListener('click', () => {
      hideStickers();
      sendSticker(id);
    });
    grid.append(button);
  }
  stickerPanelReady = true;
}

function hideStickers() {
  $('#sticker-panel').hidden = true;
}

function toggleStickers() {
  const panel = $('#sticker-panel');
  if (!panel.hidden) {
    panel.hidden = true;
    return;
  }
  if (!stickerPanelReady) buildStickerPanel();
  panel.hidden = false;
  clearAttachment();
}

async function sendSticker(id) {
  const key = state.activeKey;
  if (!key) return;
  const { type, id: peerId } = parseKey(key);
  try {
    const data = await api('/api/messages', {
      method: 'POST',
      body: { ...(type === 'group' ? { group: peerId } : { to: peerId }), sticker: id },
    });
    onIncoming(data.message);
    scrollToBottom();
  } catch (err) {
    showToast(err.message);
  }
}

$('#stickers').addEventListener('click', toggleStickers);

/* ───────────────────────── группы ───────────────────────── */

function openModal(title) {
  $('#modal-title').textContent = title;
  $('#modal').hidden = false;
}

function closeModal() {
  $('#modal').hidden = true;
  $('#modal-body').replaceChildren();
  $('#modal-foot').replaceChildren();
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (event) => {
  if (event.target.id === 'modal') closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('#modal').hidden) closeModal();
});

function pickRow(user) {
  const row = document.createElement('label');
  row.className = 'pick-row';
  const name = document.createElement('span');
  name.textContent = user.name;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = String(user.id);
  row.append(makeAvatar(user), name, box);
  return row;
}

async function showCreateGroup() {
  if (!state.users.length) {
    showToast('Пока нет собеседников — позови друга');
    return;
  }

  openModal('Новая группа');
  const body = $('#modal-body');
  const foot = $('#modal-foot');

  const input = document.createElement('input');
  input.className = 'modal-input';
  input.placeholder = 'Название группы';
  input.maxLength = 60;
  body.append(input);

  const hint = document.createElement('p');
  hint.className = 'modal-hint';
  hint.textContent = 'Кого добавить:';
  body.append(hint);

  const list = document.createElement('div');
  list.className = 'pick-list';
  for (const user of state.users) list.append(pickRow(user));
  body.append(list);

  const create = document.createElement('button');
  create.className = 'btn-primary';
  create.type = 'button';
  create.textContent = 'Создать';
  create.addEventListener('click', async () => {
    const memberIds = [...list.querySelectorAll('input:checked')].map((i) => Number(i.value));
    try {
      const data = await api('/api/groups', {
        method: 'POST',
        body: { title: input.value.trim(), memberIds },
      });
      closeModal();
      await loadUsers();
      openThread(keyOfGroup(data.group.id));
    } catch (err) {
      showToast(err.message);
    }
  });
  foot.append(create);
  input.focus();
}

async function showGroupInfo() {
  const { type, id } = parseKey(state.activeKey);
  if (type !== 'group') return;

  try {
    const data = await api(`/api/groups/${id}`);
    const group = data.group;
    openModal(group.title);

    const body = $('#modal-body');
    const foot = $('#modal-foot');

    const hint = document.createElement('p');
    hint.className = 'modal-hint';
    hint.textContent = `${group.members.length} ${plural(group.members.length, 'участник', 'участника', 'участников')}`;
    body.append(hint);

    for (const member of group.members) {
      const row = document.createElement('div');
      row.className = 'member-row';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = member.name;
      row.append(makeAvatar(member), name);

      if (member.id === group.ownerId) {
        const role = document.createElement('span');
        role.className = 'role';
        role.textContent = 'создатель';
        row.append(role);
      } else if (member.id === state.me.id) {
        const role = document.createElement('span');
        role.className = 'role';
        role.textContent = 'ты';
        row.append(role);
      }
      body.append(row);
    }

    if (group.ownerId === state.me.id) {
      const candidates = state.users.filter((u) => !group.members.some((m) => m.id === u.id));
      if (candidates.length) {
        const addTitle = document.createElement('p');
        addTitle.className = 'modal-hint';
        addTitle.style.marginTop = '12px';
        addTitle.textContent = 'Добавить участников:';
        body.append(addTitle);

        const list = document.createElement('div');
        list.className = 'pick-list';
        for (const user of candidates) list.append(pickRow(user));
        body.append(list);

        const add = document.createElement('button');
        add.className = 'btn-primary';
        add.type = 'button';
        add.textContent = 'Добавить';
        add.addEventListener('click', async () => {
          const userIds = [...list.querySelectorAll('input:checked')].map((i) => Number(i.value));
          if (!userIds.length) return;
          try {
            await api(`/api/groups/${id}/members`, { method: 'POST', body: { userIds } });
            closeModal();
            await loadUsers();
            showGroupInfo();
          } catch (err) {
            showToast(err.message);
          }
        });
        foot.append(add);
      }
    }

    const leave = document.createElement('button');
    leave.className = 'btn-ghost btn-danger';
    leave.type = 'button';
    leave.textContent = 'Покинуть группу';
    leave.addEventListener('click', async () => {
      try {
        await api(`/api/groups/${id}/leave`, { method: 'POST' });
        closeModal();
        state.threads.delete(keyOfGroup(id));
        state.activeKey = null;
        $('#conversation').hidden = true;
        $('#empty-state').hidden = false;
        await loadUsers();
      } catch (err) {
        showToast(err.message);
      }
    });
    foot.append(leave);
  } catch (err) {
    showToast(err.message);
  }
}

$('#new-group').addEventListener('click', showCreateGroup);
$('#group-info').addEventListener('click', showGroupInfo);

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

/** Как показывать человека: приватный псевдоним, если задан, иначе имя. */
const displayName = (user) => (user && (user.nickname || user.name)) || '';
/* ───────────────────────── авторизация ───────────────────────── */

let authMode = 'login';

/**
 * Страница на GitHub Pages не знает, где сервер: адрес берём из ссылки (#api=…),
 * из памяти браузера или из server.json, который обновляет online.cmd.
 * Первый живой адрес и становится рабочим.
 */
async function probeServer(base) {
  try {
    const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3500), cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

function rememberServer(base) {
  API_BASE = base;
  try {
    localStorage.setItem('volna.apiBase', base);
  } catch {
    /* приватный режим */
  }
}

async function resolveServer() {
  const candidates = [];
  const hash = new URLSearchParams(location.hash.replace(/^#/, '')).get('api');
  if (hash) candidates.push(hash.replace(/\/+$/, ''));
  try {
    const saved = localStorage.getItem('volna.apiBase');
    if (saved) candidates.push(saved.replace(/\/+$/, ''));
  } catch {
    /* приватный режим */
  }

  for (const base of [...new Set(candidates)]) {
    if (await probeServer(base)) {
      rememberServer(base);
      return true;
    }
  }

  try {
    const res = await fetch('./server.json', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const published = String(data.api || '').replace(/\/+$/, '');
      if (published && (await probeServer(published))) {
        rememberServer(published);
        return true;
      }
    }
  } catch {
    /* файла нет или он битый */
  }

  return false;
}

/* Этот интерфейс открыт не со своего сервера (GitHub Pages) — спрашиваем адрес. */

function showApiSetup() {
  $('#api-setup').hidden = false;
  document.querySelector('.tabs').hidden = true;
  $('#auth-form').hidden = true;
  $('#auth-hint').hidden = true;
}

function apiSetupError(text) {
  const box = $('#api-error');
  box.textContent = text;
  box.hidden = !text;
}

function changeServer() {
  try {
    localStorage.removeItem('volna.apiBase');
    localStorage.removeItem('volna.token');
  } catch {
    /* приватный режим */
  }
  location.hash = '';
  location.reload();
}

$('#api-connect').addEventListener('click', () => {
  const raw = $('#api-url').value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(raw)) {
    apiSetupError('Нужен адрес вида https://xxx.trycloudflare.com');
    return;
  }
  try {
    localStorage.setItem('volna.apiBase', raw);
  } catch {
    /* приватный режим */
  }
  location.hash = `api=${encodeURIComponent(raw)}`;
  location.reload();
});

$('#api-change').addEventListener('click', changeServer);
$('#api-change-foot').addEventListener('click', changeServer);

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
  // если SSE через прокси не доходит, статусы подтянем отдельным запросом
  setTimeout(() => {
    if (state.me) loadUsers();
  }, 2500);

  const desktop = window.matchMedia('(min-width: 881px)').matches;
  if (desktop && !state.activeKey) {
    const first = chatItems()[0];
    if (first) openThread(first.key);
  }
}

function signOut(notifyServer = true) {
  if (notifyServer && state.token) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  closeStream();
  state.token = '';
  state.me = null;
  state.users = [];
  state.groups = [];
  state.activeKey = null;
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

/** Один обработчик на оба канала: WebSocket (основной) и SSE (резервный). */
function handleEvent(name, data) {
  markStreamAlive();

  if (name === 'ready') {
    if (data.me) state.me = { ...state.me, ...data.me };
    state.online = new Set(data.online || []);
    renderOnline();
    renderList();
    return;
  }

  if (name === 'message') {
    onIncoming(data);
    return;
  }

  if (name === 'typing') {
    const key = data.group ? keyOfGroup(data.group) : keyOfUser(data.from);
    if (key !== state.activeKey || data.from === state.me.id) return;
    state.typingUntil = Date.now() + 3200;
    $('#typing-text').textContent = `${data.name} печатает…`;
    $('#typing').hidden = false;
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      $('#typing').hidden = true;
    }, 3200);
    return;
  }

  if (name === 'read') {
    if (state.activeKey !== keyOfUser(data.by)) return;
    const thread = state.threads.get(state.activeKey);
    if (!thread) return;
    let changed = false;
    for (const m of thread.messages) {
      if (m.from === state.me.id && m.id <= data.upTo && !m.readAt) {
        m.readAt = data.at;
        changed = true;
      }
    }
    if (changed) renderMessages({ keepScroll: true });
    return;
  }

  if (name === 'presence') {
    if (data.online) state.online.add(data.userId);
    else state.online.delete(data.userId);
    renderOnline();
    renderList();
    return;
  }

  if (name === 'messageEdited') {
    const key = data.group ? keyOfGroup(data.group) : keyOfUser(data.from === state.me.id ? data.to : data.from);
    const thread = state.threads.get(key);
    if (thread) {
      const message = thread.messages.find((m) => m.id === data.id);
      if (message) {
        message.body = data.body;
        message.editedAt = data.editedAt;
        if (key === state.activeKey) renderMessages({ keepScroll: true });
      }
    }
    loadUsers();
    return;
  }

  if (name === 'messageDeleted') {
    const key = data.group ? keyOfGroup(data.group) : keyOfUser(data.from === state.me.id ? data.to : data.from);
    const thread = state.threads.get(key);
    if (thread) {
      thread.messages = thread.messages.filter((m) => m.id !== data.id);
      if (key === state.activeKey) renderMessages({ keepScroll: true });
    }
    loadUsers();
    return;
  }
  if (name === 'chats') {
    loadUsers();
    return;
  }

  if (name === 'profile') {
    if (state.me && data.userId === state.me.id) {
      state.me.avatarId = data.avatarId;
      paintAvatar($('#me-avatar'), state.me);
    }
    const user = state.users.find((u) => u.id === data.userId);
    if (user) {
      user.avatarId = data.avatarId;
      renderList();
      if (state.activeKey === keyOfUser(data.userId)) renderHead();
    }
  }
}

function closeStream() {
  try {
    state.ws?.close();
  } catch {
    /* уже закрыт */
  }
  state.ws = null;
  try {
    state.es?.close();
  } catch {
    /* уже закрыт */
  }
  state.es = null;
}

function connectStream() {
  closeStream();
  connectSocket();
}

function socketUrl() {
  const base = API_BASE
    ? API_BASE.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:')
    : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
  return `${base}/api/ws?token=${encodeURIComponent(state.token)}`;
}

/**
 * Основной канал — WebSocket: туннели и прокси пропускают его, а SSE часто держат
 * в буфере. Если подключиться не вышло — переходим на SSE, затем на опрос.
 */
function connectSocket() {
  if (typeof WebSocket === 'undefined' || !state.token) {
    connectEvents();
    return;
  }

  let ws;
  try {
    ws = new WebSocket(socketUrl());
  } catch {
    connectEvents();
    return;
  }
  state.ws = ws;

  const giveUp = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    connectEvents();
  };

  const timer = setTimeout(() => {
    if (ws.readyState !== 1) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      giveUp();
    }
  }, 4000);

  ws.addEventListener('open', () => {
    clearTimeout(timer);
    markStreamAlive();
    try {
      state.es?.close();
    } catch {
      /* ignore */
    }
    state.es = null;
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg && msg.event) handleEvent(msg.event, msg.data);
    } catch {
      /* не наш пакет */
    }
  });

  ws.addEventListener('close', () => {
    clearTimeout(timer);
    setTimeout(giveUp, 600);
  });

  ws.addEventListener('error', () => {
    /* следом придёт close */
  });
}

/** Резервный канал: SSE. */
function connectEvents() {
  if (state.es) return;
  const es = new EventSource(apiUrl(`/api/events?token=${encodeURIComponent(state.token)}`));
  state.es = es;

  for (const name of ['ready', 'message', 'typing', 'read', 'presence', 'profile']) {
    es.addEventListener(name, (event) => {
      try {
        handleEvent(name, JSON.parse(event.data));
      } catch {
        /* ignore */
      }
    });
  }

  es.addEventListener('error', () => {
    state.streamErrors = (state.streamErrors || 0) + 1;
    if (state.streamErrors >= 5) {
      state.streamErrors = 0;
      try {
        es.close();
      } catch {
        /* ignore */
      }
      state.es = null;
      setTimeout(() => state.me && connectSocket(), 2000);
    }
  });

  es.onopen = () => {
    state.streamErrors = 0;
  };
}

/** Раз в полминуты пробуем вернуться на быстрый канал. */
setInterval(() => {
  if (state.me && !state.ws) connectSocket();
}, 30000);

function onIncoming(message) {
  const key = message.group
    ? keyOfGroup(message.group)
    : keyOfUser(message.from === state.me.id ? message.to : message.from);
  const thread = ensureThread(key);
  if (thread.messages.some((m) => m.id === message.id)) return;
  thread.messages.push(message);
  thread.messages.sort((a, b) => a.id - b.id);

  if (key === state.activeKey) {
    renderMessages();
    scrollToBottom();
  }

  if (message.from !== state.me.id) {
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    if (key === state.activeKey && focused) {
      markRead(key);
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
  const key = state.activeKey;
  if (!key) return;
  const thread = state.threads.get(key);
  if (!thread) return;

  const lastId = thread.messages.length ? thread.messages[thread.messages.length - 1].id : 0;
  const data = await api(historyPath(key, { limit: 40 }));
  const fresh = data.messages.filter((message) => message.id > lastId);
  if (!fresh.length) return;

  thread.messages.push(...fresh);
  thread.messages.sort((a, b) => a.id - b.id);
  renderMessages();
  scrollToBottom();
  if (fresh.some((message) => message.from !== state.me.id)) {
    beep();
    markRead(key);
  }
}

setInterval(async () => {
  if (!state.me) return;
  // быстрый канал жив — опрос не нужен
  if (state.ws && state.ws.readyState === 1) {
    state.polling = false;
    return;
  }
  if (Date.now() - state.lastEventAt > 8000) {
    state.polling = true;
    try {
      await pollOnce();
    } catch {
      /* сеть моргнула, попробуем на следующем тике */
    }
  } else {
    state.polling = false;
  }
}, 1500);

async function loadUsers() {
  try {
    const data = await api('/api/users');
    state.users = data.users;
    state.groups = data.groups || [];
    if (Array.isArray(data.online)) state.online = new Set(data.online);
    for (const user of data.users) {
      if (user.online) state.online.add(user.id);
      else state.online.delete(user.id);
    }
    renderList();
    renderOnline();
  } catch (err) {
    if (err.status !== 401) console.error(err);
  }
}

function ensureThread(key) {
  let thread = state.threads.get(key);
  if (!thread) {
    thread = { messages: [], hasMore: false, loaded: false };
    state.threads.set(key, thread);
  }
  return thread;
}

async function openThread(key) {
  if (!key) return;
  const { type } = parseKey(key);
  if (type === 'group' && !state.groups.some((g) => keyOfGroup(g.id) === key)) return;
  if (type === 'user' && !state.users.some((u) => keyOfUser(u.id) === key)) return;

  state.activeKey = key;
  document.body.classList.add('mobile-chat');
  $('#empty-state').hidden = true;
  $('#conversation').hidden = false;
  $('#typing').hidden = true;
  hideStickers();

  renderHead();
  renderList();

  const thread = ensureThread(key);
  if (!thread.loaded) {
    try {
      const data = await api(historyPath(key));
      thread.messages = data.messages;
      thread.hasMore = data.hasMore;
      thread.loaded = true;
      if (data.group) {
        const existing = state.groups.find((g) => g.id === data.group.id);
        if (existing) Object.assign(existing, { members: data.group.members.length });
      }
    } catch (err) {
      console.error(err);
    }
  }

  renderMessages();
  scrollToBottom();
  markRead(key);
  $('#input').value = '';
  autoGrow();
  if (window.matchMedia('(min-width: 881px)').matches) $('#input').focus();
}

async function loadOlder() {
  const key = state.activeKey;
  const thread = state.threads.get(key);
  if (!thread || !thread.hasMore || !thread.messages.length) return;
  const before = thread.messages[0].id;
  const box = $('#messages');
  const prevHeight = box.scrollHeight;
  const data = await api(historyPath(key, { before: String(before) }));
  thread.messages = [...data.messages, ...thread.messages];
  thread.hasMore = data.hasMore;
  renderMessages({ keepScroll: true });
  box.scrollTop = box.scrollHeight - prevHeight;
}

async function send(text) {
  const body = text.trim();
  const photo = state.pending;
  const key = state.activeKey;
  if ((!body && !photo) || !key) return;

  if (state.editing) {
    if (!body) return;
    const target = state.editing;
    $('#input').value = '';
    autoGrow();
    try {
      await api(`/api/messages/${target.id}`, { method: 'PATCH', body: { body } });
      const thread = state.threads.get(target.key);
      const message = thread && thread.messages.find((m) => m.id === target.id);
      if (message) {
        message.body = body;
        message.editedAt = Date.now();
      }
      cancelEdit();
      if (target.key === state.activeKey) renderMessages({ keepScroll: true });
    } catch (err) {
      showToast(err.message);
      $('#input').value = text;
      autoGrow();
    }
    return;
  }

  const { type, id } = parseKey(key);
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
      body: { ...(type === 'group' ? { group: id } : { to: id }), body, mediaId },
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

async function markRead(key) {
  const { type, id } = parseKey(key);
  const thread = state.threads.get(key);

  if (thread) {
    const at = Date.now();
    let changed = false;
    for (const m of thread.messages) {
      if (m.from === id && !m.readAt) {
        m.readAt = at;
        changed = true;
      }
    }
    const item = type === 'group' ? state.groups.find((g) => g.id === id) : state.users.find((u) => u.id === id);
    if (item && item.unread) {
      item.unread = 0;
      renderList();
    }
    if (changed && key === state.activeKey) renderMessages({ keepScroll: true });
  }

  const payload = type === 'group' ? { groupId: id } : { userId: id };
  api('/api/read', { method: 'POST', body: payload }).catch(() => {});
}

/* ───────────────────────── отрисовка ───────────────────────── */

/** Единый список чатов: люди и группы, по времени последнего сообщения. */
function chatItems() {
  const items = [];

  for (const user of state.users) {
    items.push({
      key: keyOfUser(user.id),
      type: 'user',
      id: user.id,
      title: displayName(user),
      hue: user.hue,
      avatarId: user.avatarId,
      lastBody: user.lastBody,
      lastKind: user.lastKind,
      lastAt: user.lastAt,
      lastFrom: user.lastFrom,
      lastName: null,
      unread: user.unread,
      members: 0,
      online: state.online.has(user.id),
    });
  }

  for (const group of state.groups) {
    items.push({
      key: keyOfGroup(group.id),
      type: 'group',
      id: group.id,
      title: group.title,
      hue: group.hue,
      avatarId: group.avatarId,
      lastBody: group.lastBody,
      lastKind: group.lastKind,
      lastAt: group.lastAt,
      lastFrom: group.lastFrom,
      lastName: group.lastFromName,
      unread: group.unread,
      members: group.members,
      online: false,
    });
  }

  return items.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || a.title.localeCompare(b.title));
}

function renderList() {
  const list = $('#user-list');
  const filter = state.filter.toLowerCase();
  const items = chatItems().filter(
    (item) =>
      !filter ||
      item.title.toLowerCase().includes(filter) ||
      (item.lastBody || '').toLowerCase().includes(filter),
  );

  list.replaceChildren();
  if (!items.length && !state.found.length) {
    const empty = document.createElement('li');
    empty.className = 'list-empty';
    empty.textContent = state.filter
      ? 'Ничего не найдено'
      : 'Пока никого нет — найди человека по имени через поиск';
    list.append(empty);
  }

  for (const chat of items) {
    const item = document.createElement('li');
    item.className = 'chat-item' + (chat.key === state.activeKey ? ' is-active' : '');
    item.dataset.key = chat.key;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(chat.key === state.activeKey));

    const avatar = makeAvatar(
      { name: chat.title, hue: chat.hue, avatarId: chat.avatarId },
      chat.type === 'group' ? 'is-group' : chat.online ? 'online' : '',
    );
    item.append(avatar);

    const body = document.createElement('div');
    body.className = 'chat-body';

    const top = document.createElement('div');
    top.className = 'chat-top';
    const name = document.createElement('div');
    name.className = 'chat-name';
    name.textContent = chat.title;
    if (chat.type === 'group') {
      const tag = document.createElement('span');
      tag.className = 'group-tag';
      tag.textContent = 'группа';
      name.append(tag);
    }
    const time = document.createElement('div');
    time.className = 'chat-time';
    time.textContent = shortTime(chat.lastAt);
    top.append(name, time);

    const preview = document.createElement('div');
    preview.className = 'chat-preview';

    const prefix = document.createElement('span');
    prefix.className = 'prefix';
    if (chat.lastAt && chat.lastFrom === state.me.id) prefix.textContent = 'Вы:';
    else if (chat.lastAt && chat.type === 'group' && chat.lastName) prefix.textContent = `${chat.lastName}:`;
    if (prefix.textContent) preview.append(prefix);

    const isPhoto = chat.lastKind === 'photo';
    const isSticker = chat.lastKind === 'sticker';
    const text = document.createElement('span');
    if (isSticker) text.textContent = 'Стикер';
    else if (chat.lastBody) text.textContent = isPhoto ? `📷 ${chat.lastBody}` : chat.lastBody;
    else if (isPhoto) text.textContent = '📷 Фото';
    else {
      text.textContent = chat.type === 'group' ? 'Группа создана' : 'Нет сообщений';
      text.style.color = 'var(--muted-dim)';
    }
    preview.append(text);

    body.append(top, preview);
    item.append(body);

    if (chat.unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = chat.unread > 99 ? '99+' : String(chat.unread);
      item.append(badge);
    }

    item.addEventListener('click', () => openThread(chat.key));
    list.append(item);
  }

  // результаты поиска по людям, с которыми ещё нет переписки
  if (state.found.length) {
    const heading = document.createElement('li');
    heading.className = 'list-heading';
    heading.textContent = 'Найти человека';
    list.append(heading);

    for (const person of state.found) {
      const item = document.createElement('li');
      item.className = 'chat-item is-found';
      item.setAttribute('role', 'option');
      item.append(
        makeAvatar(
          { name: displayName(person), hue: person.hue, avatarId: person.avatarId },
          person.online ? 'online' : '',
        ),
      );

      const body = document.createElement('div');
      body.className = 'chat-body';

      const top = document.createElement('div');
      top.className = 'chat-top';
      const name = document.createElement('div');
      name.className = 'chat-name';
      name.textContent = displayName(person);
      top.append(name);

      const preview = document.createElement('div');
      preview.className = 'chat-preview';
      const hint = document.createElement('span');
      hint.textContent = 'начать чат';
      hint.style.color = 'var(--muted-dim)';
      preview.append(hint);

      body.append(top, preview);
      item.append(body);

      item.addEventListener('click', () => {
        if (!state.users.some((u) => u.id === person.id)) {
          state.users.push({ ...person, unread: 0, lastAt: null });
        }
        state.filter = '';
        state.found = [];
        $('#search').value = '';
        renderList();
        openThread(keyOfUser(person.id));
      });
      list.append(item);
    }
  }

  const total = [...state.users, ...state.groups].reduce((sum, x) => sum + (x.unread || 0), 0);
  document.title = total > 0 ? `(${total}) Волна` : 'Волна';
}

function renderOnline() {
  $('#online-count').textContent = String(state.online.size);
  renderHead();
}

function renderHead() {
  const key = state.activeKey;
  if (!key) return;
  const { type, id } = parseKey(key);
  const status = $('#peer-status');

  if (type === 'group') {
    const group = state.groups.find((g) => g.id === id);
    if (!group) return;
    paintAvatar($('#peer-avatar'), { name: group.title, hue: group.hue, avatarId: group.avatarId });
    $('#peer-avatar').classList.remove('online');
    $('#peer-avatar').classList.add('is-group');
    $('#peer-name').textContent = group.title;
    status.textContent = `${group.members} ${plural(group.members, 'участник', 'участника', 'участников')}`;
    status.classList.remove('is-online');
    $('#conv-head').classList.add('is-group');
    $('#group-info').hidden = false;
    $('#rename-peer').hidden = true;
    return;
  }

  const peer = state.users.find((u) => u.id === id);
  if (!peer) return;
  $('#group-info').hidden = true;
  $('#rename-peer').hidden = false;
  const online = state.online.has(peer.id) || peer.online;
  paintAvatar($('#peer-avatar'), { ...peer, name: displayName(peer) });
  $('#peer-avatar').classList.remove('is-group');
  $('#peer-avatar').classList.toggle('online', online);
  $('#peer-name').textContent = displayName(peer);
  status.textContent = online ? 'в сети' : 'не в сети';
  if (peer.nickname) status.textContent += ' · ' + peer.name;
  status.classList.toggle('is-online', online);
  $('#conv-head').classList.remove('is-group');
}

const GROUP_MS = 5 * 60 * 1000;

function renderMessages({ keepScroll = false } = {}) {
  const box = $('#messages');
  const key = state.activeKey;
  const thread = state.threads.get(key);
  const { type: chatType, id: chatId } = parseKey(key);
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
      const sender =
        chatType === 'group'
          ? { name: m.fromName || '?', hue: m.fromHue ?? 232, avatarId: m.fromAvatarId || null }
          : state.users.find((u) => u.id === chatId) || { name: '?', hue: 232 };
      const avatar = makeAvatar({ ...sender, name: displayName(sender) }, sameAsPrev ? 'hidden' : '');
      row.append(avatar);
    }

    const bubble = document.createElement('div');
    bubble.className = 'bubble';

    if (mine) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'bubble-menu';
      more.textContent = '⋯';
      more.title = 'Изменить или удалить';
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        openMsgMenu({ ...m, key }, event.clientX, event.clientY);
      });
      bubble.append(more);
    }

    // в группе подписываем, кто написал
    if (chatType === 'group' && !mine && !sameAsPrev) {
      const author = document.createElement('span');
      author.className = 'sender';
      author.textContent = m.fromName || '?';
      author.style.color = `hsl(${m.fromHue ?? 232} 62% 72%)`;
      bubble.append(author);
    }

    if (m.kind === 'sticker' && m.stickerId) {
      bubble.classList.add('is-sticker');
      const img = document.createElement('img');
      img.className = 'sticker-img';
      img.src = stickerSrc(m.stickerId);
      img.alt = 'Стикер';
      img.loading = 'lazy';
      bubble.append(img);
    } else if (m.kind === 'photo' && m.mediaId) {
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
      if (m.editedAt) {
        const edited = document.createElement('span');
        edited.className = 'edited';
        edited.textContent = 'изменено';
        meta.append(edited);
      }
      if (mine) {
        meta.append(eyeBadge(Boolean(m.readAt)));
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
  const key = state.activeKey;
  if (!key) return;
  if (Date.now() - state.typingSentAt < 1600) return;
  state.typingSentAt = Date.now();
  const { type, id } = parseKey(key);
  api('/api/typing', {
    method: 'POST',
    body: type === 'group' ? { group: id } : { to: id },
  }).catch(() => {});
});

let searchTimer = null;

async function runSearch() {
  const query = state.filter.trim();
  if (query.length < 2) {
    state.found = [];
    renderList();
    return;
  }
  try {
    const data = await api('/api/users?q=' + encodeURIComponent(query));
    if (state.filter.trim() !== query) return; // пока искали, запрос сменился
    state.found = (data.users || []).filter((u) => !state.users.some((own) => own.id === u.id));
    renderList();
  } catch {
    state.found = [];
    renderList();
  }
}

$('#search').addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderList();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 280);
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
  state.activeKey = null;
  $('#conversation').hidden = true;
  $('#empty-state').hidden = false;
  renderList();
});

window.addEventListener('focus', () => {
  if (state.activeKey && document.visibilityState === 'visible') markRead(state.activeKey);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.activeKey) markRead(state.activeKey);
});

/* ───────────────────────── старт ───────────────────────── */

async function boot() {
  setAuthMode('login');
  autoGrow();

  if (IS_REMOTE_UI) {
    $('#api-change-foot').hidden = false;
    const ok = await resolveServer();
    if (!ok) {
      showApiSetup();
      return;
    }
    $('#api-current').hidden = false;
    $('#api-current-url').textContent = API_BASE.replace(/^https?:\/\//, '');
  }

  // в закрытом режиме подсказку про регистрацию не показываем
  if (INVITE_REQUIRED) $('#auth-hint').hidden = true;

  if (!state.token) return;
  try {
    await enterChat();
  } catch (err) {
    if (err.status === 401) {
      state.token = '';
      localStorage.removeItem('volna.token');
    } else {
      showAuthError(err.message);
    }
  }
}


/* ───────────────────────── тема ───────────────────────── */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  try {
    localStorage.setItem('volna.theme', theme);
  } catch {
    /* приватный режим */
  }
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem('volna.theme');
  } catch {
    /* приватный режим */
  }
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  applyTheme(saved || (prefersLight ? 'light' : 'dark'));
}

initTheme();

$('#theme').addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

/* ───────────────────────── правка и удаление ───────────────────────── */

function hideMsgMenu() {
  $('#msg-menu').hidden = true;
}

function messageFromRow(row) {
  const key = state.activeKey;
  if (!key || !row) return null;
  const thread = state.threads.get(key);
  if (!thread) return null;
  const message = thread.messages.find((m) => String(m.id) === row.dataset.id);
  return message ? { message, key } : null;
}

function openMsgMenu(target, x, y) {
  const menu = $('#msg-menu');
  const canEdit = (target.kind || 'text') === 'text' && !target.mediaId && !target.stickerId;

  $('#msg-edit').hidden = !canEdit;
  menu.hidden = false;
  menu.dataset.id = String(target.id);
  menu.dataset.key = target.key;
  menu.dataset.body = target.body || '';

  const width = 160;
  const height = canEdit ? 92 : 50;
  menu.style.left = `${Math.min(Math.max(8, x - 24), window.innerWidth - width - 10)}px`;
  menu.style.top = `${Math.min(Math.max(8, y - 12), window.innerHeight - height - 10)}px`;
}

function startEdit() {
  const menu = $('#msg-menu');
  const target = { id: Number(menu.dataset.id), key: menu.dataset.key, body: menu.dataset.body };
  hideMsgMenu();
  if (!target.id) return;

  state.editing = target;
  $('#edit-bar').hidden = false;
  const input = $('#input');
  input.value = target.body;
  input.focus();
  autoGrow();
  input.setSelectionRange(input.value.length, input.value.length);
}

function cancelEdit() {
  state.editing = null;
  $('#edit-bar').hidden = true;
  $('#input').value = '';
  autoGrow();
}

function removeLocalMessage(id, key) {
  const thread = state.threads.get(key);
  if (!thread) return;
  thread.messages = thread.messages.filter((m) => m.id !== id);
  if (key === state.activeKey) renderMessages({ keepScroll: true });
}

function askDelete() {
  const menu = $('#msg-menu');
  const id = Number(menu.dataset.id);
  const key = menu.dataset.key;
  hideMsgMenu();
  if (!id) return;

  openModal('Удалить сообщение?');
  const body = $('#modal-body');
  const hint = document.createElement('p');
  hint.className = 'modal-hint';
  hint.textContent = 'Сообщение исчезнет у тебя и у собеседника.';
  body.append(hint);

  const foot = $('#modal-foot');
  const cancel = document.createElement('button');
  cancel.className = 'btn-ghost';
  cancel.type = 'button';
  cancel.textContent = 'Отмена';
  cancel.addEventListener('click', closeModal);

  const ok = document.createElement('button');
  ok.className = 'btn-ghost btn-danger';
  ok.type = 'button';
  ok.textContent = 'Удалить';
  ok.addEventListener('click', async () => {
    try {
      await api(`/api/messages/${id}`, { method: 'DELETE' });
      closeModal();
      removeLocalMessage(id, key);
    } catch (err) {
      showToast(err.message);
    }
  });
  foot.append(cancel, ok);
}

$('#msg-edit').addEventListener('click', startEdit);
$('#msg-delete').addEventListener('click', askDelete);
$('#edit-cancel').addEventListener('click', cancelEdit);

document.addEventListener('click', (event) => {
  if (!event.target.closest('#msg-menu')) hideMsgMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideMsgMenu();
});

document.addEventListener('contextmenu', (event) => {
  const row = event.target.closest('.row.mine');
  const found = messageFromRow(row);
  if (!found) return;
  event.preventDefault();
  openMsgMenu({ ...found.message, key: found.key }, event.clientX, event.clientY);
});

let pressTimer = null;

document.addEventListener(
  'touchstart',
  (event) => {
    const row = event.target.closest('.row.mine');
    const found = messageFromRow(row);
    if (!found) return;
    const touch = event.touches[0];
    pressTimer = setTimeout(() => {
      openMsgMenu({ ...found.message, key: found.key }, touch.clientX, touch.clientY);
    }, 480);
  },
  { passive: true },
);

document.addEventListener('touchend', () => clearTimeout(pressTimer));
document.addEventListener('touchmove', () => clearTimeout(pressTimer));

/* ───────────────────────── псевдоним контакта ───────────────────────── */

function openRename() {
  const key = state.activeKey;
  if (!key) return;
  const { type, id } = parseKey(key);
  if (type !== 'user') return;
  const peer = state.users.find((u) => u.id === id);
  if (!peer) return;

  openModal('Как показывать контакт?');
  const body = $('#modal-body');
  const hint = document.createElement('p');
  hint.className = 'modal-hint';
  hint.textContent = 'Псевдоним видишь только ты. У собеседника останется обычное имя.';
  const input = document.createElement('input');
  input.className = 'modal-input';
  input.maxLength = 32;
  input.value = peer.nickname || peer.name;
  input.placeholder = peer.name;
  body.append(hint, input);

  const foot = $('#modal-foot');
  const cancel = document.createElement('button');
  cancel.className = 'btn-ghost';
  cancel.type = 'button';
  cancel.textContent = 'Отмена';
  cancel.addEventListener('click', closeModal);

  const save = document.createElement('button');
  save.className = 'btn-ghost is-primary';
  save.type = 'button';
  save.textContent = 'Сохранить';

  const apply = async (nickname) => {
    try {
      const data = await api('/api/users/' + id + '/nickname', { method: 'PUT', body: { nickname } });
      state.users = data.users;
      closeModal();
      renderList();
      renderHead();
      loadUsers();
    } catch (err) {
      showToast(err.message);
    }
  };

  save.addEventListener('click', () => apply(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') apply(input.value);
  });

  if (peer.nickname) {
    const reset = document.createElement('button');
    reset.className = 'btn-ghost';
    reset.type = 'button';
    reset.textContent = 'Вернуть имя';
    reset.addEventListener('click', () => apply(''));
    foot.append(cancel, reset, save);
  } else {
    foot.append(cancel, save);
  }

  setTimeout(() => input.focus(), 30);
}

$('#rename-peer').addEventListener('click', openRename);

// вернулся во вкладку — подтягиваем свежие контакты (псевдонимы, аватары, статусы)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !state.me) return;
  loadUsers();
});
// отладочная ручка: из консоли видно состояние (и удобно проверять автотестами)
window.__volna = state;
window.__volnaApi = API_BASE;

// офлайн-оболочка: позволяет открыть приложение без сети и установить его на телефон
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      /* service worker не критичен */
    });
  });
}

boot();
