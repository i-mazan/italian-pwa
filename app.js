'use strict';

// ---------- constants & storage ----------
const WORDS_KEY = 'ivp.words.v1';
const SETTINGS_KEY = 'ivp.settings.v1';
const POS = ['noun', 'verb', 'adj', 'adv', 'phrase', 'other'];
const PRON = ['io', 'tu', 'lui', 'noi', 'voi', 'loro'];
const PRON_LABEL = { io: 'io', tu: 'tu', lui: 'lui/lei', noi: 'noi', voi: 'voi', loro: 'loro' };
const DAY = 864e5;
const INTERVALS = [1, 2, 4, 8, 16]; // days per Leitner box 1..5
const NEW_PER_SESSION = 5;
const SESSION_MAX = 20;
const CSV_COLUMNS = ['defArticle', 'indefArticle', 'italian', 'russian', 'pos', 'example', ...PRON];

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
let words = loadJSON(WORDS_KEY, []);
let settings = Object.assign({ strict: false, sortDesc: false }, loadJSON(SETTINGS_KEY, {}));
const hooks = { changed() {} }; // replaced by the sync code; called after every save
const saveWords = () => { localStorage.setItem(WORDS_KEY, JSON.stringify(words)); hooks.changed(); };
// Words deleted on this device, kept until the server has been told: { id: { t, sent } }
const TOMB_KEY = 'ivp.tomb.v1';
let tombs = loadJSON(TOMB_KEY, {});
function deleteWord(w) {
  words = words.filter(x => x !== w);
  tombs[w.id] = { t: Date.now(), sent: false };
  localStorage.setItem(TOMB_KEY, JSON.stringify(tombs));
  saveWords();
}
// Nouns used to be split into noun-m / noun-f; the article already carries the gender, so they are one type now.
const oldNoun = p => p === 'noun-m' || p === 'noun-f';
if (words.some(w => oldNoun(w.pos))) { words.forEach(w => { if (oldNoun(w.pos)) w.pos = 'noun'; }); saveWords(); }
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

