'use strict';

// Telegram-библиотека: пользователь пересылает файл книги боту, приложение забирает его через Worker
// и разбирает на устройстве (Parsers.parse -> Reader.addBook). Контракт - CONTRACT_TG.md.
// Все запросы с таймаутами и без исключений: нет сети - тихо ждём следующей попытки.
// Подписи интерфейса здесь не хранятся: приложение подписывается на TG.hooks (change, added, error).

(() => {
  // Переключатель Telegram-библиотеки. false - раздела в настройках, подсказок про бота и автосинхронизации нет,
  // в справке нет упоминаний бота. Включить для проверки на своём компьютере: localStorage reader.tgEnabled = true
  // (работает только на localhost). Перед выкладкой с Worker сменить на true.
  const TG_ENABLED = false;
  let enabled = TG_ENABLED;
  try {
    if (!enabled && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) enabled = JSON.parse(localStorage.getItem('reader.tgEnabled')) === true;
  } catch (e) { /* выключено */ }

  const TG_WORKER = 'https://potok-library.imenie.workers.dev';
  const POLL_MS = 2000;
  const PAIR_MS = 15 * 60000;
  const API_TIMEOUT = 15000;
  const FILE_TIMEOUT = 120000;

  // ---------- состояние: localStorage reader.tg = {key, linked, bot, name} (+ code, expires пока ждём подтверждения) ----------

  function readState() {
    try {
      const v = JSON.parse(localStorage.getItem('reader.tg'));
      return v && typeof v === 'object' && v.key ? v : null;
    } catch (e) {
      return null;
    }
  }

  function saveState() {
    try {
      if (st) localStorage.setItem('reader.tg', JSON.stringify(st));
      else localStorage.removeItem('reader.tg');
    } catch (e) { /* без сохранения */ }
  }

  function baseUrl() {
    try {
      const u = JSON.parse(localStorage.getItem('reader.tgUrl'));
      if (typeof u === 'string' && u) return u.replace(/\/+$/, '');
    } catch (e) { /* по умолчанию */ }
    return TG_WORKER;
  }

  let st = readState();
  let poll = 0;
  let ticking = false;
  let syncing = false;
  const hooks = {};

  function notify(event) {
    try { if (hooks.change) hooks.change(event); } catch (e) { /* ок */ }
  }

  // ---------- запросы ----------

  // -> {status, ok, json} или null (нет сети, таймаут)
  async function api(path, { method = 'GET', auth = true } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), API_TIMEOUT);
    try {
      const headers = {};
      if (auth && st && st.key) headers.Authorization = 'Bearer ' + st.key;
      const r = await fetch(baseUrl() + path, { method, headers, signal: ctl.signal });
      let json = null;
      try { json = await r.json(); } catch (e) { /* без тела */ }
      return { status: r.status, ok: r.ok, json };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // -> {status, blob} или null
  async function fetchFile(id) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FILE_TIMEOUT);
    try {
      const r = await fetch(baseUrl() + '/api/books/' + encodeURIComponent(id) + '/file', {
        headers: { Authorization: 'Bearer ' + st.key },
        signal: ctl.signal,
      });
      if (!r.ok) return { status: r.status, blob: null };
      return { status: r.status, blob: await r.blob() };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- подключение ----------

  function stopPoll() {
    clearInterval(poll);
    poll = 0;
  }

  // время вышло или сервер не знает ключ: возвращаемся к "не подключено"
  function drop(event) {
    stopPoll();
    st = null;
    saveState();
    notify(event);
  }

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (!st || st.linked) {
        stopPoll();
        return;
      }
      if (Date.now() > st.expires) {
        drop('expired');
        return;
      }
      const key = st.key;
      const r = await api('/api/status');
      if (!r || !st || st.key !== key) return;
      if (r.status === 401) drop('expired');
      else if (r.ok && r.json && r.json.linked) {
        st = { key, linked: true, bot: r.json.bot || st.bot, name: r.json.name || '' };
        saveState();
        stopPoll();
        notify('linked');
        sync();
      } else if (r.ok && r.json && r.json.codeExpired) drop('expired');
    } finally {
      ticking = false;
    }
  }

  function startPoll() {
    stopPoll();
    poll = setInterval(tick, POLL_MS);
  }

  // -> {ok: true} или {ok: false, error: 'network' | 'limit'}
  async function connect() {
    if (!enabled) return { ok: false, error: 'network' };
    if (st && !st.linked && poll) return { ok: true };
    const r = await api('/api/pair', { method: 'POST', auth: false });
    if (!r || !r.ok || !r.json || !r.json.key) return { ok: false, error: r && r.status === 429 ? 'limit' : 'network' };
    const j = r.json;
    st = { key: j.key, linked: false, bot: j.bot, name: null, code: j.code, expires: j.expires || Date.now() + PAIR_MS };
    saveState();
    startPoll();
    notify('pending');
    return { ok: true };
  }

  // отмена ожидания: аккаунт на сервере без привязки удаляем, ошибки не важны
  function cancel() {
    if (!st) return;
    const old = st;
    stopPoll();
    st = null;
    saveState();
    notify('cancelled');
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), API_TIMEOUT);
    fetch(baseUrl() + '/api/unlink', { method: 'POST', headers: { Authorization: 'Bearer ' + old.key }, signal: ctl.signal }).catch(() => { /* ок */ });
  }

  async function disconnect() {
    stopPoll();
    if (st && st.key) await api('/api/unlink', { method: 'POST' });
    st = null;
    saveState();
    notify('disconnected');
  }

  // ---------- синхронизация ----------

  // -> null (не подключено или уже идёт) или {added, duplicates, errors, failed}
  async function sync() {
    if (!enabled || syncing || !st || !st.linked) return null;
    syncing = true;
    notify('sync');
    const res = { added: 0, duplicates: 0, errors: 0, failed: false };
    try {
      const r = await api('/api/books?pending=1');
      if (!r) {
        res.failed = true;
        return res;
      }
      if (r.status === 401) {
        drop('revoked');
        return res;
      }
      const list = r.ok && r.json && Array.isArray(r.json.books) ? r.json.books : [];
      for (const b of list) {
        if (!st) break;
        const f = await fetchFile(b.id);
        if (!f) {
          res.failed = true; // нет сети - повторим позже
          break;
        }
        if (!f.blob) {
          if (f.status !== 404) res.failed = true; // Telegram не отдал файл - повторим позже
          continue;
        }
        if (!window.Parsers || !window.Reader) {
          res.failed = true;
          break;
        }
        try {
          const book = await window.Parsers.parse(new File([f.blob], b.name));
          const a = await window.Reader.addBook(book);
          if (a.status === 'added') {
            res.added++;
            if (hooks.added) hooks.added(a.title);
          } else res.duplicates++;
        } catch (e) {
          const code = e && e.name === 'ParseError' ? e.code : 'unknown';
          if (code === 'storage') {
            // нет места: не помечаем доставленной, пользователь освободит место
            res.failed = true;
            if (hooks.error) hooks.error(b.name, code);
            break;
          }
          res.errors++;
          if (hooks.error) hooks.error(b.name, code);
        }
        // доставлена (в том числе дубликат и ошибка разбора), иначе она вернулась бы при каждой проверке
        await api('/api/books/' + encodeURIComponent(b.id) + '/delivered', { method: 'POST' });
      }
      return res;
    } catch (e) {
      res.failed = true;
      return res;
    } finally {
      syncing = false;
      notify('sync-end');
    }
  }

  // сохранённое ожидание подтверждения: продолжаем опрос, пока код не просрочен
  if (enabled && st && !st.linked) {
    if (st.code && st.expires > Date.now()) startPoll();
    else {
      st = null;
      saveState();
    }
  }

  window.TG = {
    enabled,
    hooks,
    state: () => (st ? { ...st } : null),
    linked: () => !!(st && st.linked),
    // ожидание подтверждения: {code, bot, link} или null
    pending: () => (st && !st.linked && st.code
      ? { code: st.code, bot: st.bot, link: 'https://t.me/' + st.bot + '?start=' + st.code }
      : null),
    isSyncing: () => syncing,
    connect,
    cancel,
    disconnect,
    sync,
  };
})();
