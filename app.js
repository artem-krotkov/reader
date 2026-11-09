'use strict';

// "Поток": читалка книг со скорочтением. Движок RSVP перенесён из "Библия: скорочтение" (ритм не менять),
// текст книги не зашит, а лежит в IndexedDB. Все подписи интерфейса - в strings.js (window.T).

const T = window.T;
const WPM_MIN = 100;
const WPM_MAX = 1000;

const $ = (id) => document.getElementById(id);
const body = document.body;
const el = {
  library: $('library'), reader: $('reader'), panel: $('panel'), dialog: $('dialog'),
  ref: $('ref'), bar: $('bar'), pct: $('pct'), word: $('word'), wl: $('wl'), wp: $('wp'), wr: $('wr'),
  context: $('context'), hint: $('hint'), wpm: $('wpm'),
  sent: $('sent'), st: $('st'), stn: $('st-n'), strip: $('wordstrip'), sl: $('sl'), sp: $('sp'), sr: $('sr'),
  pTitle: $('panel-title'), pBack: $('panel-back'), pList: $('panel-list'),
};

// ---------- мелочи ----------

const fmt = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => (v[k] != null ? v[k] : m));

function plural(n, forms) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return forms[1];
  return forms[2];
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function percent(x) {
  const p = x * 100;
  if (p > 0 && p < 1) return '<1%';
  return (p >= 99.95 ? 100 : Math.floor(p * 10) / 10).toLocaleString('ru-RU') + '%';
}

// точка расширения: аналитика позже (сейчас ничего не отправляется)
function track(name, params) { /* пока пусто */ }

function applyStrings() {
  document.title = T.appTitle;
  document.querySelectorAll('[data-t]').forEach((n) => { n.textContent = T[n.dataset.t]; });
  document.querySelectorAll('[data-aria]').forEach((n) => { n.setAttribute('aria-label', T[n.dataset.aria]); });
}

// ---------- хранилище ----------
// localStorage: ключи reader.*, значения - JSON. IndexedDB: books (метаданные), texts (главы).

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem('reader.' + key));
    return v ?? fallback;
  } catch (e) {
    return fallback;
  }
}

function store(key, value) {
  try { localStorage.setItem('reader.' + key, JSON.stringify(value)); } catch (e) { /* без сохранения */ }
}

