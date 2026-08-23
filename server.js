/* Tiny local server for EngRem.
 * Serves this folder over http://127.0.0.1:<port>/ and exposes:
 *   /api/list                 — JSON listing of the XML files in this folder
 *   /api/examples?word=<w>    — example sentences for a word, fetched once from
 *                               public APIs and cached on disk (examples-cache.json)
 * Start it with EngRem.bat or: node server.js
 */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const ROOT = __dirname;
const START_PORT = parseInt(process.env.ENGREM_PORT, 10) || 8017;
const CACHE_FILE = path.join(ROOT, "examples-cache.json");
const AUDIO_DIR = path.join(ROOT, "audio-cache");
const AUDIO_INDEX = path.join(AUDIO_DIR, "index.json");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/* ---------- example cache (disk-backed) ---------- */
/* EX_SCHEMA versions the fetch logic: bump it when search/filter quality
   improves and every stale entry (including cached empties) refetches. */
const EX_SCHEMA = 5;
let exCache = {};
try { exCache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")); } catch {}
let cacheDirty = false;

function saveCacheSoon() {
  cacheDirty = true;
}
setInterval(() => {
  if (!cacheDirty) return;
  cacheDirty = false;
  fs.writeFile(CACHE_FILE, JSON.stringify(exCache), (e) => {
    if (e) console.error("Could not write cache:", e.message);
  });
}, 3000).unref();

/* ---------- audio cache (mp3 files on disk + index) ---------- */
let audioIndex = {}; // word -> filename, or "" meaning "no recording exists"
try { audioIndex = JSON.parse(fs.readFileSync(AUDIO_INDEX, "utf-8")); } catch {}
let audioDirty = false;

function saveAudioIndexSoon() { audioDirty = true; }
setInterval(() => {
  if (!audioDirty) return;
  audioDirty = false;
  try { fs.mkdirSync(AUDIO_DIR, { recursive: true }); } catch {}
  fs.writeFile(AUDIO_INDEX, JSON.stringify(audioIndex), (e) => {
    if (e) console.error("Could not write audio index:", e.message);
  });
}, 3000).unref();

/* ---------- image cache (files on disk + index) ---------- */
const IMG_DIR = path.join(ROOT, "image-cache");
const IMG_INDEX = path.join(IMG_DIR, "index.json");
const IMG_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
let imgIndex = {}; // word -> { file, src, attr }
try { imgIndex = JSON.parse(fs.readFileSync(IMG_INDEX, "utf-8")); } catch {}
let imgDirty = false;
function saveImgIndexSoon() { imgDirty = true; }
setInterval(() => {
  if (!imgDirty) return;
  imgDirty = false;
  try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch {}
  fs.writeFile(IMG_INDEX, JSON.stringify(imgIndex), (e) => {
    if (e) console.error("Could not write image index:", e.message);
  });
}, 3000).unref();

function extFromContentType(ct) {
  ct = (ct || "").toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("svg")) return ".svg";
  return ".jpg";
}

/* Memory-aid picture chain: Wikipedia article thumbnail (precise when it
   exists) -> Openverse CC image search (broad coverage) -> Pollinations AI
   illustration (fills abstract words). Each returns {buf, ext, src, attr}. */