// Per-day answer log ({ 'YYYY-MM-DD': { n, ok } }) for streak and today's count.
// Kept separate from word progress so "Reset progress" does not erase it.
const LOG_KEY = 'ivp.log.v1';
let log = loadJSON(LOG_KEY, {});
// `log` is this device's own answers; `logOthers` is the per-day total from the user's other devices (filled by sync).
const LOG_OTHERS_KEY = 'ivp.logOthers.v1';
let logOthers = loadJSON(LOG_OTHERS_KEY, {});
const dayKey = d => d.toLocaleDateString('en-CA');
const dayStat = k => {
  const a = log[k], b = logOthers[k];
  return a || b ? { n: (a ? a.n : 0) + (b ? b.n : 0), ok: (a ? a.ok : 0) + (b ? b.ok : 0) } : null;
};
function logAnswer(ok) {
  const d = log[dayKey(new Date())] || (log[dayKey(new Date())] = { n: 0, ok: 0 });
  d.n++;
  if (ok) d.ok++;
  localStorage.setItem(LOG_KEY, JSON.stringify(log));
  hooks.changed();
}
function streak() {
  const d = new Date();
  if (!dayStat(dayKey(d))) d.setDate(d.getDate() - 1); // today not practised yet: count back from yesterday
  let n = 0;
  while (dayStat(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

// ---------- small helpers ----------
const $ = sel => document.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'it-IT';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
const speakBtn = text => h('button', { class: 'icon-btn', title: 'Pronounce', type: 'button', onclick: () => speak(text) }, '🔊');

// ---------- word helpers ----------
const withArticle = (a, it) => (!a ? it : a.endsWith("'") ? a + it : a + ' ' + it);
const itForms = w => {
  const f = [w.defArticle, w.indefArticle].filter(Boolean).map(a => withArticle(a, w.it));
  return f.length ? f : [w.it];
};
// Flashcards show both articles together: 'il / un museo' (or "l'amico / un amico" when the article elides).
function itShown(w) {
  if (!w.defArticle || !w.indefArticle) return itForms(w)[0];
  return (w.defArticle.endsWith("'") || w.indefArticle.endsWith("'"))
    ? itForms(w).join(' / ')
    : w.defArticle + ' / ' + w.indefArticle + ' ' + w.it;
}
const ruList = w => w.ru.split(',').map(s => s.trim()).filter(Boolean);
const conjOf = w => (w.conj && w.conj.presente) || {};
const hasConj = w => w.pos === 'verb' && PRON.some(p => conjOf(w)[p]);

function normIt(s) {
  s = s.normalize('NFC').toLowerCase().replace(/[’`´]/g, "'").replace(/'\s+/g, "'").replace(/\s+/g, ' ').trim();
  if (!settings.strict) s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
  return s;
}
const normRu = s => s.normalize('NFC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

// Regular present-tense forms for -are / -ere / -ire verbs (best-effort suggestion, user edits).
function regularForms(inf) {
  const m = inf.trim().toLowerCase().match(/^(.+)(are|ere|ire)$/);
  if (!m) return null;
  const [, stem, kind] = m;
  const ends = {
    are: ['o', 'i', 'a', 'iamo', 'ate', 'ano'],
    ere: ['o', 'i', 'e', 'iamo', 'ete', 'ono'],
    ire: ['o', 'i', 'e', 'iamo', 'ite', 'ono'],
  }[kind];
  return ends.map((end, i) => {
    let st = stem;
    if (kind === 'are' && (i === 1 || i === 3)) {
      if (/[cg]$/.test(st)) st += 'h'; // cercare -> cerchi
      else if (/[cg]i$/.test(st)) st = st.slice(0, -1); // mangiare -> mangi
    }
    return st + end;
  });
}

// ---------- spaced repetition ----------
const srsGet = (w, k) => w.srs && w.srs[k];

function grade(w, k, ok) {
  w.srs = w.srs || {};
  const e = w.srs[k] || { box: 1, due: 0 };
  e.box = ok ? Math.min(e.box + 1, 5) : 1;
  e.due = Date.now() + INTERVALS[e.box - 1] * DAY;
  w.srs[k] = e;
  w.updatedAt = Date.now();
}

function keysOf(item) {
  return item.k === 'table' ? PRON.filter(p => conjOf(item.w)[p]).map(p => 'conj-' + p) : [item.k];
}

function status(item) {
  const es = keysOf(item).map(k => srsGet(item.w, k));
  if (es.every(e => !e)) return 'new';
  return es.some(e => !e || e.due <= Date.now()) ? 'due' : 'later';
}

function itemsFor(mode, dir) {
  if (mode === 'conj') {
    return words.flatMap(w => (w.pos === 'verb' ? PRON.filter(p => conjOf(w)[p]).map(p => ({ w, k: 'conj-' + p, p })) : []));
  }
  if (mode === 'table') return words.filter(hasConj).map(w => ({ w, k: 'table' }));
  const dirs = dir === 'mixed' ? ['ru-it', 'it-ru'] : [dir];
  return words.flatMap(w => dirs.map(k => ({ w, k })));
}

function buildQueue(items) {
  const due = shuffle(items.filter(i => status(i) === 'due'));
  const fresh = shuffle(items.filter(i => status(i) === 'new')).slice(0, NEW_PER_SESSION);
  const queue = due.concat(fresh).slice(0, SESSION_MAX);
  if (queue.length || !items.length) return queue;
  // Nothing due or new: extra practice, weakest cards (lowest box) first.
  const box = i => Math.min(...keysOf(i).map(k => srsGet(i.w, k)?.box ?? 1));
  return shuffle(items).sort((a, b) => box(a) - box(b)).slice(0, SESSION_MAX).map(i => ({ ...i, extra: true }));
}

// ---------- theme ----------
// Follows the device until the user picks Light or Dark in Settings.
const currentTheme = () => settings.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const applyTheme = () => { document.documentElement.dataset.theme = currentTheme(); };
applyTheme();

// ---------- navigation ----------
const views = { library: renderLibrary, train: renderTrain, settings: renderSettings };

let currentView = 'library';
function show(view) {
  if (!authSession) return showLogin();
  currentView = view;
  $('#view-login').hidden = true;
  $('nav').hidden = false;
  for (const name of Object.keys(views)) $('#view-' + name).hidden = name !== view;
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  views[view]();
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));

// The Library toolbar sticks just below the header, so it needs the header's height.
const syncHeaderHeight = () => document.documentElement.style.setProperty('--header-h', document.querySelector('header').offsetHeight + 'px');
syncHeaderHeight();
window.addEventListener('resize', syncHeaderHeight);

// ---------- library ----------
const lib = { q: '', pos: '' };
// Library filter chips: words without an article ('other') are listed with the nouns.
const LIB_GROUPS = [
  ['', 'All', () => true],
  ['noun', 'Nouns', w => w.pos === 'noun' || w.pos === 'other'],
  ['verb', 'Verbs', w => w.pos === 'verb'],
  ['adj', 'Adjectives', w => w.pos === 'adj'],
  ['adv', 'Adverbs', w => w.pos === 'adv'],
  ['phrase', 'Phrases', w => w.pos === 'phrase'],
];

const sortLabel = () => (settings.sortDesc ? 'Z→A' : 'A→Z');

function renderLibrary() {
  const root = $('#view-library');
  root.replaceChildren();
  const list = h('div');
  const chips = h('div', { class: 'chips' });

  const sortBtn = h('button', {
    class: 'btn secondary sort-btn',
    title: 'Sort Italian words',
    onclick: () => { settings.sortDesc = !settings.sortDesc; saveSettings(); sortBtn.textContent = sortLabel(); refresh(); },
  }, sortLabel());

  // Sorted once per render (words only change through the editor, which re-renders);
  // typing in Search or tapping a chip just filters this list.
  const sorted = words
    .map(w => ({ w, hay: (w.it + ' ' + w.ru).toLowerCase() }))
    .sort((a, b) => a.w.it.localeCompare(b.w.it, 'it'));
  const counts = LIB_GROUPS.map(([, , test]) => words.filter(test).length);

  const drawChips = () => chips.replaceChildren(...LIB_GROUPS.map(([key, label], i) =>
    h('button', {
      class: 'chip' + (lib.pos === key ? ' active' : ''),
      onclick: () => { lib.pos = key; drawChips(); refresh(); },
    }, `${label} (${counts[i]})`)));

  const refresh = () => {
    const q = lib.q.toLowerCase();
    const test = LIB_GROUPS.find(g => g[0] === lib.pos)[2];
    const shown = sorted.filter(s => test(s.w) && (!q || s.hay.includes(q))).map(s => s.w);
    if (settings.sortDesc) shown.reverse();
    list.replaceChildren(
      ...(shown.length ? shown.map(wordRow) : [h('p', { class: 'muted' }, words.length ? 'No matches.' : 'No words yet. Add one or import a CSV in Settings.')])
    );
  };

  root.append(
    h('div', { class: 'lib-top' },
      h('div', { class: 'row' },
        h('input', { type: 'search', placeholder: 'Search…', value: lib.q, oninput: e => { lib.q = e.target.value; refresh(); } }),
        sortBtn,
        h('button', { class: 'btn add-btn', onclick: () => openEditor() }, '+ Add')
      ),
      chips
    ),
    list
  );
  drawChips();
  refresh();
}

const openVerbs = new Set();

function wordRow(w) {
  const art = [w.defArticle, w.indefArticle].filter(Boolean).join(' / ');
  const expandable = hasConj(w);
  const open = expandable && openVerbs.has(w.id);
  const row = h('div', { class: 'word' },
    h('div', { class: 'main' },
      h('div', null,
        art ? h('span', { class: 'art' }, art + ' ') : null,
        h('span', { class: 'it' }, w.it),
        h('span', { class: 'badge' }, w.pos)),
      h('div', { class: 'muted' }, w.ru),
      w.example ? h('div', { class: 'muted example' }, w.example) : null,
      expandable ? h('button', {
        class: 'conj-toggle',
        title: open ? 'Hide conjugation' : 'Show conjugation',
        onclick: () => {
          if (openVerbs.has(w.id)) openVerbs.delete(w.id); else openVerbs.add(w.id);
          row.replaceWith(wordRow(w));
        },
      }, open ? '▾' : '▸') : null),
    speakBtn(itForms(w)[0]),
    h('button', { class: 'icon-btn', title: 'Edit', onclick: () => openEditor(w) }, '✏️'),
    open ? h('div', { class: 'conj-list' },
      ...PRON.filter(p => conjOf(w)[p]).flatMap(p => [h('span', { class: 'hl' }, p), h('span', null, conjOf(w)[p])])) : null);
  return row;
}

function openEditor(existing) {
  const w = existing || { pos: 'noun' };
  const conj = conjOf(w);
  const f = {};
  const field = (name, label, attrs = {}) => {
    f[name] = h('input', Object.assign({ value: w[name] ?? '' }, attrs));
    return [h('label', { id: 'lbl-' + name }, label), f[name]];
  };

  f.pos = h('select', { onchange: syncVerb }, POS.map(p => h('option', { value: p, selected: w.pos === p }, p)));
  const conjInputs = {};
  const conjBox = h('fieldset', null,
    h('legend', { class: 'muted' }, 'Present simple (presente)'),
    h('div', { class: 'conj-grid' },
      PRON.flatMap(p => {
        conjInputs[p] = h('input', { value: conj[p] ?? '', autocapitalize: 'off' });
        return [h('label', null, PRON_LABEL[p]), conjInputs[p], h('span')];
      })),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn secondary', type: 'button',
        onclick: () => {
          const forms = regularForms(f.it.value);
          if (!forms) return alert('Enter the infinitive first (ending in -are, -ere or -ire).');
          PRON.forEach((p, i) => { conjInputs[p].value = forms[i]; });
        },
      }, 'Autofill regular'),
      h('span', { class: 'muted' }, 'Check -isc verbs and irregulars by hand.')));

  function syncVerb() {
    conjBox.hidden = f.pos.value !== 'verb';
    dlg.querySelector('#article-fields').hidden = !f.pos.value.startsWith('noun');
    // "without article" only makes sense for nouns and other (article-less) words
    const plain = f.pos.value.startsWith('noun') || f.pos.value === 'other';
    dlg.querySelector('#lbl-it').textContent = plain ? 'Italian (without article)' : 'Italian';
  }

  const dlg = h('dialog');
  const form = h('form', {
    method: 'dialog',
    onsubmit: e => {
      e.preventDefault();
      const it = f.it.value.trim();
      const ru = f.ru.value.trim();
      if (!it || !ru) return alert('Italian and Russian are required.');
      const isNoun = f.pos.value.startsWith('noun');
      const data = {
        it, ru,
        pos: f.pos.value,
        defArticle: isNoun ? f.defArticle.value.trim().toLowerCase() : '',
        indefArticle: isNoun ? f.indefArticle.value.trim().toLowerCase() : '',
        example: f.example.value.trim(),
      };
      const forms = {};
      if (data.pos === 'verb') PRON.forEach(p => { const v = conjInputs[p].value.trim(); if (v) forms[p] = v; });
      data.conj = Object.keys(forms).length ? { presente: forms } : undefined;
      if (existing) Object.assign(existing, data);
      else words.push({ id: crypto.randomUUID(), srs: {}, ...data });
      (existing || words[words.length - 1]).updatedAt = Date.now();
      saveWords();
      dlg.close();
      renderLibrary();
    },
  },
    h('button', { class: 'close-x', type: 'button', title: 'Cancel', 'aria-label': 'Cancel', onclick: () => dlg.close() }, '✕'),
    h('h2', null, existing ? 'Edit word' : 'Add word'),
    h('label', null, 'Type'), f.pos,
    field('it', 'Italian (without article)', { required: true, autocapitalize: 'off' }),
    field('ru', 'Russian (separate translations with commas)', { required: true }),
    h('div', { id: 'article-fields' },
      field('defArticle', 'Definite article (il, lo, la, l\', i, gli, le)', { list: 'dl-def', autocapitalize: 'off' }),
      field('indefArticle', 'Indefinite article (un, uno, una, un\')', { list: 'dl-indef', autocapitalize: 'off' })),
    field('example', 'Example sentence'),
    conjBox,
    h('div', { class: 'row' },
      existing ? h('button', {
        class: 'btn danger', type: 'button',
        onclick: () => {
          if (!confirm(`Delete "${existing.it}"?`)) return;
          deleteWord(existing);
          dlg.close();
          renderLibrary();
        },
      }, 'Delete') : null,
      h('button', { class: 'btn secondary', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn', type: 'submit' }, 'Save')));

  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  syncVerb();
  dlg.showModal();
}

// ---------- training ----------
const trainPrefs = { mode: 'flash', dir: 'mixed' };
let session = null;

const MODES = [
  ['flash', 'Flashcards'],
  ['type', 'Type the answer'],
  ['conj', 'Verb conjugation: one form'],
  ['table', 'Verb conjugation: full table'],
];

// Phrases can't be typed reliably, so they only appear in flashcards.
function modeItems(mode, dir) {
  const items = itemsFor(mode === 'flash' || mode === 'type' ? 'words' : mode, dir);
  return mode === 'type' ? items.filter(i => i.w.pos !== 'phrase') : items;
}

function renderTrain() {
  const root = $('#view-train');
  root.replaceChildren();
  if (session) return renderCard();

  const dirSel = h('select', { onchange: e => { trainPrefs.dir = e.target.value; } },
    [['mixed', 'Mixed'], ['ru-it', 'Russian → Italian'], ['it-ru', 'Italian → Russian']]
      .map(([v, t]) => h('option', { value: v, selected: trainPrefs.dir === v }, t)));
  const syncDir = () => { dirSel.disabled = trainPrefs.mode === 'conj' || trainPrefs.mode === 'table'; };

  root.append(
    h('h2', null, 'Practice'),
    h('label', { class: 'muted' }, 'Mode'),
    h('select', { onchange: e => { trainPrefs.mode = e.target.value; syncDir(); } },
      MODES.map(([v, t]) => h('option', { value: v, selected: trainPrefs.mode === v }, t))),
    h('label', { class: 'muted' }, 'Direction'),
    dirSel,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: startSession }, 'Start')));
  syncDir();
}

function startSession() {
  const queue = buildQueue(modeItems(trainPrefs.mode, trainPrefs.dir));
  if (!queue.length) {
    const needsVerbs = trainPrefs.mode === 'conj' || trainPrefs.mode === 'table';
    return alert(words.length
      ? needsVerbs ? 'No verbs with conjugation forms yet. Add a verb and fill in its forms.'
        : trainPrefs.mode === 'type' ? 'No words to type yet. Phrases are practised with flashcards.' : 'Nothing to practise yet.'
      : 'Add some words first.');
  }
  session = { mode: trainPrefs.mode, queue, idx: 0, correct: 0, total: 0 };
  renderTrain();
}

function endSession() {
  session = null;
  renderTrain();
}

function finish(item, results) {
  // results: { key: bool } - graded once per item; retries are not graded again
  const ok = Object.values(results).every(Boolean);
  if (!item.isRetry) {
    // Extra practice (nothing was due): right answers leave the schedule alone, wrong ones still reset the card.
    for (const [k, v] of Object.entries(results)) if (!item.extra || !v) grade(item.w, k, v);
    saveWords();
    logAnswer(ok);
    session.total++;
    if (ok) session.correct++;
    if (!ok) session.queue.push({ ...item, isRetry: true });
  }
  session.idx++;
}

function progressBar() {
  return h('div', { class: 'row' },
    h('span', { class: 'muted' }, `${Math.min(session.idx + 1, session.queue.length)} / ${session.queue.length}`),
    h('button', { class: 'btn secondary', onclick: endSession }, 'Quit'));
}

function renderCard() {
  const root = $('#view-train');
  root.replaceChildren();
  const item = session.queue[session.idx];
  if (!item) {
    root.append(
      h('div', { class: 'card' },
        h('div', { class: 'big' }, 'Done!'),
        h('div', { class: 'sub' }, `${session.correct} of ${session.total} correct first time`),
        session.queue.some(i => i.extra) ? h('div', { class: 'sub' }, 'Extra practice: correct answers did not change your schedule.') : null),
      h('div', { class: 'row' },
        h('button', { class: 'btn secondary', onclick: endSession }, 'Back'),
        h('button', { class: 'btn', onclick: () => { session = null; startSession(); } }, 'Practice more')));
    return;
  }
  root.append(progressBar());
  const next = () => renderCard();
  if (session.mode === 'flash') flashCard(root, item, next);
  else if (session.mode === 'type') typeCard(root, item, next);
  else if (session.mode === 'conj') conjCard(root, item, next);
  else tableCard(root, item, next);
}

function prompt(item) {
  const w = item.w;
  return item.k === 'ru-it' ? w.ru : itForms(w)[0];
}
function answer(item) {
  const w = item.w;
  return item.k === 'ru-it' ? itForms(w).join('  /  ') : w.ru;
}
const typeLabel = w => (w.pos.startsWith('noun') ? 'noun' : w.pos);

function extras(w) {
  return [w.example ? h('div', { class: 'sub' }, w.example) : null, h('div', { class: 'sub' }, typeLabel(w))];
}

function flashCard(root, item, next) {
  const w = item.w;
  const inner = h('div', { class: 'flip-inner' },
    h('div', { class: 'face front' },
      h('div', { class: 'big' }, item.k === 'ru-it' ? w.ru : itShown(w), item.k === 'it-ru' ? speakBtn(itForms(w)[0]) : null),
      h('div', { class: 'sub' }, typeLabel(w))),
    h('div', { class: 'face back' },
      h('div', { class: 'big' }, item.k === 'ru-it' ? itShown(w) : w.ru, item.k === 'ru-it' ? speakBtn(itForms(w)[0]) : null),
      extras(w)));
  const flip = h('div', { class: 'flip' }, inner);
  const grading = h('div', { class: 'row center', hidden: true },
    h('button', { class: 'btn dunno', onclick: () => { finish(item, { [item.k]: false }); next(); } }, 'Still learning'),
    h('button', { class: 'btn know', onclick: () => { finish(item, { [item.k]: true }); next(); } }, 'Know'));
  const reveal = h('div', { class: 'row center' },
    h('button', {
      class: 'btn',
      onclick: e => {
        inner.classList.add('flipped');
        e.target.parentElement.hidden = true;
        grading.hidden = false;
        if (item.k === 'ru-it') speak(itForms(w)[0]);
      },
    }, 'Show answer'));
  root.append(flip, reveal, grading);
}

const answerInput = placeholder =>
  h('input', { autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder });

// Shared by the three typed-answer cards: a card plus a Check/Next button.
// check() runs on the first submit (grade, show feedback); the next submit moves on.
function formCard(root, next, cardKids, check, focusEl) {
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Check');
  let checked = false;
  root.append(h('form', {
    onsubmit: e => {
      e.preventDefault();
      if (checked) return next();
      checked = true;
      check();
      btn.textContent = 'Next';
      btn.focus();
    },
  }, h('div', { class: 'card' }, cardKids), h('div', { class: 'row' }, btn)));
  focusEl.focus();
}

function showFeedback(fb, ok, correct) {
  fb.className = 'fb ' + (ok ? 'ok' : 'bad');
  fb.textContent = ok ? 'Correct!' : 'Answer: ' + correct;
}

function typeCard(root, item, next) {
  const w = item.w;
  const input = answerInput(item.k === 'ru-it' ? 'Italian' : 'Russian');
  const fb = h('div', { class: 'fb' });
  formCard(root, next, [
    h('div', { class: 'big' }, prompt(item), item.k === 'it-ru' ? speakBtn(itForms(w)[0]) : null),
    input, fb,
  ], () => {
    const text = input.value;
    const ok = item.k === 'ru-it'
      ? itForms(w).some(x => normIt(x) === normIt(text))
      : ruList(w).concat(w.ru).some(x => normRu(x) === normRu(text));
    input.disabled = true;
    showFeedback(fb, ok, answer(item));
    if (item.k === 'ru-it') speak(itForms(w)[0]);
    finish(item, { [item.k]: ok });
  }, input);
}

function conjShow(w, hlPron) {
  const c = conjOf(w);
  return h('div', { class: 'conj-show' },
    PRON.flatMap(p => c[p] ? [h('span', { class: p === hlPron ? 'hl' : '' }, PRON_LABEL[p]), h('span', { class: p === hlPron ? 'hl' : '' }, c[p])] : []));
}

function conjCard(root, item, next) {
  const w = item.w;
  const input = answerInput('Form');
  const fb = h('div', { class: 'fb' });
  const detail = h('div');
  formCard(root, next, [
    h('div', { class: 'big' }, w.it),
    h('div', { class: 'sub' }, w.ru),
    h('div', { class: 'pron' }, PRON_LABEL[item.p]),
    input, fb, detail,
  ], () => {
    const expected = conjOf(w)[item.p];
    const ok = normIt(input.value) === normIt(expected);
    input.disabled = true;
    showFeedback(fb, ok, expected);
    detail.append(conjShow(w, item.p));
    speak(expected);
    finish(item, { [item.k]: ok });
  }, input);
}

function tableCard(root, item, next) {
  const w = item.w;
  const c = conjOf(w);
  const pronouns = PRON.filter(p => c[p]);
  const inputs = {};
  const marks = {};
  const fixes = {};
  const grid = h('div', { class: 'conj-grid' },
    pronouns.flatMap(p => {
      inputs[p] = answerInput(null);
      marks[p] = h('span', { class: 'mark' });
      fixes[p] = h('div', { class: 'fix', hidden: true });
      return [h('label', null, PRON_LABEL[p]), inputs[p], marks[p], fixes[p]];
    }));
  formCard(root, next, [
    h('div', { class: 'big' }, w.it),
    h('div', { class: 'sub' }, w.ru),
    grid,
  ], () => {
    const results = {};
    pronouns.forEach(p => {
      const ok = normIt(inputs[p].value) === normIt(c[p]);
      results['conj-' + p] = ok;
      inputs[p].disabled = true;
      marks[p].className = 'mark ' + (ok ? 'ok' : 'bad');
      marks[p].textContent = ok ? '✓' : '✗';
      if (!ok) { fixes[p].textContent = c[p]; fixes[p].hidden = false; }
    });
    finish(item, results);
  }, inputs[pronouns[0]]);
}

// ---------- CSV ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0];
  const delim = first.split(';').length >= first.split(',').length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function importCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) return alert('The file is empty.');
  const header = rows[0].map(c => c.trim().toLowerCase());
  const col = Object.fromEntries(CSV_COLUMNS.map(n => [n, header.indexOf(n.toLowerCase())]));
  if (col.italian < 0 || col.russian < 0) return alert('The header row must contain "italian" and "russian" columns.');
  const get = (r, n) => (col[n] >= 0 ? (r[col[n]] || '').trim() : '');

  let added = 0, updated = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const it = get(r, 'italian'), ru = get(r, 'russian');
    if (!it || !ru) { skipped++; continue; }
    const forms = {};
    PRON.forEach(p => { const v = get(r, p); if (v) forms[p] = v; });
    let pos = get(r, 'pos').toLowerCase();
    if (oldNoun(pos)) pos = 'noun'; // older files use noun-m / noun-f
    if (!POS.includes(pos)) pos = Object.keys(forms).length ? 'verb' : 'other';
    const data = {
      it, ru, pos,
      defArticle: get(r, 'defArticle').toLowerCase(),
      indefArticle: get(r, 'indefArticle').toLowerCase(),
      example: get(r, 'example'),
      conj: Object.keys(forms).length ? { presente: forms } : undefined,
      updatedAt: Date.now(),
    };
    const dup = words.find(w => w.it.toLowerCase() === it.toLowerCase() && (w.defArticle || '') === data.defArticle);
    if (dup) { Object.assign(dup, data); updated++; }
    else { words.push({ id: crypto.randomUUID(), srs: {}, ...data }); added++; }
  }
  saveWords();
  alert(`Import finished: ${added} added, ${updated} updated, ${skipped} skipped.`);
}

function exportCSV() {
  const esc = v => (/[;",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  const lines = [CSV_COLUMNS.join(';')];
  for (const w of words) {
    const c = conjOf(w);
    const vals = [w.defArticle || '', w.indefArticle || '', w.it, w.ru, w.pos, w.example || '', ...PRON.map(p => c[p] || '')];
    lines.push(vals.map(esc).join(';'));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: 'italian-words.csv' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- settings ----------
// Every card a word can have: two directions, plus one per filled verb form.
function validKeys(w) {
  const forms = w.pos === 'verb' ? PRON.filter(p => conjOf(w)[p]).map(p => 'conj-' + p) : [];
  return ['ru-it', 'it-ru', ...forms];
}

function learningStats() {
  const s = { total: 0, new: 0, learning: 0, familiar: 0, mastered: 0 };
  for (const w of words) {
    for (const k of validKeys(w)) {
      s.total++;
      const e = srsGet(w, k);
      if (!e) s.new++;
      else if (e.box <= 2) s.learning++;
      else if (e.box <= 4) s.familiar++;
      else s.mastered++;
    }
  }
  return s;
}

function progressSection(s) {
  const today = dayStat(dayKey(new Date())) || { n: 0 };
  const tile = (value, label) => h('div', { class: 'tile' }, h('div', { class: 'num' }, String(value)), h('div', { class: 'muted' }, label));
  const parts = [['new', 'New', s.new], ['learning', 'Learning', s.learning], ['familiar', 'Familiar', s.familiar], ['mastered', 'Mastered', s.mastered]];
  return h('div', null,
    h('div', { class: 'stats' },
      tile(streak(), 'day streak'),
      tile(today.n, 'answered today')),
    s.total
      ? [
        h('div', { class: 'bar' }, parts.map(([cls, label, n]) => (n ? h('span', { class: 'seg ' + cls, style: `flex:${n}`, title: `${label}: ${n}` }) : null))),
        h('div', { class: 'legend' }, parts.map(([cls, label, n]) => h('span', null, h('i', { class: 'dot ' + cls }), `${label} ${n}`))),
      ]
      : h('p', { class: 'muted' }, 'Add some words to start tracking progress.'));
}

function renderSettings() {
  const root = $('#view-settings');
  root.replaceChildren();

  const fileInput = h('input', {
    type: 'file', accept: '.csv,text/csv,text/plain', hidden: true,
    onchange: async e => {
      const file = e.target.files[0];
      if (!file) return;
      importCSV(await file.text());
      e.target.value = '';
      renderSettings();
    },
  });

  root.append(
    h('h2', null, 'Settings'),
    h('p', { class: 'muted' }, `${words.length} word${words.length === 1 ? '' : 's'} in your library`),
    h('label', { class: 'row' },
      h('input', {
        type: 'checkbox', checked: settings.strict,
        onchange: e => { settings.strict = e.target.checked; saveSettings(); },
      }),
      h('span', null, 'Strict accents (è ≠ e) when typing Italian')),
    h('h3', null, 'Theme'),
    h('div', { class: 'row' }, ...['light', 'dark'].map(t =>
      h('button', {
        class: 'btn ' + (currentTheme() === t ? '' : 'secondary'),
        onclick: () => { settings.theme = t; saveSettings(); applyTheme(); renderSettings(); },
      }, t === 'light' ? 'Light' : 'Dark'))),
    h('h3', null, 'CSV'),
    h('p', { class: 'muted' }, 'Columns: ' + CSV_COLUMNS.join('; ') + '. Only italian and russian are required.'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Import CSV'),
      h('button', { class: 'btn secondary', onclick: exportCSV }, 'Export CSV'),
      fileInput),
    h('h3', null, 'Progress'),
    progressSection(learningStats()),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn',
        onclick: () => {
          const s = learningStats();
          if (s.total === s.new) return alert('There is no progress to reset yet.');
          const msg = `Reset progress on ${s.total - s.new} cards (${s.mastered} mastered, ${s.familiar} familiar, ${s.learning} learning)?\n\nYour words and streak are kept. This can't be undone.`;
          if (!confirm(msg)) return;
          words.forEach(w => { w.srs = {}; w.updatedAt = Date.now(); });
          saveWords();
          renderSettings();
        },
      }, 'Reset progress')),
    ...accountSection());
}