function forget(key) {
  try { localStorage.removeItem('reader.' + key); } catch (e) { /* ок */ }
}

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('no indexedDB'));
        return;
      }
      const r = indexedDB.open('reader', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('books', { keyPath: 'id' });
        r.result.createObjectStore('texts', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

async function idbGet(name, key) { return req((await db()).transaction(name).objectStore(name).get(key)); }
async function idbAll(name) { return req((await db()).transaction(name).objectStore(name).getAll()); }
async function idbPut(name, value) { return req((await db()).transaction(name, 'readwrite').objectStore(name).put(value)); }

// несколько записей одной транзакцией: [[хранилище, значение], ...] или удаление [[хранилище, null, ключ], ...]
async function idbWrite(ops) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction([...new Set(ops.map((o) => o[0]))], 'readwrite');
    for (const [name, value, key] of ops) {
      if (value) t.objectStore(name).put(value);
      else t.objectStore(name).delete(key);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---------- разбивка абзаца на слова ----------

const LETTER = /[\p{L}\p{N}]/u;
// короткие служебные слова мелькают и проскакивают - показываем их вместе с основным словом:
// "before" - со следующим ("и сказал", "в доме", "не ходит"), "after" - с предыдущим ("знаешь ли").
// Наборы зависят от языка книги; прочие языки - без склейки
const SETS = {
  ru: {
    before: new Set(['и', 'а', 'в', 'во', 'к', 'ко', 'с', 'со', 'о', 'об', 'у', 'на', 'по', 'от', 'за', 'из', 'до', 'не', 'ни']),
    after: new Set(['ли', 'же', 'ж', 'бы', 'б']),
    neg: new Set(['не', 'ни']),
  },
  en: {
    before: new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or', 'not', 'no']),
    after: new Set(),
    neg: new Set(['not', 'no']),
  },
  none: { before: new Set(), after: new Set(), neg: new Set() },
};
let sets = SETS.none;

function setsFor(lang) {
  const l = String(lang || '').toLowerCase();
  if (l.startsWith('ru')) return SETS.ru;
  if (l.startsWith('en')) return SETS.en;
  return SETS.none;
}

const CHUNK_MAX = 4;
// (в отличие от Библии срезаем и ведущее тире: абзацы диалогов начинаются с "— и сказал")
const bare = (w) => w.toLowerCase().replace(/^[\s"«“„(\[—–-]+/, '');
// конец предложения, в том числе внутри прямой речи: "камни?",", "так? —"
const SENT_END = /[.!?…]["»”')]*(\s*[,;:\-—]["»”')]*)?$/;

// слова абзаца: одиночные знаки и тире приклеиваются к предыдущему слову, но после конца предложения
// ("он. — Домой") и в начале абзаца ("— Куда?") - к следующему, иначе тире мелькало бы отдельным показом
const ENDS_SENTENCE = /[.!?…]["»”')]*$/;

function splitWords(s) {
  const words = [];
  let prefix = '';
  for (const part of s.split(/\s+/)) {
    if (!part) continue;
    if (!LETTER.test(part)) {
      if (words.length && !ENDS_SENTENCE.test(words[words.length - 1])) words[words.length - 1] += ' ' + part;
      else prefix = prefix ? prefix + ' ' + part : part;
    } else {
      words.push(prefix ? prefix + ' ' + part : part);
      prefix = '';
    }
  }
  if (prefix) {
    if (words.length) words[words.length - 1] += ' ' + prefix;
    else words.push(prefix);
  }
  return words;
}

// то же число слов, что даёт splitWords, но без создания строк (для импорта)
function countWords(s) {
  let n = 0;
  let any = false;
  for (const part of s.split(/\s+/)) {
    if (!part) continue;
    any = true;
    if (LETTER.test(part)) n++;
  }
  return n || (any ? 1 : 0);
}

// сокращения, после которых предложение не заканчивается, даже если дальше слово с большой буквы ("г. Минск", "Mr. Smith")
const ABBR = new Set(['т.е', 'т.к', 'т.н', 'т.о', 'ул', 'д', 'кв', 'стр', 'рис', 'см', 'ср', 'напр', 'проф', 'акад',
  'доц', 'им', 'пер', 'просп', 'обл', 'пос', 'тов', 'гр', 'св', 'mr', 'mrs', 'ms', 'dr', 'prof', 'vs', 'e.g', 'i.e', 'fig', 'vol']);

// граница предложений после показа w (для шага назад/вперёд; ритм этим не меняется)
function isBoundary(units, words, w, atStart) {
  const u = units[w];
  if (!SENT_END.test(u.t)) return false;
  const last = words[u.o + u.k - 1];
  const core = last.replace(/[\s"»”')\]\-—–,;:]+$/, '');
  const next = words[units[w + 1].o].replace(/^[\s"«“„'(\[—–-]+/, '');
  if (core.endsWith('.') && !core.endsWith('..')) {
    const raw = core.slice(0, -1).replace(/^[^\p{L}\p{N}]+/u, '');
    const low = raw.toLowerCase();
    if (/^\p{Lu}$/u.test(raw)) {
      // инициал ("А. С. Пушкин"); одинокое "Я." в начале предложения перед обычным словом - всё же конец
      if (!atStart || /^\p{Lu}\.$/u.test(next)) return false;
    } else if (/^(\p{Lu}\.)+\p{Lu}$/u.test(raw)) return false;
    else if (ABBR.has(low)) return false;
    else if ((low === 'г' || low === 'гг') && !/\d/.test(words[u.o + u.k - 2] || '')) return false;
  }
  // после знака идёт строчная буква ("— Куда? — спросил он"): предложение продолжается
  return !/^\p{Ll}/u.test(next);
}

// показы абзаца: t - текст, o - номер первого слова в абзаце, k - сколько слов,
// m - границы основного слова в t (на нём красная буква), g - есть отрицание,
// e - последний показ абзаца, s - первое слово после конца предложения (после паузы глазу нужно время)
function tokenize(text) {
  const words = splitWords(text);
  const { before, after, neg } = sets;
  const units = [];
  let k = 0;
  while (k < words.length) {
    const from = k;
    while (before.has(bare(words[k])) && k + 1 < words.length && k - from + 1 < CHUNK_MAX) k++;
    const main = k;
    const next = words[k + 1];
    if (next && after.has(bare(next).replace(/[^\p{L}]/gu, '')) && k - from + 1 < CHUNK_MAX) k++;
    const parts = words.slice(from, k + 1);
    const start = words.slice(from, main).reduce((n, w) => n + w.length + 1, 0);
    units.push({
      t: parts.join(' '),
      o: from,
      k: parts.length,
      m: [start, start + words[main].length],
      g: words.slice(from, main).some((w) => neg.has(bare(w))),
    });
    k++;
  }
  let afterEnd = true;
  const starts = [];
  units.forEach((u, w) => {
    u.e = w === units.length - 1;
    u.s = afterEnd;
    afterEnd = SENT_END.test(u.t);
    if (!w || (starts.length && isBoundary(units, words, w - 1, starts[starts.length - 1] === w - 1))) starts.push(w);
  });
  units.starts = starts; // номера показов, с которых начинаются предложения
  return units;
}

// ---------- открытая книга ----------

const EMPTY_BOOK = { meta: null, chapters: null, pw: null, start: null };
let bk = EMPTY_BOOK;
let paraCache = new Map();
let headCache = new Map();
let cumCache = new Map();
let readMap = {}; // глава -> строка из 0/1 по абзацам (прочитан, когда показано его последнее слово)

function unitsAt(ch, p) {
  const key = ch + ':' + p;
  let u = paraCache.get(key);
  if (!u) {
    u = tokenize(bk.chapters[ch].paras[p]);
    if (paraCache.size > 600) paraCache.delete(paraCache.keys().next().value);
    paraCache.set(key, u);
  }
  return u;
}

// слова до начала каждого абзаца главы (лениво, один раз на главу)
function cumOf(ch) {
  let c = cumCache.get(ch);
  if (!c) {
    const pw = bk.pw[ch];
    c = new Int32Array(pw.length + 1);
    for (let i = 0; i < pw.length; i++) c[i + 1] = c[i] + pw[i];
    if (cumCache.size > 8) cumCache.delete(cumCache.keys().next().value);
    cumCache.set(ch, c);
  }
  return c;
}

function chapterLabel(ch) {
  const c = bk.chapters[ch];
  if (c.title) return c.title;
  return bk.chapters.length === 1 ? bk.meta.title : fmt(T.chapterN, { n: ch + 1 });
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

// заголовок главы - первый показ при входе в неё (p = -1)
function headToken(ch) {
  let h = headCache.get(ch);
  if (!h) {
    const t = clip(chapterLabel(ch), 36);
    h = { t, h: true, m: [0, t.length], k: 0, g: false, e: false, s: false, o: 0 };
    headCache.set(ch, h);
  }
  return h;
}

// позиция в памяти: {ch, p, i} (p = -1 - заголовок главы, i - номер показа в абзаце);
// сохраняется как {ch, p, o, w}: o - номер слова в абзаце, w - сколько слов книги до этого места,
// чтобы изменения разбивки на показы не сдвигали сохранённое место
let pos = { ch: 0, p: -1, i: 0 };

const cur = () => (pos.p < 0 ? headToken(pos.ch) : unitsAt(pos.ch, pos.p)[pos.i]);

function wordsBefore(q) {
  if (q.p < 0) return bk.start[q.ch];
  return bk.start[q.ch] + cumOf(q.ch)[q.p] + unitsAt(q.ch, q.p)[q.i].o;
}

function freeze(q) {
  return { ch: q.ch, p: q.p, o: q.p < 0 ? 0 : unitsAt(q.ch, q.p)[q.i].o, w: wordsBefore(q) };
}

function resolve(s) {
  if (!s || !Number.isInteger(s.ch) || !bk.chapters[s.ch]) return null;
  const c = bk.chapters[s.ch];
  if (!(s.p >= 0) || s.p >= c.paras.length) return { ch: s.ch, p: -1, i: 0 };
  const u = unitsAt(s.ch, s.p);
  if (!u.length) return { ch: s.ch, p: -1, i: 0 };
  let i = 0;
  for (let k = 0; k < u.length; k++) if (u[k].o <= (s.o || 0)) i = k;
  return { ch: s.ch, p: s.p, i };
}

// ---------- предложения: шаги назад и вперёд ----------

// границы предложения [первый показ, последний показ] в абзаце
function sentenceOf(u, i) {
  const st = u.starts;
  let lo = 0;
  let hi = st.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (st[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return [st[lo], lo + 1 < st.length ? st[lo + 1] - 1 : u.length - 1];
}

// ставит pos на начало абзаца p главы ch (пустые пропускает); дальше конца главы - заголовок следующей; false - книга кончилась
function startAt(ch, p) {
  for (;;) {
    if (p < bk.chapters[ch].paras.length) {
      if (unitsAt(ch, p).length) {
        pos = { ch, p, i: 0 };
        return true;
      }
      p++;
    } else {
      if (ch + 1 >= bk.chapters.length) return false;
      pos = { ch: ch + 1, p: -1, i: 0 };
      return true;
    }
  }
}

// ставит pos на начало последнего предложения перед абзацем p главы ch (в пределах главы); false - там ничего нет
function lastSentenceBefore(ch, p) {
  while (--p >= 0) {
    const u = unitsAt(ch, p);
    if (u.length) {
      pos = { ch, p, i: u.starts[u.starts.length - 1] };
      return true;
    }
  }
  return false;
}

function advance() {
  if (pos.p < 0) return startAt(pos.ch, 0);
  const u = unitsAt(pos.ch, pos.p);
  if (pos.i + 1 < u.length) {
    pos.i++;
    return true;
  }
  return startAt(pos.ch, pos.p + 1);
}

function prevSentence() {
  if (pos.p < 0) {
    // с заголовка главы - к последнему предложению предыдущей (или к её заголовку, если она пуста)
    if (pos.ch > 0) {
      const ch = pos.ch - 1;
      if (!lastSentenceBefore(ch, bk.chapters[ch].paras.length)) pos = { ch, p: -1, i: 0 };
    }
  } else {
    const u = unitsAt(pos.ch, pos.p);
    const [a] = sentenceOf(u, pos.i);
    if (pos.i > a) pos.i = a;
    else if (a > 0) pos.i = u.starts[u.starts.indexOf(a) - 1];
    else if (!lastSentenceBefore(pos.ch, pos.p)) pos = { ch: pos.ch, p: -1, i: 0 }; // с первого предложения главы - к заголовку
  }
  showPaused();
}

function nextSentence() {
  let ok = true;
  if (pos.p < 0) {
    ok = startAt(pos.ch, 0);
  } else {
    const u = unitsAt(pos.ch, pos.p);
    const [, z] = sentenceOf(u, pos.i);
    if (z + 1 < u.length) pos.i = z + 1;
    else ok = startAt(pos.ch, pos.p + 1);
  }
  if (!ok) toast(T.bookEnd);
  showPaused();
}


// ---------- показ предложениями ----------
// view: 'words' (по умолчанию, RSVP) или 'sentence' - предложение целиком в #sent, без автосмены и скорости:
// листание только касанием у краёв и кнопками. Длинное предложение делится на части (экраны) по смыслу.
// Позиция по-прежнему {ch, p, i}: в этом режиме i - первый показ на экране; сохраняется как первое слово экрана.

let view = load('view', 'words') === 'sentence' ? 'sentence' : 'words';
const sentenceView = () => view === 'sentence';
const screenCache = new Map(); // 'гл:абз:начало предложения' -> части [[первый показ, последний показ], ...]
const MIN_FILL = 0.4; // на экране остаётся не меньше 40% того, что влезло: лучше крупный кусок, чем разрез в неудобном месте

// влезает ли текст показов a..z абзаца в блок предложения (меряется в самом блоке)
function fitsUnits(u, a, z) {
  el.sent.classList.remove('heading');
  const parts = [];
  for (let k = a; k <= z; k++) parts.push(u[k].t);
  el.st.textContent = parts.join(' ');
  return el.st.offsetHeight <= el.sent.clientHeight - 6;
}

// сила границы после показа q: конец предложения, затем ";" и ":", затем запятая и тире
function breakStrength(u, q) {
  const t = u[q].t;
  if (SENT_END.test(t)) return 3;
  if (/[;:]["»”')]*$/.test(t)) return 2;
  if (/[,—–]["»”')]*$/.test(t)) return 1;
  return 0;
}

// части предложения a..z: сначала целиком; иначе экран набирается "сколько влезет" (бинарный поиск),
// затем край сдвигается назад к ближайшей границе по смыслу (не дальше, чем до 40% экрана); иначе режем по слову
function splitUnits(u, a, z) {
  const parts = [];
  let from = a;
  while (from <= z) {
    let lo = from;
    let hi = z;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fitsUnits(u, from, mid)) lo = mid;
      else hi = mid - 1;
    }
    let end = lo;
    if (end < z) {
      const floor = from + Math.max(0, Math.floor((end - from + 1) * MIN_FILL) - 1);
      for (const need of [3, 2, 1]) {
        let q = end;
        while (q >= floor && breakStrength(u, q) < need) q--;
        if (q >= floor) {
          end = q;
          break;
        }
      }
    }
    parts.push([from, end]);
    from = end + 1;
  }
  return parts;
}

function partsOf(ch, p, a, z) {
  const key = ch + ':' + p + ':' + a;
  let parts = screenCache.get(key);
  if (!parts) {
    const u = unitsAt(ch, p);
    parts = a === z || fitsUnits(u, a, z) ? [[a, z]] : splitUnits(u, a, z);
    if (screenCache.size > 300) screenCache.delete(screenCache.keys().next().value);
    screenCache.set(key, parts);
  }
  return parts;
}

// экран позиции: {u, parts, k, a, z}; для заголовка главы null
function screenOf() {
  if (pos.p < 0) return null;
  const u = unitsAt(pos.ch, pos.p);
  const [a, z] = sentenceOf(u, pos.i);
  const parts = partsOf(pos.ch, pos.p, a, z);
  let k = parts.findIndex((q) => pos.i >= q[0] && pos.i <= q[1]);
  if (k < 0) k = 0;
  return { u, parts, k, a, z };
}

// позиция - в начало экрана, на котором лежит текущее слово
function snapToScreen() {
  const s = screenOf();
  if (s) pos.i = s.parts[s.k][0];
}

function toLastPart() {
  const s = screenOf();
  pos.i = s.parts[s.parts.length - 1][0];
}

// экран назад: часть, затем предыдущее предложение (его последняя часть), абзац, заголовок главы
function prevScreen() {
  if (pos.p < 0) {
    if (pos.ch > 0) {
      const ch = pos.ch - 1;
      if (lastSentenceBefore(ch, bk.chapters[ch].paras.length)) toLastPart();
      else pos = { ch, p: -1, i: 0 };
    }
    return;
  }
  const s = screenOf();
  if (s.k > 0) pos.i = s.parts[s.k - 1][0];
  else if (s.a > 0) {
    pos.i = s.u.starts[s.u.starts.indexOf(s.a) - 1];
    toLastPart();
  } else if (lastSentenceBefore(pos.ch, pos.p)) toLastPart();
  else pos = { ch: pos.ch, p: -1, i: 0 };
}

// экран вперёд; false - книга кончилась
function nextScreen() {
  if (pos.p < 0) return startAt(pos.ch, 0);
  const s = screenOf();
  if (s.k + 1 < s.parts.length) pos.i = s.parts[s.k + 1][0];
  else if (s.z + 1 < s.u.length) pos.i = s.z + 1;
  else return startAt(pos.ch, pos.p + 1);
  return true;
}

// шаг назад/вперёд для краёв, кнопок и стрелок; в режиме предложений вперёд - это чтение (считается в статистику)
function goPrev() {
  if (sentenceView()) {
    prevScreen();
    showPaused();
  } else prevSentence();
}

function goNext() {
  if (!sentenceView()) {
    nextSentence();
    return;
  }
  if (!session) startSession(true);
  const ok = nextScreen();
  if (!ok) toast(T.bookEnd);
  else countScreen();
  showPaused();
}

// экран показан при листании: считаем его слова, абзац - прочитанным, когда показан его последний показ
function countScreen() {
  const s = screenOf();
  if (!s || !session) return;
  const [i0, i1] = s.parts[s.k];
  for (let k = i0; k <= i1; k++) session.words += s.u[k].k;
  if (i1 === s.u.length - 1) markPara(pos.ch, pos.p);
  touchManual();
  if (!body.classList.contains('started')) {
    body.classList.add('started');
    if (!load('hintSeen', false)) store('hintSeen', true);
  }
}

// ручная сессия статистики: кончается после минуты без касаний (время - по последнему касанию),
// при выходе в меню или библиотеку, сворачивании, смене показа
let manualIdle = 0;

function touchManual() {
  if (!sentenceView() || playing || !session) return;
  session.last = Date.now();
  clearTimeout(manualIdle);
  manualIdle = setTimeout(endManual, 60000);
}

function endManual() {
  clearTimeout(manualIdle);
  if (playing || !session) return;
  endSession(session.last || Date.now());
  savePos();
}

function setView(v) {
  pause();
  endManual();
  view = v;
  store('view', v);
  body.classList.toggle('sentence-view', sentenceView());
  if (!bk.meta || el.reader.hidden) return;
  measure(); // заодно сбрасывает кэш экранов
  if (sentenceView()) snapToScreen();
  showHint();
  showPaused();
}

const toggleView = () => setView(sentenceView() ? 'words' : 'sentence');

// ---------- шрифт, тема, управление ----------

const FONTS = [
  ['system', 'Roboto, "Segoe UI", system-ui, sans-serif'],
  ['condensed', '"Roboto Condensed", Roboto, system-ui, sans-serif'],
  ['literata', 'Literata, Georgia, serif'],
];
const THEMES = [['black', '#000000'], ['gray', '#1c1c1e'], ['light', '#ffffff']];
const MODES = ['hold', 'tap'];

let font = FONTS.find((f) => f[0] === load('font', 'system')) || FONTS[0];
let theme = THEMES.find((x) => x[0] === load('theme', 'black')) || THEMES[0];
let mode = MODES.includes(load('mode', 'hold')) ? load('mode', 'hold') : 'hold';
let wpm = 275;
const roundSpeed = (w) => Math.min(WPM_MAX, Math.max(WPM_MIN, w < 500 ? Math.round(w / 25) * 25 : Math.round(w / 50) * 50));
wpm = roundSpeed(Number(load('wpm', 275)) || 275);

const ctx = document.createElement('canvas').getContext('2d');

function textWidth(s, fs) {
  ctx.font = fs + 'px ' + font[1];
  return ctx.measureText(s).width;
}

// размер слова постоянный, чтобы не скакал: по обе стороны от красной буквы влезает FIT_CHARS знаков
// средней ширины (99,9% показов); длиннее - только 1 показ из 1000, его уменьшаем
const FIT_CHARS = 10.5;
const SAMPLE = 'и сказал Бог: да будет свет. и стал свет, и увидел Бог свет, что он хорош';
let baseFs = 44;

function measure() {
  screenCache.clear();
  const w = el.word.clientWidth || $('progress').clientWidth || window.innerWidth - 32;
  const charW = textWidth(SAMPLE, 100) / 100 / SAMPLE.length;
  baseFs = Math.min(60, (w / 2) * 0.96 / (FIT_CHARS * charW));
  el.word.style.setProperty('--line', Math.ceil(baseFs * 1.3) + 'px');
}

// заново подогнать размер и перерисовать, если книга открыта на экране
function relayout() {
  if (!bk.meta || el.reader.hidden) return;
  measure();
  render();
}

function applyFont(f) {
  font = f;
  document.documentElement.style.setProperty('--read-font', f[1]);
  relayout();
  // свой шрифт грузится не сразу - пересчитать размер, когда загрузится
  if (document.fonts) document.fonts.load('40px ' + f[1], SAMPLE).then(() => { if (font === f) relayout(); }, () => {});
}

function applyTheme(x) {
  theme = x;
  document.documentElement.setAttribute('data-theme', x[0]);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', x[1]);
}

// ---------- отрисовка слова ----------

function pivotIndex(t) {
  const letters = [];
  for (let i = 0; i < t.length; i++) if (LETTER.test(t[i])) letters.push(i);
  if (!letters.length) return 0;
  const n = letters.length;
  // у очень длинных слов фокус ближе к середине, иначе слово пришлось бы сильно уменьшать
  const k = n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : Math.round(n * 0.4);
  return letters[k];
}

// фокус считаем по всей связке ("и не стоит"), чтобы она не уезжала влево,
// но красную букву ставим только в основное слово - ближайшую к этой точке
function pivotOf(t) {
  const [a, z] = t.m;
  const p = pivotIndex(t.t);
  if (p >= a && p < z) return p;
  const letters = [];
  for (let i = a; i < z; i++) if (LETTER.test(t.t[i])) letters.push(i);
  if (!letters.length) return p;
  return p < a ? letters[0] : letters[letters.length - 1];
}

// размер слова, чтобы оно влезло по обе стороны от красной буквы в ширину w
function fitFs(t, w, base) {
  const p = pivotOf(t);
  const room = (w - textWidth(t.t[p] || '', base)) / 2 * 0.98;
  const need = Math.max(textWidth(t.t.slice(0, p), base), textWidth(t.t.slice(p + 1), base));
  return need > room ? base * room / need : base;
}

function render() {
  const t = cur();
  const w = el.word.clientWidth || window.innerWidth - 32;
  if (sentenceView()) renderSentence();
  else if (t.h) {
    el.word.classList.add('heading');
    el.wl.textContent = '';
    el.wp.textContent = t.t;
    el.wr.textContent = '';
    // заголовок крупнее 30 px не бывает (style.css), а длинный на узком экране уменьшаем, чтобы влез
    const big = Math.min(baseFs, 30);
    el.word.style.setProperty('--fs', Math.min(big, big * w * 0.96 / textWidth(t.t, big)).toFixed(1) + 'px');
  } else {
    el.word.classList.remove('heading');
    const p = pivotOf(t);
    el.wl.textContent = t.t.slice(0, p);
    el.wp.textContent = t.t[p] || '';
    el.wr.textContent = t.t.slice(p + 1);
    // размер постоянный; слово, которое не влезает по обе стороны от красной буквы, уменьшаем
    el.word.style.setProperty('--fs', fitFs(t, w, baseFs).toFixed(1) + 'px');
  }
  const label = chapterLabel(pos.ch);
  if (el.ref.textContent !== label) el.ref.textContent = label;
  const x = wordsBefore(pos) / Math.max(1, bk.meta.words);
  el.bar.style.width = (100 * x).toFixed(2) + '%';
  const pct = Math.floor(x * 100) + '%';
  if (el.pct.textContent !== pct) el.pct.textContent = pct;
}

// экран предложения: текст целиком (или его часть) и номер части; заголовок главы - отдельный экран
function renderSentence() {
  const s = screenOf();
  el.sent.classList.toggle('heading', !s);
  if (!s) {
    el.st.textContent = chapterLabel(pos.ch);
    el.stn.textContent = '';
  } else {
    const [i0, i1] = s.parts[s.k];
    const parts = [];
    for (let k = i0; k <= i1; k++) parts.push(s.u[k].t);
    el.st.textContent = parts.join(' ');
    el.stn.textContent = s.parts.length > 1 ? (s.k + 1) + ' / ' + s.parts.length : '';
  }
  // строка внизу: первое слово экрана, касание возвращает к словам
  const t = cur();
  const p = pivotOf(t);
  el.sl.textContent = t.h ? '' : t.t.slice(0, p);
  el.sp.textContent = t.h ? t.t : t.t[p] || '';
  el.sr.textContent = t.h ? '' : t.t.slice(p + 1);
  el.strip.classList.toggle('heading', !!t.h);
  const w = (el.strip.clientWidth || window.innerWidth - 32) - 16;
  el.strip.style.setProperty('--fs', fitFs(t, w, Math.min(baseFs, 30)).toFixed(1) + 'px');
}

// на паузе: всё предложение с подсвеченным текущим словом (длинное предложение - окно вокруг слова)
const CTX_BEFORE = 25;
const CTX_AFTER = 35;

function renderContext() {
  const t = cur();
  body.classList.toggle('has-context', !t.h);
  el.context.scrollTop = 0;
  if (t.h || sentenceView()) {
    el.context.textContent = '';
    return;
  }
  const u = unitsAt(pos.ch, pos.p);
  let [a, z] = sentenceOf(u, pos.i);
  let pre = '';
  let post = '';
  if (pos.i - a > CTX_BEFORE) {
    a = pos.i - CTX_BEFORE;
    pre = '… ';
  }
  if (z - pos.i > CTX_AFTER) {
    z = pos.i + CTX_AFTER;
    post = ' …';
  }
  const parts = [];
  for (let k = a; k <= z; k++) parts.push(k === pos.i ? '<mark>' + escapeHtml(u[k].t) + '</mark>' : escapeHtml(u[k].t));
  el.context.innerHTML = pre + parts.join(' ') + post;
  const m = el.context.querySelector('mark');
  if (m && el.context.scrollHeight > el.context.clientHeight) {
    const off = m.getBoundingClientRect().top - el.context.getBoundingClientRect().top;
    el.context.scrollTop = Math.max(0, off - el.context.clientHeight / 2);
  }
}

function savePos() {
  if (bk.meta) store('pos.' + bk.meta.id, freeze(pos));
}

function showPaused() {
  render();
  renderContext();
  savePos();
}

// ---------- ритм ----------

const RHYTHM_FLOOR = 1.43;
const RHYTHM_SCALE = 0.7675;

function delayFor(t) {
  const base = 60000 / wpm;
  if (t.h) return Math.max(900, base * 3);
  let d = base;
  const n = (t.t.slice(t.m[0], t.m[1]).match(/[\p{L}\p{N}]/gu) || []).length;
  // длинные слова дольше; очень длинные (от 14 букв) - заметно дольше
  if (n > 13) d *= Math.min(2.5, 1.48 + (n - 13) * 0.12);
  else if (n > 7) d *= 1 + (n - 7) * 0.08;
  if (SENT_END.test(t.t)) d *= 2.2;
  else if (/[,;:\-—]["»”')]*$/.test(t.t)) d *= 1.6;
  if (t.e) d *= 1.15;
  // каждое прицепленное служебное слово +40%, отрицание ещё +10%
  if (t.k > 1) d *= 1 + 0.4 * (t.k - 1);
  if (t.g) d *= 1.1;
  // начало предложения: после длинной паузы короткое "Он", "я" иначе мелькает
  if (t.s) d *= n <= 3 ? 1.5 : 1.25;
  // ритм 2: ни один показ не короче среднего ритма (иначе короткие слова "разгоняются" на фоне пауз),
  // и всё масштабировано так, чтобы реальная скорость совпадала с настройкой
  return Math.max(d, base * RHYTHM_FLOOR) * RHYTHM_SCALE;
}

// ---------- воспроизведение: держишь палец - идёт, отпустил - пауза ----------

let playing = false;
let timer = 0;
let wake = null;
let sleepTimer = 0;
const plugins = (window.Capacitor && window.Capacitor.Plugins) || {};

// экран не гаснет, пока читаем, и ещё минуту после паузы
async function keepAwake() {
  clearTimeout(sleepTimer);
  try {
    if (plugins.KeepAwake) await plugins.KeepAwake.keepAwake();
    else if ('wakeLock' in navigator && !wake) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    }
  } catch (e) { /* не поддерживается */ }
}

function allowSleepLater() {
  clearTimeout(sleepTimer);
  sleepTimer = setTimeout(() => {
    try {
      if (plugins.KeepAwake) plugins.KeepAwake.allowSleep();
      else if (wake) wake.release();
    } catch (e) { /* ок */ }
  }, 60000);
}

// ---------- статистика чтения ----------

let days = load('days', {}); // 'ГГГГ-ММ-ДД' -> {ms, words} - по всем книгам
if (!days || typeof days !== 'object' || Array.isArray(days)) days = {};
let session = null;

function dateKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// абзац прочитан, когда во время чтения показано его последнее слово
function markPara(ch, p) {
  const n = bk.chapters[ch].paras.length;
  let s = readMap[ch];
  if (!s || s.length !== n) s = '0'.repeat(n);
  if (s[p] === '1') return;
  readMap[ch] = s.slice(0, p) + '1' + s.slice(p + 1);
}

// доля прочитанных слов главы
function readFraction(ch) {
  const s = readMap[ch];
  const pw = bk.pw[ch];
  if (!s || s.length !== pw.length) return 0;
  let n = 0;
  let total = 0;
  for (let i = 0; i < pw.length; i++) {
    total += pw[i];
    if (s[i] === '1') n += pw[i];
  }
  return total ? n / total : 0;
}

function startSession(manual) {
  session = { t: Date.now(), words: 0, manual: !!manual };
}

function endSession(at) {
  const s = session;
  session = null;
  if (!s || !s.words) return;
  const now = at || Date.now();
  const ms = now - s.t;
  track('read', { words: s.words, seconds: Math.round(ms / 1000), wpm });
  const day = days[dateKey(now)] || { ms: 0, words: 0 };
  day.ms += ms;
  day.words += s.words;
  days[dateKey(now)] = day;
  store('days', days);
  store('read.' + bk.meta.id, readMap);
  // реальная скорость книги считается только по режиму слов; чтение предложениями копится отдельно
  if (s.manual) {
    bk.meta.sentWords = (bk.meta.sentWords || 0) + s.words;
    bk.meta.sentMs = (bk.meta.sentMs || 0) + ms;
  } else {
    bk.meta.wordsRead = (bk.meta.wordsRead || 0) + s.words;
    bk.meta.readMs = (bk.meta.readMs || 0) + ms;
  }
  idbPut('books', bk.meta).catch(() => { /* ок */ });
}

function play() {
  if (playing || !bk.meta || sentenceView()) return;
  playing = true;
  body.classList.add('playing', 'started');
  if (!load('hintSeen', false)) store('hintSeen', true);
  startSession();
  keepAwake();
  render();
  // текущее слово показываем чуть дольше, чтобы глаз успел поймать ритм
  const t = cur();
  timer = setTimeout(step, delayFor(t) * (t.h ? 1 : 1.5));
}

function step() {
  if (!playing) return;
  if (!advance()) {
    pause();
    toast(T.bookEnd);
    return;
  }
  const t = cur();
  if (session && !t.h) session.words += t.k;
  if (t.e) markPara(pos.ch, pos.p);
  render();
  timer = setTimeout(step, delayFor(t));
}

function pause() {
  if (!playing) return;
  playing = false;
  clearTimeout(timer);
  body.classList.remove('playing');
  endSession();
  allowSleepLater();
  showPaused();
}

// ---------- касания ----------
// hold - держишь палец - идёт, отпустил - пауза; tap - касание: старт и стоп.
// У краёв (20% ширины) короткое касание - предложение назад/вперёд, удержание - чтение (в режиме hold)

const pointers = new Set();
const TAP_MS = 220;
const TAP_MOVE = 20;
// свайп вверх или вниз переключает показ слова/предложение (в режиме "держать палец" чтение успевает стартовать - свайп его останавливает)
const SWIPE_MIN = 70;
let edge = null;
let swipe = null;

function edgeSide(x) {
  const w = el.reader.clientWidth;
  const zone = Math.max(56, w * 0.2);
  return x < zone ? -1 : x > w - zone ? 1 : 0;
}

function flash(side) {
  const f = $('flash');
  f.className = side < 0 ? 'left' : 'right';
  void f.offsetWidth;
  f.classList.add('on');
}

el.reader.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.ui')) return;
  e.preventDefault();
  pointers.add(e.pointerId);
  try { el.reader.setPointerCapture(e.pointerId); } catch (err) { /* ок */ }
  const side = edgeSide(e.clientX);
  swipe = pointers.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
  // предложение внизу на паузе: короткое касание - показ предложениями, удержание - чтение (как у краёв)
  if (!sentenceView() && !playing && pointers.size === 1 && e.target.closest('#context')) {
    edge = { id: e.pointerId, side: 0, ctx: true, x: e.clientX, y: e.clientY };
    if (mode === 'hold') edge.timer = setTimeout(() => { edge = null; play(); }, TAP_MS);
    return;
  }
  if (sentenceView()) {
    // предложения листаются только касанием у края; середина экрана ничего не делает
    if (side && pointers.size === 1) edge = { id: e.pointerId, side, x: e.clientX, y: e.clientY };
    return;
  }
  if (mode === 'tap') {
    if (pointers.size > 1) return;
    if (playing) pause();
    else if (side) edge = { id: e.pointerId, side, x: e.clientX, y: e.clientY };
    else play();
    return;
  }
  if (side && !playing && pointers.size === 1) {
    edge = { id: e.pointerId, side, x: e.clientX, y: e.clientY };
    edge.timer = setTimeout(() => { edge = null; play(); }, TAP_MS);
    return;
  }
  play();
});

el.reader.addEventListener('pointermove', (e) => {
  if (swipe && swipe.id === e.pointerId) {
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.abs(dy) > SWIPE_MIN && Math.abs(dy) > 1.8 * Math.abs(dx)) {
      swipe = null;
      if (edge) clearTimeout(edge.timer);
      edge = null;
      toggleView();
      return;
    }
  }
  if (!edge || edge.id !== e.pointerId) return;
  if (Math.hypot(e.clientX - edge.x, e.clientY - edge.y) > TAP_MOVE) {
    clearTimeout(edge.timer);
    edge = null;
    if (mode === 'hold' && !sentenceView()) play();
  }
});

function release(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (swipe && swipe.id === e.pointerId) swipe = null;
  if (edge && edge.id === e.pointerId) {
    clearTimeout(edge.timer);
    const { side, ctx } = edge;
    edge = null;
    if (!playing && e.type === 'pointerup') {
      if (ctx) {
        toggleView();
        return;
      }
      if (side < 0) goPrev();
      else goNext();
      flash(side);
    }
  }
  if (mode === 'hold' && !pointers.size) pause();
}

el.reader.addEventListener('pointerup', release);
el.reader.addEventListener('pointercancel', release);
el.reader.addEventListener('lostpointercapture', release);
document.addEventListener('contextmenu', (e) => e.preventDefault());

// на компьютере (для проверки): держать пробел, стрелки - предложения, +/- скорость
document.addEventListener('keydown', (e) => {
  if (!$('whatsnew').hidden) return; // окно "что нового" закрывается только кнопкой
  if (!el.dialog.hidden) {
    if (e.key === 'Escape') closeDialog(false);
    return;
  }
  if (!el.panel.hidden) {
    if (e.key === 'Escape') closePanel();
    return;
  }
  if (el.reader.hidden || !bk.meta) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (e.repeat || sentenceView()) return;
    if (mode === 'hold' || !playing) play();
    else pause();
  } else if (!playing && e.key === 'ArrowLeft') goPrev();
  else if (!playing && e.key === 'ArrowRight') goNext();
  else if (sentenceView()) return;
  else if (e.key === '+' || e.key === '=') changeWpm(1);
  else if (e.key === '-') changeWpm(-1);
});

document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && mode === 'hold' && !el.reader.hidden) pause();
});

function leave() {
  pointers.clear();
  pause();
  endManual();
  savePos();
}

document.addEventListener('visibilitychange', () => { if (document.hidden) leave(); });
window.addEventListener('pagehide', leave);

// ---------- скорость ----------

function changeWpm(dir) {
  const stepSize = (dir > 0 ? wpm >= 500 : wpm > 500) ? 50 : 25;
  wpm = Math.min(WPM_MAX, Math.max(WPM_MIN, wpm + dir * stepSize));
  el.wpm.textContent = wpm;
  store('wpm', wpm);
}

$('slower').addEventListener('click', () => changeWpm(-1));
$('faster').addEventListener('click', () => changeWpm(1));
$('prev').addEventListener('click', goPrev);
$('next').addEventListener('click', goNext);
el.strip.addEventListener('click', () => { if (!playing) toggleView(); });

function showHint() {
  el.hint.replaceChildren();
  (sentenceView() ? T.hintSentence : T.hint[mode]).forEach((line, k) => {
    if (k) el.hint.append(document.createElement('br'));
    el.hint.append(line);
  });
}

// ---------- мелкие окна: подсказка и подтверждение ----------

let toastTimer = 0;

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}

let dialogDone = null;

function ask(title, text, okLabel) {
  if (dialogDone) return Promise.resolve(false);
  $('dialog-title').textContent = title;
  $('dialog-text').textContent = text;
  $('dialog-ok').textContent = okLabel;
  el.dialog.hidden = false;
  return new Promise((resolve) => { dialogDone = resolve; });
}

function closeDialog(answer) {
  el.dialog.hidden = true;
  const done = dialogDone;
  dialogDone = null;
  if (done) done(answer);
}

$('dialog-ok').addEventListener('click', () => closeDialog(true));
$('dialog-cancel').addEventListener('click', () => closeDialog(false));
el.dialog.addEventListener('click', (e) => { if (e.target === el.dialog) closeDialog(false); });

// ---------- панель: оглавление, настройки, справка ----------

let panelHome = null; // 'toc' - панель открыта из чтения, из настроек и справки "назад" ведёт в оглавление

function openPanel(show, home) {
  panelHome = home;
  tgBox = null;
  show();
  el.panel.hidden = false;
}

function closePanel() {
  el.panel.hidden = true;
  if (!el.reader.hidden) relayout();
}

function panelBack() {
  if (panelHome === 'toc') showToc();
  else closePanel();
}

// вложенный экран (настройки, справка): слева "назад", значки скрыты
function subScreen(title) {
  tgBox = null;
  el.pTitle.textContent = title;
  el.pBack.textContent = '‹ ' + T.back;
  el.pBack.hidden = false;
  $('panel-help').hidden = true;
  $('panel-settings').hidden = true;
  el.pList.scrollTop = 0;
}

// заливка кнопки по доле прочитанного
function fill(btn, x) {
  if (x > 0) btn.style.setProperty('--done', (x * 100).toFixed(1) + '%');
  if (x >= 0.999) btn.classList.add('done');
}

function showToc() {
  el.pTitle.textContent = T.toc;
  el.pBack.hidden = true;
  $('panel-help').hidden = false;
  $('panel-settings').hidden = false;
  const summary = node('p', 'summary', fmt(T.tocSummary, { p: percent(wordsBefore(pos) / Math.max(1, bk.meta.words)) }));
  const box = node('div', 'toc');
  let curBtn = null;
  bk.chapters.forEach((c, ch) => {
    const btn = node('button');
    btn.type = 'button';
    btn.append(node('span', '', chapterLabel(ch)));
    const x = readFraction(ch);
    if (x > 0) btn.append(node('small', '', percent(x)));
    fill(btn, x);
    if (ch === pos.ch) {
      btn.classList.add('cur');
      curBtn = btn;
    }
    btn.addEventListener('click', () => goTo({ ch, p: -1, i: 0 }));
    box.append(btn);
  });
  el.pList.replaceChildren(summary, box);
  if (curBtn) curBtn.scrollIntoView({ block: 'center' });
  else el.pList.scrollTop = 0;
}

function goTo(q) {
  pos = q;
  closePanel();
  showPaused();
}

function versionLine() {
  return fmt(T.version, { v: window.APP_VERSION || '' });
}

function showHelp() {
  subScreen(T.help);
  const box = node('div', 'help');
  for (const [title, lines] of T.helpSections) {
    const ul = node('ul');
    // с включённым Telegram во второй строке раздела "Книги" другой текст про хранение и отправку
    let shown = TG.enabled && title === T.helpSections[3][0] ? [lines[0], ...T.helpTelegramBooks, ...lines.slice(2)] : lines;
    if (sentenceView() && title === T.helpSections[0][0]) shown = T.helpSentence; // красной буквы и скорости в этом показе нет
    for (const line of shown) ul.append(node('li', '', line == null ? T.modes[mode].desc : line));
    box.append(node('h3', '', title), ul);
  }
  box.append(node('p', 'summary', versionLine()));
  el.pList.replaceChildren(box);
}

function showSettings() {
  subScreen(T.settings);
  const box = node('div', 'help');

  const modes = node('div', 'choices');
  for (const m of MODES) {
    const btn = node('button', m === mode ? 'on' : '', T.modes[m].title);
    btn.type = 'button';
    btn.append(node('small', '', T.modes[m].desc));
    btn.addEventListener('click', () => {
      mode = m;
      store('mode', m);
      showHint();
      modes.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
    });
    modes.append(btn);
  }

  const fonts = node('div', 'choices');
  for (const f of FONTS) {
    const btn = node('button', f === font ? 'on' : '');
    btn.type = 'button';
    const word = T.fontSample;
    const p = pivotIndex(word);
    const sample = node('span', 'font-sample', word.slice(0, p));
    sample.style.fontFamily = f[1];
    sample.append(node('i', '', word[p]), word.slice(p + 1));
    btn.append(sample, node('small', '', T.fonts[f[0]]));
    btn.addEventListener('click', () => {
      store('font', f[0]);
      applyFont(f);
      fonts.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === btn));
    });
    fonts.append(btn);
  }

  const themes = node('div', 'choices');
  for (const x of THEMES) {
    const btn = node('button', x === theme ? 'on' : '');
    btn.type = 'button';
    const dot = node('span', 'theme-sample');
    dot.style.background = x[1];
    btn.append(dot, T.themes[x[0]]);
    btn.addEventListener('click', () => {
      store('theme', x[0]);
      applyTheme(x);
      themes.querySelectorAll('button').forEach((y) => y.classList.toggle('on', y === btn));
    });
    themes.append(btn);
  }

  tgBox = node('div', 'tg');
  // Telegram - сверху, чтобы не прятаться под длинными списками шрифтов и тем
  if (TG.enabled) box.append(node('h3', '', T.tgSection), tgBox);
  else tgBox = null;
  box.append(node('h3', '', T.secMode), modes, node('h3', '', T.secFont), fonts, node('h3', '', T.secTheme), themes);
  el.pList.replaceChildren(box);
  renderTg();
}

// ---------- Telegram: подключение и подсказки (логика - в telegram.js) ----------

let tgBox = null; // блок в настройках (пока они открыты)
let tgBusy = false; // идёт запрос на подключение
let tgErrors = [];

function tgButton(label, onClick, cls) {
  const b = node('button', cls || '', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function renderTg() {
  if (!tgBox || !tgBox.isConnected) return;
  const items = [];
  const pending = TG.pending();
  if (TG.linked()) {
    const s = TG.state();
    const check = tgButton(TG.isSyncing() ? T.tgChecking : T.tgCheck, async () => {
      const r = await tgSync();
      if (r && !r.added && !r.errors && !r.duplicates) toast(r.failed ? T.tgOffline : T.tgNothingNew);
    });
    check.disabled = TG.isSyncing();
    items.push(
      node('p', 'tg-state', s.name ? fmt(T.tgConnectedAs, { name: s.name }) : T.tgConnected),
      node('p', 'summary', fmt(T.tgHowTo, { bot: s.bot })),
      check,
      tgButton(T.tgDisconnect, async () => {
        if (await ask(T.tgDisconnectTitle, T.tgDisconnectText, T.tgDisconnectOk)) {
          await TG.disconnect();
          toast(T.tgDisconnected);
        }
      }),
      node('p', 'summary', T.tgPrivacyOn),
    );
  } else if (pending) {
    const open = node('a', 'btn', T.tgOpen);
    open.href = pending.link;
    open.target = '_blank';
    open.rel = 'noopener';
    items.push(
      node('p', 'tg-state', T.tgWaiting),
      node('p', 'summary', T.tgWaitingText),
      open,
      tgButton(T.tgCancel, () => TG.cancel()),
      node('p', 'summary', fmt(T.tgCodeHint, { bot: pending.bot, code: pending.code })),
    );
  } else {
    const connect = tgButton(tgBusy ? T.tgConnecting : T.tgConnect, async () => {
      tgBusy = true;
      renderTg();
      const r = await TG.connect();
      tgBusy = false;
      if (!r.ok) toast(r.error === 'limit' ? T.tgLimit : T.tgConnectFailed);
      renderTg();
    }, 'primary');
    connect.disabled = tgBusy;
    items.push(node('p', 'summary', T.tgIntro), connect, node('p', 'summary', T.tgPrivacyOff));
  }
  tgBox.replaceChildren(...items);
}

// небольшая подсказка в библиотеке: при подключении и при пустом списке; касание открывает настройки
function renderTgHint() {
  const hint = $('tg-hint');
  let text = '';
  if (!TG.enabled) text = '';
  else if (TG.linked()) text = fmt(T.tgLibHintOn, { bot: TG.state().bot });
  else if (!libBooks.length && !TG.pending()) text = T.tgLibHintOff;
  hint.hidden = !text;
  hint.textContent = text;
  hint.classList.toggle('busy', TG.isSyncing());
}

// проверка Telegram: добавленные книги появляются в списке, ошибки разбора - в сообщении вверху
async function tgSync() {
  tgErrors = [];
  const r = await TG.sync();
  if (tgErrors.length) renderNotice(tgErrors);
  if (r && r.added > 1) toast(fmt(T.tgAddedMany, { n: r.added }));
  return r;
}

TG.hooks.added = (title) => toast(fmt(T.tgAdded, { title }));
TG.hooks.error = (name, code) => tgErrors.push({ kind: 'err', text: fmt(T.errors[code] || T.errors.unknown, { name }) });
TG.hooks.change = (event) => {
  renderTg();
  renderTgHint();
  if (event === 'expired') toast(T.tgExpired);
  if (event === 'revoked') toast(T.tgRevoked);
};

el.ref.addEventListener('click', () => {
  pause();
  endManual();
  openPanel(showToc, 'toc');
});
$('panel-help').addEventListener('click', showHelp);
$('panel-settings').addEventListener('click', showSettings);
$('panel-close').addEventListener('click', closePanel);
el.pBack.addEventListener('click', panelBack);

// ---------- экраны: библиотека и чтение ----------

let libBooks = []; // метаданные всех книг
let opening = false;

function bookPos(meta) {
  return load('pos.' + meta.id, null);
}

function bookProgress(meta) {
  const p = bookPos(meta);
  return p && p.w > 0 && meta.words > 0 ? Math.min(1, p.w / meta.words) : 0;
}

function realSpeed(meta) {
  return meta.readMs >= 60000 && meta.wordsRead >= 100 ? Math.round(meta.wordsRead * 60000 / meta.readMs / 5) * 5 : 0;
}

function coverEl(meta) {
  if (meta.cover) {
    const img = node('img', 'cover');
    img.src = meta.cover;
    img.alt = '';
    return img;
  }
  // обложки нет: цветная заглушка с первой буквой названия
  let hue = 0;
  for (const ch of meta.title) hue = (hue * 31 + ch.codePointAt(0)) % 360;
  const ph = node('div', 'cover-ph', ((meta.title.match(/\p{L}/u) || ['?'])[0]).toUpperCase());
  ph.style.background = 'hsl(' + hue + ' 35% 28%)';
  return ph;
}

function bookRow(meta) {
  const li = node('li', 'book');
  const open = node('button', 'open');
  open.type = 'button';
  const info = node('span', 'info');
  const x = bookProgress(meta);
  const speed = realSpeed(meta);
  const bits = [percent(x)];
  if (speed) bits.push(fmt(T.realSpeed, { n: speed }));
  const meter = node('span', 'meter');
  const bar = node('i');
  bar.style.width = (x * 100).toFixed(1) + '%';
  meter.append(bar);
  info.append(node('span', 'name', meta.title), node('span', 'author', meta.author || T.noAuthor), node('span', 'meta', bits.join(' · ')), meter);
  open.append(coverEl(meta), info);
  const menu = node('button', 'menu', '⋯');
  menu.type = 'button';
  menu.setAttribute('aria-label', T.bookMenu);
  li.append(open, menu);

  // долгое нажатие и правая кнопка мыши - как "⋯"
  let hold = 0;
  let held = false;
  const stopHold = () => clearTimeout(hold);
  open.addEventListener('pointerdown', () => {
    held = false;
    hold = setTimeout(() => { held = true; askDelete(meta); }, 600);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => open.addEventListener(ev, stopHold));
  open.addEventListener('click', () => { if (!held) openBook(meta.id); held = false; });
  li.addEventListener('contextmenu', (e) => { e.preventDefault(); askDelete(meta); });
  menu.addEventListener('click', () => askDelete(meta));
  return li;
}

// "1 240 слов"
function wordsText(n) {
  return n.toLocaleString('ru-RU') + ' ' + plural(n, T.chartWords);
}

// "<1 мин", "25 мин", "1 ч", "1 ч 5 мин"
function durationText(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return T.durLess;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return fmt(T.durMin, { m });
  return m ? fmt(T.durHourMin, { h, m }) : fmt(T.durHour, { h });
}

// ---------- график "слов по дням" ----------
// days - {'ГГГГ-ММ-ДД': {ms, words}}; opts - {dateKey(ms), words(n) -> "1 240 слов", duration(ms) -> "25 мин",
// text - объект с подписями (T), count = 60}. Возвращает DOM-элемент: 60 столбцов (слева старый день, справа сегодня),
// единый масштаб по максимуму; касание / клик / протяжка выбирает день, он показан в строке под графиком.
function dayChart(days, opts) {
  const count = opts.count || 60;
  const tx = opts.text;
  const num = (n) => n.toLocaleString('ru-RU');
  const box = node('div', 'dchart');

  // последние count календарных дней, включая сегодня (середина дня - чтобы не спотыкаться о смену времени)
  const base = new Date();
  const list = [];
  for (let k = count - 1; k >= 0; k--) {
    const key = opts.dateKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() - k, 12).getTime());
    const d = days[key];
    list.push({ key, words: d && d.words > 0 ? d.words : 0, ms: d && d.ms > 0 ? d.ms : 0 });
  }
  const total = list.reduce((sum, d) => sum + d.words, 0);
  if (!total) {
    box.append(node('p', 'dchart-empty', tx.chartEmpty));
    return box;
  }
  const max = Math.max(...list.map((d) => d.words));
  const active = list.filter((d) => d.words > 0).length;

  const head = node('div', 'dchart-head');
  head.append(node('span', 'dchart-title', tx.chartTitle), node('span', 'dchart-max', fmt(tx.chartMax, { n: num(max) })));

  const bars = node('div', 'dchart-bars');
  const info = node('p', 'dchart-info');
  info.setAttribute('aria-live', 'polite');
  const cols = list.map((d) => {
    const col = node('div', 'dchart-col');
    const bar = node('i', d.words ? 'dchart-bar' : 'dchart-bar zero');
    if (d.words) bar.style.height = (d.words / max * 100).toFixed(2) + '%';
    col.append(bar);
    bars.append(col);
    return col;
  });

  const dateText = (key) => {
    const [y, m, dd] = key.split('-').map(Number);
    const o = { day: 'numeric', month: 'long' };
    if (y !== base.getFullYear()) o.year = 'numeric';
    return new Date(y, m - 1, dd).toLocaleDateString('ru-RU', o);
  };
  let current = -1;
  const select = (i) => {
    i = Math.max(0, Math.min(count - 1, i));
    if (i === current) return;
    if (current >= 0) cols[current].classList.remove('on');
    current = i;
    cols[i].classList.add('on');
    const d = list[i];
    info.textContent = d.words
      ? dateText(d.key) + ' · ' + opts.words(d.words) + ' · ' + opts.duration(d.ms)
      : dateText(d.key) + ' · ' + tx.chartNone;
  };
  // протяжка пальцем по горизонтали выбирает дни, вертикаль остаётся прокруткой (touch-action: pan-y)
  const pick = (e) => {
    const r = bars.getBoundingClientRect();
    select(Math.floor((e.clientX - r.left) / r.width * count));
  };
  let down = false;
  bars.addEventListener('pointerdown', (e) => { down = true; pick(e); });
  bars.addEventListener('pointermove', (e) => { if (down || e.pointerType === 'mouse') pick(e); });
  const up = () => { down = false; };
  bars.addEventListener('pointerup', up);
  bars.addEventListener('pointercancel', up);
  bars.addEventListener('pointerleave', up);
  select(count - 1);

  const sum = fmt(tx.chartSum, { words: opts.words(total), avg: num(Math.round(total / active)) });
  box.append(head, bars, info, node('p', 'dchart-hint', tx.chartHint), node('p', 'dchart-sum', sum));
  return box;
}

function renderStats() {
  const box = $('stats');
  const now = Date.now();
  if (!Object.keys(days).length) {
    box.hidden = true;
    return;
  }
  const today = (days[dateKey(now)] || { words: 0 }).words;
  let week = 0;
  for (let k = 0; k < 7; k++) week += (days[dateKey(now - k * 86400000)] || { words: 0 }).words;
  let t = now;
  if (!days[dateKey(t)]) t -= 86400000;
  let streak = 0;
  while (days[dateKey(t)]) {
    streak++;
    t -= 86400000;
  }
  const tile = (n, forms) => {
    const s = node('div', 'stat');
    s.append(node('b', '', n.toLocaleString('ru-RU')), node('span', '', plural(n, forms)));
    return s;
  };
  box.replaceChildren(
    tile(today, T.statToday), tile(week, T.statWeek), tile(streak, T.statStreak),
    dayChart(days, { dateKey, words: wordsText, duration: durationText, text: T }),
  );
  box.hidden = false;
}

function renderLibrary() {
  const sorted = [...libBooks].sort((a, b) => (b.opened || b.added) - (a.opened || a.added));
  const last = sorted.find((b) => b.opened > 0);
  $('continue').hidden = !last;
  if (last) {
    const x = bookProgress(last);
    $('continue-cover').replaceChildren(coverEl(last));
    $('continue-title').textContent = last.title;
    $('continue-author').textContent = last.author || T.noAuthor;
    $('continue-bar').style.width = (x * 100).toFixed(1) + '%';
    $('continue-pct').textContent = percent(x);
    $('continue').dataset.id = last.id;
  }
  $('empty').hidden = libBooks.length > 0;
  $('books-title').hidden = libBooks.length === 0;
  $('books').replaceChildren(...sorted.map(bookRow));
  renderStats();
  renderTgHint();
}

function showLibrary() {
  closeBook();
  el.reader.hidden = true;
  el.library.hidden = false;
  renderLibrary();
}

function closeBook() {
  if (!bk.meta) return;
  leave();
  bk = EMPTY_BOOK;
  paraCache = new Map();
  headCache = new Map();
  cumCache = new Map();
  readMap = {};
  body.classList.remove('has-context');
}

async function openBook(id) {
  if (opening) return;
  const meta = libBooks.find((b) => b.id === id);
  if (!meta) return;
  opening = true;
  try {
    const text = await idbGet('texts', id);
    if (!text || !text.chapters || !text.chapters.length) {
      toast(T.openFailed);
      return;
    }
    closeBook();
    bk = {
      meta,
      chapters: text.chapters,
      pw: text.pw || text.chapters.map((c) => c.paras.map(countWords)),
      start: [],
    };
    let acc = 0;
    for (const n of meta.chapterWords) {
      bk.start.push(acc);
      acc += n;
    }
    sets = setsFor(meta.lang);
    const saved = load('read.' + id, {});
    readMap = saved && typeof saved === 'object' ? saved : {};
    pos = resolve(bookPos(meta)) || { ch: 0, p: -1, i: 0 };
    meta.opened = Date.now();
    idbPut('books', meta).catch(() => { /* ок */ });
    track('open_book', { lang: meta.lang, format: meta.format });
    el.library.hidden = true;
    el.reader.hidden = false;
    body.classList.remove('playing');
    measure();
    if (sentenceView()) snapToScreen();
    showHint();
    showPaused();
  } catch (e) {
    toast(T.openFailed);
  } finally {
    opening = false;
  }
}

async function askDelete(meta) {
  if (!(await ask(T.deleteTitle, fmt(T.deleteText, { title: meta.title }), T.deleteOk))) return;
  await idbWrite([['books', null, meta.id], ['texts', null, meta.id]]).catch(() => { /* ок */ });
  libBooks = libBooks.filter((b) => b.id !== meta.id);
  forget('pos.' + meta.id);
  forget('read.' + meta.id);
  renderLibrary();
  toast(T.deleted);
}

$('continue').addEventListener('click', () => openBook($('continue').dataset.id));
$('back').addEventListener('click', showLibrary);
$('lib-help').addEventListener('click', () => openPanel(showHelp, null));
$('lib-settings').addEventListener('click', () => openPanel(showSettings, null));
$('tg-hint').addEventListener('click', () => openPanel(showSettings, null));

// ---------- добавление книг ----------

const parseError = (code) => Object.assign(new Error(code), { name: 'ParseError', code });
const normKey = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Book (см. CONTRACT.md) -> библиотека. Возвращает {status: 'added' | 'duplicate', id, title}
async function addBook(book) {
  if (!book || !Array.isArray(book.chapters)) throw parseError('broken');
  const chapters = book.chapters
    .map((c) => ({ title: String((c && c.title) || '').trim(), paras: ((c && c.paras) || []).filter((s) => typeof s === 'string' && s.trim()) }))
    .filter((c) => c.paras.length);
  const pw = chapters.map((c) => c.paras.map(countWords));
  const chapterWords = pw.map((a) => a.reduce((n, w) => n + w, 0));
  const words = chapterWords.reduce((n, w) => n + w, 0);
  if (!words) throw parseError('empty');
  const title = String(book.title || '').trim() || '?';
  const author = String(book.author || '').trim();
  const dup = libBooks.find((b) => normKey(b.title) === normKey(title) && normKey(b.author) === normKey(author) && b.words === words);
  if (dup) return { status: 'duplicate', id: dup.id, title: dup.title };
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const meta = {
    id, title, author, lang: String(book.lang || ''), cover: book.cover || null, format: String(book.format || ''),
    added: Date.now(), opened: 0, words, chapterWords, wordsRead: 0, readMs: 0,
  };
  try {
    await idbWrite([['books', meta], ['texts', { id, chapters, pw }]]);
  } catch (e) {
    throw parseError('storage');
  }
  libBooks.push(meta);
  if (!el.library.hidden) renderLibrary();
  requestPersist();
  track('add_book', { format: meta.format, lang: meta.lang, words });
  return { status: 'added', id, title };
}

function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { /* ок */ });
  } catch (e) { /* ок */ }
}

let noticeTimer = 0;

function renderNotice(items) {
  const box = $('notice');
  clearTimeout(noticeTimer);
  box.hidden = !items.length;
  if (!items.length) return;
  const close = node('button', '', '✕');
  close.type = 'button';
  close.setAttribute('aria-label', T.importDismiss);
  close.addEventListener('click', () => renderNotice([]));
  box.replaceChildren(...items.map((x) => node('p', x.kind, x.text)), close);
  if (items.every((x) => x.kind === 'ok')) noticeTimer = setTimeout(() => renderNotice([]), 6000);
}

async function importOne(file) {
  try {
    if (!window.Parsers) throw parseError('noParser');
    const book = await window.Parsers.parse(file);
    const r = await addBook(book);
    return r.status === 'added'
      ? { kind: 'ok', id: r.id, text: fmt(T.importDone, { title: r.title }) }
      : { kind: 'warn', id: r.id, text: fmt(T.importDuplicate, { title: r.title }) };
  } catch (e) {
    const code = e && e.name === 'ParseError' ? e.code : 'unknown';
    return { kind: 'err', text: fmt(T.errors[code] || T.errors.unknown, { name: file.name }) };
  }
}

let importing = false;

async function importFiles(files) {
  files = [...files];
  if (!files.length || importing) return;
  importing = true;
  const results = [];
  for (const f of files) {
    renderNotice([...results, { kind: 'busy', text: fmt(T.importing, { name: f.name }) }]);
    await new Promise((r) => setTimeout(r, 30)); // дать экрану обновиться перед тяжёлым разбором
    results.push(await importOne(f));
  }
  renderNotice(results);
  importing = false;
}

// "Открыть с помощью" / "Поделиться" в Android (native.js): один файл - добавить и сразу открыть книгу
// (если она уже есть - открыть её), несколько - добавить в библиотеку и показать итог
async function openFiles(files) {
  files = [...files];
  if (!files.length) return;
  if (!el.dialog.hidden) closeDialog(false);
  closePanel();
  showLibrary();
  if (files.length > 1) return importFiles(files);
  if (importing) return;
  importing = true;
  try {
    renderNotice([{ kind: 'busy', text: fmt(T.importing, { name: files[0].name }) }]);
    await new Promise((r) => setTimeout(r, 30));
    const res = await importOne(files[0]);
    renderNotice(res.id ? [] : [res]);
    if (res.id) await openBook(res.id);
  } finally {
    importing = false;
  }
}

$('add').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  importFiles(files);
});

// перетаскивание файлов на окно (компьютер)
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  if (!el.library.hidden) $('drop').hidden = false;
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop').hidden = true;
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  if (!el.library.hidden) importFiles(e.dataTransfer.files);
});

// ---------- запуск ----------

window.addEventListener('resize', relayout);

async function boot() {
  applyStrings();
  applyTheme(theme);
  applyFont(font);
  showHint();
  el.wpm.textContent = wpm;
  if (load('hintSeen', false)) body.classList.add('started');
  body.classList.toggle('sentence-view', sentenceView());
  requestPersist();
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (isIos && !standalone && !window.Capacitor) $('install').hidden = false;
  try {
    libBooks = await idbAll('books');
  } catch (e) {
    libBooks = [];
    renderNotice([{ kind: 'err', text: T.storageUnavailable }]);
  }
  renderLibrary();
  tgSync();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) tgSync(); });