async function fetchWikiImage(word) {
  const r = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(word),
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const d = await r.json();
  if (!d.thumbnail || !d.thumbnail.source || d.type === "disambiguation") return null;
  // the article for a word is often about something else entirely (a surname,
  // a play, a band) — its photo would actively mislead, so skip those senses
  if (/surname|given name|family name|film|play|album|band|TV series|magazine|song|footballer|politician/i.test(d.description || "")) return null;
  const ar = await fetch(d.thumbnail.source, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
  if (!ar.ok) return null;
  const b = Buffer.from(await ar.arrayBuffer());
  if (b.length < 500) return null;
  return { buf: b, ext: extFromContentType(ar.headers.get("content-type")), src: "wiki",
    attr: "Wikipedia — " + (d.title || word) };
}

/* Openverse allows anonymous use but rate-limits bursts: space requests out
   and back off on 429, same treatment as Tatoeba. */
let openverseNextAt = 0, openverseCooldownUntil = 0;
async function fetchOpenverseImage(word) {
  if (Date.now() < openverseCooldownUntil) return null;
  const now = Date.now();
  const at = Math.max(now, openverseNextAt);
  openverseNextAt = at + 600;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
  const r = await fetch("https://api.openverse.org/v1/images/?q=" + encodeURIComponent(word) +
    "&page_size=8&license_type=commercial,modification",
    { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (r.status === 429) { openverseCooldownUntil = Date.now() + 60000; return null; }
  if (!r.ok) return null;
  const d = await r.json();
  // tag search is loose ("wilt" -> a "Wilts & Dorset" bus): require the word
  // in the result title or tags, scanning several results
  const re = wordVariantsRegex(word);
  const hits = ((d && d.results) || []).filter((x) => {
    if (!re) return true;
    re.lastIndex = 0;
    if (re.test(x.title || "")) return true;
    return (x.tags || []).some((t) => { re.lastIndex = 0; return re.test((t && t.name) || ""); });
  });
  const it = hits[0];
  if (!it) return null;
  const ar = await fetch(it.thumbnail || it.url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
  if (!ar.ok) return null;
  const b = Buffer.from(await ar.arrayBuffer());
  if (b.length < 500) return null;
  const lic = it.license ? "CC " + String(it.license).toUpperCase() : "CC";
  return { buf: b, ext: extFromContentType(ar.headers.get("content-type")), src: "openverse",
    attr: (it.creator ? "by " + it.creator + " " : "") + "(" + lic + ") via Openverse" };
}

const IMG_AI_V = 2; // bump when the AI prompt improves: old entries regenerate

/* A short English definition makes generated pictures depict the MEANING
   instead of the model free-associating on the word. */
async function definitionOf(word) {
  try {
    const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word),
      { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      for (const e of Array.isArray(d) ? d : []) for (const m of e.meanings || []) for (const def of m.definitions || [])
        if (def.definition) return def.definition;
    }
  } catch {}
  try {
    const r = await fetch("https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(word) + "?redirect=true",
      { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const d = await r.json();
      for (const sec of d.en || []) for (const def of sec.definitions || []) {
        const t = String(def.definition || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
        if (t) return t;
      }
    }
  } catch {}
  return null;
}

async function fetchAiImage(word) {
  const def = await definitionOf(word);
  const meaning = def ? def.slice(0, 160) : 'the English word "' + word + '"';
  // rotate art styles so re-rolls look genuinely different, not the same
  // composition with a new seed
  const styles = ["simple clear cartoon illustration", "colorful flat vector illustration",
    "children's picture-book watercolor illustration", "clean simple 3D render", "expressive pencil sketch"];
  const style = styles[Math.floor(Math.random() * styles.length)];
  // "no words" matters: rendered text could leak the answer in ZH->EN mode
  const prompt = style + " for a vocabulary flashcard, clearly depicting: " +
    meaning + ". single scene, no words, no letters, no captions";
  const r = await fetch("https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt) +
    "?width=640&height=480&nologo=true&seed=" + Math.floor(Math.random() * 1e9), { signal: AbortSignal.timeout(60000) });
  if (!r.ok) return null;
  const b = Buffer.from(await r.arrayBuffer());
  if (b.length < 2000 || !(r.headers.get("content-type") || "").startsWith("image/")) return null;
  return { buf: b, ext: extFromContentType(r.headers.get("content-type")), src: "ai",
    attr: "AI-generated illustration (Pollinations)", v: IMG_AI_V };
}

function findAudioUrl(dictData) {
  let first = "";
  for (const entry of Array.isArray(dictData) ? dictData : []) {
    for (const p of entry.phonetics || []) {
      if (!p.audio) continue;
      if (p.audio.includes("-us.")) return p.audio; // prefer US pronunciation
      if (!first) first = p.audio;
    }
  }
  return first;
}

const UA = "EngRem/1.0 (+https://github.com/Zulolo/engrem)"; // Wikimedia asks for a descriptive User-Agent
const AUDIO_MIME = { ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav" };

/* Wikimedia Commons hosts the human recordings behind Wiktionary (CC-licensed).
   Official API, but coverage is partial — used as the first-choice source. */
async function fetchCommonsAudio(word) {
  if (/\s/.test(word)) return null; // phrases are never on Commons
  const w = word.toLowerCase();
  const titles = ["File:En-us-" + w + ".ogg", "File:En-" + w + ".ogg", "File:En-uk-" + w + ".ogg"].join("|");
  const u = "https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*" +
    "&prop=imageinfo&iiprop=url&titles=" + encodeURIComponent(titles);
  const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const data = await r.json();
  const pages = Object.values((data.query && data.query.pages) || {});
  const hit = pages.find((p) => p.imageinfo && p.imageinfo[0] && p.imageinfo[0].url);
  if (!hit) return null;
  const ar = await fetch(hit.imageinfo[0].url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
  if (!ar.ok) return null;
  const b = Buffer.from(await ar.arrayBuffer());
  return b.length > 200 ? { buf: b, ext: ".ogg" } : null;
}

function flushCache() {
  if (cacheDirty) {
    cacheDirty = false;
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(exCache)); } catch {}
  }
  if (audioDirty) {
    audioDirty = false;
    try { fs.mkdirSync(AUDIO_DIR, { recursive: true }); } catch {}
    try { fs.writeFileSync(AUDIO_INDEX, JSON.stringify(audioIndex)); } catch {}
  }
  if (imgDirty) {
    imgDirty = false;
    try { fs.mkdirSync(IMG_DIR, { recursive: true }); } catch {}
    try { fs.writeFileSync(IMG_INDEX, JSON.stringify(imgIndex)); } catch {}
  }
}
process.on("SIGINT", () => { flushCache(); process.exit(0); });
process.on("SIGTERM", () => { flushCache(); process.exit(0); });
process.on("exit", flushCache);

/* ---------- example fetching (mirrors the logic in index.html) ---------- */
/* Inflections are treated as exchangeable: a vocabulary word saved as "thawed"
   should match (and search with) thaw/thaws/thawing, and vice versa. */
function lemmaCandidates(word) {
  const w = word.toLowerCase().trim();
  const out = new Set([w]);
  const add = (x) => { if (x && x.length > 2) out.add(x); };
  if (w.endsWith("ies")) add(w.slice(0, -3) + "y");
  if (w.endsWith("es")) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  else if (w.endsWith("s") && !w.endsWith("ss")) add(w.slice(0, -1));
  if (w.endsWith("ied")) add(w.slice(0, -3) + "y");
  else if (w.endsWith("ed")) {
    add(w.slice(0, -2)); add(w.slice(0, -1)); // wanted -> want, loved -> love
    const st = w.slice(0, -2);
    if (/(.)\1$/.test(st)) add(st.slice(0, -1)); // stopped -> stop
  }
  if (w.endsWith("ing")) {
    const st = w.slice(0, -3);
    add(st); add(st + "e"); // thawing -> thaw, hoping -> hope
    if (/(.)\1$/.test(st)) add(st.slice(0, -1)); // running -> run
  }
  return [...out];
}

function expandForms(w) {
  const v = new Set([w, w + "s", w + "es", w + "ed", w + "d", w + "ing", w + "ly"]);
  if (w.length > 2) {
    if (w.endsWith("e")) { const st = w.slice(0, -1); v.add(st + "ing"); v.add(st + "ed"); }
    if (w.endsWith("y")) { const st = w.slice(0, -1); v.add(st + "ies"); v.add(st + "ied"); v.add(st + "ier"); v.add(st + "iest"); v.add(st + "ily"); }
    const last = w[w.length - 1];
    if (/[bdgklmnprtv]/.test(last) && /[aeiou]/.test(w[w.length - 2]) && !/[aeiou]/.test(w[w.length - 3] || "x")) {
      v.add(w + last + "ing"); v.add(w + last + "ed");
    }
  }
  return v;
}

/* Only these endings take un-/in- prefixes or -ly in practice; without this
   filter a noun like "intercession" spawns doomed searches for
   "inintercession" / "intercessionly" that cost whole request round-trips. */
const ADJ_LIKE = /(ent|ant|able|ible|ive|ful|ous|ic|al|ar|id|ish|less|y|ed|ing)$/;

/* Close morphological relatives, tried only when the word itself has no
   examples anywhere (e.g. "advertent" -> "inadvertent"). */
function relatedForms(word) {
  const w = word.toLowerCase().trim();
  if (/\s/.test(w) || w.length < 4) return [];
  const out = [];
  const add = (x) => { if (x && x !== w && out.length < 3 && !out.includes(x)) out.push(x); };
  // strip a negation prefix only from adjective-like words: "inadvertent" ->
  // "advertent" is real, while "intercession" -> "tercession" is garbage that
  // used to cost a whole extra sweep
  if (ADJ_LIKE.test(w)) {
    for (const p of ["in", "un", "im", "dis", "non", "ir", "il"]) {
      if (w.startsWith(p) && w.length - p.length >= 4) add(w.slice(p.length));
    }
  }
  if (ADJ_LIKE.test(w)) {
    add("in" + w); // advertent -> inadvertent
    add("un" + w);
    add(w.endsWith("y") ? w.slice(0, -1) + "ily" : w + "ly"); // -> advertently
  }
  return out;
}

function wordVariantsRegex(word) {
  const w = word.trim();
  if (!w) return null;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/\s/.test(w)) return new RegExp("\\b" + escRe(w).replace(/\s+/g, "\\s+") + "\\b", "gi");
  const forms = new Set();
  const lems = lemmaCandidates(w);
  for (const lem of lems) for (const f of expandForms(lem)) forms.add(f);
  // prefixed relatives count as family too: happy -> unhappy, advertent ->
  // inadvertent(ly); a word saved WITH a prefix also matches its bare form
  for (const lem of lems) {
    if (lem.length < 4) continue;
    for (const p of ["un", "in", "im", "dis", "non", "ir", "il"]) {
      if (lem.startsWith(p) && lem.length - p.length >= 4) {
        for (const f of expandForms(lem.slice(p.length))) forms.add(f);
      }
    }
    for (const p of ["un", "in"]) for (const f of expandForms(p + lem)) forms.add(f);
  }
  const parts = [...forms].sort((a, b) => b.length - a.length).map(escRe);
  return new RegExp("\\b(" + parts.join("|") + ")\\b", "gi");
}

/* Returns {ok, sentences}. ok=false means network failure — don't cache that. */
async function fetchExamples(word) {
  const primary = await searchSentences(word);
  if (primary.ok && primary.sentences.length === 0) {
    // nothing anywhere — try close relatives (advertent -> inadvertent)
    // probe them all at once, so one dead end does not delay the next
    const tried = await Promise.all(relatedForms(word).map((rel) =>
      searchSentences(rel).then((r) => ({ rel, r }), () => ({ rel, r: { sentences: [] } }))));
    for (const { rel, r } of tried) {
      if (r.sentences.length) {
        return { ok: true, sentences: r.sentences.slice(0, 3).map((s) => ({ ...s, rel })) };
      }
    }
  }
  return primary;
}

/* Classify which inflection family member a matched token is, so the final
   pick can cover distinct forms (thaw / thawed / thawing) instead of five
   sentences all using the same form. */
function formKey(token, word) {
  const t = token.toLowerCase();
  const w = word.toLowerCase().trim();
  let pre = "";
  for (const p of ["in", "un", "im", "dis", "non", "ir", "il"]) {
    if (t.startsWith(p) && !w.startsWith(p)) { pre = p + "+"; break; }
  }
  let suf = "other";
  if (t === w) suf = "base";
  else if (t.endsWith("ing")) suf = "ing";
  else if (t.endsWith("ed")) suf = "ed";
  else if (t.endsWith("ly")) suf = "ly";
  else if (t.endsWith("s")) suf = "s";
  return pre + suf;
}

/* Collect up to POOL candidates, then pick PICK maximizing form diversity. */
const EX_PICK = 5;

function pickDiverse(sentences, varRe, word) {
  const withForm = sentences.map((s) => {
    let form = "other";
    if (varRe) {
      varRe.lastIndex = 0;
      const m = varRe.exec(s.text);
      if (m) form = formKey(m[0], word);
    }
    return { s, form };
  });
  const picked = [];
  const usedForms = new Set();
  for (const e of withForm) {
    if (picked.length >= EX_PICK) break;
    if (!usedForms.has(e.form)) { usedForms.add(e.form); picked.push(e.s); }
  }
  for (const e of withForm) {
    if (picked.length >= EX_PICK) break;
    if (!picked.includes(e.s)) picked.push(e.s);
  }
  return picked;
}

/* Tatoeba is a small volunteer service and rate-limits bursts (HTTP 429, or
   it simply stops answering). Space out request starts globally and back off
   after a 429/timeout — without this a bulk cache run gets throttled, and then
   every word waits out a timeout AND returns fewer sentences. */
let tatoebaNextAt = 0, tatoebaCooldownUntil = 0;
async function tatoebaGate() {
  const now = Date.now();
  const at = Math.max(now, tatoebaNextAt);
  tatoebaNextAt = at + 350;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/* One sweep over the sources for a single term. Every upstream query runs
   CONCURRENTLY: awaiting them one at a time made a single word take tens of
   seconds, since each source waited out its own timeout before the next
   started. Results merge in source-priority order, so the pick is unchanged. */
async function searchSentences(word) {
  const sentences = [];
  const seen = new Set();
  // near-duplicate key: contraction- and punctuation-insensitive
  // ("What's your favourite advert?" == "What is your favourite advert?")
  const exKey = (s) => s.toLowerCase().replace(/[’']/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !["is", "s", "are", "re", "am", "m", "not", "nt", "will", "ll", "have", "ve", "would", "d", "the", "a", "an"].includes(t))
    .join(" ");
  // a sentence must contain the word (or an inflection) to enter the pool —
  // otherwise wrong-word results from one source (e.g. dict's "wilt" -> "will"
  // entry) crowd out the sources that have the real sentences
  const varRe = wordVariantsRegex(word);
  const push = (s, src) => {
    s = String(s).replace(/\s+/g, " ").trim();
    if (!s || s.length < 8 || s.length > 220) return;
    if (varRe) { varRe.lastIndex = 0; if (!varRe.test(s)) return; }
    const k = exKey(s);
    if (seen.has(k)) return;
    seen.add(k);
    sentences.push({ text: s, src });
  };
  const stripHtml = (h) => String(h).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const TIMEOUT = 8000; // one slow source no longer delays the others
  // search with the word AND its base/inflected forms — a wordbook may store
  // "thawed" while the good sentences use "thaw" or "thawing"
  const searchTerms = /\s/.test(word) ? [word] : [...new Set([word.toLowerCase(), ...lemmaCandidates(word)])].slice(0, 3);

  const dictQuery = (term) => async () => {
    const out = [];
    try {
      const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(term),
        { signal: AbortSignal.timeout(TIMEOUT) });
      if (!(r.ok || r.status === 404)) return { ok: false, out }; // 404 = simply not in that dictionary
      if (r.ok) {
        const data = await r.json();
        for (const entry of Array.isArray(data) ? data : []) {
          for (const m of entry.meanings || []) {
            for (const d of m.definitions || []) if (d.example) out.push([d.example, "dict"]);
          }
        }
      }
      return { ok: true, out };
    } catch { return { ok: false, out }; }
  };

  const wiktQuery = (term) => async () => {
    const out = [];
    try {
      const r = await fetch("https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(term) + "?redirect=true",
          { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT) });
      if (!(r.ok || r.status === 404)) return { ok: false, out };
      if (r.ok) {
        const data = await r.json();
        for (const sec of data.en || []) {
          for (const d of sec.definitions || []) {
            for (const ex of d.parsedExamples || []) if (ex.example) out.push([stripHtml(ex.example), "wikt"]);
            for (const ex of d.examples || []) out.push([stripHtml(ex), "wikt"]);
          }
        }
      }
      return { ok: true, out };
    } catch { return { ok: false, out }; }
  };

  const tatoebaQuery = (term) => async () => {
    const out = [];
    if (Date.now() < tatoebaCooldownUntil) return { ok: false, throttled: true, out };
    try {
      await tatoebaGate();
      // unquoted, so Tatoeba's stemmed search covers inflections both ways
      const r = await fetch("https://api.tatoeba.org/unstable/sentences?lang=eng&q=" +
        encodeURIComponent(term) + "&sort=relevance&limit=8", { signal: AbortSignal.timeout(TIMEOUT) });
      if (r.status === 429) { tatoebaCooldownUntil = Date.now() + 60000; return { ok: false, throttled: true, out }; }
      if (!r.ok) return { ok: false, out };
      const data = await r.json();
      for (const s of (data && data.data) || []) out.push([s.text, "tatoeba"]);
      return { ok: true, out };
    } catch { tatoebaCooldownUntil = Date.now() + 30000; return { ok: false, throttled: true, out }; }
  };

  // prefixed relatives (un-/in-), so the pick can also offer family members
  // like "unhappy" / "inadvertently" alongside plain inflections
  const prefixTerms = [];
  if (!/\s/.test(word)) {
    const w0 = word.toLowerCase().trim();
    if (ADJ_LIKE.test(w0)) {
      for (const p of ["in", "un", "im", "dis", "non", "ir", "il"]) {
        if (w0.startsWith(p) && w0.length - p.length >= 4) prefixTerms.push(w0.slice(p.length));
      }
    }
    if (!prefixTerms.length && w0.length >= 4 && ADJ_LIKE.test(w0)) prefixTerms.push("in" + w0, "un" + w0);
  }

  // query order is merge order: dictionary, then Wiktionary, then Tatoeba
  // Tatoeba search is already stemmed, so ONE query covers the inflections;
  // extra terms only spent rate-limit budget for near-duplicate results
  const queries = [
    ...searchTerms.slice(0, 2).map(dictQuery),
    ...searchTerms.slice(0, 2).map(wiktQuery),
    ...searchTerms.slice(0, 1).map(tatoebaQuery),
    ...prefixTerms.slice(0, 1).map(tatoebaQuery),
  ];
  const results = await Promise.all(queries.map((q) => q()));
  let okAny = false, throttled = false;
  for (const r of results) {
    if (r.ok) okAny = true;
    if (r.throttled) throttled = true;
    for (const [text, src] of r.out) push(text, src);
  }
  // pick a mix of inflection forms rather than whatever came first
  const picked = pickDiverse(sentences, varRe, word);
  // never cache an empty result that a throttled source might have filled
  return { ok: okAny && (picked.length > 0 || !throttled), sentences: picked };
}

/* ---------- http server ---------- */
const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://localhost");
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400).end("Bad request"); return; }

  if (pathname === "/api/list") {
    let files = [];
    try {
      files = fs.readdirSync(ROOT)
        .filter((n) => /\.xml$/i.test(n))
        .map((n) => {
          try {
            const st = fs.statSync(path.join(ROOT, n));
            return { name: n, size: st.size, mtime: Math.round(st.mtimeMs) };
          } catch { return null; }
        })
        .filter(Boolean);
    } catch {}
    res.writeHead(200, { "Content-Type": MIME[".json"] });
    res.end(JSON.stringify(files));
    return;
  }

  if (pathname === "/api/examples") {
    const word = (url.searchParams.get("word") || "").trim();
    if (!word || word.length > 100) {
      res.writeHead(400, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify({ ok: false, sentences: [], error: "missing word" }));
      return;
    }
    const key = word.toLowerCase();
    if (exCache[key] && exCache[key].v === EX_SCHEMA) {
      res.writeHead(200, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify({ ok: true, cached: true, sentences: exCache[key].sentences }));
      return;
    }
    const result = await fetchExamples(word);
    if (result.ok) {
      exCache[key] = { sentences: result.sentences, ts: Date.now(), v: EX_SCHEMA };
      saveCacheSoon();
    }
    res.writeHead(200, { "Content-Type": MIME[".json"] });
    res.end(JSON.stringify({ ok: result.ok, cached: false, sentences: result.sentences }));
    return;
  }

  if (pathname === "/api/clear-cache") {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    exCache = {}; cacheDirty = false;
    audioIndex = {}; audioDirty = false;
    try { fs.rmSync(CACHE_FILE, { force: true }); } catch {}
    try { fs.rmSync(AUDIO_DIR, { recursive: true, force: true }); } catch {}
    imgIndex = {}; imgDirty = false;
    try { fs.rmSync(IMG_DIR, { recursive: true, force: true }); } catch {}
    console.log("Caches cleared by client request");
    res.writeHead(200, { "Content-Type": MIME[".json"] });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (pathname === "/api/image") {
    const word = (url.searchParams.get("word") || "").trim();
    if (!word || word.length > 100) { res.writeHead(400).end(); return; }
    const key = word.toLowerCase();
    const sendEntry = (entry, buf) => {
      res.writeHead(200, {
        "Content-Type": IMG_MIME[path.extname(entry.file).toLowerCase()] || "image/jpeg",
        // no-store: the app caches images itself (IndexedDB + disk); letting
        // the browser HTTP-cache this URL made "another" replay the same
        // bytes without the request ever reaching the server
        "Cache-Control": "no-store",
        "x-image-source": entry.src || "",
        "x-image-attr": encodeURIComponent(entry.attr || ""),
        "x-image-v": String(entry.v || ""),
      });
      res.end(buf);
    };
    // ?src=wiki|openverse|ai refetches from that one source (the "another
    // picture" button), replacing whatever is cached
    const FETCHERS = { wiki: fetchWikiImage, openverse: fetchOpenverseImage, ai: fetchAiImage };
    const forced = url.searchParams.get("src");
    const cached = imgIndex[key];
    // regenerate AI entries made with the old, low-quality prompt
    const stale = cached && cached.src === "ai" && cached.v !== IMG_AI_V;
    if (!forced && !stale && cached && cached.file) {
      try { sendEntry(cached, fs.readFileSync(path.join(IMG_DIR, cached.file))); return; }
      catch { delete imgIndex[key]; } // cached file vanished — refetch below
    }
    let got = null;
    if (forced && FETCHERS[forced]) {
      try { got = await FETCHERS[forced](word); } catch { got = null; }
    } else {
      // Wikipedia -> Openverse -> Pollinations, first hit wins
      for (const fn of [fetchWikiImage, fetchOpenverseImage, fetchAiImage]) {
        try { got = await fn(word); } catch { got = null; }
        if (got) break;
      }
    }
    if (!got) { res.writeHead(503).end(); return; } // nothing cached — client retries later
    const fname = key.replace(/[^a-z0-9\-]/g, "_") + got.ext;
    try {
      fs.mkdirSync(IMG_DIR, { recursive: true });
      fs.writeFileSync(path.join(IMG_DIR, fname), got.buf);
      imgIndex[key] = { file: fname, src: got.src, attr: got.attr, v: got.v };
      saveImgIndexSoon();
    } catch {}
    sendEntry({ file: fname, src: got.src, attr: got.attr }, got.buf);
    return;
  }

  if (pathname === "/api/audio") {
    const word = (url.searchParams.get("word") || "").trim();
    if (!word || word.length > 100) { res.writeHead(400).end(); return; }
    const key = word.toLowerCase();
    const sendFile = (fname) => {
      const fp = path.join(AUDIO_DIR, fname);
      try {
        const buf = fs.readFileSync(fp);
        res.writeHead(200, {
          "Content-Type": AUDIO_MIME[path.extname(fname).toLowerCase()] || "audio/mpeg",
          "Cache-Control": "max-age=31536000",
        });
        res.end(buf);
        return true;
      } catch { return false; }
    };
    if (key in audioIndex) {
      if (audioIndex[key] === "") { res.writeHead(404).end(); return; }        // known: no recording
      if (sendFile(audioIndex[key])) return;
      delete audioIndex[key]; // cached file vanished — refetch below
    }
    /* Source order: officially licensed APIs first; the unofficial Youdao
       endpoint only fills coverage gaps (rare words, phrases). */
    let got = null;
    // 1) Wikimedia Commons (official, CC-licensed human recordings)
    try { got = await fetchCommonsAudio(word); } catch {}
    // 2) Free Dictionary API recordings (Wiktionary mirror)
    if (!got) {
      try {
        const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word),
          { signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const audioUrl = findAudioUrl(await r.json());
          if (audioUrl) {
            const ar = await fetch(audioUrl, { signal: AbortSignal.timeout(10000) });
            if (ar.ok) {
              const b = Buffer.from(await ar.arrayBuffer());
              if (b.length > 200) {
                const em = /\.(mp3|ogg|wav)$/i.exec(new URL(audioUrl).pathname);
                got = { buf: b, ext: em ? em[0].toLowerCase() : ".mp3" };
              }
            }
          }
        }
      } catch {}
    }
    // 3) Youdao dictvoice (unofficial; synthesizes anything — coverage fallback)
    if (!got) {
      try {
        const r = await fetch("https://dict.youdao.com/dictvoice?audio=" + encodeURIComponent(word) + "&type=2",
          { signal: AbortSignal.timeout(8000) });
        if (r.ok && (r.headers.get("content-type") || "").includes("audio")) {
          const b = Buffer.from(await r.arrayBuffer());
          if (b.length > 200) got = { buf: b, ext: ".mp3" };
        }
      } catch {}
    }
    if (!got) { res.writeHead(503).end(); return; } // nothing cached — client retries later / uses TTS
    const fname = key.replace(/[^a-z0-9\-]/g, "_") + got.ext;
    try {
      fs.mkdirSync(AUDIO_DIR, { recursive: true });
      fs.writeFileSync(path.join(AUDIO_DIR, fname), got.buf);
      audioIndex[key] = fname;
      saveAudioIndexSoon();
    } catch {}
    res.writeHead(200, { "Content-Type": AUDIO_MIME[got.ext] || "audio/mpeg", "Cache-Control": "max-age=31536000" });
    res.end(got.buf);
    return;
  }

  if (pathname === "/") pathname = "/index.html";
  // resolve inside ROOT only — reject traversal
  const full = path.join(ROOT, path.normalize(pathname).replace(/^([/\\])+/, ""));
  if (!full.startsWith(ROOT) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store", // wordbook files change on re-export — always serve fresh
  });
  fs.createReadStream(full).pipe(res);
});

/* Registered ONCE — passing a callback to server.listen() on every retry
   would stack one 'listening' listener per failed port, and all of them fire
   together on the port that finally binds (log spam + one browser tab each). */
server.on("listening", () => {
  server.removeAllListeners("error");
  server.on("error", (e) => console.error("Server error:", e.message));
  const url = "http://127.0.0.1:" + server.address().port + "/";
  console.log("EngRem is running at " + url);
  console.log("Example cache: " + CACHE_FILE + " (" + Object.keys(exCache).length + " words)");
  console.log("Keep this window open while studying; close it to stop.");
  exec('start "" "' + url + '"'); // open default browser (Windows)
});

function listen(port) {
  server.once("error", (e) => {
    // EACCES: Windows can reserve whole port ranges (Hyper-V/WinNAT), and the
    // reserved ranges move around after a reboot — walk past them, and as a
    // last resort take any free port (0 = OS-assigned)
    if ((e.code === "EADDRINUSE" || e.code === "EACCES") && port !== 0) {
      listen(port < START_PORT + 30 ? port + 1 : 0);
    } else { console.error("Failed to start server:", e.message); process.exit(1); }
  });
  server.listen(port, "127.0.0.1");
}
listen(START_PORT);