// ---------- account ----------
// Accounts are created in the Supabase dashboard; the app only signs in, changes the password and signs out.
const PAROLE_CFG = window.PAROLE_CONFIG || {};
const sb = window.supabase && PAROLE_CFG.url && PAROLE_CFG.anonKey && !PAROLE_CFG.url.startsWith('YOUR_')
  ? window.supabase.createClient(PAROLE_CFG.url, PAROLE_CFG.anonKey)
  : null;
let authSession = null;
const MIN_PASSWORD = 6;

function authMessage(err) {
  const m = (err && err.message) || '';
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
  if (/failed to fetch|network|load failed/i.test(m)) return "Can't reach the server. Check your internet connection.";
  if (/same password|different from the old/i.test(m)) return 'The new password must be different from the current one.';
  return m || 'Something went wrong. Please try again.';
}

function showLogin() {
  for (const name of Object.keys(views)) $('#view-' + name).hidden = true;
  $('nav').hidden = true;
  $('#view-login').hidden = false;
  renderLogin();
}

function renderLogin() {
  const root = $('#view-login');
  root.replaceChildren();
  const msg = h('p', { class: 'fb bad', role: 'alert' });
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const button = h('button', { class: 'btn', type: 'submit' }, 'Sign in');
  root.append(
    h('h2', null, 'Sign in'),
    h('p', { class: 'muted' }, 'Sign in to sync your words across devices.'),
    sb ? null : h('p', { class: 'fb bad' }, 'The app is not connected to Supabase yet. Fill in config.js.'),
    h('form', {
      class: 'login',
      onsubmit: async e => {
        e.preventDefault();
        if (!sb) return;
        msg.textContent = '';
        button.disabled = true;
        try {
          const { data, error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: password.value });
          if (error) throw error;
          authSession = data.session;
          show('library');
        } catch (err) {
          msg.textContent = authMessage(err);
          button.disabled = false;
        }
      },
    },
    h('label', { class: 'muted' }, 'Email'), email,
    h('label', { class: 'muted' }, 'Password'), password,
    msg,
    h('div', { class: 'row' }, button)));
}