window.addEventListener('online', () => tgSync());

// веб-версия: работа без интернета (в сборке Android не нужна)
if ('serviceWorker' in navigator && !window.Capacitor && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // с экрана Домой приложение часто не запускается заново, а возвращается из фона - проверяем и тогда
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && reg) reg.update().catch(() => { /* нет сети */ });
    });
  }).catch(() => { /* без офлайна */ });
}

// ---------- окно "Приложение обновилось" ----------
// Один раз после обновления (тихого в Android и веб): что нового с прошлого показанного номера.
// publish.py пишет в version.js window.APP_CHANGES = [{v, n, notes}, ...] (последние 5, новые сверху).
// reader.seenVersion - APP_WEB последней показанной версии; нет ключа (первая установка или первый запуск
// с этой функцией) - запоминаем номер молча. Не показываем во время чтения, при открытых панели, окне,
// предложении обновить APK и пока палец на экране - ждём, проверяя раз в секунду.

const WHATSNEW_MAX = 5;
let whatsNewTimer = 0;

function whatsNewBusy() {
  const upd = document.getElementById('update'); // плашка нового APK создаётся в native.js (только Android)
  return playing || pointers.size > 0 || document.hidden || !el.panel.hidden || !el.dialog.hidden
    || !$('drop').hidden || !!(upd && !upd.hidden);
}

