# EngRem — Youdao Wordbook Recall Assistant

A single-file web app (`index.html`) that imports vocabulary books exported from
NetEase Youdao Dictionary (网易有道翻译) and drills you with flashcard-style recall.

## Getting started

**Recommended: double-click `EngRem.bat`.** It starts a tiny local server
(`server.js`, requires [Node.js](https://nodejs.org/)) and opens the app in your
browser. The server prefers port 8017 but automatically walks past ports that
are busy or reserved by Windows (set `ENGREM_PORT` to pin one yourself). The import screen then automatically lists every Youdao-format XML file
in this folder — no folder dialog at all. Click a file to import it; click
**Rescan** after adding new exports. Keep the console window open while studying.

Alternatively, open `index.html` directly (no Node needed). The browser cannot
read the folder on its own in this mode, so click **Scan folder…** once and pick
this folder; if your browser offers **"Allow on every visit"**, choose it and the
file list appears automatically on future opens (Chrome/Edge; other browsers fall
back to a folder-selection dialog).

In both modes you can also:

- **Drag & drop** — drop an exported `.xml` file anywhere on the page.
- **Browse** — click the drop zone to pick a single file.

No Youdao account yet? The repo includes `sample_wordbook.xml` (ten common words
with hand-written translations) so you can try the app immediately — it shows up
in the folder list like any other wordbook.

Words, study state, and cached examples are stored in the browser's localStorage,
so you import once. **Re-exports are picked up automatically**: the app remembers
which file it imported (name, size, modified time) and checks it on every start —
when you re-export the wordbook from Youdao under the same name, the next launch
re-imports it silently, keeps your current position, and shows a toast with the
new word count. (In `file://` mode this needs the folder permission to still be
granted; otherwise use **📂 Import** to reload manually. A page reload — `F5` —
also triggers the check.)

## Features

- **EN → ZH mode**: shows the English word and phonetic; the Chinese translation is
  hidden until you click **Show Answer** or press `Space`.
- **ZH → EN mode**: shows the Chinese translation with the English word hidden; in
  example sentences only the word's core is blanked while affixes stay visible
  as a grammatical hint — *thawed* shows as `____ed`, *inadvertently* as
  `in______ly` — until revealed, then highlighted.
- **Example sentences**: fetched automatically from the Free Dictionary API,
  Wiktionary, and Tatoeba, cached locally. Searches treat inflections as
  exchangeable — a word saved as *thawed* also searches and matches *thaw /
  thaws / thawing*, and vice versa. The five shown sentences deliberately mix
  distinct forms (base / *-ed* / *-ing* / *-s* / *-ly*) instead of repeating
  one, and prefixed family members (*un-*, *in-*, *dis-*…) are searched and
  included too — *happy* also gets an *unhappy* example. Only sentences that
  genuinely contain the word (or a family member) are shown. For words too rare for any corpus
  (e.g. *advertent*), the search falls back to close relatives (*inadvertent*,
  *advertently*) and labels those sentences "≈ inadvertent" — in ZH→EN mode the
  related word's core is blanked (`in______ly`) and the label stays generic
  until you reveal, so the answer never leaks. When nothing qualifies at all
  you get one-click search links to Youdao / Cambridge / Google.
- **Fast, mostly-offline caching**:
  - Examples are stored in the browser's IndexedDB, so every word you have seen
    loads instantly and works offline.
  - While you study a word, examples for the next few words are prefetched in the
    background — switching with `→` feels instant.
  - In `EngRem.bat` mode the server keeps its own disk cache
    (`examples-cache.json`), shared by all browsers; each word hits the public
    APIs at most once, ever.
  - The **⬇ Cache** button in the header downloads examples and pronunciation
    for the entire wordbook into the cache, a few words in parallel (click
    again to pause). The counter shows how many words already have cached
    examples, so pausing and resuming continues from the real count. Roughly
    20 minutes for a 1500-word book; after one full run the app needs no
    network at all for studying.
  - Requests to Tatoeba are spaced out and backed off after a rate-limit
    response, and a word whose sources were throttled is deliberately **not**
    cached — so a temporary throttle never leaves a word permanently stuck
    with no examples.
  - The **🧹 Clear cache** button deletes all cached examples and audio — both
    the browser's IndexedDB stores and, in server mode, the disk caches
    (`examples-cache.json`, `audio-cache/`). Words, study position, and
    known-marks are untouched. Use it to force a re-fetch, e.g. after the
    example/pronunciation sources change.
- **Real pronunciation with caching**: audio comes from Wikimedia Commons and
  the Free Dictionary API where available (real human recordings), with Youdao's
  voice service filling coverage gaps (see Credits). It is cached in the
  browser's IndexedDB and — in `EngRem.bat` mode — as audio files in
  `audio-cache/`, so each word is downloaded once and then plays instantly,
  even offline. Browser TTS is the last-resort fallback.
- **Auto-pronounce switch** (`🔈 Auto` in the header, shortcut `A`): speaks each
  word automatically — on switching words in EN→ZH mode, and on revealing the
  answer in ZH→EN mode (so the audio never gives away the hidden word).
  By design, the word already on screen when the app opens is **not** spoken:
  a voice right at page load would startle you. Pronunciation starts from your
  first interaction (next word, reveal, etc.) onward.
- **Memory-aid pictures** (`🖼 Pics` in the header, shortcut `I`, on by
  default): each word gets a cached picture — a Wikipedia article thumbnail
  when one exists (precise for concrete nouns), else a Creative-Commons photo
  found via Openverse (with attribution), else an AI-generated illustration
  (Pollinations) so abstract words get one too. In EN→ZH mode the picture
  depicts the hidden meaning, so it stays hidden until you reveal; in ZH→EN
  it shows immediately as a memory anchor. Cached like everything else
  (IndexedDB + `image-cache/` in server mode) — fetched once per word, ever.
  Picture quality is imperfect by nature (tag searches mismatch senses, and the
  free AI model is weak on abstract words), so every picture has an
  **↻ another** button: it swaps in the next source — Wikipedia → Openverse →
  AI (a fresh generation each time) → hidden — and remembers your choice.
  AI prompts are built from the word's dictionary definition so generated
  scenes depict the meaning, and Wikipedia articles about unrelated senses
  (surnames, films, bands) are skipped.
- **Shuffle**, **mark as known + skip known words**, and a **searchable word
  list** for jumping around.

## Notes on Youdao's export format (quirks observed in practice)

- **Exporting onto an existing file name appends instead of overwriting.**
  Export three times to the same `youdao_dict.xml` and the file contains three
  concatenated copies of the whole wordbook (and is no longer well-formed XML).
  The app handles this: the parser falls back to a lenient mode for concatenated
  documents, and the importer always merges duplicates — you still get exactly
  one card per unique word. To keep the file small you can delete it before
  re-exporting, but it is not required.
- **Even a single clean export can contain duplicate items** for the same word
  (e.g. a word saved twice, or copies related to group membership). Merged the
  same way. When duplicates were merged, the import toast reports both counts,
  e.g. "1510 unique words (4532 entries in export, duplicates merged)".
- Youdao's group names appear in the export's `<tags>` field, but the app
  deliberately has **no group feature** for now; tags are parsed and stored but
  ignored.
- **Only English words are imported.** Youdao can also save Chinese (and other
  non-English) words to the vocabulary book; they appear in the export with a
  different `<lanfrom>` (e.g. `zh-CHS`). This is an English-recall app, so such
  entries are skipped at import to keep it simple — the import toast reports how
  many were skipped (e.g. "…, 1 non-English skipped"). A character check backs
  up the `lanfrom` field, so CJK words are filtered even if the field is missing.

## Credits, licensing & data sources

The app code is released under the [MIT License](LICENSE).

Content shown at runtime comes from external services, each fetched live and
cached locally on your machine:

- **Example sentences**: [Tatoeba](https://tatoeba.org) (licensed
  [CC BY 2.0 FR](https://creativecommons.org/licenses/by/2.0/fr/)), the
  [Free Dictionary API](https://dictionaryapi.dev), and the
  [Wiktionary REST API](https://en.wiktionary.org/api/rest_v1/) — the latter
  two serve [Wiktionary](https://www.wiktionary.org) content (CC BY-SA).
- **Pictures**: [Wikipedia](https://en.wikipedia.org) article thumbnails,
  [Openverse](https://openverse.org) (Creative-Commons image search — each
  image credited with creator and license), and
  [Pollinations](https://pollinations.ai) for AI-generated illustrations (a
  free community service — it may change or stop working at any time).
- **Pronunciation audio**, tried in this order:
  1. [Wikimedia Commons](https://commons.wikimedia.org) — the CC-licensed human
     recordings behind Wiktionary, via the official API (partial coverage);
  2. [Free Dictionary API](https://dictionaryapi.dev) recordings (Wiktionary
     mirror);
  3. Youdao's `dictvoice` endpoint — an **unofficial, undocumented** service
     that synthesizes any word or phrase; used only to fill coverage gaps and
     may change or stop working at any time;
  4. browser text-to-speech as the offline last resort.

Important notes for contributors and forks:

- **Never commit personal wordbook exports.** The `<trans>` definitions inside
  them are Youdao's copyrighted dictionary content. The `.gitignore` excludes
  all `.xml` files except the hand-written `sample_wordbook.xml`, plus the
  local caches (`examples-cache.json`, `audio-cache/`, `image-cache/`) that accumulate
  third-party content.
- This project is an independent study tool. It is **not affiliated with,
  endorsed by, or connected to NetEase Youdao (网易有道翻译)** in any way; the
  name is used only to describe file-format compatibility.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Show / hide the answer |
| `←` / `→` | Previous / next word |
| `M` | Switch EN→ZH / ZH→EN mode |
| `S` | Toggle shuffle |
| `F` | Mark / unmark as known |
| `P` | Pronounce the word |
| `A` | Toggle auto-pronounce |
| `L` | Open the word list |
