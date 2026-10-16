# Parole

Parole is a small app for learning Italian words. You keep your own word list with Russian translations, then train it in both directions: Russian → Italian and Italian → Russian.

It is a web app that can be installed on a phone (PWA), written in plain HTML, CSS and JavaScript with no build step. Your words and progress are saved in the browser on your device. The app requires signing in with a Supabase account (created in the Supabase dashboard); `config.js` holds the project URL and anon key.

## Features and how to use them

### Library
Your list of words.
- **Search** by Italian or Russian text.
- **Sort** A→Z or Z→A with the sort button.
- **Filter** with the chips: All, Nouns, Verbs, Adjectives, Adverbs, Other (the number is how many words are in each).
- **+ Add** opens a form for a new word: article, Italian, Russian, type, example sentence and, for verbs, the present-tense forms.
- Each row shows the article, the word, its type, the translation and the example. Verbs have a ▸ arrow that shows the present-tense forms.
- 🔊 plays the Italian pronunciation. ✏️ edits the word, and the form has Save, Cancel and Delete.

### Practice
- **Flashcards:** see a word, think of the answer, flip the card and say whether you knew it.
- **Type the answer:** type the translation. Russian → Italian accepts the word with its definite or indefinite article (`il libro` or `un libro`), and a wrong article counts as wrong.
- **Verb conjugation:** type one form at a time, or fill the whole table (present simple).
- **Direction:** Russian → Italian, Italian → Russian, or mixed.
- **Spaced repetition:** words you miss come back sooner and words you know come back after 1, 2, 4, 8 and 16 days. When nothing is due you can still practise extra. In that case correct answers don't change the schedule, and wrong ones reset the word.

### Settings
- **Progress:** your streak, answers today, and how many words are New, Learning, Familiar or Mastered.
- **Import CSV / Export CSV:** add many words at once or back up your list.
- **Reset progress:** starts the training schedule over.

## CSV import
Settings → Import CSV. Save the file as UTF-8 so Russian letters and accents survive. Only `italian` and `russian` are required.

```
defArticle;indefArticle;italian;russian;pos;example
il;un;libro;книга;noun;Leggo un libro.
```
`pos` is one of `noun`, `verb`, `adj`, `adv`, `phrase`, `other`. Importing a word that already exists updates it and keeps its progress.
