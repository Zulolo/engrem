/* Hosted mode for EngRem: one user, a handful of personal devices, the server
 * reachable from the internet (e.g. a small Linux board behind a Cloudflare
 * Tunnel). Enabled by ENGREM_HOSTED=1; server.js runs exactly as before
 * without it (no login, loopback only).
 *
 * Rules (as asked by the owner):
 *   - one password, the initial one must be changed at first login;
 *   - a device signs in once with the password and then keeps a cookie that is
 *     renewed on every visit (Chrome caps cookies at 400 days, so a device that
 *     is used at least once a year never sees the password form again);
 *   - a NEW device can only be enrolled from inside the home network: either
 *     the request reaches the server directly from a private address, or it
 *     comes through the tunnel from the same public IP the server itself has;
 *   - at most DEVICE_LIMIT devices; enrolling one more evicts the device that
 *     was seen least recently.
 * Everything lives in <data dir>/auth.json (never committed).
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEVICE_LIMIT = 5;
const COOKIE = "engrem_s";
const COOKIE_MAX_AGE = 400 * 86400; // seconds — the browsers' hard cap
const INITIAL_PASSWORD = process.env.ENGREM_INITIAL_PASSWORD || "Aa123456";
const MIN_PASSWORD = 8;
const LOGIN_FAILS = 5;            // per client IP ...
const LOGIN_LOCK_MS = 15 * 60000; // ... then locked out this long
const ENROL_TTL_MS = 5 * 60000;   // LAN-to-public hand-off links

function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString("hex"); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function stripV4(ip) { return String(ip || "").replace(/^::ffff:/i, ""); }
function isLoopback(ip) { ip = stripV4(ip); return ip === "127.0.0.1" || ip === "::1"; }
function isPrivate(ip) {
  ip = stripV4(ip);
  return isLoopback(ip) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fe80:|f[cd][0-9a-f]{2}:)/i.test(ip);
}
function deviceName(ua) {
  ua = String(ua || "");
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return os + " · " + br;
}
function parseCookies(h) {
  const out = {};
  for (const part of String(h || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

module.exports = function hosted({ dataDir, publicUrl, lanUrl }) {
  const AUTH_FILE = path.join(dataDir, "auth.json");
  let auth = null;
  try { auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8")); } catch {}
  if (!auth || !auth.pw) {
    const salt = crypto.randomBytes(16).toString("hex");
    auth = { pw: { salt, hash: hashPassword(INITIAL_PASSWORD, salt) }, mustChange: true, devices: {} };
    save();
    console.log("Hosted mode: created " + AUTH_FILE + " with the initial password (must be changed at first login)");
  }
  function save() {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
    const tmp = AUTH_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(auth, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, AUTH_FILE);
  }
  function checkPassword(pw) { return safeEqual(hashPassword(String(pw), auth.pw.salt), auth.pw.hash); }
  function setPassword(pw) {
    const salt = crypto.randomBytes(16).toString("hex");
    auth.pw = { salt, hash: hashPassword(pw, salt) };
    auth.mustChange = false;
    save();
  }

  /* ---- "inside the home network" ---- */
  // The server's own public (NAT egress) addresses: a tunnelled request whose
  // Cloudflare-reported client IP is one of these comes from the same network.
  let egress = new Set(), egressAt = 0, egressPending = null;
  async function refreshEgress(force) {
    if (!force && Date.now() - egressAt < 10 * 60000) return;
    if (egressPending) return egressPending;
    egressPending = (async () => {
      const found = new Set();
      const probes = [
        ["https://www.cloudflare.com/cdn-cgi/trace", (t) => (/^ip=(.+)$/m.exec(t) || [])[1]],
        ["https://ipv4.icanhazip.com", (t) => t.trim()],
        ["https://ipv6.icanhazip.com", (t) => t.trim()],
      ];
      await Promise.all(probes.map(async ([u, pick]) => {
        try {
          const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) return;
          const ip = pick(await r.text());
          if (ip && /^[0-9a-f.:]+$/i.test(ip)) found.add(ip.toLowerCase());
        } catch {}
      }));
      if (found.size) { egress = found; egressAt = Date.now(); }
      egressPending = null;
    })();
    return egressPending;
  }
  refreshEgress(true).catch(() => {});
  setInterval(() => refreshEgress(false).catch(() => {}), 5 * 60000).unref();

  function clientInfo(req) {
    const ra = stripV4(req.socket.remoteAddress);
    const cf = req.headers["cf-connecting-ip"];
    // the Cloudflare header is trusted only when cloudflared itself (on this
    // machine) delivered the request — a LAN client cannot spoof its way in
    const viaTunnel = !!cf && isLoopback(ra);
    const ip = viaTunnel ? String(cf).toLowerCase() : ra;
    const https = viaTunnel || req.headers["x-forwarded-proto"] === "https";
    return { ip, viaTunnel, https };
  }
  async function onLan(info) {
    if (!info.viaTunnel) return isPrivate(info.ip);
    if (Date.now() - egressAt > 60000) await refreshEgress(true);
    return egress.has(info.ip);
  }

  /* ---- devices / cookies ---- */
  function cookieHeader(value, info, maxAge) {
    return COOKIE + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge + (info.https ? "; Secure" : "");
  }
  function deviceOf(req) {
    const c = parseCookies(req.headers.cookie)[COOKIE];
    if (!c) return null;
    const i = c.indexOf(".");
    if (i < 0) return null;
    const id = c.slice(0, i), secret = c.slice(i + 1);
    const d = auth.devices[id];
    if (!d || !safeEqual(sha256(secret), d.hash)) return null;
    return { id, d, value: c };
  }
  function touch(req, res, dev, info) {
    const now = Date.now();
    if (now - (dev.d.lastSeen || 0) > 60000) { // throttle disk writes
      dev.d.lastSeen = now; dev.d.ip = info.ip; save();
    }
    res.setHeader("Set-Cookie", cookieHeader(dev.value, info, COOKIE_MAX_AGE)); // sliding expiry
  }
  function enrolDevice(req, info) {
    const id = crypto.randomBytes(6).toString("hex");
    const secret = crypto.randomBytes(32).toString("base64url");
    auth.devices[id] = { hash: sha256(secret), name: deviceName(req.headers["user-agent"]),
      created: Date.now(), lastSeen: Date.now(), ip: info.ip };
    // over the limit: the device not seen for the longest time goes
    const ids = Object.keys(auth.devices).sort((a, b) => (auth.devices[a].lastSeen || 0) - (auth.devices[b].lastSeen || 0));
    while (ids.length > DEVICE_LIMIT) delete auth.devices[ids.shift()];
    save();
    return { id, d: auth.devices[id], value: id + "." + secret };
  }

  /* ---- login throttling ---- */
  const fails = new Map(); // ip -> { n, until }
  function locked(ip) { const f = fails.get(ip); return !!(f && f.until > Date.now()); }
  function noteFail(ip) {
    const f = fails.get(ip) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= LOGIN_FAILS) { f.until = Date.now() + LOGIN_LOCK_MS; f.n = 0; }
    fails.set(ip, f);
  }
  setInterval(() => { for (const [k, f] of fails) if (f.until < Date.now() - LOGIN_LOCK_MS) fails.delete(k); }, 60000).unref();

  const enrolTokens = new Map(); // token -> { id, value, until }

  const json = (res, code, obj, extra) => {
    res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extra || {}));
    res.end(JSON.stringify(obj));
  };
  const html = (res, code, body, extra) => {
    res.writeHead(code, Object.assign({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, extra || {}));
    res.end(body);
  };
  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 65536) throw new Error("too large"); chunks.push(c); }
    return JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
  }

  /* ---- pages (served without the app, so they work before login) ---- */
  const PAGE_CSS = `
  :root{--bg:#f6f7f9;--panel:#fff;--text:#1c2330;--muted:#6b7484;--accent:#2563eb;--border:#e2e6ec;--bad:#dc2626;--good:#16a34a}
  @media(prefers-color-scheme:dark){:root{--bg:#12151c;--panel:#1b202b;--text:#e6e9ef;--muted:#8b93a5;--accent:#60a5fa;--border:#2a3140;--bad:#f87171;--good:#4ade80}}
  *{box-sizing:border-box}body{margin:0;font-family:"Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1rem}
  .card{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:1.4rem 1.5rem;width:100%;max-width:420px;box-shadow:0 1px 3px rgba(16,24,40,.08),0 4px 16px rgba(16,24,40,.06)}
  h1{font-size:1.2rem;margin:0 0 .3rem}h2{font-size:1rem;margin:1.2rem 0 .4rem}p{margin:.3rem 0 .8rem;color:var(--muted);font-size:.92rem;line-height:1.45}
  label{display:block;font-size:.85rem;color:var(--muted);margin:.7rem 0 .25rem}
  input{width:100%;font:inherit;font-size:1.05rem;padding:.6rem .7rem;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--text)}
  input:focus{outline:2px solid var(--accent);border-color:transparent}
  button{font:inherit;font-size:1rem;padding:.65rem 1rem;border-radius:9px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer;margin-top:1rem;width:100%}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
  button.small{width:auto;margin:0;padding:.3rem .6rem;font-size:.85rem}
  .msg{min-height:1.3em;font-size:.9rem;margin-top:.7rem;color:var(--bad)}.msg.ok{color:var(--good)}
  .note{font-size:.85rem;color:var(--muted);margin-top:1rem;line-height:1.45}
  ul{list-style:none;padding:0;margin:.4rem 0}li{display:flex;align-items:center;gap:.6rem;padding:.5rem 0;border-top:1px solid var(--border);font-size:.9rem}li .n{flex:1}li .t{color:var(--muted);font-size:.8rem}
  a{color:var(--accent)}.hidden{display:none}`;

  function loginPage(info) {
    const lanTip = lanUrl ? ' If that still fails, open <a href="' + esc(lanUrl) + '">' + esc(lanUrl) + "</a> on this device while at home and sign in there." : "";
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EngRem — sign in</title><style>${PAGE_CSS}</style></head><body>
<div class="card"><h1>🧠 EngRem</h1><p>Sign in once on this device; it stays signed in afterwards.</p>
<form id="f"><label for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" autofocus required>
<button class="primary" type="submit">Sign in</button><div class="msg" id="msg"></div></form>
<div id="handoff" class="hidden"><p class="msg ok">Signed in on the home-network address.</p><a id="hlink" href="#"><button class="primary">Continue on the public address →</button></a></div>
<div class="note">A new device can only be registered from inside the home network (same Wi-Fi/LAN as the server).${lanTip}</div></div>
<script>
const f=document.getElementById("f"),msg=document.getElementById("msg");
f.addEventListener("submit",async(e)=>{e.preventDefault();msg.textContent="…";msg.className="msg";
 try{const r=await fetch("api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("pw").value})});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){msg.textContent=d.message||d.error||("HTTP "+r.status);return}
  if(d.handoff){document.getElementById("hlink").href=d.handoff;f.classList.add("hidden");document.getElementById("handoff").classList.remove("hidden");if(d.mustChange)document.getElementById("hlink").href=d.handoff+"&must=1";return}
  location.replace(d.mustChange?"account?must=1":"./");
 }catch(err){msg.textContent="Network error: "+err.message}});
</script></body></html>`;
  }

  function accountPage(dev, must) {
    const list = Object.entries(auth.devices).sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0)).map(([id, d]) =>
      '<li><span class="n">' + esc(d.name || "Device") + (id === dev.id ? " <b>(this device)</b>" : "") +
      '<br><span class="t">last seen ' + new Date(d.lastSeen || d.created).toLocaleString("en-GB") + (d.ip ? " · " + esc(d.ip) : "") + "</span></span>" +
      (id === dev.id ? "" : '<button class="small" data-forget="' + id + '">Forget</button>') + "</li>").join("");
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EngRem — account</title><style>${PAGE_CSS}</style></head><body>
<div class="card"><h1>🔒 Account</h1>
${must ? '<p class="msg">Please set your own password before continuing — the initial one is public.</p>' : '<p><a href="./">← Back to study</a></p>'}
<h2>Change password</h2>
<form id="f"><label for="cur">Current password</label><input id="cur" type="password" autocomplete="current-password" required>
<label for="nw">New password (at least ${MIN_PASSWORD} characters)</label><input id="nw" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
<label for="nw2">Repeat new password</label><input id="nw2" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
<button class="primary" type="submit">Change password</button><div class="msg" id="msg"></div></form>
<h2>Signed-in devices (${Object.keys(auth.devices).length} of ${DEVICE_LIMIT})</h2>
<ul id="devs">${list}</ul>
<p>When a sixth device signs in, the one used least recently is signed out automatically. A forgotten device must sign in again from the home network.</p>
<button id="out">Sign out on this device</button></div>
<script>
const msg=document.getElementById("msg");
document.getElementById("f").addEventListener("submit",async(e)=>{e.preventDefault();msg.className="msg";
 const nw=document.getElementById("nw").value;if(nw!==document.getElementById("nw2").value){msg.textContent="The new passwords do not match";return}
 const r=await fetch("api/change-password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({current:document.getElementById("cur").value,next:nw})});
 const d=await r.json().catch(()=>({}));if(!r.ok){msg.textContent=d.message||d.error||("HTTP "+r.status);return}
 msg.className="msg ok";msg.textContent="Password changed";setTimeout(()=>location.replace("./"),700)});
document.getElementById("devs").addEventListener("click",async(e)=>{const b=e.target.closest("[data-forget]");if(!b)return;
 b.disabled=true;const r=await fetch("api/devices/forget",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:b.dataset.forget})});if(r.ok)b.closest("li").remove();else b.disabled=false});
document.getElementById("out").addEventListener("click",async()=>{await fetch("api/logout",{method:"POST"});location.replace("login")});
</script></body></html>`;
  }

  /* ---- the request hook: returns true when the request was fully handled ---- */
  const OPEN_PATHS = new Set(["/login", "/api/login", "/api/me", "/healthz", "/favicon.ico"]);
  const MUST_CHANGE_PATHS = new Set(["/account", "/api/change-password", "/api/logout", "/api/devices/forget"]);

  async function handle(req, res, url, pathname) {
    const info = clientInfo(req);
    const dev = deviceOf(req);

    if (pathname === "/healthz") { json(res, 200, { ok: true }); return true; }

    if (pathname === "/api/me") {
      json(res, 200, { hosted: true, authed: !!dev, mustChange: !!(dev && auth.mustChange),
        device: dev ? { id: dev.id, name: dev.d.name } : null, devices: Object.keys(auth.devices).length,
        lan: await onLan(info).catch(() => false) });
      return true;
    }

    if (pathname === "/api/login") {
      if (req.method !== "POST") { res.writeHead(405).end(); return true; }
      if (locked(info.ip)) { json(res, 429, { error: "locked", message: "Too many failed attempts — try again in 15 minutes" }); return true; }
      let body; try { body = await readJson(req); } catch { json(res, 400, { error: "bad request" }); return true; }
      if (!checkPassword(body.password || "")) {
        noteFail(info.ip);
        console.log("Login failed from " + info.ip);
        json(res, 401, { error: "wrong password", message: "Wrong password" });
        return true;
      }
      let d = dev;
      if (!d) { // a device without a (valid) cookie is new: home network only
        if (!(await onLan(info))) {
          console.log("Login refused (not on the home network) from " + info.ip + (info.viaTunnel ? " via tunnel" : ""));
          json(res, 403, { error: "not_lan", message: "Right password, but new devices can only be registered from inside the home network. Connect to the home Wi-Fi/LAN and try again." });
          return true;
        }
        d = enrolDevice(req, info);
        console.log("Device enrolled: " + d.d.name + " from " + info.ip + " (" + Object.keys(auth.devices).length + "/" + DEVICE_LIMIT + ")");
      } else { d.d.lastSeen = Date.now(); d.d.ip = info.ip; save(); }
      const out = { ok: true, mustChange: !!auth.mustChange };
      // signed in on the LAN address: hand the cookie over to the public one
      if (!info.viaTunnel && publicUrl) {
        const pubHost = (() => { try { return new URL(publicUrl).host; } catch { return ""; } })();
        if (pubHost && pubHost !== (req.headers.host || "")) {
          const token = crypto.randomBytes(24).toString("base64url");
          enrolTokens.set(token, { value: d.value, until: Date.now() + ENROL_TTL_MS });
          out.handoff = publicUrl.replace(/\/+$/, "") + "/login?enrol=" + token;
        }
      }
      json(res, 200, out, { "Set-Cookie": cookieHeader(d.value, info, COOKIE_MAX_AGE) });
      return true;
    }

    if (pathname === "/login") {
      const token = url.searchParams.get("enrol");
      if (token) { // one-time hand-off from a LAN sign-in
        const t = enrolTokens.get(token);
        enrolTokens.delete(token);
        for (const [k, v] of enrolTokens) if (v.until < Date.now()) enrolTokens.delete(k);
        if (t && t.until >= Date.now()) {
          res.writeHead(302, { Location: auth.mustChange || url.searchParams.get("must") ? "account?must=1" : "./",
            "Set-Cookie": cookieHeader(t.value, info, COOKIE_MAX_AGE), "Cache-Control": "no-store" });
          res.end();
          return true;
        }
        html(res, 400, loginPage(info).replace('<div class="msg" id="msg"></div>', '<div class="msg" id="msg">This sign-in link has expired — sign in again.</div>'));
        return true;
      }
      if (dev) { res.writeHead(302, { Location: auth.mustChange ? "account?must=1" : "./", "Cache-Control": "no-store" }); res.end(); return true; }
      html(res, 200, loginPage(info));
      return true;
    }

    if (!dev) { // everything else needs a signed-in device
      if (pathname.startsWith("/api/")) json(res, 401, { error: "unauthorized" });
      else { res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" }); res.end(); }
      return true;
    }
    touch(req, res, dev, info);

    if (pathname === "/api/logout") {
      delete auth.devices[dev.id]; save();
      json(res, 200, { ok: true }, { "Set-Cookie": cookieHeader("", info, 0) });
      return true;
    }
    if (pathname === "/api/devices/forget") {
      if (req.method !== "POST") { res.writeHead(405).end(); return true; }
      let body; try { body = await readJson(req); } catch { json(res, 400, { error: "bad request" }); return true; }
      if (body.id && body.id !== dev.id && auth.devices[body.id]) { delete auth.devices[body.id]; save(); }
      json(res, 200, { ok: true });
      return true;
    }
    if (pathname === "/api/change-password") {
      if (req.method !== "POST") { res.writeHead(405).end(); return true; }
      let body; try { body = await readJson(req); } catch { json(res, 400, { error: "bad request" }); return true; }
      if (!checkPassword(body.current || "")) { noteFail(info.ip); json(res, 401, { error: "wrong password", message: "The current password is wrong" }); return true; }
      const next = String(body.next || "");
      if (next.length < MIN_PASSWORD) { json(res, 400, { error: "weak", message: "Use at least " + MIN_PASSWORD + " characters" }); return true; }
      if (next === INITIAL_PASSWORD) { json(res, 400, { error: "weak", message: "Choose a password different from the initial one" }); return true; }
      setPassword(next);
      console.log("Password changed from " + info.ip);
      json(res, 200, { ok: true });
      return true;
    }
    if (pathname === "/account") { html(res, 200, accountPage(dev, url.searchParams.get("must") === "1" || auth.mustChange)); return true; }

    if (auth.mustChange && !MUST_CHANGE_PATHS.has(pathname)) { // nothing else until the initial password is gone
      if (pathname.startsWith("/api/")) json(res, 403, { error: "must_change_password" });
      else { res.writeHead(302, { Location: "/account?must=1", "Cache-Control": "no-store" }); res.end(); }
      return true;
    }
    return false; // signed in: let server.js serve the app
  }

  return { handle, OPEN_PATHS };
};
