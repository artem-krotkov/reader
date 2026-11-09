'use strict';

// Только для сборки Android (Capacitor); в обычном браузере файл ничего не делает.
// 1) "Открыть с помощью" и "Поделиться": нативный плагин FileInbox (FileInboxPlugin.java) копирует файл
//    из content:// / file:// в cache/inbox, здесь он читается через fetch и передаётся в Reader.openFiles.
// 2) Обновления (как в "Библия: скорочтение"): веб-часть меняется тихо (Capgo, ручной режим),
//    новый APK - окно "Вышла версия..." в библиотеке.
// Тексты окна - в strings.js (ключи upd...).

(function () {
  const cap = window.Capacitor;
  if (!cap || !cap.Plugins || (cap.isNativePlatform && !cap.isNativePlatform())) return;

  const P = cap.Plugins;
  const T = window.T || {};
  const UPDATE_URL = 'https://artem-krotkov.github.io/reader/android.json';

  // ---------- файлы из "Открыть с помощью" / "Поделиться" ----------

  const inbox = P.FileInbox;
  let pulling = false;

  // файл с диска -> File (WebView читает его потоком, без base64); затем сразу удаляем копию
  async function toFile(item) {
    try {
      const r = await fetch(cap.convertFileSrc(item.path));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return new File([await r.blob()], item.name, { type: item.mime || '' });
    } finally {
      inbox.release({ path: item.path }).catch(() => { /* ок */ });
    }
  }

  async function pullFiles() {
    if (!inbox || pulling) return;
    pulling = true;
    try {
      await window.Reader.ready;
      for (;;) {
        const { files } = await inbox.takePending();
        if (!files || !files.length) break;
        const list = [];
        for (const item of files) {
          try {
            if (item.error) throw new Error(item.error);
            list.push(await toFile(item));
          } catch (e) {
            // не скопировался или не прочитался: пустой файл - приложение само покажет "файл повреждён" с именем
            list.push(new File([], item.name || 'book'));
          }
        }
        await window.Reader.openFiles(list);
      }
    } catch (e) { /* приложение покажет ошибку само или файла не было */ } finally {
      pulling = false;
    }
  }

  if (inbox) {
    inbox.addListener('filesPending', pullFiles);
    pullFiles(); // файл, с которым запустили приложение
  }

  // ---------- обновления ----------

  const updater = P.CapacitorUpdater;
  let native = null; // {build: номер APK, version: '0.1.N'}
  let updateLater = false;
  let checking = false;
  let webReady = 0;
  let box = null;

  // новая веб-часть запустилась - иначе через 10 с модуль обновлений вернёт прежнюю
  if (updater) {
    window.Reader.ready.then(() => updater.notifyAppReady()).catch(() => { /* ок */ });
  }

  async function nativeInfo() {
    if (native || !P.App) return native;
    const i = await P.App.getInfo();
    native = { build: Number(i.build) || 0, version: i.version };
    return native;
  }

  async function checkUpdate() {
    if (checking) return;
    checking = true;
    try {
      const n = await nativeInfo();
      if (!n) return;
      const r = await fetch(UPDATE_URL + '?t=' + Date.now(), { cache: 'no-store' });
      const u = await r.json();
      // новый APK (обёртка)
      if (u.code > n.build && u.url && !updateLater && !(box && !box.hidden)) showUpdate(u);
      // веб-часть: тихо, включится при следующем запуске
      const w = u.web;
      if (updater && w && w.code > (window.APP_WEB || 0) && n.build >= w.min_native && webReady !== w.code) {
        const { bundles } = await updater.list();
        let b = bundles.find((x) => x.version === w.name && x.status === 'success');
        if (!b) b = await updater.download({ url: UPDATE_URL, version: w.name, manifest: w.manifest });
        await updater.next({ id: b.id });
        webReady = w.code;
      }
    } catch (e) {
      /* нет сети или не скачалось - в другой раз */
    } finally {
      checking = false;
    }
  }

  const CSS = `
#update { position: relative; margin-bottom: 12px; padding: 10px 12px; border: 1px solid var(--faint); border-radius: 10px;
  box-shadow: inset 3px 0 0 var(--accent); background: var(--card); font-size: 14px; line-height: 1.4; color: var(--dim); }
#update[hidden] { display: none; }
#update b { color: var(--fg); font-weight: 600; }
#update .btns { display: flex; gap: 8px; margin-top: 8px; }
#update .btns[hidden] { display: none; }
#update .btns button { min-height: 40px; padding: 0 16px; border: 1px solid var(--faint); border-radius: 8px; color: var(--dim); }
#update .btns button.go { border-color: var(--accent); color: var(--fg); }`;

  function ensureBox() {
    if (box) return box;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
    box = document.createElement('div');
    box.id = 'update';
    box.hidden = true;
    const wrap = document.querySelector('#library .wrap');
    const notice = document.getElementById('notice');
    if (notice) notice.before(box);
    else wrap.append(box);
    return box;
  }

  function showUpdate(u) {
    const b = ensureBox();
    const text = document.createElement('p');
    const title = document.createElement('b');
    title.textContent = T.updTitle.replace('{N}', u.name);
    text.append(title);
    if (u.notes) text.append(document.createElement('br'), u.notes);
    const btns = document.createElement('div');
    btns.className = 'btns';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    go.textContent = T.updGo;
    const later = document.createElement('button');
    later.type = 'button';
    later.textContent = T.updLater;
    btns.append(go, later);
    b.replaceChildren(text, btns);
    b.hidden = false;
    go.onclick = () => {
      btns.hidden = true;
      text.textContent = T.updAfter;
      location.href = u.url; // внешний адрес Capacitor открывает в браузере, дальше установщик Android
    };
    later.onclick = () => {
      updateLater = true;
      b.hidden = true;
    };
  }

  checkUpdate();
  if (P.App) {
    P.App.addListener('resume', checkUpdate);
    if (inbox) P.App.addListener('resume', pullFiles); // событие могло прийти, пока приложение было свёрнуто
  }
})();
