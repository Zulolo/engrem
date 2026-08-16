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
const START_PORT = 8017;
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
function wordVariantsRegex(word) {
  const w = word.trim();
  if (!w) return null;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/\s/.test(w)) return new RegExp("\\b" + escRe(w).replace(/\s+/g, "\\s+") + "\\b", "gi");
  const v = new Set([w, w + "s", w + "es", w + "ed", w + "d", w + "ing"]);
  if (w.length > 2) {
    if (w.endsWith("e")) { const st = w.slice(0, -1); v.add(st + "ing"); v.add(st + "ed"); }
    if (w.endsWith("y")) { const st = w.slice(0, -1); v.add(st + "ies"); v.add(st + "ied"); v.add(st + "ier"); v.add(st + "iest"); }
    const last = w[w.length - 1];
    if (/[bdgklmnprtv]/.test(last) && /[aeiou]/.test(w[w.length - 2]) && !/[aeiou]/.test(w[w.length - 3] || "x")) {
      v.add(w + last + "ing"); v.add(w + last + "ed");
    }
  }
  const parts = [...v].sort((a, b) => b.length - a.length).map(escRe);
  return new RegExp("\\b(" + parts.join("|") + ")\\b", "gi");
}

async function fetchExamples(word) {
  let okAny = false;
  const sentences = [];
  const seen = new Set();
  const push = (s, src) => {
    s = String(s).replace(/\s+/g, " ").trim();
    if (!s || s.length < 8 || s.length > 220) return;
    const k = s.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    sentences.push({ text: s, src });
  };
  // 1) Free Dictionary API
  try {
    const r = await fetch("https://api.dictionaryapi.dev/api/v2/entries/en/" + encodeURIComponent(word),
      { signal: AbortSignal.timeout(8000) });
    if (r.ok || r.status === 404) okAny = true; // 404 = word simply not in that dictionary
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
  // 2) Tatoeba
  if (sentences.length < 5) {
    try {
      const u = "https://api.tatoeba.org/unstable/sentences?lang=eng&q=" +
        encodeURIComponent('"' + word + '"') + "&sort=relevance&limit=8";
      const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        okAny = true;
        const data = await r.json();
        for (const s of (data && data.data) || []) push(s.text, "tatoeba");
      }
    } catch {}
  }
  const re = wordVariantsRegex(word);
  const hits = re ? sentences.filter((s) => { re.lastIndex = 0; return re.test(s.text); }) : sentences;
  return { ok: okAny, sentences: (hits.length ? hits : sentences).slice(0, 5) };
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
    if (exCache[key]) {
      res.writeHead(200, { "Content-Type": MIME[".json"] });
      res.end(JSON.stringify({ ok: true, cached: true, sentences: exCache[key].sentences }));
      return;
    }
    const result = await fetchExamples(word);
    if (result.ok) {
      exCache[key] = { sentences: result.sentences, ts: Date.now() };
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
    if (e.code === "EADDRINUSE" && port < START_PORT + 20) listen(port + 1);
    else { console.error("Failed to start server:", e.message); process.exit(1); }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = "http://127.0.0.1:" + port + "/";
    console.log("EngRem is running at " + url);
    console.log("Example cache: " + CACHE_FILE + " (" + Object.keys(exCache).length + " words)");
    console.log("Keep this window open while studying; close it to stop.");
    exec('start "" "' + url + '"'); // open default browser (Windows)
  });
}
listen(START_PORT);