function accountSection() {
  const email = authSession && authSession.user ? authSession.user.email : '';
  return [
    h('h3', null, 'Account'),
    h('p', { class: 'muted' }, 'Signed in as ' + email),
    h('p', { class: 'muted', id: 'sync-status' }, syncText()),
    h('div', { class: 'row' },
      h('button', { class: 'btn small', onclick: openChangePassword }, 'Change password'),
      h('button', { class: 'btn small secondary', onclick: () => sb.auth.signOut() }, 'Sign out')),
  ];
}

function openChangePassword() {
  const email = authSession && authSession.user ? authSession.user.email : '';
  const msg = h('p', { class: 'fb', role: 'status' });
  const setMsg = (text, ok) => { msg.className = 'fb ' + (ok ? 'ok' : 'bad'); msg.textContent = text; };
  const current = h('input', { type: 'password', autocomplete: 'current-password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password' });
  const again = h('input', { type: 'password', autocomplete: 'new-password' });
  const save = h('button', { class: 'btn', type: 'submit' }, 'Change password');
  const cancel = h('button', { class: 'btn secondary', type: 'button', onclick: () => dlg.close() }, 'Cancel');

  const dlg = h('dialog');
  dlg.append(h('form', {
    method: 'dialog',
    onsubmit: async e => {
      e.preventDefault();
      if (!current.value) return setMsg('Enter your current password.');
      if (next.value.length < MIN_PASSWORD) return setMsg(`The new password must be at least ${MIN_PASSWORD} characters.`);
      if (next.value !== again.value) return setMsg("The new password and its confirmation don't match.");
      save.disabled = true;
      try {
        // Supabase doesn't check the current password on update, so verify it by signing in again first.
        const check = await sb.auth.signInWithPassword({ email, password: current.value });
        if (check.error) return setMsg(/invalid login credentials/i.test(check.error.message) ? 'The current password is wrong.' : authMessage(check.error));
        const { error } = await sb.auth.updateUser({ password: next.value });
        if (error) return setMsg(authMessage(error));
        current.value = next.value = again.value = '';
        setMsg('Password changed.', true);
        cancel.textContent = 'Close';
      } catch (err) {
        setMsg(authMessage(err));
      } finally {
        save.disabled = false;
      }
    },
  },
  h('button', { class: 'close-x', type: 'button', title: 'Cancel', 'aria-label': 'Cancel', onclick: () => dlg.close() }, '✕'),
  h('h2', null, 'Change password'),
  h('label', null, 'Current password'), current,
  h('label', null, 'New password'), next,
  h('label', null, 'Confirm new password'), again,
  msg,
  h('div', { class: 'row' }, cancel, save)));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  current.focus();
}

