/*
 * parsers.js - разбор электронных книг (FB2, FB2.ZIP/ZIP, EPUB, TXT, DOCX, HTML) в единый формат Book.
 * Контракт: CONTRACT.md. Глобальный объект window.Parsers: EXTENSIONS, accept, parse(file), ParseError.
 * Нужны только браузерные API (DOMParser, TextDecoder, Blob, canvas) и JSZip (lib/jszip.min.js).
 */
(function (global) {
  'use strict';

  var EXTENSIONS = ['.fb2', '.fb2.zip', '.epub', '.txt', '.zip', '.docx', '.html', '.htm'];
  var ACCEPT = EXTENSIONS.join(',') +
    ',application/epub+zip,application/x-fictionbook+xml,application/zip,text/plain,text/html,' +
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  var MIN_WORDS = 20;            // меньше - книга считается пустой
  var SHORT_CHAPTER_WORDS = 30;  // короче - файл EPUB приклеивается к следующему
  var CHUNK_WORDS = 5000;        // размер куска TXT без заголовков
  var MAX_PARA_WORDS = 3000;     // абзацы длиннее режутся по предложениям
  var COVER_MAX_SIDE = 300;
  var COVER_MAX_CHARS = 60 * 1024;
  var MAX_ENTRY_BYTES = 300 * 1024 * 1024;

  var OPS_NS = 'http://www.idpf.org/2007/ops';

  // ---------------------------------------------------------------- ошибки

  class ParseError extends Error {
    constructor(code, message) {
      super(message || code);
      this.name = 'ParseError';
      this.code = code;
    }
  }

  function fail(code, message) { throw new ParseError(code, message); }

  // ---------------------------------------------------------------- текст

  var RE_INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u00ad\u200b-\u200d\u2060\ufeff]/g;
  var RE_SPACES = /\s+/g;

  // схлопнуть пробелы (в т.ч. неразрывные), убрать невидимые символы
  function norm(s) {
    return s.replace(RE_INVISIBLE, '').replace(RE_SPACES, ' ').trim();
  }

  function countWords(s) {
    var m = s.match(/\S+/g);
    return m ? m.length : 0;
  }

  function lowerAlnum(s) {
    return s.toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]+/g, '');
  }

  // отдать управление браузеру, чтобы вкладка не "зависала" на больших книгах
  var lastYield = Date.now();
  function tick() {
    if (Date.now() - lastYield < 40) return null;
    return new Promise(function (resolve) {
      setTimeout(function () { lastYield = Date.now(); resolve(); }, 0);
    });
  }

  function guessLang(chapters) {
    var cyr = 0, lat = 0, seen = 0;
    for (var i = 0; i < chapters.length && seen < 80000; i++) {
      var paras = chapters[i].paras;
      for (var j = 0; j < paras.length && seen < 80000; j++) {
        var p = paras[j];
        cyr += (p.match(/[Ѐ-ӿ]/g) || []).length;
        lat += (p.match(/[A-Za-z]/g) || []).length;
        seen += p.length;
      }
    }
    return cyr + lat > 0 && cyr / (cyr + lat) > 0.5 ? 'ru' : 'en';
  }

  var LANG3 = { rus: 'ru', eng: 'en', ukr: 'uk', bel: 'be', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr',
    spa: 'es', ita: 'it', pol: 'pl', por: 'pt' };

  function normLang(raw) {
    var l = String(raw || '').trim().toLowerCase().split(/[-_]/)[0];
    if (LANG3[l]) l = LANG3[l];
    return /^[a-z]{2,3}$/.test(l) && l !== 'und' && l !== 'zxx' ? l : '';
  }

  // "Austen, Jane" -> "Jane Austen"
  function fixAuthor(name) {
    var m = /^([^,]+),\s*([^,]+)$/.exec(name);
    return m ? m[2].trim() + ' ' + m[1].trim() : name;
  }

  function stripExt(name) {
    return name.replace(/^.*[\\/]/, '').replace(/\.(fb2\.zip|fb2|epub|txt|zip|docx|html?|xhtml)$/i, '').trim();
  }

  // ---------------------------------------------------------------- байты и кодировки

  function readBytes(file) {
    if (file.arrayBuffer) {
      return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(new Uint8Array(r.result)); };
      r.onerror = function () { reject(r.error); };
      r.readAsArrayBuffer(file);
    });
  }

  function isOle(b) {
    var sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    if (b.length < 8) return false;
    for (var i = 0; i < 8; i++) if (b[i] !== sig[i]) return false;
    return true;
  }

  // Есть ли в байтах строка ASCII в виде UTF-16LE (имена записей OLE)
  function hasUtf16(b, str) {
    var n = str.length, first = str.charCodeAt(0);
    for (var i = 0; i + 2 * n <= b.length; i++) {
      if (b[i] !== first || b[i + 1] !== 0) continue;
      var k = 1;
      while (k < n && b[i + 2 * k] === str.charCodeAt(k) && b[i + 2 * k + 1] === 0) k++;
      if (k === n) return true;
    }
    return false;
  }

  function isZip(b) { return b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5); }

  function latin1Head(b, n) {
    var s = '';
    for (var i = 0; i < Math.min(n, b.length); i++) s += String.fromCharCode(b[i]);
    return s;
  }

  function tryDecode(label, bytes, fatal) {
    try { return new TextDecoder(label, { fatal: !!fatal }).decode(bytes); } catch (e) { return null; }
  }

  // Какая 8-битная кодировка: по доле частых русских букв среди байт >= 0x80
  var FREQ_RU = 'оеаинтсрвлкмдпуыьгзбчй';
  function guess8bit(bytes) {
    var sample = bytes.subarray(0, 300000), high = 0, i;
    for (i = 0; i < sample.length; i++) if (sample[i] >= 0x80) high++;
    if (!high) return 'utf-8';
    var best = 'windows-1252', bestScore = 0.35, labels = ['windows-1251', 'koi8-r', 'ibm866'];
    for (var k = 0; k < labels.length; k++) {
      var s = tryDecode(labels[k], sample);
      if (!s) continue;
      var hit = 0;
      for (i = 0; i < s.length; i++) if (FREQ_RU.indexOf(s.charAt(i)) >= 0) hit++;
      var score = hit / high;
      if (score > bestScore) { bestScore = score; best = labels[k]; }
    }
    return best;
  }

  // Текст без декларации: BOM, строгий UTF-8, иначе 8-битная кодировка
  function decodeText(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return tryDecode('utf-16le', bytes);
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return tryDecode('utf-16be', bytes);
    var s = tryDecode('utf-8', bytes, true);   // BOM UTF-8 снимается декодером
    if (s !== null) return s;
    return tryDecode(guess8bit(bytes), bytes) || tryDecode('utf-8', bytes);
  }

  function labelFromXmlDecl(name) {
    var l = String(name).toLowerCase().trim();
    if (/1251/.test(l)) return 'windows-1251';
    if (/koi8/.test(l)) return 'koi8-r';
    if (/866/.test(l)) return 'ibm866';
    if (l === 'utf8') return 'utf-8';
    return l;
  }

  // XML (FB2, OPF, XHTML): кодировка из BOM / XML-декларации
  function decodeXmlBytes(bytes) {
    var b = bytes, label = 'utf-8';
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) label = 'utf-16le';
    else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) label = 'utf-16be';
    else if (b.length >= 4 && b[0] === 0x3c && b[1] === 0) label = 'utf-16le';
    else if (b.length >= 4 && b[0] === 0 && b[1] === 0x3c) label = 'utf-16be';
    else if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) {
      var m = /<\?xml[^>]*?encoding\s*=\s*["']([^"']+)["']/i.exec(latin1Head(b, 300));
      if (m) label = labelFromXmlDecl(m[1]);
    }
    var s = tryDecode(label, bytes, label === 'utf-8');
    if (s === null) {   // неизвестная метка или битый UTF-8
      s = label === 'utf-8' ? decodeText(bytes) : tryDecode('utf-8', bytes);
    }
    return s;
  }

  function base64ToBytes(b64) {
    var bin = atob(b64.replace(/[^A-Za-z0-9+/=]/g, ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------------------------------------------------------------- XML

  function hasXmlError(doc) {
    return doc.getElementsByTagNameNS('*', 'parsererror').length > 0 ||
      doc.getElementsByTagName('parsererror').length > 0;
  }

  function parseStrict(str, mime) {
    var doc;
    try { doc = new DOMParser().parseFromString(str, mime); } catch (e) { return null; }
    return doc && !hasXmlError(doc) ? doc : null;
  }

  // XML с типичными огрехами: мусорные символы, голые &, &nbsp;
  function parseXml(str) {
    str = str.replace(/^[\s\ufeff]+/, '');
    var doc = parseStrict(str, 'application/xml');
    if (doc) return doc;
    var fixed = str
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
      .replace(/&nbsp;/g, '\u00a0')
      .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    return parseStrict(fixed, 'application/xml');
  }

  // XHTML главы: строгий XML, иначе как HTML (там известны все &-сущности)
  function parseXhtml(str) {
    str = str.replace(/^[\s\ufeff]+/, '');
    var doc = parseStrict(str, 'application/xhtml+xml');
    if (doc) return doc.getElementsByTagNameNS('*', 'body')[0] || doc.documentElement;
    try {
      doc = new DOMParser().parseFromString(str, 'text/html');
      return doc.body || doc.documentElement;
    } catch (e) { return null; }
  }

  function lname(el) { return (el.localName || el.nodeName || '').toLowerCase(); }

  function childEls(el, name) {
    var out = [];
    name = name && name.toLowerCase();
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (!name || lname(c) === name) out.push(c);
    }
    return out;
  }

  function firstChild(el, name) {
    name = name.toLowerCase();
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (lname(c) === name) return c;
    return null;
  }

  function firstDesc(el, name) { return el.getElementsByTagNameNS('*', name)[0] || null; }

  function textOf(el) { return el ? norm(el.textContent || '') : ''; }

  function attrAny(el, names) {   // атрибут по списку имён (с префиксом или без)
    for (var i = 0; i < names.length; i++) {
      var v = el.getAttribute(names[i]);
      if (v) return v;
    }
    return '';
  }

  function hrefOf(el) {           // href / l:href / xlink:href
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if ((a.localName || a.name).replace(/^.*:/, '') === 'href') return a.value;
    }
    return '';
  }

  // ---------------------------------------------------------------- обложка

  function sniffImageMime(b) {
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp';
    if (/<svg/i.test(latin1Head(b, 400))) return 'image/svg+xml';
    return '';
  }

  function loadImageElement(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      var timer = setTimeout(function () { URL.revokeObjectURL(url); reject(new Error('image timeout')); }, 8000);
      img.onload = function () {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        resolve({ src: img, w: img.naturalWidth, h: img.naturalHeight, close: function () {} });
      };
      img.onerror = function () { clearTimeout(timer); URL.revokeObjectURL(url); reject(new Error('image error')); };
      img.src = url;
    });
  }

  function loadImage(blob) {
    if (typeof createImageBitmap === 'function' && blob.type !== 'image/svg+xml') {
      return createImageBitmap(blob).then(function (bmp) {
        return { src: bmp, w: bmp.width, h: bmp.height, close: function () { if (bmp.close) bmp.close(); } };
      }).catch(function () { return loadImageElement(blob); });
    }
    return loadImageElement(blob);
  }

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function canvasToBlob(c, q) {
    if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality: q });
    return new Promise(function (resolve) { c.toBlob(resolve, 'image/jpeg', q); });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  // Уменьшить обложку: <= 300 px, JPEG, строка data: <= 60 КБ. При любой ошибке - null.
  async function makeCover(bytes, mime) {
    var img = null;
    try {
      if (!bytes || bytes.length < 16 || bytes.length > 40 * 1024 * 1024) return null;
      var type = sniffImageMime(bytes) || mime || '';
      img = await loadImage(new Blob([bytes], { type: type }));
      if (!img.w || !img.h) return null;
      var scale = Math.min(1, COVER_MAX_SIDE / Math.max(img.w, img.h));
      for (var attempt = 0; attempt < 4; attempt++, scale *= 0.8) {
        var w = Math.max(1, Math.round(img.w * scale)), h = Math.max(1, Math.round(img.h * scale));
        var canvas = makeCanvas(w, h), ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img.src, 0, 0, w, h);
        var qs = [0.85, 0.72, 0.6, 0.48, 0.36, 0.25];
        for (var i = 0; i < qs.length; i++) {
          var url = await blobToDataUrl(await canvasToBlob(canvas, qs[i]));
          if (url.length <= COVER_MAX_CHARS) return url;
        }
      }
      return null;
    } catch (e) {
      return null;
    } finally {
      if (img) img.close();
    }
  }

  // ---------------------------------------------------------------- общая сборка Book

  // Режет очень длинные абзацы по предложениям (~200 слов)
  function splitLongPara(p) {
    var sentences = p.match(/[^.!?…]+[.!?…]+["'»”)\]]*\s*|[^.!?…]+$/g) || [p];
    var out = [], cur = [], n = 0;
    function push() { if (cur.length) { out.push(norm(cur.join(''))); cur = []; n = 0; } }
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i], w = countWords(s);
      if (w > 400) {   // одно "предложение" без точек - режем по словам
        push();
        var words = s.split(/\s+/);
        for (var k = 0; k < words.length; k += 200) out.push(words.slice(k, k + 200).join(' '));
        continue;
      }
      cur.push(s); n += w;
      if (n >= 200) push();
    }
    push();
    return out.filter(Boolean);
  }

  // Чистим главы, проверяем, что текст есть; возвращает [главы, всего слов]
  function cleanChapters(chapters) {
    var out = [], total = 0;
    for (var i = 0; i < chapters.length; i++) {
      var paras = [], src = chapters[i].paras;
      for (var j = 0; j < src.length; j++) {
        var p = src[j];
        if (!p) continue;
        if (p.length > 20000 && countWords(p) > MAX_PARA_WORDS) {
          var parts = splitLongPara(p);
          for (var k = 0; k < parts.length; k++) paras.push(parts[k]);
        } else paras.push(p);
      }
      if (!paras.length) continue;
      for (var m = 0; m < paras.length; m++) total += countWords(paras[m]);
      out.push({ title: chapters[i].title || '', paras: paras });
    }
    if (!out.length || total < MIN_WORDS) fail('empty', 'No readable text (' + total + ' words)');
    return out;
  }

  var CYR_LANGS = { ru: 1, uk: 1, be: 1, bg: 1, sr: 1, mk: 1, kk: 1, ky: 1, tg: 1, mn: 1 };

  // Заявленный язык не должен противоречить алфавиту текста (Word часто ставит en-US по умолчанию)
  function crossCheckLang(declared, chapters) {
    var guess = guessLang(chapters);
    if (!declared) return guess;
    if (guess === 'ru' && !CYR_LANGS[declared]) return 'ru';
    if (guess === 'en' && CYR_LANGS[declared]) return 'en';
    return declared;
  }

  async function buildBook(f, getCover) {
    var chapters = cleanChapters(f.chapters);
    var cover = null;
    if (getCover) { try { cover = await getCover(); } catch (e) { cover = null; } }
    return {
      title: f.title || f.fallbackTitle || 'Book',
      author: f.author || '',
      lang: f.checkLang ? crossCheckLang(normLang(f.lang), chapters) : (normLang(f.lang) || guessLang(chapters)),
      cover: cover || null,
      format: f.format,
      chapters: chapters
    };
  }

  // ---------------------------------------------------------------- FB2

  function fb2Inline(node, parts) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) parts.push(c.nodeValue);
      else if (c.nodeType === 1) {
        var n = lname(c);
        if (n === 'image') continue;
        if (n === 'a' && isNoteLink(c)) continue;
        fb2Inline(c, parts);
      }
    }
  }

  function fb2Text(el) {
    var parts = [];
    fb2Inline(el, parts);
    return norm(parts.join(''));
  }

  var MARKER_BRACKET = /^[\[({]\s*(?:\d{1,4}|[*†‡§]+|[a-zA-Z])\s*[\])}]$/;
  var MARKER_PLAIN = /^(?:\d{1,4}|[*†‡§]+)$/;

  // Ссылка-маркер сноски: <a type="note">, [1], надстрочный номер-ссылка
  function isNoteLink(a) {
    if (a.getAttribute('type') === 'note') return true;
    var href = hrefOf(a);
    if (href.indexOf('#') < 0) return false;
    var t = norm(a.textContent || '');
    if (MARKER_BRACKET.test(t)) return true;
    if (!MARKER_PLAIN.test(t)) return false;
    var parent = a.parentNode && a.parentNode.nodeType === 1 ? lname(a.parentNode) : '';
    return parent === 'sup' || !!firstDesc(a, 'sup');
  }

  function fb2Title(sec) {
    var t = firstChild(sec, 'title');
    if (!t) return '';
    var parts = [];
    for (var c = t.firstElementChild; c; c = c.nextElementSibling) {
      var s = fb2Text(c);
      if (s) parts.push(s);
    }
    return parts.length ? parts.join(' ') : fb2Text(t);
  }

  function fb2Poem(poem, out) {
    for (var c = poem.firstElementChild; c; c = c.nextElementSibling) {
      var n = lname(c), s;
      if (n === 'title') { s = fb2Title(poem); if (s) out.push(s); }
      else if (n === 'epigraph') fb2Blocks(c, out);
      else if (n === 'subtitle' || n === 'text-author') { s = fb2Text(c); if (s) out.push(s); }
      else if (n === 'stanza') {
        var lines = [];
        for (var v = c.firstElementChild; v; v = v.nextElementSibling) {
          var ln = lname(v);
          if (ln === 'v' || ln === 'subtitle' || ln === 'title') { s = fb2Text(v); if (s) lines.push(s); }
        }
        if (lines.length) out.push(lines.join(' '));
      }
    }
  }

  function fb2Table(table, out) {
    var rows = table.getElementsByTagNameNS('*', 'tr');
    for (var i = 0; i < rows.length; i++) {
      var cells = [];
      for (var c = rows[i].firstElementChild; c; c = c.nextElementSibling) {
        var s = fb2Text(c);
        if (s) cells.push(s);
      }
      if (cells.length) out.push(cells.join('; '));
    }
  }

  // Собственный текст контейнера (без вложенных секций и заголовка)
  function fb2Blocks(parent, out) {
    for (var c = parent.firstElementChild; c; c = c.nextElementSibling) {
      var n = lname(c), s;
      if (n === 'p' || n === 'subtitle' || n === 'text-author') { s = fb2Text(c); if (s) out.push(s); }
      else if (n === 'epigraph' || n === 'cite' || n === 'annotation') fb2Blocks(c, out);
      else if (n === 'poem') fb2Poem(c, out);
      else if (n === 'table') fb2Table(c, out);
    }
  }

  // Лист = глава; у секции со своим текстом и вложенными секциями свой текст - отдельная глава
  function fb2Section(sec, chapters) {
    var own = [], subs = childEls(sec, 'section');
    fb2Blocks(sec, own);
    if (own.length) chapters.push({ title: fb2Title(sec), paras: own });
    for (var i = 0; i < subs.length; i++) fb2Section(subs[i], chapters);
  }

  function fb2Bodies(root) {
    var bodies = childEls(root, 'body'), main = [];
    for (var i = 0; i < bodies.length; i++) {
      var name = bodies[i].getAttribute('name') || '';
      if (!/note|comment|сноск|примеч/i.test(name)) main.push(bodies[i]);
    }
    return main.length ? main : bodies;
  }

  function fb2AuthorName(a) {
    var parts = [textOf(firstChild(a, 'first-name')), textOf(firstChild(a, 'last-name'))].filter(Boolean);
    return parts.length ? parts.join(' ') : textOf(firstChild(a, 'nickname'));
  }

  async function fb2Cover(root) {
    var cp = firstDesc(root, 'coverpage');
    var img = cp && firstDesc(cp, 'image');
    if (!img) return null;
    var id = hrefOf(img).replace(/^#/, '');
    var bins = root.getElementsByTagNameNS('*', 'binary');
    for (var i = 0; i < bins.length; i++) {
      if (bins[i].getAttribute('id') === id) {
        return makeCover(base64ToBytes(bins[i].textContent || ''), bins[i].getAttribute('content-type'));
      }
    }
    return null;
  }

  async function parseFb2(bytes, fallbackTitle) {
    var doc = parseXml(decodeXmlBytes(bytes));
    if (!doc) fail('broken', 'FB2 is not well-formed XML');
    var root = doc.documentElement;
    if (!root || lname(root) !== 'fictionbook') fail('unsupported', 'XML root is not FictionBook');
    var ti = firstDesc(root, 'title-info');
    var authors = ti ? childEls(ti, 'author').map(fb2AuthorName).filter(Boolean) : [];
    var chapters = [];
    var bodies = fb2Bodies(root);
    for (var i = 0; i < bodies.length; i++) {
      fb2Section(bodies[i], chapters);
      var t = tick(); if (t) await t;
    }
    return buildBook({
      title: ti ? textOf(firstChild(ti, 'book-title')) : '',
      fallbackTitle: fallbackTitle,
      author: authors.slice(0, 3).join(', '),
      lang: ti ? textOf(firstChild(ti, 'lang')) : '',
      format: 'fb2',
      chapters: chapters
    }, function () { return fb2Cover(root); });
  }

  // ---------------------------------------------------------------- EPUB: пути и zip

  function dirOf(p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i + 1); }

  // href относительно baseDir -> { path, frag }; path пустой для "#frag"
  function resolveHref(baseDir, href) {
    var parts = String(href || '').split('#');
    var p = parts[0], frag = parts.length > 1 ? parts.slice(1).join('#') : '';
    try { p = decodeURIComponent(p); } catch (e) { /* оставляем как есть */ }
    try { frag = decodeURIComponent(frag); } catch (e) { /* оставляем как есть */ }
    if (!p) return { path: '', frag: frag };
    if (p.charAt(0) === '/') p = p.slice(1); else p = baseDir + p;
    var out = [], segs = p.split('/');
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] === '.' || segs[i] === '') continue;
      if (segs[i] === '..') out.pop(); else out.push(segs[i]);
    }
    return { path: out.join('/'), frag: frag };
  }

  function ZipIndex(zip) {
    this.zip = zip;
    this.lower = null;
  }
  ZipIndex.prototype.find = function (path) {
    var f = this.zip.file(path);
    if (f) return f;
    if (!this.lower) {
      this.lower = {};
      var self = this;
      this.zip.forEach(function (p, entry) { if (!entry.dir) self.lower[p.toLowerCase()] = entry; });
    }
    return this.lower[path.toLowerCase()] || null;
  };
  ZipIndex.prototype.bytes = async function (path) {
    var f = this.find(path);
    if (!f) return null;
    var size = f._data && f._data.uncompressedSize;
    if (size && size > MAX_ENTRY_BYTES) fail('broken', 'Zip entry too large: ' + path);
    return f.async('uint8array');
  };

  async function openZip(bytes) {
    try { return await global.JSZip.loadAsync(bytes); } catch (e) { fail('broken', 'Cannot open zip: ' + (e && e.message)); }
  }

  // ---------------------------------------------------------------- EPUB: DRM, OPF, оглавление

  var FONT_RE = /\.(otf|ttf|ttc|woff2?|eot)$/i;

  async function checkDrm(idx) {
    var data = await idx.bytes('META-INF/encryption.xml');
    if (!data) return;
    var doc = parseXml(decodeXmlBytes(data));
    if (!doc) return;
    var encs = doc.getElementsByTagNameNS('*', 'EncryptedData');
    for (var i = 0; i < encs.length; i++) {
      var ref = firstDesc(encs[i], 'CipherReference');
      var uri = ref ? ref.getAttribute('URI') || '' : '';
      if (uri && !FONT_RE.test(uri)) fail('drm', 'EPUB is encrypted (DRM): ' + uri);
    }
  }

  async function findOpfPath(idx) {
    var data = await idx.bytes('META-INF/container.xml');
    if (data) {
      var doc = parseXml(decodeXmlBytes(data));
      var rf = doc && firstDesc(doc, 'rootfile');
      var p = rf && rf.getAttribute('full-path');
      if (p && idx.find(p)) return p;
    }
    var found = '';
    idx.zip.forEach(function (p) { if (!found && /\.opf$/i.test(p)) found = p; });
    if (!found) fail('broken', 'EPUB has no OPF package file');
    return found;
  }

  function parseOpf(doc, opfDir) {
    var md = firstDesc(doc, 'metadata');
    var pkg = { title: '', author: '', lang: '', items: [], byId: {}, spine: [], tocId: '', coverId: '' };
    if (md) {
      var authors = [];
      for (var c = md.firstElementChild; c; c = c.nextElementSibling) {
        var n = lname(c);
        if (n === 'title' && !pkg.title) pkg.title = textOf(c);
        else if (n === 'creator') { var a = textOf(c); if (a && authors.length < 3) authors.push(fixAuthor(a)); }
        else if (n === 'language' && !pkg.lang) pkg.lang = textOf(c);
        else if (n === 'meta' && c.getAttribute('name') === 'cover') pkg.coverId = c.getAttribute('content') || '';
      }
      pkg.author = authors.join(', ');
    }
    var items = doc.getElementsByTagNameNS('*', 'item');
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var obj = {
        id: it.getAttribute('id') || '',
        path: resolveHref(opfDir, it.getAttribute('href') || '').path,
        type: (it.getAttribute('media-type') || '').toLowerCase(),
        props: ' ' + (it.getAttribute('properties') || '') + ' '
      };
      pkg.items.push(obj);
      if (obj.id) pkg.byId[obj.id] = obj;
    }
    var spine = firstDesc(doc, 'spine');
    if (spine) {
      pkg.tocId = spine.getAttribute('toc') || '';
      var refs = childEls(spine, 'itemref');
      for (var j = 0; j < refs.length; j++) pkg.spine.push(refs[j].getAttribute('idref'));
    }
    return pkg;
  }

  function isHtmlItem(it) {
    return /x?html|xml$/.test(it.type) && it.type !== 'application/x-dtbncx+xml' && !/^image\//.test(it.type) &&
      it.type !== 'application/smil+xml' && it.type.indexOf('opf') < 0;
  }

  // TOC: Map путь -> [{ frag, title }] в порядке оглавления
  function addTocEntry(map, base, href, title) {
    if (!href || !title) return;
    var r = resolveHref(base, href);
    if (!r.path) return;
    if (!map.has(r.path)) map.set(r.path, []);
    map.get(r.path).push({ frag: r.frag, title: title });
  }

  function tocFromNav(doc, navPath) {
    var map = new Map(), base = dirOf(navPath), navs = doc.getElementsByTagNameNS('*', 'nav'), nav = null, i;
    for (i = 0; i < navs.length && !nav; i++) {
      if (/\btoc\b/.test(navs[i].getAttributeNS(OPS_NS, 'type') || navs[i].getAttribute('epub:type') || '')) nav = navs[i];
    }
    nav = nav || navs[0];
    if (!nav) return map;
    var links = nav.getElementsByTagNameNS('*', 'a');
    for (i = 0; i < links.length; i++) addTocEntry(map, base, links[i].getAttribute('href'), textOf(links[i]));
    return map;
  }

  function tocFromNcx(doc, ncxPath) {
    var map = new Map(), base = dirOf(ncxPath), pts = doc.getElementsByTagNameNS('*', 'navPoint');
    for (var i = 0; i < pts.length; i++) {
      var label = firstChild(pts[i], 'navlabel'), content = firstChild(pts[i], 'content');
      if (label && content) addTocEntry(map, base, content.getAttribute('src'), textOf(label));
    }
    return map;
  }

  async function readToc(idx, pkg) {
    var nav = pkg.items.filter(function (it) { return it.props.indexOf(' nav ') >= 0; })[0];
    var map = new Map(), data, doc;
    if (nav && (data = await idx.bytes(nav.path)) && (doc = parseXml(decodeXmlBytes(data)))) {
      map = tocFromNav(doc, nav.path);
      if (map.size) return map;
    }
    var ncx = (pkg.tocId && pkg.byId[pkg.tocId]) ||
      pkg.items.filter(function (it) { return it.type === 'application/x-dtbncx+xml'; })[0];
    if (ncx && (data = await idx.bytes(ncx.path)) && (doc = parseXml(decodeXmlBytes(data)))) {
      map = tocFromNcx(doc, ncx.path);
    }
    return map;
  }

  // ---------------------------------------------------------------- EPUB: текст XHTML

  var BLOCK = {};
  ('p div h1 h2 h3 h4 h5 h6 li ul ol blockquote section article aside header footer figure figcaption ' +
    'table thead tbody tfoot caption dl dt dd pre body html main hr address center form fieldset details summary ' +
    'td th').split(' ').forEach(function (n) { BLOCK[n] = true; });
  var SKIP = {};
  ('head script style svg img image noscript rt rp nav audio video canvas object iframe math title ' +
    'button select option textarea template')
    .split(' ').forEach(function (n) { SKIP[n] = true; });

  function epubType(el) {
    return (el.getAttributeNS(OPS_NS, 'type') || el.getAttribute('epub:type') || '').toLowerCase();
  }

  function isNoteRef(a) {
    var et = epubType(a), role = (a.getAttribute('role') || '').toLowerCase();
    if (et.indexOf('noteref') >= 0 || role === 'doc-noteref') return true;
    if (/\b(noteref|footnote-?ref|fnref|footnoteref)\b/i.test(a.getAttribute('class') || '')) return true;
    var href = a.getAttribute('href') || '';
    if (href.indexOf('#') < 0) return false;
    var t = norm(a.textContent || '');
    if (MARKER_BRACKET.test(t)) return true;
    if (!MARKER_PLAIN.test(t)) return false;
    var parent = a.parentNode && a.parentNode.nodeType === 1 ? lname(a.parentNode) : '';
    return parent === 'sup' || !!firstDesc(a, 'sup');
  }

  function isFootnoteBody(el) {
    var et = epubType(el), role = (el.getAttribute('role') || '').toLowerCase();
    if (/\b(footnotes?|endnotes?|rearnotes?)\b/.test(et)) return true;
    if (/^doc-(footnotes?|endnotes?|rearnotes?)$/.test(role)) return true;
    return /\b(footnotes?|endnotes?)\b/i.test(el.getAttribute('class') || '');
  }

  function htmlInline(node, parts) {
    for (var c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) parts.push(c.nodeValue);
      else if (c.nodeType === 1) {
        var n = lname(c);
        if (SKIP[n] || isFootnoteBody(c) || (n === 'a' && isNoteRef(c))) continue;
        if (n === 'br') parts.push(' ');
        else htmlInline(c, parts);
      }
    }
  }

  // Разбор тела XHTML на сегменты: новый сегмент начинается на элементе с id из anchors.
  // Сегмент: { anchor, items: [{ t, h }], total, link } (h - уровень заголовка или 0)
  function extractSegments(root, anchors) {
    var segs = [], buf = [], inLink = 0, linkChars = 0, cur = newSeg(null);

    function newSeg(a) {
      var s = { anchor: a, items: [], total: 0, link: 0 };
      segs.push(s);
      return s;
    }
    function flush(h) {
      if (!buf.length) { linkChars = 0; return; }
      var t = norm(buf.join(''));
      buf.length = 0;
      if (t) {
        cur.items.push({ t: t, h: h || 0, l: linkChars >= t.length * 0.85 });
        cur.total += t.length;
        cur.link += Math.min(linkChars, t.length);
      }
      linkChars = 0;
    }
    function walk(node) {
      for (var c = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3 || c.nodeType === 4) {
          buf.push(c.nodeValue);
          if (inLink) linkChars += c.nodeValue.length;
          continue;
        }
        if (c.nodeType !== 1) continue;
        var n = lname(c);
        if (anchors) {
          var id = c.getAttribute('id') || c.getAttribute('name');
          if (id && anchors.has(id)) { flush(); cur = newSeg(id); }
        }
        if (SKIP[n] || isFootnoteBody(c)) continue;
        if (n === 'br') { buf.push(' '); continue; }
        if (n === 'a') {
          if (isNoteRef(c)) continue;
          if (c.hasAttribute('href')) { inLink++; walk(c); inLink--; } else walk(c);
        } else if (n === 'tr') {
          flush();
          var cells = [];
          for (var cell = c.firstElementChild; cell; cell = cell.nextElementSibling) {
            var parts = [];
            htmlInline(cell, parts);
            var s = norm(parts.join(''));
            if (s) cells.push(s);
          }
          if (cells.length) { buf.push(cells.join('; ')); flush(); }
        } else if (/^h[1-6]$/.test(n)) {
          flush(); walk(c); flush(+n.charAt(1));
        } else if (BLOCK[n]) {
          flush(); walk(c); flush();
        } else walk(c);
      }
    }
    walk(root);
    flush();
    return segs;
  }

  function related(a, b) {
    a = lowerAlnum(a); b = lowerAlnum(b);
    return !!a && !!b && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0);
  }

  // Длинные серии абзацев-ссылок (оглавление внутри текста) выкидываем
  function dropLinkRuns(items) {
    var out = [], i = 0, MIN_RUN = 6;
    while (i < items.length) {
      var j = i;
      while (j < items.length && items[j].l && !items[j].h) j++;
      if (j - i >= MIN_RUN) { i = j; continue; }
      var end = Math.max(j, i + 1);
      for (; i < end; i++) out.push(items[i]);
    }
    return out;
  }

  // Сегмент -> глава { title, paras, words }; ведущие заголовки уходят в название
  function segmentToChapter(seg, tocTitle) {
    var items = seg.items, i = 0, paras = [], words = 0;
    var title = tocTitle || '';
    if (seg.total > 0 && seg.link / seg.total > 0.6 && items.length >= 3) items = [];   // страница оглавления
    else items = dropLinkRuns(items);
    var lead = [];
    while (i < items.length && items[i].h && lead.length < 3) { lead.push(items[i].t); i++; }
    if (title) {
      for (var k = 0; k < lead.length; k++) if (!related(lead[k], title)) paras.push(lead[k]);
    } else if (lead.length) {
      title = lead.reduce(function (acc, t) {
        return acc ? acc + (/[.:!?]$/.test(acc) ? ' ' : '. ') + t : t;
      }, '');
    }
    for (; i < items.length; i++) paras.push(items[i].t);
    for (var j = 0; j < paras.length; j++) words += countWords(paras[j]);
    return { title: title, paras: paras, words: words, bare: !title };
  }

  function appendChapter(to, from) {
    for (var i = 0; i < from.paras.length; i++) to.paras.push(from.paras[i]);
    to.words += from.words;
  }

  // Короткие главы приклеиваются к следующей; хвостовые - к предыдущей
  function mergeShort(list) {
    var out = [], pend = null;
    for (var i = 0; i < list.length; i++) {
      var ch = list[i];
      if (pend) {
        ch.paras = pend.paras.concat(ch.paras);
        ch.words += pend.words;
        if (!ch.title) ch.title = pend.title;
        pend = null;
      }
      if (ch.words < SHORT_CHAPTER_WORDS) pend = ch; else out.push(ch);
    }
    if (pend) {
      if (out.length) {
        appendChapter(out[out.length - 1], pend);
      } else out.push(pend);
    }
    return out;
  }

  // ---------------------------------------------------------------- EPUB: обложка и сборка

  function findImageRef(root) {   // первая картинка на странице-обложке
    var img = firstDesc(root, 'img') || firstDesc(root, 'image');
    return img ? (img.getAttribute('src') || hrefOf(img)) : '';
  }

  async function epubCover(idx, pkg) {
    var imgs = pkg.items.filter(function (it) { return /^image\//.test(it.type); });
    var item = pkg.items.filter(function (it) { return it.props.indexOf(' cover-image ') >= 0; })[0];
    if (!item && pkg.coverId && pkg.byId[pkg.coverId] && /^image\//.test(pkg.byId[pkg.coverId].type)) {
      item = pkg.byId[pkg.coverId];
    }
    if (!item) item = imgs.filter(function (it) { return /cover/i.test(it.id + ' ' + it.path); })[0];
    if (!item && pkg.coverId && pkg.byId[pkg.coverId]) {   // обложка задана страницей
      var page = pkg.byId[pkg.coverId], pdata = await idx.bytes(page.path);
      var proot = pdata && parseXhtml(decodeXmlBytes(pdata));
      var ref = proot && findImageRef(proot);
      if (ref) item = { path: resolveHref(dirOf(page.path), ref).path, type: '' };
    }
    if (!item) return null;
    var bytes = await idx.bytes(item.path);
    return bytes ? makeCover(bytes, item.type) : null;
  }

  function spinePaths(pkg) {
    var seen = {}, out = [], ids = pkg.spine.length ? pkg.spine : pkg.items.filter(isHtmlItem).map(function (i) { return i.id; });
    for (var i = 0; i < ids.length; i++) {
      var it = pkg.byId[ids[i]];
      if (!it || !it.path || seen[it.path] || !isHtmlItem(it)) continue;
      seen[it.path] = true;
      out.push(it.path);
    }
    return out;
  }

  async function parseEpubZip(zip, fallbackTitle) {
    var idx = new ZipIndex(zip);
    await checkDrm(idx);
    var opfPath = await findOpfPath(idx);
    var opfBytes = await idx.bytes(opfPath);
    var opfDoc = opfBytes && parseXml(decodeXmlBytes(opfBytes));
    if (!opfDoc) fail('broken', 'EPUB package file is not valid XML');
    var pkg = parseOpf(opfDoc, dirOf(opfPath));
    var toc = await readToc(idx, pkg);
    var paths = spinePaths(pkg), chapters = [];

    for (var i = 0; i < paths.length; i++) {
      var data = await idx.bytes(paths[i]);
      var root = data && parseXhtml(decodeXmlBytes(data));
      if (!root) continue;
      var entries = toc.get(paths[i]) || [], anchorTitles = new Map(), fileTitle = '';
      for (var e = 0; e < entries.length; e++) {
        if (entries[e].frag) { if (!anchorTitles.has(entries[e].frag)) anchorTitles.set(entries[e].frag, entries[e].title); }
        else if (!fileTitle) fileTitle = entries[e].title;
      }
      var segs = extractSegments(root, anchorTitles.size ? new Set(anchorTitles.keys()) : null);
      if (!fileTitle && segs.length === 1 && entries.length) fileTitle = entries[0].title;
      for (var s = 0; s < segs.length; s++) {
        var t = segs[s].anchor ? anchorTitles.get(segs[s].anchor) : fileTitle;
        var ch = segmentToChapter(segs[s], t);
        // при наличии оглавления кусок без названия - продолжение предыдущей главы (файл разрезан посреди главы)
        if (ch.bare && toc.size && chapters.length) appendChapter(chapters[chapters.length - 1], ch);
        else chapters.push(ch);
      }
      var y = tick(); if (y) await y;
    }
    return buildBook({
      title: pkg.title,
      fallbackTitle: fallbackTitle,
      author: pkg.author,
      lang: pkg.lang,
      format: 'epub',
      chapters: mergeShort(chapters)
    }, function () { return epubCover(idx, pkg); });
  }

  // ---------------------------------------------------------------- TXT

  // Слово "Глава/Часть/Chapter..." в начале строки + номер
  var HEAD_KW = /^(глава|часть|книга|раздел|том|chapter|part|book|section|volume)(?![a-zа-яё])[\s.:\-–—]*(.*)$/i;
  // Номер словом: "первая", "Part One"
  var RU_NUM_STEM = /^(перв|втор|трет|четв[её]рт|пят|шест|седьм|восьм|девят|десят|одиннадцат|двенадцат|тринадцат|четырнадцат|пятнадцат|шестнадцат|семнадцат|восемнадцат|девятнадцат|двадцат|тридцат|последн)/i;
  var EN_NUM_WORD = /^(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|first|second|third|fourth|fifth|last|final)$/i;
  // Заголовки без номера
  var HEAD_SINGLE = /^(пролог|эпилог|предисловие|введение|вступление|заключение|послесловие|prologue|epilogue|preface|introduction|foreword|afterword)(?![a-zа-яё])[^.!?]{0,40}$/i;

  function isChapterNumber(tok) {
    return /^\d{1,4}$/.test(tok) || /^[IVXLCDM]{1,8}$/.test(tok) || RU_NUM_STEM.test(tok) || EN_NUM_WORD.test(tok);
  }

  // Строка - заголовок главы? isolated: пустая строка до и после (или края файла)
  function isHeadingLine(t, isolated) {
    if (t.length > 70 || /[,;]$/.test(t)) return false;
    var m = HEAD_KW.exec(t);
    if (m) {
      var first = (m[2] || '').split(/[\s.:\-–—]+/)[0];
      return first ? isChapterNumber(first) : isolated;   // голое "Глава" - только отдельной строкой
    }
    if (HEAD_SINGLE.test(t)) return true;
    if (!isolated) return false;
    if (/^[IVXLCDM]{1,7}\.(\s.{0,60})?$/.test(t)) return true;   // "IV." или "IV. Название"
    if (/^[IVXLCDM]{2,7}$/.test(t)) return true;
    // ВСЕ ЗАГЛАВНЫЕ: минимум 4 буквы, нет строчных, не восклицание
    var letters = t.replace(/[^A-Za-zЀ-ӿ]/g, '');
    return letters.length >= 4 && letters === letters.toUpperCase() && !/[!?…]$/.test(t);
  }

  function analyseLines(lines) {
    var lens = [], blanks = 0, i;
    for (i = 0; i < lines.length; i++) {
      var n = lines[i].trim().length;
      if (n) lens.push(n); else blanks++;
    }
    var info = { hasBlank: false, wrapped: false, width: 0 };
    if (!lens.length) return info;
    info.hasBlank = lens.length < 20 ? blanks > 0 : blanks > lens.length * 0.05;
    var sorted = Int32Array.from(lens).sort();
    var width = sorted[Math.floor(sorted.length * 0.95)], full = 0;
    for (i = 0; i < lens.length; i++) if (lens[i] >= width * 0.75) full++;
    info.width = width;
    info.wrapped = lens.length >= 20 && width >= 40 && width <= 120 && full / lens.length >= 0.4;
    return info;
  }

  var RE_TERMINAL = /[.!?…:]["'»”“)\]]*$/;

  // Строки блока -> абзацы (склейка жёстких переносов)
  function blockToParas(cur, info) {
    var out = [], i;
    if (!info.wrapped) {
      if (cur.length === 1) return [cur[0].t];
      var sum = 0;
      for (i = 0; i < cur.length; i++) sum += cur[i].t.length;
      if (sum / cur.length > 100) return cur.map(function (l) { return l.t; });   // каждая строка - абзац
      return [cur.map(function (l) { return l.t; }).join(' ')];                   // строфа
    }
    var short = info.width * 0.8, acc = [cur[0].t];
    // перенос по дефису ("чьей-" / "то") склеиваем без пробела
    function joinWrapped(a) {
      var s = a[0];
      for (var k = 1; k < a.length; k++) {
        s += (/[a-zа-яё]-$/i.test(a[k - 1]) && /^[a-zа-яё]/.test(a[k]) ? '' : ' ') + a[k];
      }
      return s;
    }
    for (i = 1; i < cur.length; i++) {
      var prev = cur[i - 1], l = cur[i];
      var prevShort = prev.t.length < short, term = RE_TERMINAL.test(prev.t);
      var brk = info.hasBlank
        ? l.indent && prevShort
        : (prevShort && (term || l.indent || /^[—–-]\s/.test(l.t))) || (l.indent && term);
      if (brk) { out.push(joinWrapped(acc)); acc = [l.t]; } else acc.push(l.t);
    }
    out.push(joinWrapped(acc));
    return out;
  }

  // Текст -> единицы { t, h: заголовок?, iso: одиночная строка между пустыми }
  async function txtUnits(lines, info) {
    var units = [], cur = [], startBlank = true, prevBlank = true, afterHead = false;
    function flushBlock(endBlank) {
      if (!cur.length) return;
      var paras = blockToParas(cur, info);
      var iso = cur.length === 1 && startBlank && endBlank;
      for (var i = 0; i < paras.length; i++) units.push({ t: paras[i], h: false, iso: iso && paras.length === 1 });
      cur = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i], t = norm(raw);
      if (!t) { flushBlock(true); prevBlank = true; afterHead = false; continue; }
      var nextBlank = i + 1 >= lines.length || !lines[i + 1].trim();
      if (isHeadingLine(t, prevBlank && nextBlank)) {
        flushBlock(false);
        units.push({ t: t, h: true, iso: false });
        prevBlank = false; afterHead = true;
        continue;
      }
      if (!info.hasBlank && !info.wrapped) {
        units.push({ t: t, h: false, iso: false });
      } else {
        if (!cur.length) startBlank = prevBlank || afterHead;
        cur.push({ t: t, indent: /^[ \t\u00a0\u3000]/.test(raw) });
      }
      prevBlank = false; afterHead = false;
      if ((i & 4095) === 4095) { var y = tick(); if (y) await y; }
    }
    flushBlock(true);
    return units;
  }

  // "Глава 1" + короткая строка-подзаголовок -> одно название
  function mergeSubtitles(units) {
    for (var i = 0; i + 1 < units.length; i++) {
      var u = units[i], nx = units[i + 1];
      if (!u.h || nx.h || !nx.iso || nx.t.length > 60 || /[.!?…]$/.test(nx.t) || countWords(nx.t) > 8) continue;
      var m = HEAD_KW.exec(u.t);
      if (m && m[2] && m[2].trim().split(/\s+/).length === 1) {   // в заголовке только номер
        u.t = u.t.replace(/[.:]$/, '') + '. ' + nx.t;
        units.splice(i + 1, 1);
      }
    }
  }

  function unitsToChapters(units) {
    var heads = 0, i;
    for (i = 0; i < units.length; i++) if (units[i].h) heads++;
    var chapters = [], cur = null;
    if (heads >= 2) {
      mergeSubtitles(units);
      cur = { title: '', paras: [] };
      for (i = 0; i < units.length; i++) {
        var u = units[i];
        if (u.h) {
          if (cur.paras.length) { chapters.push(cur); cur = { title: u.t, paras: [] }; }
          else cur.title = cur.title ? cur.title + '. ' + u.t : u.t;   // заголовки подряд
        } else cur.paras.push(u.t);
      }
      chapters.push(cur);
      return chapters;
    }
    // заголовков нет: куски ~CHUNK_WORDS слов по границам абзацев
    cur = { title: '', paras: [] };
    var words = 0;
    for (i = 0; i < units.length; i++) {
      cur.paras.push(units[i].t);
      words += countWords(units[i].t);
      if (words >= CHUNK_WORDS) { chapters.push(cur); cur = { title: '', paras: [] }; words = 0; }
    }
    if (cur.paras.length) {
      // остаток меньше половины куска присоединяем к предыдущему
      if (chapters.length && words < CHUNK_WORDS / 2) {
        var last = chapters[chapters.length - 1];
        for (i = 0; i < cur.paras.length; i++) last.paras.push(cur.paras[i]);
      } else chapters.push(cur);
    }
    return chapters;
  }

  async function parseTxt(bytes, fallbackTitle) {
    var text = decodeText(bytes) || '';
    var y = tick(); if (y) await y;
    var lines = text.split(/\r\n|\r|\n/);
    text = '';
    var info = analyseLines(lines);
    var units = await txtUnits(lines, info);
    return buildBook({
      title: '', fallbackTitle: fallbackTitle, author: '', lang: '', format: 'txt',
      chapters: unitsToChapters(units)
    }, null);
  }

  // ---------------------------------------------------------------- общее для DOCX и HTML

  // Единственный заголовок верхнего уровня при нескольких подзаголовках - это название книги, а не глава.
  // units: [{ t, h }] (h - уровень 1-3 или 0). Возвращает название и убирает его из units.
  function liftDocTitle(units) {
    var h1 = [], sub = 0, i;
    for (i = 0; i < units.length; i++) {
      if (units[i].h === 1) h1.push(i); else if (units[i].h) sub++;
    }
    if (h1.length === 1 && sub >= 2 && h1[0] < 3) return units.splice(h1[0], 1)[0].t;
    return '';
  }

  // ---------------------------------------------------------------- DOCX

  var W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  var HEADING_NAME = /^(?:heading|заголовок|überschrift|titre|título)\s*([1-9])$/i;
  var TOC_NAME = /^(?:toc\b|table of contents|оглавление|содержание|заголовок оглавления)/i;
  var TOC_ID = /^toc\s*\d*$|^tocheading$/i;
  // Не берём текст из свойств, рисунков, текстовых полей, ссылок на сноски и кодов полей
  var DOCX_SKIP = { ppr: 1, rpr: 1, sectpr: 1, drawing: 1, pict: 1, txbxcontent: 1, fallback: 1, object: 1,
    footnotereference: 1, endnotereference: 1, commentreference: 1, instrtext: 1, deltext: 1 };

  function wAttr(el, name) {
    return el.getAttributeNS(W_NS, name) || el.getAttribute('w:' + name) || '';
  }

  function levelFromName(s) {
    var m = HEADING_NAME.exec(String(s || '').replace(/[_-]+/g, ' ').trim());
    return m ? +m[1] : 0;
  }

  // styles.xml -> { styles: { id: { name, based, outline } }, lang }
  function parseDocxStyles(doc) {
    var styles = {}, lang = '';
    if (!doc) return { styles: styles, lang: lang };
    var list = doc.getElementsByTagNameNS('*', 'style');
    for (var i = 0; i < list.length; i++) {
      var st = list[i], type = wAttr(st, 'type');
      if (type && type !== 'paragraph') continue;
      var nameEl = firstChild(st, 'name'), basedEl = firstChild(st, 'basedOn');
      var ppr = firstChild(st, 'pPr'), ol = ppr && firstChild(ppr, 'outlineLvl');
      styles[wAttr(st, 'styleId')] = {
        name: nameEl ? wAttr(nameEl, 'val') : '',
        based: basedEl ? wAttr(basedEl, 'val') : '',
        outline: ol ? parseInt(wAttr(ol, 'val'), 10) : -1,
        info: null
      };
    }
    var dd = firstDesc(doc, 'docDefaults'), l = dd && firstDesc(dd, 'lang');
    if (l) lang = wAttr(l, 'val');
    return { styles: styles, lang: lang };
  }

  // Уровень заголовка (0 - не заголовок) и признак оглавления по стилю, с учётом basedOn
  function styleInfo(styles, id, depth) {
    var st = styles[id];
    if (!st) return { level: levelFromName(id), toc: TOC_ID.test(id) };
    if (st.info) return st.info;
    var level = levelFromName(st.name) || levelFromName(id);
    var toc = TOC_NAME.test(st.name) || TOC_ID.test(id);
    if (!level && st.outline >= 0) level = st.outline < 9 ? st.outline + 1 : 0;
    else if (!level && !toc && st.based && depth < 8) {
      var b = styleInfo(styles, st.based, depth + 1);
      level = b.level; toc = b.toc;
    }
    st.info = { level: level, toc: toc };
    return st.info;
  }

  function docxParaInfo(p, styles) {
    var ppr = firstChild(p, 'pPr'), level = 0, toc = false;
    if (ppr) {
      var ps = firstChild(ppr, 'pStyle'), ol = firstChild(ppr, 'outlineLvl');
      if (ps) { var info = styleInfo(styles, wAttr(ps, 'val'), 0); level = info.level; toc = info.toc; }
      if (ol) { var v = parseInt(wAttr(ol, 'val'), 10); level = v >= 0 && v < 9 ? v + 1 : 0; }
    }
    return { level: level, toc: toc };
  }

  function docxInline(node, parts) {
    for (var c = node.firstElementChild; c; c = c.nextElementSibling) {
      var n = lname(c);
      if (n === 't') parts.push(c.textContent);
      else if (n === 'tab' || n === 'br' || n === 'cr') parts.push(' ');
      else if (n === 'nobreakhyphen') parts.push('-');
      else if (DOCX_SKIP[n]) continue;
      else if (n === 'r' && firstChild(c, 'rPr') && firstChild(firstChild(c, 'rPr'), 'vanish')) continue;   // скрытый текст
      else docxInline(c, parts);
    }
  }

  function docxText(p) {
    var parts = [];
    docxInline(p, parts);
    return norm(parts.join(''));
  }

  // Строка таблицы -> абзац, ячейки через "; "
  function docxTable(tbl, units) {
    for (var r = tbl.firstElementChild; r; r = r.nextElementSibling) {
      if (lname(r) !== 'tr') continue;
      var cells = [];
      for (var c = r.firstElementChild; c; c = c.nextElementSibling) {
        if (lname(c) !== 'tc') continue;
        var ps = c.getElementsByTagNameNS('*', 'p'), parts = [];
        for (var i = 0; i < ps.length; i++) { var t = docxText(ps[i]); if (t) parts.push(t); }
        if (parts.length) cells.push(parts.join(' '));
      }
      if (cells.length) units.push({ t: cells.join('; '), h: 0 });
    }
  }

  function docxCollect(container, styles, units) {
    for (var c = container.firstElementChild; c; c = c.nextElementSibling) {
      var n = lname(c);
      if (n === 'p') {
        var info = docxParaInfo(c, styles);
        if (info.toc) continue;
        var t = docxText(c);
        if (t) units.push({ t: t, h: info.level >= 1 && info.level <= 3 ? info.level : 0 });
      } else if (n === 'tbl') docxTable(c, units);
      else if (n !== 'sectpr' && n !== 'sdtpr') docxCollect(c, styles, units);   // sdt, ins, smartTag и т.п.
    }
  }

  async function docxMainPath(idx) {
    var data = await idx.bytes('_rels/.rels'), doc = data && parseXml(decodeXmlBytes(data));
    if (doc) {
      var rels = doc.getElementsByTagNameNS('*', 'Relationship');
      for (var i = 0; i < rels.length; i++) {
        if (/\/officeDocument$/.test(rels[i].getAttribute('Type') || '')) {
          var path = resolveHref('', rels[i].getAttribute('Target') || '').path;
          if (path && idx.find(path)) return path;
        }
      }
    }
    return 'word/document.xml';
  }

  async function parseDocxZip(zip, fallbackTitle) {
    var idx = new ZipIndex(zip), mainPath = await docxMainPath(idx);
    var data = await idx.bytes(mainPath);
    if (!data) fail('broken', 'DOCX has no word/document.xml');
    var doc = parseXml(decodeXmlBytes(data));
    var body = doc && firstDesc(doc, 'body');
    if (!body) fail('broken', 'DOCX main document is not valid');
    var sdata = await idx.bytes(dirOf(mainPath) + 'styles.xml');
    var st = parseDocxStyles(sdata && parseXml(decodeXmlBytes(sdata)));
    var cdata = await idx.bytes('docProps/core.xml'), core = cdata && parseXml(decodeXmlBytes(cdata));
    var units = [];
    docxCollect(body, st.styles, units);
    var t = tick(); if (t) await t;
    var lifted = liftDocTitle(units);
    return buildBook({
      title: (core && textOf(firstDesc(core, 'title'))) || lifted,
      fallbackTitle: fallbackTitle,
      author: core ? textOf(firstDesc(core, 'creator')) : '',
      lang: st.lang,
      checkLang: true,
      format: 'docx',
      chapters: unitsToChapters(units)
    }, null);
  }

  // ---------------------------------------------------------------- HTML

  // Кодировка HTML: BOM, <meta charset> / http-equiv, иначе строгий UTF-8, иначе 8-битная по частотам
  function decodeHtmlBytes(bytes) {
    var b = bytes;
    if ((b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) || (b[0] === 0xff && b[1] === 0xfe) ||
        (b[0] === 0xfe && b[1] === 0xff)) return decodeText(bytes);
    var head = latin1Head(b, 4096);
    var m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head) || /<\?xml[^>]*encoding\s*=\s*["']([^"']+)/i.exec(head);
    var label = m ? labelFromXmlDecl(m[1]) : '';
    if (label && label !== 'utf-8') {
      var s = tryDecode(label, bytes);
      if (s !== null) return s;
    }
    return decodeText(bytes);
  }

  function metaContent(doc, name) {
    var metas = doc.getElementsByTagName('meta');
    for (var i = 0; i < metas.length; i++) {
      if ((metas[i].getAttribute('name') || '').toLowerCase() === name) return norm(metas[i].getAttribute('content') || '');
    }
    return '';
  }

  async function parseHtml(bytes, fallbackTitle) {
    var doc;
    try { doc = new DOMParser().parseFromString(decodeHtmlBytes(bytes), 'text/html'); } catch (e) { doc = null; }
    if (!doc || !doc.body) fail('broken', 'HTML cannot be parsed');
    var seg = extractSegments(doc.body, null)[0];
    var items = seg.total > 0 && seg.link / seg.total > 0.6 && seg.items.length >= 3 ? [] : dropLinkRuns(seg.items);
    var units = items.map(function (it) { return { t: it.t, h: it.h >= 1 && it.h <= 3 ? it.h : 0 }; });
    var t = tick(); if (t) await t;
    var lifted = liftDocTitle(units);
    var root = doc.documentElement;
    return buildBook({
      title: norm(doc.title || '') || lifted,
      fallbackTitle: fallbackTitle,
      author: metaContent(doc, 'author'),
      lang: root.getAttribute('lang') || root.getAttribute('xml:lang') || '',
      checkLang: true,
      format: 'html',
      chapters: unitsToChapters(units)
    }, null);
  }

  // ---------------------------------------------------------------- ZIP и точка входа

  // порядок важен: при нескольких файлах в архиве берётся первый подходящий вид, самый большой файл
  var BOOK_EXT = [/\.fb2$/i, /\.epub$/i, /\.docx$/i, /\.txt$/i, /\.html?$/i, /\.zip$/i];

  async function parseZipBytes(bytes, fallbackTitle, depth) {
    var zip = await openZip(bytes), idx = new ZipIndex(zip);
    if (idx.find('META-INF/container.xml') || idx.find('mimetype')) return parseEpubZip(zip, fallbackTitle);
    if (idx.find('word/document.xml')) return parseDocxZip(zip, fallbackTitle);
    var names = [];
    zip.forEach(function (p, entry) {
      if (!entry.dir && !/(^|\/)(__MACOSX|\.)/.test(p) && !/(^|\/)\._/.test(p)) names.push({ p: p, size: entry._data ? entry._data.uncompressedSize || 0 : 0 });
    });
    for (var k = 0; k < BOOK_EXT.length; k++) {
      var hits = names.filter(function (n) { return BOOK_EXT[k].test(n.p); });
      if (!hits.length) continue;
      hits.sort(function (a, b) { return b.size - a.size; });
      if (k === BOOK_EXT.length - 1 && depth >= 2) break;
      return parseByName(await idx.bytes(hits[0].p), hits[0].p, fallbackTitle, depth + 1);
    }
    return fail('unsupported', 'Zip has no FB2/EPUB/DOCX/TXT/HTML file');
  }

  async function parseByName(bytes, name, fallbackTitle, depth) {
    var lower = String(name || '').toLowerCase();
    if (/\.txt$/.test(lower)) return parseTxt(bytes, fallbackTitle);
    if (/\.(html?|xhtml)$/.test(lower)) return parseHtml(bytes, fallbackTitle);
    if (isOle(bytes)) {   // OLE: пароль на DOCX (EncryptedPackage) или старый .doc
      return hasUtf16(bytes, 'EncryptedPackage') ? fail('drm', 'Office file is password protected')
        : fail('unsupported', 'Legacy OLE document (.doc) is not supported');
    }
    if (isZip(bytes)) {
      if (/\.epub$/.test(lower)) return parseEpubZip(await openZip(bytes), fallbackTitle);
      if (/\.docx$/.test(lower)) return parseDocxZip(await openZip(bytes), fallbackTitle);
      return depth > 2 ? fail('broken', 'Zip nested too deep') : parseZipBytes(bytes, fallbackTitle, depth);
    }
    if (/\.(epub|docx|zip)$/.test(lower)) return fail('broken', 'File is not a zip archive');
    if (/\.fb2$/.test(lower)) return parseFb2(bytes, fallbackTitle);
    // расширение неизвестно: распознаём FB2 по содержимому
    if (/^\s*(<\?xml|<FictionBook)/i.test(latin1Head(bytes, 100).replace(/^\u00ef\u00bb\u00bf/, ''))) {
      return parseFb2(bytes, fallbackTitle);
    }
    return fail('unsupported', 'Unsupported file type: ' + lower);
  }

  async function parse(file) {
    try {
      if (!file || typeof file.size !== 'number') fail('unsupported', 'Not a file');
      var name = file.name || '';
      var bytes = await readBytes(file);
      if (!bytes.length) {
        return /\.txt$/i.test(name) ? fail('empty', 'File is empty') : fail('broken', 'File is empty');
      }
      return await parseByName(bytes, name, stripExt(name), 0);
    } catch (e) {
      if (e && e.name === 'ParseError') throw e;
      throw new ParseError('broken', 'Unexpected failure: ' + (e && e.message ? e.message : e));
    }
  }

  global.ParseError = global.ParseError || ParseError;
  global.Parsers = { EXTENSIONS: EXTENSIONS, accept: ACCEPT, parse: parse, ParseError: ParseError };
})(typeof window !== 'undefined' ? window : this);
