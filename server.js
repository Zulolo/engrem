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

/* Close morphological relatives, tried only when the word itself has no
   examples anywhere (e.g. "advertent" -> "inadvertent"). Bogus candidates are
   harmless: their searches return nothing and the loop moves on. */
function relatedForms(word) {
  const w = word.toLowerCase().trim();
  if (/\s/.test(w) || w.length < 4) return [];
  const out = [];
  const add = (x) => { if (x && x !== w && out.length < 4 && !out.includes(x)) out.push(x); };
  for (const p of ["in", "un", "im", "dis", "non", "ir", "il"]) {
    if (w.startsWith(p) && w.length - p.length >= 4) add(w.slice(p.length)); // inadvertent -> advertent
  }
  add("in" + w); // advertent -> inadvertent
  add("un" + w);
  add(w.endsWith("y") ? w.slice(0, -1) + "ily" : w + "ly"); // -> advertently
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
    for (const rel of relatedForms(word)) {
      const r = await searchSentences(rel);
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
const EX_POOL = 10, EX_PICK = 5;

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

/* One sweep over the sources for a single term. */
async function searchSentences(word) {
  let okAny = false;
  const sentences = [];
  const seen = new Set();
  // near-duplicate key: contraction- and punctuation-insensitive
  // ("What's your favourite advert?" == "What is your favourite advert?")
  const exKey = (s) => s.toLowerCase().replace(/[’']/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !["is", "s", "are", "re", "am", "m", "not", "nt", "will", "ll", "have", "ve", "would", "d", "the", "a", "an"].includes(t))
    .join(" ");
  // filter AT COLLECTION time: a sentence must contain the word (or an
  // inflection) to count toward the 5-sentence quota — otherwise wrong-word
  // results from one source (e.g. dict's "wilt" -> "will" entry) fill the
  // quota and block the sources that have the real sentences
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
  // search with the word AND its base/inflected forms — a wordbook may store
  // "thawed" while the good sentences use "thaw" or "thawing"
  const searchTerms = /\s/.test(word) ? [word] : [...new Set([word.toLowerCase(), ...lemmaCandidates(word)])].slice(0, 3);
  // 1) Free Dictionary API definition examples
  for (const term of searchTerms) {
    if (sentences.length >= EX_POOL) break;
    try {
      const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(term),
        { signal: AbortSignal.timeout(8000) });
      if (r.ok || r.status === 404) okAny = true; // 404 = term simply not in that dictionary
      if (r.ok) {
        const data = await r.json();
        for (const entry of Array.isArray(data) ? data : []) {
          for (const m of entry.meanings || []) {
            for (const d of m.definitions || []) {
              if (d.example) push(d.example, "dict");
            }
          }
        }
      }
    } catch {}
  }
  // 2) Wiktionary usage examples
  for (const term of searchTerms) {
    if (sentences.length >= EX_POOL) break;
    try {
      const r = await fetch("https://en.wiktionary.org/api/rest_v1/page/definition/" + encodeURIComponent(term) + "?redirect=true",
        { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
      if (r.ok || r.status === 404) okAny = true;
      if (r.ok) {
        const data = await r.json();
        for (const sec of data.en || []) {
          for (const d of sec.definitions || []) {
            for (const ex of d.parsedExamples || []) if (ex.example) push(stripHtml(ex.example), "wikt");
            for (const ex of d.examples || []) push(stripHtml(ex), "wikt");
          }
        }
      }
    } catch {}
  }
  // 3) Tatoeba — unquoted, so its stemmed search covers inflections both ways
  for (const term of searchTerms.slice(0, 2)) {
    if (sentences.length >= EX_POOL) break;
    try {
      const u = "https://api.tatoeba.org/unstable/sentences?lang=eng&q=" +
        encodeURIComponent(term) + "&sort=relevance&limit=8";
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        okAny = true;
        const data = await r.json();
        for (const s of (data && data.data) || []) push(s.text, "tatoeba");
      }
    } catch {}
  }
  // 4) prefixed relatives (un-/in-): if the pool has no prefixed family
  // member yet, spend up to two Tatoeba queries looking for ones so the pick
  // can also offer "unhappy" / "inadvertently" alongside plain inflections
  if (!/\s/.test(word)) {
    const hasPrefixed = varRe && sentences.some((s) => {
      varRe.lastIndex = 0;
      const m = varRe.exec(s.text);
      return m && formKey(m[0], word).includes("+");
    });
    if (!hasPrefixed) {
      const w0 = word.toLowerCase().trim();
      const prefixTerms = [];
      for (const p of ["in", "un", "im", "dis", "non", "ir", "il"]) {
        if (w0.startsWith(p) && w0.length - p.length >= 4) prefixTerms.push(w0.slice(p.length));
      }
      if (prefixTerms.length === 0 && w0.length >= 4) prefixTerms.push("in" + w0, "un" + w0);
      const before = sentences.length;
      for (const term of prefixTerms.slice(0, 2)) {
        if (sentences.length - before >= 4) break;
        try {
          const r = await fetch("https://api.tatoeba.org/unstable/sentences?lang=eng&q=" +
            encodeURIComponent(term) + "&sort=relevance&limit=8", { signal: AbortSignal.timeout(8000) });
          if (r.ok) {
            okAny = true;
            const data = await r.json();
            for (const s of (data && data.data) || []) push(s.text, "tatoeba");
          }
        } catch {}
      }
    }
  }
  // already filtered at collection time — wrong-word examples never enter;
  // pick a mix of inflection forms rather than the first five in source order
  return { ok: okAny, sentences: pickDiverse(sentences, varRe, word) };
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
    console.log("Caches cleared by client request");
    res.writeHead(200, { "Content-Type": MIME[".json"] });
    res.end(JSON.stringify({ ok: true }));
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

function listen(port) {
  server.once("error", (e) => {
    // EACCES: Windows can reserve whole port ranges (Hyper-V/WinNAT), and the
    // reserved ranges move around after a reboot — walk past them, and as a
    // last resort take any free port (0 = OS-assigned)
    if ((e.code === "EADDRINUSE" || e.code === "EACCES") && port !== 0) {
      listen(port < START_PORT + 30 ? port + 1 : 0);
    } else { console.error("Failed to start server:", e.message); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = "http://127.0.0.1:" + server.address().port + "/";
    console.log("EngRem is running at " + url);
    console.log("Example cache: " + CACHE_FILE + " (" + Object.keys(exCache).length + " words)");
    console.log("Keep this window open while studying; close it to stop.");
    exec('start "" "' + url + '"'); // open default browser (Windows)
  });
}
listen(START_PORT);