// ---------- sync ----------
// Offline-first: localStorage stays the source of truth. A sync pulls rows changed on the server and merges them
// per word (the newer updatedAt wins), then pushes what changed here. It runs on sign-in, app start, when the tab
// comes back, when the device goes online, and a moment after every edit or answer.
const SYNC_KEY = 'ivp.sync.v1';
let syncState = loadJSON(SYNC_KEY, {}); // { uid, deviceId, lastPull, logPushed }
const syncInfo = { at: 0, error: '' };
const PAGE = 1000;
const saveSyncState = () => localStorage.setItem(SYNC_KEY, JSON.stringify(syncState));
const persistWords = () => localStorage.setItem(WORDS_KEY, JSON.stringify(words)); // saveWords would re-trigger a sync
const persistTombs = () => localStorage.setItem(TOMB_KEY, JSON.stringify(tombs));

// A word's `sv` is the updatedAt the server last had for it, so a word is unsent when sv differs from updatedAt.
const rowToWord = r => ({
  id: r.id, it: r.it, ru: r.ru, pos: r.pos,
  defArticle: r.def_article, indefArticle: r.indef_article, example: r.example,
  conj: r.conj || undefined, srs: r.srs || {}, updatedAt: r.updated_at, sv: r.updated_at,
});
const wordToRow = w => ({
  id: w.id, it: w.it, ru: w.ru, pos: w.pos,
  def_article: w.defArticle || '', indef_article: w.indefArticle || '', example: w.example || '',
  conj: w.conj || null, srs: w.srs || {}, updated_at: w.updatedAt, deleted: false,
});

