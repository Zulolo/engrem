#!/usr/bin/env node
/* Merge one EngRem data folder into another (both the layout server.js
 * writes: state.json, examples-cache.json, phonetic-cache.json,
 * audio-cache/, image-cache/, *.xml). Typical use: the data a second PC
 * accumulated in local mode, folded into the hosted box's /var/lib/engrem.
 *
 *   node deploy/merge-data.js --from <folder> --into <folder> [--dry-run]
 *
 * Rules — the target is the authority, the source only adds:
 *   words        union by word; a target entry gains a phonetic it lacked
 *   levels       union; Known wins over Acquainted, so a word is never demoted
 *   position     the target's (mode, shuffle, study set, order, position stay)
 *   examples     a word missing in the target, or cached there with an older
 *                schema version, takes the source's sentences
 *   phonetics    a word missing in the target, or empty there, takes the source's
 *   audio/images a word missing in the target takes the source's file
 *   wordbooks    a file name new to the target is copied; one that exists
 *                with different content is copied as "<name> (merged).xml" so
 *                the automatic re-import never replaces the merged word list
 * The merged state gets a fresh server stamp (_ts), so every device adopts it
 * at its next visit. Stop the server before running this against its folder.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : ""; };
const FROM = path.resolve(opt("--from") || ""), INTO = path.resolve(opt("--into") || "");
const DRY = args.includes("--dry-run");
if (!opt("--from") || !opt("--into") || !fs.existsSync(FROM) || !fs.existsSync(INTO)) {
  console.error("usage: node merge-data.js --from <folder> --into <folder> [--dry-run]");
  process.exit(2);
}
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fb; } };
const writeJson = (p, v) => { if (!DRY) fs.writeFileSync(p, JSON.stringify(v)); };
const report = [];
const say = (s) => { report.push(s); console.log("  " + s); };

/* ---- study state ---- */
const K = { words: "engrem.words", state: "engrem.state", fam: "engrem.familiar", acq: "engrem.acquainted" };
const src = readJson(path.join(FROM, "state.json"), {});
const dst = readJson(path.join(INTO, "state.json"), {});
if (Array.isArray(src[K.words]) && src[K.words].length) {
  const words = Array.isArray(dst[K.words]) ? dst[K.words] : [];
  const byWord = new Map(words.map((w) => [w.word, w]));
  let added = 0, phon = 0;
  for (const w of src[K.words]) {
    if (!w || !w.word) continue;
    const t = byWord.get(w.word);
    if (!t) { words.push(w); byWord.set(w.word, w); added++; }
    else if (!t.phonetic && w.phonetic) { t.phonetic = w.phonetic; phon++; }
    else if (!t.trans && w.trans) t.trans = w.trans;
  }
  const fam = new Set(dst[K.fam] || []), acq = new Set(dst[K.acq] || []);
  let famAdded = 0, acqAdded = 0;
  for (const w of src[K.fam] || []) if (!fam.has(w)) { fam.add(w); acq.delete(w); famAdded++; }
  for (const w of src[K.acq] || []) if (!fam.has(w) && !acq.has(w)) { acq.add(w); acqAdded++; }
  dst[K.words] = words;
  dst[K.fam] = [...fam];
  dst[K.acq] = [...acq];
  if (!dst[K.state]) dst[K.state] = src[K.state];
  dst._ts = Date.now();
  writeJson(path.join(INTO, "state.json"), dst);
  say(`words: ${words.length} total, ${added} added, ${phon} phonetics filled`);
  say(`levels: ${fam.size} known (+${famAdded}), ${acq.size} acquainted (+${acqAdded})`);
} else say("words: source has none, state untouched");

/* ---- example sentences ---- */
{
  const s = readJson(path.join(FROM, "examples-cache.json"), {}), d = readJson(path.join(INTO, "examples-cache.json"), {});
  let n = 0;
  for (const [w, e] of Object.entries(s)) {
    if (!d[w] || (e.v || 0) > (d[w].v || 0)) { d[w] = e; n++; }
  }
  writeJson(path.join(INTO, "examples-cache.json"), d);
  say(`examples: ${Object.keys(d).length} words cached, ${n} taken from source`);
}

/* ---- phonetics ---- */
{
  const s = readJson(path.join(FROM, "phonetic-cache.json"), {}), d = readJson(path.join(INTO, "phonetic-cache.json"), {});
  let n = 0;
  for (const [w, e] of Object.entries(s)) {
    if (e && e.p && !(d[w] && d[w].p)) { d[w] = e; n++; }
  }
  writeJson(path.join(INTO, "phonetic-cache.json"), d);
  say(`phonetics: ${Object.keys(d).length} cached, ${n} taken from source`);
}

/* ---- audio and image files (index.json + one file per word) ---- */
function mergeFiles(dir, label, valueOf) {
  const sIdx = readJson(path.join(FROM, dir, "index.json"), {}), dIdx = readJson(path.join(INTO, dir, "index.json"), {});
  let n = 0;
  for (const [w, e] of Object.entries(sIdx)) {
    const file = valueOf(e);
    if (dIdx[w] !== undefined && (valueOf(dIdx[w]) || file === "")) continue; // target has it (or a real file beats "none")
    if (file) {
      const from = path.join(FROM, dir, file), to = path.join(INTO, dir, file);
      if (!fs.existsSync(from)) continue;
      if (!DRY) { fs.mkdirSync(path.join(INTO, dir), { recursive: true }); fs.copyFileSync(from, to); }
    }
    dIdx[w] = e; n++;
  }
  if (!DRY) fs.mkdirSync(path.join(INTO, dir), { recursive: true });
  writeJson(path.join(INTO, dir, "index.json"), dIdx);
  say(`${label}: ${Object.keys(dIdx).length} entries, ${n} taken from source`);
}
mergeFiles("audio-cache", "audio", (e) => (typeof e === "string" ? e : ""));
mergeFiles("image-cache", "images", (e) => (e && e.file) || "");

/* ---- wordbook exports ---- */
for (const name of fs.readdirSync(FROM).filter((n) => /\.xml$/i.test(n) && n !== "sample_wordbook.xml")) {
  const from = path.join(FROM, name);
  let to = path.join(INTO, name);
  if (fs.existsSync(to)) {
    if (fs.readFileSync(from).equals(fs.readFileSync(to))) { say(`wordbook ${name}: identical, skipped`); continue; }
    to = path.join(INTO, name.replace(/\.xml$/i, " (merged).xml"));
  }
  if (!DRY) fs.copyFileSync(from, to);
  say(`wordbook ${name}: copied as ${path.basename(to)}`);
}
if (DRY) console.log("(dry run — nothing written)");
