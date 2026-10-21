
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import {
  makeSSEParser, makeStripper, makeEventLog, makeMsgLog,
  safeEqual, makeToken, buildShimBody, parseLog, tailLines, verFrom, memFrom,
  evEcho, evText, evThink, evToolUse, evToolDone, evFinal, evResult,
  parseAvatar, cleanPrefs, AVATAR_WHO, WALL_MAX_BYTES, switchPlan, EFFORT_LEVELS, buildOutgoing,
  formatEarsResult, heSaidVoice, voiceSegments, pcmEnvelope, makeToolLines, evToolUseWith,
  bubbleKey, setReaction, cleanReactInput, searchMsgs, parseStickerImage,
  weatherCard, SONG_PROMPT, songDay, parseSongReply, songFromDetail, songOut, periodMark, periodOut,
  cacheSample, usageSig, VITALS_SERVICES, judgeService, cacheOut, hostSeries, HOST_RANGES, cleanStickerName, stickerForHim, detectReset, mergeTurn,
} from "./dwell-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8080);
const SHIM_URL = (process.env.SHIM_URL || "").replace(/\/+$/, "");
const SHIM_KEY = process.env.SHIM_KEY || "";
const DWELL_PASS = process.env.DWELL_PASS || "";
const MODEL = process.env.BRAIN_MODEL || "claude-opus-4-6";
const TURN_TIMEOUT_MS = +(process.env.TURN_TIMEOUT_MS || 600000);

const MSG_CAP = (() => {
  const raw = process.env.MSG_CAP;
  const n = Number(raw);
  if (raw === undefined || raw === "") return 4000;
  if (!Number.isFinite(n) || n < 100) {
    console.log(`⚠️ MSG_CAP 填的是「${raw}」，不是一个 ≥100 的数字，已退回默认 4000`);
    return 4000;
  }
  return Math.floor(n);
})();
const DATA_DIR = process.env.DATA_DIR || "";

let LOG_FILE = DATA_DIR ? path.join(DATA_DIR, "messages.jsonl") : "";

const SALT = Math.random().toString(36).slice(2) + Date.now().toString(36);

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!SHIM_URL) log("⚠️ SHIM_URL 没设——不知道把话交给谁,先去环境变量里补上");
if (!SHIM_KEY) log("⚠️ SHIM_KEY 没设——他那头会 401，先去环境变量里补上");
if (!DWELL_PASS) log("⚠️ DWELL_PASS 没设——**页面没有锁**，绝对不要就这样挂公网");

const VER = verFrom(...["web/index.html", "web/chat.html", "server.js", "dwell-lib.mjs"].map((f) => {
  try { return fs.readFileSync(path.join(HERE, f), "utf8"); } catch { return `missing:${f}`; }
}));

const events = makeEventLog({ ver: VER });
const msgs = makeMsgLog({ cap: MSG_CAP });

function persist(m) {
  if (!LOG_FILE || !m) return;
  try { fs.appendFileSync(LOG_FILE, JSON.stringify(m) + "\n"); }
  catch (e) { log("[persist]", e.message); }
}

const TAIL_MAX = 64 * 1048576;
function readTail(file, cap) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    let want = Math.min(size, TAIL_MAX, Math.max(262144, cap * 512));
    for (;;) {
      const start = Math.max(0, size - want);

      const from = Math.max(0, start - 1);
      const buf = Buffer.alloc(size - from);

      let got = 0;
      while (got < buf.length) {
        const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
        if (n <= 0) break;
        got += n;
      }
      const r = tailLines(buf.subarray(0, got).toString("utf8"), { cap, fromStart: from === 0 });
      if (r.enough || start === 0 || want >= TAIL_MAX) return { lines: r.lines, size, read: got };

      const per = got / Math.max(1, r.lines.length);
      want = Math.min(size, TAIL_MAX, Math.max(want * 2, Math.ceil(per * cap * 1.2)));
    }
  } finally { fs.closeSync(fd); }
}

function restoreLog() {
  if (!LOG_FILE) { log("[persist] DATA_DIR 没设——记录只在内存里，重建即丢"); return; }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.accessSync(DATA_DIR, fs.constants.W_OK);
    if (fs.existsSync(LOG_FILE)) fs.accessSync(LOG_FILE, fs.constants.W_OK);
  } catch (e) {
    LOG_FILE = "";
    log("⚠️ [persist] 这里写不进去，落盘已关闭（记录会像以前一样重建即丢）:", DATA_DIR, e.message);
    log("⚠️ [persist] 多半是卷没挂上、路径填错、或文件权限不对。/api/health 的 persisted 会如实报 false");
    return;
  }

  try {
    if (!fs.existsSync(LOG_FILE)) { log("[persist] 还没有记录文件，从空开始"); return; }
    const t = readTail(LOG_FILE, MSG_CAP);
    const r = parseLog(t.lines.join("\n"));
    log("[persist] 接回", msgs.restore(r.list), "条记录",
        `（存档 ${(t.size / 1048576).toFixed(1)}MB，只读了末尾 ${(t.read / 1048576).toFixed(1)}MB`,
        r.bad ? `，丢掉 ${r.bad} 行读不懂的）` : "）");
  } catch (e) {
    log("⚠️ [persist] 历史没接回来（新记录照常落盘，不影响聊天）:", e.message);
  }
}
restoreLog();
let busy = false;
let lastErr = null;
let turnAbort = null;

const app = express();
app.use(express.json({ limit: "12mb" }));

function authed(req) {
  if (!DWELL_PASS) return true;
  const m = /(?:^|;\s*)dwell=([^;]+)/.exec(req.headers.cookie || "");
  return !!m && safeEqual(decodeURIComponent(m[1]), makeToken(DWELL_PASS, SALT));
}

const LOGIN_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Intertidal">
<meta name="theme-color" content="#f3f2f1" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1c1b19" media="(prefers-color-scheme: dark)">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<title>Intertidal</title>
<style>
:root{color-scheme:light dark;--top:#f3f2f1;--bot:#ebeae9;--card:#fcfcfb;--ink:#1b191d;--ink2:#55534e;--dim:#8a8984;--dim2:#a9a7a1;
  --line:#ecebea;--field:#f3f2f0;--btn:#1b191d;--btnink:#f6f5f2;
  --shade:0 .5px 1px rgba(27,25,29,.018),0 3px 10px rgba(27,25,29,.022);
  --serif:ui-serif,"New York","Iowan Old Style",Georgia,"Times New Roman",serif;
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;--g:clamp(13px,4.03vw,16.2px)}
@media(prefers-color-scheme:dark){:root{--top:#1c1b19;--bot:#141312;--card:#232220;--ink:#f4f2ee;--ink2:#bcb9b1;--dim:#8f8d87;
  --dim2:#6f6d67;--line:#2e2c29;--field:#1b1a18;--btn:#f4f2ee;--btnink:#1b191d;
  --shade:0 .5px 1px rgba(0,0,0,.16),0 3px 10px rgba(0,0,0,.18)}}
*{box-sizing:border-box}
html{background:var(--bot)}
body{margin:0;min-height:100dvh;display:flex;flex-direction:column;color:var(--ink);font-family:var(--sans);
  background:linear-gradient(180deg,var(--top),var(--bot)) no-repeat;background-size:100% 100lvh;
  padding:calc(env(safe-area-inset-top) + 34px) var(--g) calc(env(safe-area-inset-bottom) + 18px);-webkit-font-smoothing:antialiased}