// Returns true when the local library changed.
function mergeRow(r) {
  const local = words.find(w => w.id === r.id);
  if (r.deleted) {
    if (!local) return false;
    if (local.updatedAt > r.updated_at) { local.sv = null; return false; } // edited here after the delete: send it back
    words = words.filter(w => w !== local);
    return true;
  }
  if (local) {
    if (local.updatedAt >= r.updated_at) {
      if (local.updatedAt === r.updated_at) local.sv = r.updated_at;
      return false;
    }
    words[words.indexOf(local)] = rowToWord(r);
    return true;
  }
  const t = tombs[r.id];
  if (t && t.t >= r.updated_at) return false; // deleted here after that version
  if (t) { delete tombs[r.id]; persistTombs(); }
  words.push(rowToWord(r));
  return true;
}

async function pullWords() {
  let changed = false;
  let latest = syncState.lastPull || '';
  for (let from = 0; ; from += PAGE) {
    let q = sb.from('words').select('*').order('synced_at').order('id').range(from, from + PAGE - 1);
    if (syncState.lastPull) q = q.gte('synced_at', syncState.lastPull);
    const { data, error } = await q;
    if (error) throw error;
    for (const r of data) {
      if (mergeRow(r)) changed = true;
      if (r.synced_at > latest) latest = r.synced_at;
    }
    if (data.length < PAGE) break;
  }
  syncState.lastPull = latest;
  if (changed) persistWords();
  return changed;
}

