# Parole – Italian ⇄ Russian vocabulary trainer (PWA)

Plain HTML/CSS/JS, no build step. Words and progress are stored in the browser (`localStorage`), so they stay on the device you use. Works offline once loaded and can be installed on a phone.

## Files
```
index.html            page shell, bottom tab bar
app.js                all app logic (library, training, settings, CSV)
style.css             styles (dark wine red palette, light and dark mode)
sw.js                 service worker (offline cache)
manifest.webmanifest  install info (name, icons, colours)
icos/                 app icons and tab icons
```
Everything above is what goes into the GitHub Pages repo. Helper scripts and test files live outside this folder, in `C:\EPG\italian-pwa-tools\`, and are not uploaded.

## Run locally
```
cd C:\EPG\italian-pwa
py -m http.server 8000
```
Open http://localhost:8000 (service worker and install work on `localhost`).

## Deploy to GitHub Pages
1. Create a GitHub repo and push the contents of this folder to the `main` branch, with `index.html` at the repo root.
2. Repo → Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. Open the Pages URL on your phone → browser menu → "Add to Home screen" / "Install app".

When you change files, bump `CACHE` in `sw.js` (e.g. `parole-v42`) so installed copies pick up the update. After changing icons, remove the installed app and add it again.

Words are per browser and per device. A new deployment starts empty: use **Export CSV** on the old copy and **Import CSV** on the new one to move words.

## Library
- Search, A→Z / Z→A sort and **+ Add** stay pinned at the top while the list scrolls, together with the filter chips (All, Nouns, Verbs, Adjectives, Adverbs, Other) with word counts.
- Each row shows the article, the Italian word, its type, the Russian translation and the example sentence. Verbs have a ▸ toggle that shows the present-tense forms.
- 🔊 pronounces the Italian word, ✏️ opens the editor (Save, Cancel, Delete).

## Training (Practice tab)
- **Flashcards** and **Type the answer**, Russian → Italian, Italian → Russian, or mixed.
- Typing Russian → Italian accepts the word with its definite *or* indefinite article (`il libro`, `un libro`); a wrong article is marked wrong.
- **Verb conjugation** (present simple): one form at a time, or the full table.
- Spaced repetition: Leitner boxes at 1, 2, 4, 8, 16 days; a miss goes back to box 1 and the card repeats once in the same session.
- When nothing is due, Start offers extra practice: correct answers don't change the schedule, wrong ones reset the card.
- The training cards don't give hints: the word type is hidden or shown without gender.

## Settings
Progress (streak, answered today, New / Learning / Familiar / Mastered bar), reset progress, and CSV import / export.

## CSV import / export
Header row required; `;` or `,` separator is detected automatically. Save the file as UTF-8 so Cyrillic and accents survive.

```
defArticle;indefArticle;italian;russian;pos;example;io;tu;lui;noi;voi;loro
il;un;libro;книга;noun-m;Leggo un libro.;;;;;;
;;mangiare;"есть, кушать";verb;Voglio mangiare.;mangio;mangi;mangia;mangiamo;mangiate;mangiano
```
- Required: `italian`, `russian`. Everything else is optional, and missing trailing columns count as empty.
- `pos`: `noun-m`, `noun-f`, `verb`, `adj`, `adv`, `other`. Anything else becomes `verb` (if forms are filled) or `other`.
- Several Russian translations go in one cell, separated by commas (quote the cell).
- `io…loro` are the present-tense forms, used only by verbs.
- Re-importing a word with the same Italian word and definite article updates it and keeps its progress.
- Rows without `italian` or `russian` are skipped.

## Not built yet
Sign-in page, change password / sign out, and phone ⇄ PC sync (planned with Supabase).