.in{animation:in .7s cubic-bezier(.2,.8,.2,1) both}
.in2{animation-delay:.08s}.in3{animation-delay:.16s}
@keyframes in{from{opacity:0;transform:translateY(10px)}}
.eyebrow{margin:0 0 0 1px;font-size:12px;font-weight:500;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
.greet{margin:6px 0 0;font:500 34px/1.16 var(--serif)}
.clock{margin:38px 0 0;display:flex;align-items:baseline;gap:10px;font-family:var(--serif)}
.clock b{font-size:96px;line-height:.9;font-weight:700;letter-spacing:-.03em;font-variant-numeric:lining-nums}
.clock span{font:500 15px var(--sans);letter-spacing:.06em;color:var(--dim)}
.spacer{flex:1;min-height:28px}
form{margin:0;padding:18px 20px 16px;border-radius:25px;background:var(--card);box-shadow:var(--shade);
  -webkit-backdrop-filter:saturate(1.1) blur(14px);backdrop-filter:saturate(1.1) blur(14px)}
.label{margin:0 0 12px;font:400 15px var(--serif);color:var(--dim)}
.row{display:flex;gap:10px;align-items:center}
input{flex:1;min-width:0;height:46px;padding:0 16px;border:0;outline:0;border-radius:18px;background:var(--field);
  color:inherit;font:17px var(--sans);letter-spacing:.06em;box-shadow:inset 0 0 0 .5px var(--line);transition:box-shadow .2s}
input:focus{box-shadow:inset 0 0 0 1px var(--dim2)}
input::placeholder{color:var(--dim2);letter-spacing:0}
button{flex:0 0 46px;height:46px;border:0;border-radius:50%;padding:0;cursor:pointer;display:grid;place-items:center;
  background:var(--btn);color:var(--btnink);transition:transform .15s,opacity .2s}
button:active{transform:scale(.92)}
input:placeholder-shown+button{opacity:.22}
button svg{width:19px;height:19px}
.err{margin:10px 2px 0;font-size:13px;color:#c4453a}
.err:empty{display:none}
.shake{animation:shake .42s cubic-bezier(.36,.07,.19,.97)}
@keyframes shake{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
.foot{margin-top:22px;display:flex;align-items:center;justify-content:center;gap:8px;font:400 15px var(--serif);color:var(--dim)}
.foot img{width:20px;height:20px;border-radius:5px;box-shadow:0 0 0 .5px var(--line)}
@media(prefers-reduced-motion:reduce){.in,.shake{animation:none!important}}
</style>
<p class="eyebrow in" id="d">&nbsp;</p>
<h1 class="greet in" id="g">Welcome back</h1>
<div class="clock in in2"><b id="t"></b><span id="ap"></span></div>
<div class="spacer"></div>
<form class="in in3" id="f" method="POST" action="login__TO__">
  <p class="label">Welcome home</p>
  <div class="row">
    <input type="password" name="pass" placeholder="口令" aria-label="口令" autocomplete="current-password" required>
    <button aria-label="Enter"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
  </div>
  <p class="err">__ERR__</p>
</form>
<div class="foot in in3"><img src="icons/icon-180.png" alt="">Intertidal</div>
<script>
(function(){
  var D=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],
      M=["January","February","March","April","May","June","July","August","September","October","November","December"];
  function tick(){var n=new Date(),h=n.getHours(),m=n.getMinutes();
    document.getElementById("d").textContent=D[n.getDay()]+", "+M[n.getMonth()]+" "+n.getDate();
    document.getElementById("g").textContent=h<5?"Good night":h<12?"Good morning":h<18?"Good afternoon":"Good evening";
    document.getElementById("t").textContent=((h+11)%12+1)+":"+(m<10?"0":"")+m;
    document.getElementById("ap").textContent=h<12?"AM":"PM";}
  tick();setInterval(tick,15000);
  if(document.querySelector(".err").textContent){var f=document.getElementById("f");f.classList.remove("in");f.classList.add("shake");}
})();
</script>`;

const loginPage = (err = "", to = "") =>
  LOGIN_PAGE.replace("__ERR__", err).replace("__TO__", to === "chat" ? "?to=chat" : "");

app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  if (!safeEqual(req.body?.pass, DWELL_PASS)) {
    log("[login] 口令不对");
    return res.status(401).type("html").send(loginPage("口令不对", req.query?.to));
  }
  res.setHeader("Set-Cookie",
    `dwell=${encodeURIComponent(makeToken(DWELL_PASS, SALT))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.redirect(req.query?.to === "chat" ? "./chat.html" : "./");
});

app.use("/icons", express.static(path.join(HERE, "web", "icons"), { maxAge: "7d" }));

app.use("/pet", express.static(path.join(HERE, "web", "pet"), { maxAge: "7d" }));
app.get("/manifest.json", (req, res) => {
  const f = path.join(HERE, "web", "manifest.json");
  if (!fs.existsSync(f)) return res.status(404).json({ ok: false });
  res.type("application/manifest+json").send(fs.readFileSync(f, "utf8"));
});

app.get("/", (req, res) => {
  if (!authed(req)) return res.type("html").send(loginPage());
  const f = path.join(HERE, "web", "index.html");
  if (!fs.existsSync(f)) {
    return res.status(500).type("html").send(
      "<meta charset=utf-8><p style='font:16px system-ui;padding:24px'>" +
      "网页文件还没放进来。把 <code>web/</code> 目录放回来。");
  }
  res.type("html").send(fs.readFileSync(f, "utf8"));
});

app.get("/chat.html", (req, res) => {
  if (!authed(req)) return res.status(401).type("html").send(loginPage("", "chat"));
  const f = path.join(HERE, "web", "chat.html");
  if (!fs.existsSync(f)) {
    return res.status(404).type("html").send(
      "<meta charset=utf-8><p style='font:16px system-ui;padding:24px'>" +
      "聊天页还没放进来。把 <code>web/</code> 目录放回来。");
  }
  res.type("html").send(fs.readFileSync(f, "utf8"));
});

const guard = (req, res, next) => authed(req) ? next() : res.status(401).json({ ok: false });

let memInfoCache = { at: 0, text: "" };
function readMem() {
  const now = Date.now();
  if (now - memInfoCache.at > 2000) {
    let text = "";
    try { text = fs.readFileSync("/proc/meminfo", "utf8"); } catch {}
    memInfoCache = { at: now, text };
  }
  return memFrom({ rss: process.memoryUsage.rss(), meminfo: memInfoCache.text });
}

app.get("/api/health", (req, res) => res.json({
  ok: true, busy, shim: SHIM_URL, msgs: msgs.count(), cursor: events.cursor(),
  locked: !!DWELL_PASS, persisted: !!LOG_FILE, cap: MSG_CAP, mem: readMem(),
  agent: !!AGENT_URL, ver: VER, lastErr,
  voice: VOICE_ON, ears: EARS_ON, ffmpeg: !!FFMPEG,
  weather: !!WEATHER_CITY, weatherAt: wxAt ? new Date(wxAt).toISOString() : null,
  vitals: { samples: cacheList.length, last: cacheList.length ? cacheList[cacheList.length - 1].at : null },
  merge: { ms: DEBOUNCE_MS, held: pending.length, queued: turnQueue.length },
  hostStats: hostStatsAt(),
  song: SONG_HOUR >= 0 ? { hour: SONG_HOUR, last: songs.length ? songs[songs.length - 1].day : null, tries: songTry.n, lastErr: songTry.err || null, wait: songWait || null } : false,
}));

const WEATHER_CITY = process.env.WEATHER_CITY || "";
const WEATHER_BASE = (process.env.WEATHER_BASE || "https://wttr.in").replace(/\/$/, "");
let wxData = null, wxAt = 0, wxBusy = false;
async function refreshWeather() {
  if (!WEATHER_CITY || wxBusy) return;
  wxBusy = true;
  try {
    const r = await fetch(`${WEATHER_BASE}/${encodeURIComponent(WEATHER_CITY)}?format=j1`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const j = await r.json(); if (weatherCard(j)) { wxData = j; wxAt = Date.now(); } }
  } catch (e) { log("[wx]", e.message || String(e)); }
  wxBusy = false;
}
if (WEATHER_CITY) { setTimeout(refreshWeather, 3000); setInterval(refreshWeather, 30 * 60000).unref(); }
else log("[wx] 没设 WEATHER_CITY,首页天气那行空着");
app.get("/api/weather", guard, (req, res) => {
  if (!WEATHER_CITY) return res.json({ ok: false, why: "没配城市" });
  if (!wxData || Date.now() - wxAt > 4 * 3600e3) { refreshWeather(); return res.json({ ok: false, why: "还没拉到" }); }
  res.json({ ok: true, ...weatherCard(wxData), at: Math.floor(wxAt / 1000) });
});

const SONG_HOUR = /^\d{1,2}$/.test(process.env.DAILY_SONG_HOUR || "") ? Math.min(23, +process.env.DAILY_SONG_HOUR) : -1;
const SONG_TIMEOUT_MS = +(process.env.SONG_TIMEOUT_MS || 300000);
const SONG_DETAIL_BASE = (process.env.SONG_DETAIL_BASE || "https://music.163.com").replace(/\/$/, "");
const SONG_FILE = DATA_DIR ? path.join(DATA_DIR, "songs.jsonl") : "";
let songs = [];
try { if (SONG_FILE && fs.existsSync(SONG_FILE)) songs = parseLog(fs.readFileSync(SONG_FILE, "utf8")).list.filter((r) => r && r.id && r.day); } catch (e) { log("[song] 读不回", e.message); }
let songBusy = false;
const songTry = { day: "", n: 0, at: 0, err: "" };
function busyWhy() { return songBusy ? "他在挑今天的歌,一会儿就好" : "他还在说上一句"; }
async function songDetail(id) {
  try {
    const r = await fetch(`${SONG_DETAIL_BASE}/api/song/detail/?id=${id}&ids=%5B${id}%5D`,
                          { headers: { "user-agent": "Mozilla/5.0", referer: "https://music.163.com/" }, signal: AbortSignal.timeout(8000) });
    return r.ok ? songFromDetail(await r.json()) : null;
  } catch { return null; }
}
async function pickSong(day) {
  busy = true; songBusy = true;
  songTry.n++; songTry.at = Date.now(); songTry.err = "";
  try {
    const r = await fetch(`${SHIM_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": SHIM_KEY, "anthropic-version": "2023-06-01", "x-system-turn": "1" },
      body: JSON.stringify({ ...buildShimBody(SONG_PROMPT), stream: false }),
      signal: AbortSignal.timeout(SONG_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`上游 ${r.status}`);
    const j = await r.json();
    const text = (j.content || []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
    const got = parseSongReply(text);
    if (!got) throw new Error("他的回复里没有认得出的那一行");
    const d = await songDetail(got.id);
    const rec = { day, at: Math.floor(Date.now() / 1000), id: got.id, name: d?.name || got.name, artist: d?.artist || got.artist, cover: d?.cover || "", note: got.note };
    if (!rec.name) throw new Error("歌名拿不到(ID 可能不对)");
    songs.push(rec);
    if (songs.length > 400) songs = songs.slice(-400);
    if (SONG_FILE) { try { fs.appendFileSync(SONG_FILE, JSON.stringify(rec) + "\n"); } catch (e) { log("[song] 写不进", e.message); } }
    log("[song] 今天:", rec.name, "-", rec.artist);
  } catch (e) {
    songTry.err = e?.message || String(e);
    log("[song] 这次没挑出来:", songTry.err);
  } finally { busy = false; songBusy = false; pump(); }
}
let songWait = "";
async function songTick() {
  const { day, hour } = songDay();
  if (songTry.day !== day) { songTry.day = day; songTry.n = 0; songTry.at = 0; songTry.err = ""; }
  if (busy || pending.length || turnQueue.length || hour < SONG_HOUR || songTry.n >= 3 || Date.now() - songTry.at < 30 * 60000) return;
  if (songs.length && songs[songs.length - 1].day === day) return;
  let cleared = null;
  try { const r = await fetch(`${SHIM_URL}/debug`, { signal: AbortSignal.timeout(8000) }); if (r.ok) cleared = !!(await r.json())?.presence?.windowCleared; } catch {}
  if (cleared !== false) {
    const why = cleared ? "他换过窗口,等她开口再挑" : "读不到 shim 的 /debug";
    if (songWait !== why) log("[song] 先不挑:", why);
    songWait = why;
    return;
  }
  songWait = "";
  if (busy) return;
  pickSong(day);
}
if (SONG_HOUR >= 0) { setTimeout(songTick, +(process.env.SONG_FIRST_MS || 20000)); setInterval(songTick, +(process.env.SONG_TICK_MS || 60000)).unref(); log(`[song] 每日一首开着:北京时间 ${SONG_HOUR} 点后挑`); }
else log("[song] 没设 DAILY_SONG_HOUR,每日一首关着");
app.get("/api/song", guard, (req, res) => {
  if (SONG_HOUR < 0) return res.json({ ok: false, why: "没开" });
  res.json(songOut(songs[songs.length - 1], songDay().day));
});

async function shimPeriod(body) {
  const r = await fetch(`${SHIM_URL}/period`, {
    method: body ? "POST" : "GET",
    headers: { "x-api-key": SHIM_KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`shim ${r.status}`);
  return r.json();
}
app.get("/api/period", guard, async (req, res) => {
  try { res.json(periodOut(await shimPeriod())); }
  catch (e) { res.json({ ok: false, why: e.message || "连不上" }); }
});
app.post("/api/period/mark", guard, async (req, res) => {
  try {
    const cur = await shimPeriod();
    const m = periodMark(cur && cur.effective, String(req.body?.what || ""), songDay().day);
    if (m.err) return res.status(400).json({ ok: false, why: m.err });
    await shimPeriod(m.patch);
    log("[period] 她在网页上记了", req.body.what);
    res.json(periodOut(await shimPeriod()));
  } catch (e) { res.status(502).json({ ok: false, why: e.message || "连不上" }); }
});

const STICKER_DIR = [path.join(HERE, "stickers")]
  .find((d) => fs.existsSync(path.join(d, "registry.json"))) || "";
let STICKERS = {};
try { if (STICKER_DIR) STICKERS = JSON.parse(fs.readFileSync(path.join(STICKER_DIR, "registry.json"), "utf8")); } catch (e) { log("[sticker]", e.message); }
log("[sticker]", STICKER_DIR ? `${Object.keys(STICKERS).length} 张(${STICKER_DIR})` : "没找到贴纸目录,网页里贴纸照旧显示成文字");
const STICKER_FILES = new Set(Object.values(STICKERS));
const STK_MIME = { gif: "image/gif", png: "image/png", webp: "image/webp", jpg: "image/jpeg" };

const MINE_DIR = path.join(DATA_DIR || os.tmpdir(), DATA_DIR ? "stickers-mine" : "dwell-stickers-mine");
const mineFile = () => path.join(MINE_DIR, "mine.json");
function readMine() { try { return JSON.parse(fs.readFileSync(mineFile(), "utf8")) || []; } catch { return []; } }
function stickerImage(tag) {
  const mine = readMine().find((x) => x.tag === tag || (x.aka || []).includes(tag));
  const dir = mine ? MINE_DIR : STICKER_DIR, f = mine ? mine.file : STICKERS[tag];
  if (!f) return null;
  try {
    const mime = STK_MIME[f.split(".").pop()];
    return mime ? { mime, data: fs.readFileSync(path.join(dir, f)).toString("base64") } : null;
  } catch { return null; }
}
app.get("/api/stickers", guard, (req, res) => res.json({ ok: true,
  items: Object.entries(STICKERS).map(([tag, file]) => ({ tag, file }))
    .concat(readMine().map((x) => ({ tag: x.tag, file: x.file, id: x.id, mine: true, aka: x.aka || [] }))) }));
const allStickerTags = (list) => Object.keys(STICKERS).concat(list.flatMap((x) => [x.tag].concat(x.aka || [])));
app.post("/api/stickers/mine", guard, (req, res) => {
  const r = parseStickerImage(req.body && req.body.dataUrl);
  if (r.err) return res.status(400).json({ ok: false, why: r.err });
  try {
    fs.mkdirSync(MINE_DIR, { recursive: true });
    const list = readMine();
    const nm = cleanStickerName(req.body && req.body.name, allStickerTags(list));
    if (nm.err) return res.status(400).json({ ok: false, why: nm.err });
    const id = crypto.randomBytes(6).toString("hex"), file = `${id}.${r.ext}`;
    let n = list.length + 1; while (allStickerTags(list).includes("自制" + n)) n++;
    const tag = nm.tag || "自制" + n;
    writeAtomic(path.join(MINE_DIR, file), r.buf);
    list.push({ id, tag, file });
    writeAtomic(mineFile(), JSON.stringify(list));
    res.json({ ok: true, item: { id, tag, file, mine: true }, persisted: onDisk() });
  } catch (e) { log("[sticker-mine]", e.message); res.status(500).json({ ok: false, why: "没存上:" + e.message }); }
});
app.post("/api/stickers/mine/:id/name", guard, (req, res) => {
  const id = String(req.params.id || "");
  const list = readMine(), hit = list.find((x) => x.id === id);
  if (!hit) return res.status(404).json({ ok: false, why: "找不到这张" });
  const own = [hit.tag].concat(hit.aka || []);
  const nm = cleanStickerName(req.body && req.body.name, allStickerTags(list), own);
  if (nm.err) return res.status(400).json({ ok: false, why: nm.err });
  if (!nm.tag) return res.status(400).json({ ok: false, why: "名字不能空着" });
  if (nm.tag === hit.tag) return res.json({ ok: true, item: { id, tag: hit.tag } });
  hit.aka = Array.from(new Set((hit.aka || []).concat(hit.tag))).filter((t) => t !== nm.tag);
  hit.tag = nm.tag;
  try { writeAtomic(mineFile(), JSON.stringify(list)); res.json({ ok: true, item: { id, tag: hit.tag } }); }
  catch (e) { log("[sticker-mine]", e.message); res.status(500).json({ ok: false, why: "没存上:" + e.message }); }
});
app.delete("/api/stickers/mine/:id", guard, (req, res) => {
  const id = String(req.params.id || "");
  const list = readMine(), hit = list.find((x) => x.id === id);
  if (!hit) return res.status(404).json({ ok: false });
  try {
    writeAtomic(mineFile(), JSON.stringify(list.filter((x) => x.id !== id)));
    fs.rmSync(path.join(MINE_DIR, hit.file), { force: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, why: e.message }); }
});
app.get("/stickers/:file", guard, (req, res) => {
  const f = req.params.file;
  res.set("Cache-Control", "private, max-age=604800");
  if (STICKER_FILES.has(f)) return res.sendFile(path.join(STICKER_DIR, f));
  if (/^[0-9a-f]{12}\.(png|jpg|webp|gif)$/.test(f) && readMine().some((x) => x.file === f)) return res.sendFile(path.join(MINE_DIR, f));
  res.status(404).end();
});

const memStore = { prefs: {}, avatars: {} };
const onDisk = () => !!LOG_FILE;
const prefsFile = () => path.join(DATA_DIR, "prefs.json");
function writeAtomic(file, data) {
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function readPrefs() {
  if (!onDisk()) return { ...memStore.prefs };
  try { return cleanPrefs(JSON.parse(fs.readFileSync(prefsFile(), "utf8"))); } catch { return {}; }
}
function findAvatar(who) {
  if (!onDisk()) { const a = memStore.avatars[who]; return a ? { ...a } : null; }
  for (const ext of ["jpg", "png", "webp"]) {
    const f = path.join(DATA_DIR, `avatar-${who}.${ext}`);
    try {
      const st = fs.statSync(f);
      return { file: f, ext, ver: Math.floor(st.mtimeMs) };
    } catch {}
  }
  return null;
}
const MIME_OF = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

app.get("/api/prefs", guard, (req, res) => {
  const avatars = {};
  for (const w of AVATAR_WHO) { const a = findAvatar(w); avatars[w] = a ? a.ver : null; }
  res.json({ ok: true, prefs: readPrefs(), avatars, persisted: onDisk() });
});
app.post("/api/prefs", guard, (req, res) => {
  const next = { ...readPrefs(), ...cleanPrefs(req.body && req.body.prefs) };
  try {
    if (onDisk()) writeAtomic(prefsFile(), JSON.stringify(next));
    else memStore.prefs = next;
    res.json({ ok: true, prefs: next, persisted: onDisk() });
  } catch (e) { log("[prefs]", e.message); res.status(500).json({ ok: false, why: "没存上:" + e.message }); }
});

app.get("/api/avatar/:who", guard, (req, res) => {
  const who = req.params.who;
  if (!AVATAR_WHO.includes(who)) return res.status(404).end();
  const a = findAvatar(who);
  if (!a) return res.status(404).end();
  res.set("Cache-Control", "private, max-age=31536000");
  res.type(MIME_OF[a.ext] || a.mime);
  if (a.buf) return res.send(a.buf);
  res.sendFile(a.file);
});
app.post("/api/avatar/:who", guard, (req, res) => {
  const who = req.params.who;
  if (!AVATAR_WHO.includes(who)) return res.status(404).json({ ok: false });
  const r = parseAvatar(req.body && req.body.dataUrl, who === "wall" || who === "cover" ? WALL_MAX_BYTES : undefined);
  if (r.err) return res.status(400).json({ ok: false, why: r.err });
  try {
    if (onDisk()) {
      const f = path.join(DATA_DIR, `avatar-${who}.${r.ext}`);
      writeAtomic(f, r.buf);
      for (const ext of ["jpg", "png", "webp"]) {
        if (ext !== r.ext) { try { fs.unlinkSync(path.join(DATA_DIR, `avatar-${who}.${ext}`)); } catch {} }
      }
    } else {
      memStore.avatars[who] = { buf: r.buf, ext: r.ext, ver: Date.now() };
    }
    const a = findAvatar(who);
    log("[avatar]", who, r.ext, r.buf.length, "B", onDisk() ? "已落盘" : "只在内存(落盘关着)");
    res.json({ ok: true, ver: a && a.ver, persisted: onDisk() });
  } catch (e) { log("[avatar]", e.message); res.status(500).json({ ok: false, why: "没存上:" + e.message }); }
});

app.delete("/api/avatar/:who", guard, (req, res) => {
  const who = req.params.who;
  if (!AVATAR_WHO.includes(who)) return res.status(404).json({ ok: false });
  if (onDisk()) {
    for (const ext of ["jpg", "png", "webp"]) { try { fs.unlinkSync(path.join(DATA_DIR, `avatar-${who}.${ext}`)); } catch {} }
  } else delete memStore.avatars[who];
  log("[avatar]", who, "已恢复默认(她点的)");
  res.json({ ok: true });
});

app.get("/api/messages", guard, (req, res) => {
  const page = msgs.slice({ limit: +(req.query.limit || 400), before: req.query.before || null });

  res.json({ ...page, upto: events.cursor() });
});

app.get("/api/poll", guard, async (req, res) => {
  const since = req.query.since;

  const deadline = Date.now() + 25000;
  for (;;) {
    const r = events.since(since);
    if (r.events.length || Date.now() > deadline) return res.json(r);
    await new Promise((r2) => setTimeout(r2, 25));
    if (res.writableEnded) return;
  }
});

app.get("/api/status", guard, (req, res) => res.json({ busy }));

app.get("/api/model", guard, async (req, res) => {

  const effortDeclared = process.env.THINK_EFFORT || "medium";
  try {
    const r = await fetch(`${SHIM_URL}/health`);
    const d = await r.json();
    const model = d.model || MODEL;

    const menu = (Array.isArray(d.models) ? d.models : [model]).map((m) => switchPlan(m, d));

    const efforts = Array.isArray(d.efforts) ? d.efforts.filter((x) => EFFORT_LEVELS.includes(x)) : null;
    res.json({ model, name: model, effort: typeof d.effort === "string" ? d.effort : effortDeclared,
               effortApplied: typeof d.effortApplied === "string" ? d.effortApplied : null, efforts: efforts && efforts.length ? efforts : null,
               cli: d.cli || null, menu, pending: pendingModel || null, up: r.ok });
  } catch { res.json({ model: MODEL, name: MODEL, effort: effortDeclared, effortApplied: null, efforts: null, menu: [], pending: pendingModel || null, up: false }); }
});

app.post("/api/effort", guard, async (req, res) => {
  const want = String(req.body?.effort || "").trim().toLowerCase();
  if (!EFFORT_LEVELS.includes(want)) return res.status(400).json({ ok: false, why: "档位只能是 " + EFFORT_LEVELS.join(" / ") });
  try {
    const r = await fetch(`${SHIM_URL}/effort`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": SHIM_KEY },
                                                   body: JSON.stringify({ effort: want }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) return res.status(r.status === 404 ? 501 : 502).json({ ok: false, why: r.status === 404 ? "他那边还不认换档(后端没有 /effort)" : (d.error || "他那边没收(HTTP " + r.status + ")") });
    log("[effort] 她点了", want, "(下一句起)");
    res.json({ ok: true, effort: d.effort, effortApplied: d.effortApplied ?? null });
  } catch (e) { res.status(502).json({ ok: false, why: "连不上他那边" }); }
});

let pendingModel = "";
app.post("/api/model/switch", guard, async (req, res) => {
  const want = String(req.body?.model || "");
  try {
    const d = await (await fetch(`${SHIM_URL}/health`)).json();
    const list = Array.isArray(d.models) ? d.models : [];
    if (want === "" || want === d.model) { pendingModel = ""; return res.json({ ok: true, pending: null, current: d.model }); }
    if (!list.includes(want)) return res.status(400).json({ ok: false, why: "菜单里没有这个模型" });
    pendingModel = want;
    log("[model] 她点了换成", want, "(随下一句生效)");
    res.json({ ok: true, pending: want, plan: switchPlan(want, d) });
  } catch (e) { res.status(502).json({ ok: false, why: "问不到 shim:" + (e?.message || e) }); }
});

app.get("/api/quota", guard, async (req, res) => {
  try {
    const d = await (await fetch(`${SHIM_URL}/health`)).json();
    if (d && d.rateLimit) return res.json({ ok: true, ...d.rateLimit });
    res.json({ ok: false, why: "shim 还没接上额度读数" });
  } catch (e) { res.json({ ok: false, why: "问不到 shim" }); }
});

app.get("/api/context", guard, async (req, res) => {

  try {
    const r = await fetch(`${SHIM_URL}/debug`);
    const d = await r.json();
    const used = d?.ctxGuard?.contextTokens ?? d?.contextTokens ?? 0;
    res.json({ used, max: +(process.env.CTX_LIMIT_TOKENS || 167000) });
  } catch { res.json({ used: 0, max: 167000 }); }
});

const CACHE_FILE = DATA_DIR ? path.join(DATA_DIR, "cache.jsonl") : "";
let cacheList = [], cacheSig = "", vitalsAt = 0, vitalsCache = null;
const VITALS_TARGETS = (() => { try { return JSON.parse(process.env.VITALS_TARGETS || "null"); } catch { return null; } })();
try {
  if (CACHE_FILE && fs.existsSync(CACHE_FILE)) {
    cacheList = parseLog(readTail(CACHE_FILE, 4000).lines.join("\n")).list.filter((r) => r && r.at && r.pct != null);
    if (cacheList.length) cacheSig = cacheList[cacheList.length - 1].sig || "";
  }
} catch (e) { log("[vitals] 缓存记录读不回(不影响别的)", e.message); }
let lastDebug = null;
async function vitalsSample() {
  try {
    const r = await fetch(`${SHIM_URL}/debug`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const d = await r.json(); lastDebug = { at: Date.now(), d };
    const sig = usageSig(d && d.lastUsage);
    if (!sig || sig === cacheSig) return;
    const s = cacheSample(d.lastUsage); if (!s) return;
    cacheSig = sig; s.sig = sig;
    cacheList.push(s);
    const cut = Math.floor(Date.now() / 1000) - 2 * 86400;
    while (cacheList.length && cacheList[0].at < cut) cacheList.shift();
    if (CACHE_FILE && LOG_FILE) { try { fs.appendFileSync(CACHE_FILE, JSON.stringify(s) + "\n"); } catch (e) { log("[vitals] 记不上", e.message); } }
  } catch {}
}
setTimeout(vitalsSample, +(process.env.VITALS_FIRST_MS || 10000));
setInterval(vitalsSample, 90000).unref?.();
function svcUrl(sv) {
  return (VITALS_TARGETS && VITALS_TARGETS[sv.key]) || sv.url || (sv.key === "him" && SHIM_URL ? SHIM_URL + "/health" : "");
}
async function askService(sv) {
  const url = svcUrl(sv);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const j = r.ok ? await r.json().catch(() => null) : null;
    return { key: sv.key, name: sv.name, ...judgeService(sv.key, j), ms: Date.now() - t0 };
  } catch { return { key: sv.key, name: sv.name, ...judgeService(sv.key, null), ms: Date.now() - t0 }; }
}
app.get("/api/vitals", guard, async (req, res) => {
  if (!vitalsCache || Date.now() - vitalsAt > 60000) {
    const services = await Promise.all(VITALS_SERVICES.filter(svcUrl).map(askService));
    vitalsCache = services; vitalsAt = Date.now();
  }
  if (!lastDebug || Date.now() - lastDebug.at > 60000) await vitalsSample();
  const d = (lastDebug && lastDebug.d) || {};
  const g = d.ctxGuard || {};
  const e = d.lastApiError && typeof d.lastApiError === "object" ? d.lastApiError : null;
  res.json({
    ok: true, at: Math.floor(vitalsAt / 1000),
    cache: cacheOut(cacheList),
    window: { compactions: g.compactions ?? null, trusted: g.trusted ?? null, pct: d.contextPct ?? null },
    lastErr: e ? { at: e.at || null, kind: String(e.kind || "error").slice(0, 40) } : null,
    services: vitalsCache.map(({ key, name, ok, detail }) => ({ key, name, ok, detail })),
  });
});

const HOST_STATS_FILE = process.env.HOST_STATS_FILE || "/hoststats/history.jsonl";
const hostCache = {};
function hostStatsAt() { try { return Math.floor(fs.statSync(HOST_STATS_FILE).mtimeMs / 1000); } catch { return null; } }
app.get("/api/server", guard, (req, res) => {
  const range = HOST_RANGES[req.query.range] ? String(req.query.range) : "24h";
  const c = hostCache[range];
  if (c && Date.now() - c.t < 30000) return res.json(c.d);
  let d;
  try {
    if (!fs.existsSync(HOST_STATS_FILE)) d = { ok: false, why: "Not set up" };
    else {
      const want = Math.ceil(HOST_RANGES[range] / 60) + 5;
      d = hostSeries(parseLog(readTail(HOST_STATS_FILE, want).lines.join("\n")).list, Math.floor(Date.now() / 1000), range);
    }
  } catch (e) { log("[server] 读不了机器体征", e.message); d = { ok: false, why: "Unreadable" }; }
  hostCache[range] = { t: Date.now(), d };
  res.json(d);
});

app.post("/api/model", guard, (req, res) => res.json({
  ok: false,
  why: "这一版不能从网页换模型或档位——真要换得重启他，窗口会丢",
}));

const AGENT_URL = (process.env.AGENT_URL || "").replace(/\/+$/, "");
const AGENT_KEY = process.env.AGENT_KEY || "";

async function toAgent(method, body) {
  if (!AGENT_URL) return { ok: false, status: 503, data: { msgs: [], reply: "（维护 agent 还没接上来）" } };
  const r = await fetch(`${AGENT_URL}/api/gong`, {
    method,
    headers: { "Content-Type": "application/json", "x-agent-key": AGENT_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),

    signal: AbortSignal.timeout(+(process.env.AGENT_TIMEOUT_MS || 120000)),
  });
  return { ok: r.ok, status: r.status, data: await r.json().catch(() => ({})) };
}

app.get("/api/gong", guard, async (req, res) => {
  try {
    const r = await toAgent("GET");
    res.status(r.ok ? 200 : r.status).json(r.data);
  } catch (e) {
    log("[gong]", e.message);
    res.json({ msgs: [] });
  }
});

app.post("/api/gong", guard, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ reply: "（没有内容）" });
  try {
    const r = await toAgent("POST", { text });
    res.status(r.ok ? 200 : r.status).json(r.data);
  } catch (e) {
    log("[gong]", e.message);
    lastErr = { at: new Date().toISOString(), kind: `agent: ${e.message}` };
    res.json({ reply: "（没送到,再试一次）" });
  }
});

app.get("/api/chats", guard, (req, res) => res.json({ items: [] }));
app.post("/api/chats", guard, (req, res) => res.json({ ok: false, why: "这一版不管窗口列表" }));
app.post("/api/newchat", guard, (req, res) => res.json({ ok: false, why: "换窗口请直接对他说「换窗口」" }));

app.post("/api/stop", guard, (req, res) => {

  if (turnAbort) { try { turnAbort.abort(); } catch {} }
  res.json({ ok: true });
});

app.post("/api/send", guard, async (req, res) => {

  const tag = req.body?.sticker ? String(req.body.sticker) : "";
  let text = String(req.body?.text || "").trim();
  let display = text, images = [];
  if (busy) return res.status(409).json({ ok: false, why: busyWhy() });
  if (tag) {
    const st = stickerImage(tag);
    if (!st) return res.status(400).json({ ok: false, why: "没有这张贴纸" });

    const mine = STICKERS[tag] ? null : readMine().find((x) => x.tag === tag || (x.aka || []).includes(tag));
    const give = stickerForHim(!!STICKERS[tag], STICKERS[tag] ? tag : mine && mine.tag);
    images = give.withImage ? [st] : []; text = give.text; display = `〔贴纸：${tag}〕`;
  } else if (Array.isArray(req.body?.attachments) && req.body.attachments.length) {

    const out = buildOutgoing(text, req.body.attachments, () => crypto.randomBytes(8).toString("hex"));
    if (out.err) return res.status(400).json({ ok: false, why: out.err });
    for (const p of out.photos) {
      try { fs.mkdirSync(PHOTO_DIR, { recursive: true }); writeAtomic(path.join(PHOTO_DIR, `${p.id}.${p.ext}`), p.buf); }
      catch (e) { log("[photo] 没存上(照样交给他,只是网页上回看不到):", e.message); }
    }
    text = out.text; display = out.display; images = out.images;
    log("[photo]", out.photos.length, "张图", out.images.length ? "交给他" : "");
  }
  if (!text) return res.status(400).json({ ok: false, why: "没有内容" });
  res.json({ ok: true });
  takeIn(text, { display, images });
});

const EARS_URL = (process.env.EARS_URL || "").replace(/\/$/, "");
const EARS_TOKEN = process.env.EARS_TOKEN || "";
const EARS_ON = !!(EARS_URL && EARS_TOKEN);
const EARS_TIMEOUT_MS = +(process.env.EARS_TIMEOUT_MS || 60000);
const ELEVEN_KEY = process.env.ELEVEN_API_KEY || "";
const ELEVEN_VOICE = process.env.ELEVEN_VOICE_ID || "";
const VOICE_MODEL = process.env.VOICE_MODEL || "eleven_multilingual_v2";
const VOICE_SPEED = +(process.env.VOICE_SPEED || 0.85);
const VOICE_STABILITY = +(process.env.VOICE_STABILITY || 0.6);
const VOICE_MAX_CHARS = +(process.env.VOICE_MAX_CHARS || 500);
const VOICE_ON = !!(ELEVEN_KEY && ELEVEN_VOICE);
const MEDIA_TIMEOUT_MS = +(process.env.MEDIA_TIMEOUT_MS || 60000);
const ELEVEN_BASE = (process.env.ELEVEN_BASE || "https://api.elevenlabs.io").replace(/\/$/, "");
let FFMPEG = process.env.FFMPEG_PATH || "";
if (!FFMPEG) { try { FFMPEG = (await import("ffmpeg-static")).default || ""; } catch { FFMPEG = ""; } }

if (FFMPEG && !fs.existsSync(FFMPEG)) { log("[ffmpeg] 路径有、文件没有(安装脚本被拦了?看 package.json 的 allowScripts):", FFMPEG); FFMPEG = ""; }
log("[voice]", `他说:${VOICE_ON ? "开" : "关(没配 ELEVEN_*)"} 她说:${EARS_ON ? "开" : "关(没配 EARS_*)"} 转码:${FFMPEG ? "有" : "没有"}`);

const TTS_DIR = path.join(DATA_DIR || os.tmpdir(), DATA_DIR ? "tts" : "dwell-tts");
try { fs.mkdirSync(TTS_DIR, { recursive: true }); } catch {}

let mediaChain = Promise.resolve();
const oneAtATime = (fn) => { const p = mediaChain.then(fn, fn); mediaChain = p.catch(() => {}); return p; };
const run = (bin, args) => new Promise((ok, no) =>
  execFile(bin, args, { timeout: MEDIA_TIMEOUT_MS, maxBuffer: 4 << 20 }, (e, stdout, stderr) => e ? no(new Error((stderr || e.message).slice(0, 300))) : ok({ stdout, stderr })));

const MYVOICE_DIR = path.join(DATA_DIR || os.tmpdir(), DATA_DIR ? "voice" : "dwell-myvoice");

app.get("/api/myvoice/:id", guard, (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[0-9a-f]{16}$/.test(id)) return res.status(404).json({ ok: false });
  const f = path.join(MYVOICE_DIR, id + ".mp3");
  if (!fs.existsSync(f)) return res.status(404).json({ ok: false });
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.type("audio/mpeg").sendFile(f);
});

const PHOTO_DIR = path.join(DATA_DIR || os.tmpdir(), DATA_DIR ? "photos" : "dwell-photos");
app.get("/api/photo/:id", guard, (req, res) => {
  const id = String(req.params.id || "");
  if (!/^[0-9a-f]{16}$/.test(id)) return res.status(404).json({ ok: false });
  for (const ext of ["jpg", "png", "webp", "gif"]) {
    const f = path.join(PHOTO_DIR, `${id}.${ext}`);
    if (fs.existsSync(f)) { res.setHeader("Cache-Control", "private, max-age=31536000, immutable"); return res.type(ext).sendFile(f); }
  }
  res.status(404).json({ ok: false });
});
app.get("/api/caps", guard, (req, res) => res.json({ ok: true, voice: VOICE_ON, ears: EARS_ON && !!FFMPEG, maxChars: VOICE_MAX_CHARS }));

const ttsInflight = new Map();
const ttsPath = (text) => path.join(TTS_DIR, crypto.createHash("sha256").update(`${VOICE_MODEL}|${ELEVEN_VOICE}|${VOICE_SPEED}|${VOICE_STABILITY}|${text}`).digest("hex").slice(0, 32) + ".mp3");
async function ttsFile(text) {
  const file = ttsPath(text);
  if (fs.existsSync(file)) return file;
  if (ttsInflight.has(file)) return ttsInflight.get(file);
  const p = (async () => {
    const r = await fetch(`${ELEVEN_BASE}/v1/text-to-speech/${ELEVEN_VOICE}?output_format=mp3_44100_128`, {
      method: "POST", headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: VOICE_MODEL, voice_settings: { speed: VOICE_SPEED, stability: VOICE_STABILITY } }),
      signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
    fs.renameSync(tmp, file);
    return file;
  })();
  ttsInflight.set(file, p);
  try { return await p; } finally { ttsInflight.delete(file); }
}

app.get("/api/tts", guard, async (req, res) => {
  const text = String(req.query.t || "").trim();
  if (!VOICE_ON) return res.status(503).json({ ok: false, why: "语音还没接上" });
  if (!text || text.length > VOICE_MAX_CHARS) return res.status(400).json({ ok: false, why: "这段太长,只能看字" });
  if (!heSaidVoice(msgs.slice({ limit: 4000 }).msgs, text)) return res.status(404).json({ ok: false, why: "记录里没有这句" });
  try {
    const f = await ttsFile(text);
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.type("audio/mpeg").sendFile(f);
  } catch (e) {
    lastErr = { at: new Date().toISOString(), kind: "tts: " + (e?.message || e) };
    log("[tts]", e?.message || e);
    res.status(502).json({ ok: false, why: "这句没合成出来,看字吧" });
  }
});

async function waveOf(mp3) {
  const jf = mp3.replace(/\.mp3$/, ".wave.json");
  try { return JSON.parse(fs.readFileSync(jf, "utf8")); } catch {}
  if (!FFMPEG || !fs.existsSync(mp3)) return null;
  const pcm = await oneAtATime(() => new Promise((ok, no) =>
    execFile(FFMPEG, ["-v", "error", "-i", mp3, "-ac", "1", "-ar", "4000", "-f", "s16le", "-"],
      { timeout: MEDIA_TIMEOUT_MS, maxBuffer: 16 << 20, encoding: "buffer" }, (e, out, err) => e ? no(new Error(String(err || e.message).slice(0, 300))) : ok(out))));
  const w = pcmEnvelope(pcm, 4000, 64);
  try { fs.writeFileSync(jf, JSON.stringify(w)); } catch {}
  return w;
}
async function prewarmVoice(full) {
  if (!VOICE_ON) return;
  for (const seg of voiceSegments(full)) {
    if (seg.length > VOICE_MAX_CHARS) continue;
    try { await waveOf(await ttsFile(seg)); }
    catch (e) { log("[tts] 提前合成没成(她点播放时会再试):", e?.message || e); }
  }
}
app.get("/api/vwave", guard, async (req, res) => {
  const id = String(req.query.id || ""), text = String(req.query.t || "").trim();
  let mp3 = "";
  if (id) { if (!/^[0-9a-f]{16}$/.test(id)) return res.status(404).json({ ok: false }); mp3 = path.join(MYVOICE_DIR, id + ".mp3"); }
  else {
    if (!VOICE_ON || !text || text.length > VOICE_MAX_CHARS) return res.json({ ok: false });
    if (!heSaidVoice(msgs.slice({ limit: 4000 }).msgs, text)) return res.status(404).json({ ok: false });
    mp3 = ttsPath(text);
  }
  if (!fs.existsSync(mp3)) return res.json({ ok: false, why: "还没合成" });
  try { const w = await waveOf(mp3); res.setHeader("Cache-Control", "private, max-age=31536000, immutable"); res.json(w ? { ok: true, ...w } : { ok: false }); }
  catch (e) { log("[vwave]", e?.message || e); res.json({ ok: false }); }
});

app.post("/api/voice", guard, express.raw({ type: () => true, limit: "15mb" }), async (req, res) => {
  if (!EARS_ON || !FFMPEG) return res.status(503).json({ ok: false, why: "语音这边还没接上,先打字告诉他吧" });
  if (busy) return res.status(409).json({ ok: false, why: busyWhy() });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length < 1000) return res.status(400).json({ ok: false, why: "太短了,没录上" });
  try {

    const id = crypto.randomBytes(8).toString("hex");
    const ogg = await oneAtATime(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dwell-voice-"));
      try {
        const src = path.join(dir, "in"), out = path.join(dir, "voice.ogg"), mp3 = path.join(dir, "voice.mp3");
        fs.writeFileSync(src, buf);
        await run(FFMPEG, ["-y", "-loglevel", "error", "-i", src,
          "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "32k", out,
          "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", mp3]);
        try { fs.mkdirSync(MYVOICE_DIR, { recursive: true }); fs.copyFileSync(mp3, path.join(MYVOICE_DIR, id + ".mp3")); }
        catch (e) { log("[voice] 回放那份没存上(不影响发出去):", e.message); }
        return fs.readFileSync(out);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
    const form = new FormData();
    form.append("file", new Blob([ogg]), "voice.ogg");
    const r = await fetch(`${EARS_URL}/api/listen`, {
      method: "POST", headers: { "x-token": EARS_TOKEN }, body: form, signal: AbortSignal.timeout(EARS_TIMEOUT_MS),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `ears HTTP ${r.status}`);
    const line = formatEarsResult(d);
    if (!line) return res.status(422).json({ ok: false, why: "没听清,再说一遍?" });
    if (busy) return res.status(409).json({ ok: false, why: busyWhy() });
    const said = String(d.text || "").trim();
    res.json({ ok: true, said });
    const dur = Math.max(0, Math.min(600, Math.round(+req.query.dur || 0)));
    const meta = fs.existsSync(path.join(MYVOICE_DIR, id + ".mp3")) ? { voice: id, dur } : null;
    takeIn(line, { display: `〔语音〕${said}`, meta });
  } catch (e) {
    lastErr = { at: new Date().toISOString(), kind: "ears: " + (e?.message || e) };
    log("[voice]", e?.message || e);
    res.status(502).json({ ok: false, why: "语音没传过去,打字告诉他吧" });
  }
});

const reactFile = () => path.join(DATA_DIR, "reactions.json");
function readReacts() { if (!onDisk()) return memStore.reacts || []; try { return JSON.parse(fs.readFileSync(reactFile(), "utf8")) || []; } catch { return []; } }
function writeReacts(list) { if (!onDisk()) { memStore.reacts = list; return; } writeAtomic(reactFile(), JSON.stringify(list)); }
app.get("/api/reactions", guard, (req, res) => res.json({ ok: true, items: readReacts() }));
app.post("/api/react", guard, (req, res) => {
  const r = cleanReactInput(req.body);
  if (!r) return res.status(400).json({ ok: false });
  try { writeReacts(setReaction(readReacts(), { ...r, by: "me" })); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, why: e.message }); }
});

app.post("/api/hide", guard, (req, res) => {
  const b = req.body || {};
  const kind = b.kind === "me" || b.kind === "gu" ? b.kind : "";
  let m = b.seq != null ? msgs.find(b.seq) : null;
  if (m && kind && m.kind !== kind) m = null;
  if (!m && kind && typeof b.text === "string" && b.text) m = msgs.findLast(kind, b.text);
  if (!m || (m.kind !== "me" && m.kind !== "gu")) return res.status(404).json({ ok: false, error: "找不到这条" });
  const part = Number.isInteger(b.part) && b.part >= 0 ? b.part : -1;
  msgs.addHide(m, part, typeof b.ptext === "string" ? b.ptext : ""); persist(msgs.last());
  log("[hide]", m.kind, part < 0 ? "整条" : `第 ${part} 颗`, "(她在网页上删的;存档留着原话)");
  res.json({ ok: true, seq: m.seq, part });
});

app.get("/api/search", guard, (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 50);
  res.json({ ok: true, q, items: q ? searchMsgs(msgs.slice({ limit: MSG_CAP }).msgs, q) : [] });
});

const DEBOUNCE_MS = Math.max(0, Number(process.env.DEBOUNCE_MS ?? 6000) || 0);
let pending = [];
let pendTimer = null;
const turnQueue = [];
function takeIn(text, { display = text, images = [], meta = null } = {}) {
  msgs.addMe(display, meta); persist(msgs.last());
  events.push({ ...evEcho(display), ...(meta || {}) });
  const item = { text, images, mine: msgs.last() };
  if (!images.length && detectReset(text)) { flushPending(); turnQueue.push(mergeTurn([item])); return pump(); }
  pending.push(item);
  clearTimeout(pendTimer);
  if (DEBOUNCE_MS > 0) pendTimer = setTimeout(flushPending, DEBOUNCE_MS); else flushPending();
}
function flushPending() {
  clearTimeout(pendTimer); pendTimer = null;
  if (!pending.length) return;
  if (pending.length > 1) log("[merge]", pending.length, "句拼成一轮");
  turnQueue.push(mergeTurn(pending)); pending = [];
  pump();
}
function pump() {
  if (busy || !turnQueue.length) return;
  runTurn(turnQueue.shift()).catch((e) => { busy = false; log("[turn]", e?.message || e); pump(); });
}

async function runTurn({ text, images = [], mine }) {
  busy = true;

  const model = pendingModel; pendingModel = "";
  if (model) log("[model] 这一句带上", model);

  const strip = makeStripper();
  const sse = makeSSEParser();
  let full = "";
  let think = "";
  let toolN = 0;
  let errText = "";

  const ac = new AbortController();
  turnAbort = ac;
  const timer = setTimeout(() => ac.abort(), TURN_TIMEOUT_MS);

  const toolLines = makeToolLines();
  const tools = [];
  let awaitingArgs = null;
  const showTool = (t) => { if (t.shown) return; t.shown = true; events.push(evToolUseWith(t.name, t.id, t.input)); };
  const flushArgs = () => { if (awaitingArgs) { showTool(awaitingArgs); awaitingArgs = null; } };
  const finishTool = (t, text, err) => {
    if (t.done) return;
    t.done = true; showTool(t);
    events.push(evToolDone(t.id, text, err));
    msgs.addTool(t.name, JSON.stringify(t.input || {}), { result: String(text || ""), err: !!err }); persist(msgs.last());
  };
  const onThink = (text) => {
    for (const q of toolLines.push(text)) {
      if (q.kind === "args" && awaitingArgs) {
        let input; try { input = JSON.parse(q.text); } catch { input = { 参数: q.text }; }
        awaitingArgs.input = input && typeof input === "object" ? input : { 参数: q.text };
        flushArgs();
      } else if (q.kind === "result" && tools.some((t) => !t.done)) {
        flushArgs();
        finishTool(tools.find((t) => !t.done), q.text, q.err);
      } else {
        const t = q.kind === "think" ? q.text : (q.kind === "args" ? "  → " : q.err ? "  ←✗ " : "  ← ") + q.text + (q.kind === "think" ? "" : "\n");
        if (t.trim()) flushArgs();
        think += t; events.push(evThink(t));
      }
    }
  };

  const emit = (parts) => {
    for (const p of parts) {
      if (p.kind === "react") {
        const k = bubbleKey("me", mine.text, 0);
        try { writeReacts(setReaction(readReacts(), { k, at: mine.at, e: p.emoji, by: "him" })); } catch (e) { log("[react]", e.message); }
        events.push({ type: "react", k, at: mine.at, e: p.emoji, by: "him" });
        continue;
      }
      if (p.kind === "check") { log("[check] 他写了 [查岗](这扇门没接手机活动记录,只剥掉)"); continue; }
      if (p.kind === "tool") {
        flushArgs();
        const t = { id: `t${Date.now()}-${++toolN}`, name: p.name, input: {}, shown: false, done: false };
        tools.push(t); awaitingArgs = t;
      } else if (p.text) {
        if (p.text.trim()) flushArgs();
        full += p.text;
        events.push(evText(p.text));
      }
    }
  };

  try {
    const r = await fetch(`${SHIM_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": SHIM_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(buildShimBody(text, { images, model })),
      signal: ac.signal,
    });

    if (!r.ok) {
      errText = `上游 ${r.status}`;
      lastErr = { at: new Date().toISOString(), kind: errText };
      log("[shim]", errText);
    } else {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const f of sse.push(dec.decode(value, { stream: true }))) {
          const d = f.data || {};
          if (d.type === "content_block_delta") {
            const delta = d.delta || {};
            if (delta.type === "text_delta" && delta.text) emit(strip.push(delta.text));
            else if (delta.type === "thinking_delta") {

              for (const p of strip.push(delta.thinking || delta.text || "")) {
                if (p.kind === "tool") { emit([p]); }
                else if (p.text) onThink(p.text);
              }
            }
          } else if (d.type === "error") {
            errText = d.error?.message || "上游报错";
            lastErr = { at: new Date().toISOString(), kind: errText };
          }
        }
      }
      emit(strip.flush());
    }
  } catch (e) {
    errText = e?.name === "AbortError" ? "" : (e?.message || "没连上");
    if (errText) lastErr = { at: new Date().toISOString(), kind: errText };
    log("[turn]", e?.name === "AbortError" ? "被叫停" : errText);
  } finally {
    clearTimeout(timer);
    turnAbort = null;
  }

  for (const q of toolLines.flush()) if (q.kind === "think") { think += q.text; events.push(evThink(q.text)); }
  flushArgs();
  for (const t of tools) finishTool(t, "", false);
  if (think.trim()) { msgs.addThink(think.trim()); persist(msgs.last()); }
  if (full.trim()) { msgs.addGu(full.trim()); persist(msgs.last()); events.push(evFinal(full.trim())); prewarmVoice(full.trim()).catch(() => {}); }
  events.push(evResult(!!errText, errText));
  busy = false;
  log("[turn] 完", { 字数: full.length, 思考: think.length, 工具: toolN, 错: errText || "-" });
  setTimeout(vitalsSample, 1500);
  pump();
}

app.listen(PORT, () => log(`dwell-bridge 起来了 :${PORT} → ${SHIM_URL}${DWELL_PASS ? "" : "（⚠️ 没上锁）"}`));