async function pushWords() {
  words.forEach(w => { if (!w.updatedAt) w.updatedAt = Date.now(); });
  const dirty = words.filter(w => w.sv !== w.updatedAt).map(w => [w, w.updatedAt]);
  const gone = Object.entries(tombs).filter(([, x]) => !x.sent);
  const rows = [
    ...dirty.map(([w]) => wordToRow(w)),
    ...gone.map(([id, x]) => ({ id, it: '', ru: '', deleted: true, updated_at: x.t })),
  ];
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('words').upsert(rows.slice(i, i + 500), { onConflict: 'id' });
    if (error) throw error;
  }
  dirty.forEach(([w, at]) => { w.sv = at; });
  gone.forEach(([, x]) => { x.sent = true; });
  if (rows.length) { persistWords(); persistTombs(); }
}

// Each device pushes its own per-day counts; the other devices' counts are summed into logOthers.
async function syncLog() {
  const pushed = syncState.logPushed || (syncState.logPushed = {});
  const rows = Object.entries(log)
    .filter(([day, v]) => pushed[day] !== v.n + '/' + v.ok)
    .map(([day, v]) => ({ device_id: syncState.deviceId, day, n: v.n, ok: v.ok }));
  if (rows.length) {
    const { error } = await sb.from('daily_log').upsert(rows, { onConflict: 'user_id,device_id,day' });
    if (error) throw error;
    rows.forEach(r => { pushed[r.day] = r.n + '/' + r.ok; });
  }
  const cutoff = dayKey(new Date(Date.now() - 400 * DAY));
  const { data, error } = await sb.from('daily_log').select('day,n,ok').neq('device_id', syncState.deviceId).gte('day', cutoff);
  if (error) throw error;
  const sum = {};
  for (const r of data) {
    const s = sum[r.day] || (sum[r.day] = { n: 0, ok: 0 });
    s.n += r.n;
    s.ok += r.ok;
  }
  if (JSON.stringify(sum) === JSON.stringify(logOthers)) return false;
  logOthers = sum;
  localStorage.setItem(LOG_OTHERS_KEY, JSON.stringify(logOthers));
  return true;
}