function closeWhatsNew() {
  const box = $('whatsnew');
  if (box.hidden) return;
  box.hidden = true;
  el.library.inert = false;
  el.reader.inert = false;
  el.panel.inert = false;
  store('seenVersion', Number(window.APP_WEB) || 0);
}

function showWhatsNew(list) {
  const first = list[0];
  const ver = String(window.APP_VERSION || '').split(' от ')[0] || first.v;
  $('whatsnew-title').textContent = fmt(T.whatsNewTitle, { N: ver });
  const items = $('whatsnew-list');
  items.replaceChildren();
  if (list.length === 1) {
    items.append(node('p', 'wn-one', first.notes));
  } else {
    for (const c of list) {
      const li = node('li');
      li.append(node('b', '', c.v), ' - ' + c.notes);
      items.append(li);
    }
  }
  $('whatsnew-ok').onclick = closeWhatsNew;
  el.library.inert = true;
  el.reader.inert = true;
  el.panel.inert = true;
  $('whatsnew').hidden = false;
  items.scrollTop = 0;
  $('whatsnew-ok').focus();
  track('whatsnew_shown', { to: window.APP_WEB });
}

function checkWhatsNew() {
  const cur = Number(window.APP_WEB) || 0;
  if (!cur || !Array.isArray(window.APP_CHANGES)) return;
  const seen = load('seenVersion', null);
  if (typeof seen !== 'number') {
    store('seenVersion', cur);
    return;
  }
  if (seen >= cur) return;
  const list = window.APP_CHANGES
    .filter((c) => c && c.notes && Number(c.n) > seen)
    .sort((a, b) => b.n - a.n)
    .slice(0, WHATSNEW_MAX);
  if (!list.length) {
    store('seenVersion', cur);
    return;
  }
  const tick = () => {
    if (whatsNewBusy()) return;
    clearInterval(whatsNewTimer);
    showWhatsNew(list);
  };
  whatsNewTimer = setInterval(tick, 1000);
}

// кнопка "назад" Android: закрыть окно, затем вернуться в библиотеку, иначе свернуть приложение
if (plugins.App) {
  plugins.App.addListener('backButton', () => {
    if (!$('whatsnew').hidden) closeWhatsNew();
    else if (!el.dialog.hidden) closeDialog(false);
    else if (!el.panel.hidden) panelBack();
    else if (!el.reader.hidden) showLibrary();
    else plugins.App.minimizeApp();
  });
}

// для тестов и будущих модулей (импорт из файла вызывает то же addBook)
window.Reader = {
  addBook,
  openBook,
  openFiles,
  ready: boot(),
  state: () => ({ pos: { ...pos }, wpm, mode, playing, book: bk.meta && bk.meta.id }),
  books: () => libBooks.map((b) => ({ ...b })),
  // для тестов разбивки на слова и показы
  debug: {
    splitWords,
    countWords,
    tokenize: (text, lang) => { sets = setsFor(lang); return tokenize(text); },
  },
};

// окно "что нового" - когда библиотека уже нарисована
window.Reader.ready.then(checkWhatsNew, () => { /* без окна */ });
