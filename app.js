'use strict';

// ---------- constants & storage ----------
const WORDS_KEY = 'ivp.words.v1';
const SETTINGS_KEY = 'ivp.settings.v1';
const POS = ['noun-m', 'noun-f', 'verb', 'adj', 'adv', 'other'];
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
const saveWords = () => localStorage.setItem(WORDS_KEY, JSON.stringify(words));
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

// Per-day answer log ({ 'YYYY-MM-DD': { n, ok } }) for streak and today's count.
// Kept separate from word progress so "Reset progress" does not erase it.
const LOG_KEY = 'ivp.log.v1';
let log = loadJSON(LOG_KEY, {});
const dayKey = d => d.toLocaleDateString('en-CA');
function logAnswer(ok) {
  const d = log[dayKey(new Date())] || (log[dayKey(new Date())] = { n: 0, ok: 0 });
  d.n++;
  if (ok) d.ok++;
  localStorage.setItem(LOG_KEY, JSON.stringify(log));
}
function streak() {
  const d = new Date();
  if (!log[dayKey(d)]) d.setDate(d.getDate() - 1); // today not practised yet: count back from yesterday
  let n = 0;
  while (log[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
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

function show(view) {
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
// Library filter chips: masculine and feminine nouns share one chip.
const LIB_GROUPS = [
  ['', 'All', () => true],
  ['noun', 'Nouns', w => w.pos === 'noun-m' || w.pos === 'noun-f'],
  ['verb', 'Verbs', w => w.pos === 'verb'],
  ['adj', 'Adjectives', w => w.pos === 'adj'],
  ['adv', 'Adverbs', w => w.pos === 'adv'],
  ['other', 'Other', w => w.pos === 'other'],
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
  const w = existing || { pos: 'noun-m' };
  const conj = conjOf(w);
  const f = {};
  const field = (name, label, attrs = {}) => {
    f[name] = h('input', Object.assign({ value: w[name] ?? '' }, attrs));
    return [h('label', null, label), f[name]];
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
    field('ru', 'Russian (separate several translations with commas)', { required: true }),
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
          words = words.filter(x => x !== existing);
          saveWords();
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

function modeItems(mode, dir) {
  return itemsFor(mode === 'flash' || mode === 'type' ? 'words' : mode, dir);
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
      ? needsVerbs ? 'No verbs with conjugation forms yet. Add a verb and fill in its forms.' : 'Nothing to practise yet.'
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
// Flashcards show the type without noun gender (noun-m / noun-f -> noun), which would hint at the article.
const typeLabel = w => (w.pos.startsWith('noun') ? 'noun' : w.pos);

function extras(w) {
  return [w.example ? h('div', { class: 'sub' }, w.example) : null, h('div', { class: 'sub' }, typeLabel(w))];
}

function flashCard(root, item, next) {
  const w = item.w;
  const inner = h('div', { class: 'flip-inner' },
    h('div', { class: 'face front' },
      h('div', { class: 'big' }, prompt(item), item.k === 'it-ru' ? speakBtn(itForms(w)[0]) : null),
      h('div', { class: 'sub' }, typeLabel(w))),
    h('div', { class: 'face back' },
      h('div', { class: 'big' }, answer(item), item.k === 'ru-it' ? speakBtn(itForms(w)[0]) : null),
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
  const today = log[dayKey(new Date())] || { n: 0 };
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
      }, 'Reset progress')));
}

// ---------- boot ----------
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
show('library');