// A different account signed in on this device: don't mix its words into the previous account.
function resetLocalData() {
  words = []; tombs = {}; log = {}; logOthers = {}; syncState = {};
  [WORDS_KEY, TOMB_KEY, LOG_KEY, LOG_OTHERS_KEY, SYNC_KEY].forEach(k => localStorage.removeItem(k));
}

const syncText = () => (syncInfo.error ? 'Sync problem: ' + syncInfo.error
  : syncInfo.at ? 'Synced at ' + new Date(syncInfo.at).toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : 'Not synced yet');
const updateSyncStatus = () => { const el = $('#sync-status'); if (el) el.textContent = syncText(); };

function refreshAfterSync() {
  if (document.querySelector('dialog[open]')) return;
  if (currentView === 'train' && session) return; // don't reshuffle a practice in progress
  views[currentView]();
}

let syncing = false, syncAgain = false, syncTimer = null;
async function syncNow() {
  if (!sb || !authSession) return;
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    const uid = authSession.user.id;
    if (syncState.uid && syncState.uid !== uid) resetLocalData();
    syncState.uid = uid;
    if (!syncState.deviceId) syncState.deviceId = crypto.randomUUID();
    const a = await pullWords();
    await pushWords();
    const b = await syncLog();
    syncInfo.at = Date.now();
    syncInfo.error = '';
    if (a || b) refreshAfterSync();
  } catch (err) {
    syncInfo.error = navigator.onLine ? ((err && err.message) || 'unknown error') : 'offline, will retry';
  } finally {
    saveSyncState();
    syncing = false;
    updateSyncStatus();
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}
function scheduleSync(delay = 2000) {
  if (!sb || !authSession) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}
hooks.changed = () => scheduleSync();
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(300); });
window.addEventListener('online', () => scheduleSync(300));

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
async function boot() {
  if (sb) {
    sb.auth.onAuthStateChange((event, s) => {
      authSession = s;
      if (event === 'SIGNED_OUT') { clearTimeout(syncTimer); showLogin(); }
      else if (event === 'SIGNED_IN') scheduleSync(300);
    });
    try { authSession = (await sb.auth.getSession()).data.session; } catch (e) { authSession = null; }
  }
  show('library');
  scheduleSync(0);
}
boot();
