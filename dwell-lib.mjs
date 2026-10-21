
export function makeSSEParser() {
  let buf = "";
  return {

    push(chunk) {
      buf += chunk;
      const frames = [];
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let ev = "", data = "";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { continue; }
        frames.push({ event: ev || parsed.type || "", data: parsed });
      }
      return frames;
    },
    pending() { return buf; },
  };
}

const OPENS = ["〔🔧", "[贴纸", "【贴纸", "[语音", "【语音", "[/语音", "【/语音", "[回应", "【回应", "[查岗", "【查岗"];
const STICKER_RE = /[\[【]\s*贴纸\s*[:：]\s*([^\]】\n]+?)\s*[\]】]/;
const REACT_RE = /[\[【]\s*回应\s*[:：]\s*([^\]】\n]*?)\s*[\]】]/;
const CHECK_RE = /[\[【]\s*查岗\s*[\]】]/;
const VOICE_OPEN_RE = /[\[【]\s*语音\s*[\]】]/;
const VOICE_CLOSE_RE = /[\[【]\s*\/\s*语音\s*[\]】]/;

function holdFrom(buf) {
  let best = -1;
  for (const open of OPENS) {
    const at = buf.lastIndexOf(open);
    if (at >= 0 && !/[\]】〕\n]/.test(buf.slice(at + open.length)) && (best < 0 || at < best)) best = at;
  }
  if (best >= 0) return best;

  for (let n = Math.min(buf.length, 8); n > 0; n--) {
    const tail = buf.slice(-n);
    if (OPENS.some((o) => o.length > n && o.startsWith(tail))) return buf.length - n;
  }
  return -1;
}

export const VOICE_END = "\u2063";

export function makeStripper() {
  let buf = "";
  let inVoice = false;

  function nextMarker() {
    let best = null;
    const take = (at, len, parts) => { if (at >= 0 && (!best || at < best.at)) best = { at, len, parts }; };
    const t = buf.indexOf("〔🔧");
    if (t >= 0) { const e = buf.indexOf("〕", t); if (e >= 0) take(t, e + 1 - t, [{ kind: "tool", name: buf.slice(t + "〔🔧".length, e).trim() }]); }
    let m;
    if ((m = STICKER_RE.exec(buf))) take(m.index, m[0].length, [{ kind: "text", text: `〔贴纸：${m[1].trim()}〕` }]);

    if ((m = REACT_RE.exec(buf))) take(m.index, m[0].length, m[1].trim() ? [{ kind: "react", emoji: m[1].trim() }] : []);

    if ((m = CHECK_RE.exec(buf))) take(m.index, m[0].length, [{ kind: "check" }]);

    if ((m = VOICE_OPEN_RE.exec(buf))) take(m.index, m[0].length, [{ kind: "text", text: "〔语音〕" }, { kind: "voice", on: true }]);

    if ((m = VOICE_CLOSE_RE.exec(buf))) take(m.index, m[0].length, [{ kind: "text", text: VOICE_END }, { kind: "voice", on: false }]);
    return best;
  }

  function drain(out, final) {
    for (;;) {
      const mk = nextMarker();
      if (!mk) break;
      if (mk.at > 0) out.push({ kind: "text", text: buf.slice(0, mk.at) });
      for (const p of mk.parts) { if (p.kind === "voice") inVoice = p.on; else out.push(p); }
      buf = buf.slice(mk.at + mk.len);
    }
    if (final) {
      if (buf) out.push({ kind: "text", text: buf });
      buf = "";
      return;
    }
    const h = holdFrom(buf);
    if (h < 0) { if (buf) out.push({ kind: "text", text: buf }); buf = ""; }
    else if (h > 0) { out.push({ kind: "text", text: buf.slice(0, h) }); buf = buf.slice(h); }
  }

  return {
    push(text) { const out = []; buf += text; drain(out, false); return out; },
    flush() { const out = []; drain(out, true); inVoice = false; return out; },
    inVoice() { return inVoice; },
  };
}

export const evEcho = (text) => ({ type: "echo", text });

export const evText = (text) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});

export const evThink = (thinking) => ({
  type: "stream_event",
  event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking } },
});

export const evToolUse = (name, id) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input: {}, id }] },
});

export const evToolDone = (id, content = "", isError = false) => ({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: id, is_error: !!isError, content: String(content || "") }] },
});

export const evToolUseWith = (name, id, input) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name, input: input && typeof input === "object" ? input : {}, id }] },
});

const ARGS_RE = /^ {2}→ (.*)$/;
const RES_RE = /^ {2}←(✗?) (.*)$/;
export function makeToolLines() {
  let buf = "";
  let atStart = true;
  const classify = (line) => {
    let m = ARGS_RE.exec(line);
    if (m) return { kind: "args", text: m[1] };
    m = RES_RE.exec(line);
    if (m) return { kind: "result", text: m[2], err: !!m[1] };
    return null;
  };
  const maybe = (s) => /^ {0,2}$/.test(s) || /^ {2}[→←]/.test(s);
  function push(text, final = false) {
    const out = [];
    let data = buf + String(text || "");
    buf = "";
    const think = (t) => { if (!t) return; const last = out[out.length - 1]; if (last && last.kind === "think") last.text += t; else out.push({ kind: "think", text: t }); atStart = t.endsWith("\n"); };
    while (data) {
      const nl = data.indexOf("\n");
      if (nl < 0) {
        if (atStart && maybe(data) && !final) { buf = data; break; }
        const c = atStart && final ? classify(data) : null;
        if (c) { out.push(c); atStart = true; } else think(data);
        break;
      }
      const line = data.slice(0, nl);
      const c = atStart ? classify(line) : null;
      if (c) { out.push(c); atStart = true; } else think(line + "\n");
      data = data.slice(nl + 1);
    }
    return out;
  }
  return { push, flush: () => push("", true) };
}

export const evFinal = (text) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

export const evResult = (isError, result) => ({
  type: "result",
  is_error: !!isError,
  ...(isError ? { result: result || "" } : {}),
});

export function makeEventLog({ cap = 3000, ver = "1" } = {}) {
  let seq = 0;
  let items = [];
  return {
    push(ev) {
      items.push({ seq: ++seq, ev });
      if (items.length > cap) items = items.slice(-cap);
      return seq;
    },
    since(cursor) {
      const c = Number(cursor) || 0;

      const list = items.filter((x) => x.seq > c);
      return { ver, next: seq, events: list.map((x) => x.ev) };
    },
    cursor() { return seq; },
  };
}

export function hideKey(m) {
  let h = 0x811c9dc5;
  const t = String(m && m.text || "");
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${m && m.kind}|${(m && m.at) || 0}|${h.toString(36)}`;
}

export function makeMsgLog({ cap = 4000 } = {}) {
  let seq = 0;
  let items = [];
  const add = (kind, text, extra, more) => {
    items.push({ seq: ++seq, kind, text, at: Math.floor(Date.now() / 1000), ...(extra ? { extra } : {}), ...(more || {}) });
    if (items.length > cap) items = items.slice(-cap);
    return seq;
  };
  return {
    addMe: (t, more = null) => add("me", t, undefined, more),
    addGu: (t) => add("gu", t),
    addThink: (t) => add("think", t),
    addTool: (name, extra = "{}", more = null) => add("tool", name, extra, more),

    addHide: (target, part = -1, ptext = "") => add("hide", "", undefined,
      { key: hideKey(target), part: Number.isInteger(part) && part >= 0 ? part : -1, ...(part >= 0 && ptext ? { ptext: String(ptext).slice(0, 2000) } : {}) }),
    find(seqN) { const n = Number(seqN); return items.find((m) => m.seq === n) || null; },
    findLast(kind, text) { for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === kind && items[i].text === text) return items[i]; return null; },

    slice({ limit = 400, before = null } = {}) {

      const hid = new Map();
      for (const m of items) if (m.kind === "hide" && m.key) {
        const e = hid.get(m.key) || { all: false, parts: [], texts: [] };
        if (m.part === -1 || m.part == null) e.all = true; else { e.parts.push(m.part); if (m.ptext) e.texts.push(m.ptext); }
        hid.set(m.key, e);
      }
      const shown = [];
      for (const m of items) {
        if (m.kind === "hide") continue;
        if (!hid.size) { shown.push(m); continue; }
        const e = hid.get(hideKey(m));
        if (!e) shown.push(m);
        else if (!e.all) shown.push({ ...m, hide: [...new Set(e.parts)].sort((a, b) => a - b), hideText: e.texts });
      }
      const pool = before ? shown.filter((m) => m.seq < Number(before)) : shown;
      const page = pool.slice(-limit);
      return {
        msgs: page,
        upto: items.length ? items[items.length - 1].seq : 0,
        more: pool.length > page.length,
      };
    },

    restore(list) {
      for (const m of list || []) {
        if (!m || !m.kind || typeof m.text !== "string") continue;
        items.push({ seq: ++seq, kind: m.kind, text: m.text, at: m.at || 0, ...(m.extra ? { extra: m.extra } : {}),
          ...(typeof m.result === "string" ? { result: m.result, err: !!m.err } : {}),
          ...(typeof m.voice === "string" ? { voice: m.voice, dur: +m.dur || 0 } : {}),
          ...(m.kind === "hide" && typeof m.key === "string" ? { key: m.key, part: Number.isInteger(m.part) ? m.part : -1, ...(m.ptext ? { ptext: String(m.ptext) } : {}) } : {}) });
      }
      if (items.length > cap) items = items.slice(-cap);
      return items.length;
    },
    last() { return items.length ? items[items.length - 1] : null; },
    count() { return items.length; },
  };
}

export function safeEqual(a, b) {
  const x = String(a ?? ""), y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export function makeToken(pass, salt) {

  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = `${salt}|${pass}|${salt}`;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i) * (i + 7), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).padStart(12, "0");
}

export function parseLog(text) {
  const list = [];
  let bad = 0;
  for (const ln of String(text || "").split("\n")) {
    if (!ln) continue;
    try { const m = JSON.parse(ln); if (m) list.push(m); else bad++; }
    catch { bad++; }
  }
  return { list, bad };
}

export function tailLines(chunk, { cap = 4000, fromStart = false } = {}) {
  const s = String(chunk || "");
  let lines = s.split("\n").filter(Boolean);

  if (!fromStart && s[0] !== "\n" && lines.length) lines = lines.slice(1);
  return { lines: lines.slice(-cap), enough: lines.length >= cap };
}

export function verFrom(...parts) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const s = parts.join(" ");
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + s.charCodeAt(i) * (i + 7), 0x85ebca6b) >>> 0;
  }
  return (h1.toString(36) + h2.toString(36)).slice(0, 10);
}

export function memFrom({ rss = 0, meminfo = "" } = {}) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(meminfo));
  const n = Number(rss);
  return {
    self: Number.isFinite(n) && n > 0 ? Math.round((n / 1048576) * 10) / 10 : null,
    avail: m ? Math.round(+m[1] / 1024) : null,
  };
}

export function buildShimBody(text, { images = [], model = "" } = {}) {
  const content = images.length
    ? [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
       { type: "text", text }]
    : text;
  const body = { max_tokens: 4096, stream: true, messages: [{ role: "user", content }] };
  if (model) body.model = model;
  return body;
}

export function engineOf(model, nextModels = []) {
  return typeof model === "string" && (model.endsWith("-next") || nextModels.includes(model)) ? "next" : "main";
}
export function switchPlan(target, h = {}) {
  const next = Array.isArray(h.nextModels) ? h.nextModels : [];
  const same = target === h.model;
  const keepsWindow = same || (h.cli === "next" && h.cliNext === "ready" && engineOf(target, next) === "next");
  return { model: target, engine: engineOf(target, next), current: same, keepsWindow };
}

export const AVATAR_WHO = ["me", "him", "wall", "cover"];

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh"];
export const AVATAR_MAX_BYTES = 400 * 1024;
export const WALL_MAX_BYTES = 1536 * 1024;
const AVATAR_MIME = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function parseAvatar(dataUrl, maxBytes = AVATAR_MAX_BYTES) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!m) return { err: "只收 JPEG / PNG / WebP 图片" };
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!buf.length) return { err: "图片是空的" };
  if (buf.length > maxBytes) return { err: `图片太大(${Math.round(buf.length / 1024)}KB),上限 ${Math.round(maxBytes / 1024)}KB` };

  const sig = buf.subarray(0, 12);
  const real = sig[0] === 0xff && sig[1] === 0xd8 ? "image/jpeg"
    : sig.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
    : sig.subarray(0, 4).toString("latin1") === "RIFF" && sig.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp"
    : null;
  if (real !== m[1]) return { err: "图片内容和类型对不上" };
  return { mime: m[1], ext: AVATAR_MIME[m[1]], buf };
}

export const PREF_SPEC = {
  chatStyle: ["official", "tg", "imsg"],
  avatarMode: ["top", "each"],

  chatFont: ["13.5", "14.5", "15.5", "16.5", "17.5"],

  voiceText: ["show", "fold"],
};

export const PREF_COLORS = ["meBubble", "himBubble"];
export function cleanPrefs(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, allowed] of Object.entries(PREF_SPEC)) {
    if (allowed.includes(obj[k])) out[k] = obj[k];
  }
  for (const k of PREF_COLORS) {
    if (obj[k] === "" || (typeof obj[k] === "string" && /^#[0-9a-fA-F]{6}$/.test(obj[k]))) out[k] = obj[k].toLowerCase();
  }

  if (typeof obj.himName === "string") {
    out.himName = Array.from(obj.himName.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim()).slice(0, 16).join("");
  }
  return out;
}

export function formatEarsResult(d) {
  const said = ((d || {}).text || "").trim();
  if (!said) return null;
  const parts = [];
  if (d.emotion) parts.push(`语气：${d.emotion}`);
  if (d.hint) parts.push(String(d.hint).trim());
  const rel = d.relative && Object.keys(d.relative).length
    ? "和平时比" + Object.entries(d.relative).map(([k, v]) => k + v).join("、") : "";
  if (rel) parts.push(rel);
  if (!parts.length) parts.push("语气分析还在认识她的声音");
  return `[语音] ${said}（${parts.join("，")}）`;
}

const VOICE_SEG_RE = /〔语音〕([^\u2063\n]*)/g;
export function voiceSegments(text) {
  const out = [];
  let m;
  VOICE_SEG_RE.lastIndex = 0;
  while ((m = VOICE_SEG_RE.exec(String(text || ""))) !== null) {
    const v = m[1].trim();
    if (v) out.push(v);
  }
  return out;
}
export function heSaidVoice(list, text) {
  const want = String(text || "").trim();
  if (!want) return false;
  for (let i = (list || []).length - 1; i >= 0; i--) {
    const m = list[i];
    if (m && m.kind === "gu" && voiceSegments(m.text).includes(want)) return true;
  }
  return false;
}

export function pcmEnvelope(buf, rate, n = 64) {
  const count = Math.floor((buf?.length || 0) / 2);
  const dur = rate > 0 ? Math.round((count / rate) * 100) / 100 : 0;
  const p = new Array(n).fill(0);
  if (!count) return { dur, p };
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * count) / n), b = Math.max(a + 1, Math.floor(((i + 1) * count) / n));
    let sum = 0;
    for (let j = a; j < b && j < count; j++) { const v = buf.readInt16LE(j * 2) / 32768; sum += v * v; }
    p[i] = Math.sqrt(sum / (b - a));
  }
  const max = Math.max(...p);
  return { dur, p: p.map((v) => (max > 0 ? Math.round((v / max) * 1000) / 1000 : 0)) };
}

export function textHash(t) {
  let h = 2166136261;
  const s = String(t || "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
export const bubbleKey = (kind, raw, idx = 0) => `${kind}:${textHash(raw)}:${idx}`;

export function setReaction(list, { k, at, e, by }) {
  const out = (list || []).filter((r) => !(r.k === k && r.by === by && Math.abs((r.at || 0) - (at || 0)) <= 300));
  if (e) out.push({ k, at: at || 0, e: String(e).slice(0, 16), by });
  return out;
}
export function cleanReactInput(b) {
  const k = String(b?.k || "");
  if (!/^(me|gu):[0-9a-z]{1,8}:\d{1,3}$/.test(k)) return null;
  const at = Math.floor(+b?.at || 0);
  const e = String(b?.e || "").trim();
  if (e && (e.length > 16 || /[<>"'&\\]/.test(e))) return null;
  return { k, at, e };
}

export function searchMsgs(list, q, limit = 60) {
  const want = String(q || "").trim().toLowerCase();
  if (!want) return [];
  const out = [];
  for (let i = (list || []).length - 1; i >= 0 && out.length < limit; i--) {
    const m = list[i];
    if (!m || (m.kind !== "me" && m.kind !== "gu")) continue;
    let text = String(m.text || "").replace(/\u2063/g, "");
    for (const t of m.hideText || []) if (t) text = text.split(t).join("");
    const at = text.toLowerCase().indexOf(want);
    if (at < 0) continue;
    const from = Math.max(0, at - 24), to = Math.min(text.length, at + want.length + 48);
    out.push({ seq: m.seq, kind: m.kind, at: m.at, text: (from > 0 ? "…" : "") + text.slice(from, to) + (to < text.length ? "…" : "") });
  }
  return out;
}

export const STICKER_MAX_BYTES = 1.5 * 1048576;
export function parseStickerImage(dataUrl) { return parseImageDataUrl(dataUrl, STICKER_MAX_BYTES); }

export function parseImageDataUrl(dataUrl, maxBytes) {
  const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ""));
  if (!m) return { err: "只收 PNG / JPEG / WebP / GIF" };
  const buf = Buffer.from(m[2].replace(/\s+/g, ""), "base64");
  if (!buf.length) return { err: "图片是空的" };
  if (buf.length > maxBytes) return { err: `太大了(${Math.round(buf.length / 1024)}KB),上限 ${(maxBytes / 1048576).toFixed(1).replace(/\.0$/, "")}MB` };
  const sig = buf.subarray(0, 12);
  const real = sig[0] === 0xff && sig[1] === 0xd8 ? "image/jpeg"
    : sig.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
    : sig.subarray(0, 4).toString("latin1") === "RIFF" && sig.subarray(8, 12).toString("latin1") === "WEBP" ? "image/webp"
    : sig.subarray(0, 4).toString("latin1") === "GIF8" ? "image/gif"
    : null;
  if (real !== m[1]) return { err: "图片内容和类型对不上" };
  return { mime: m[1], ext: { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[m[1]], buf };
}

export const PHOTO_MAX_BYTES = 4 * 1024 * 1024;
export const PHOTO_MAX_COUNT = 4;
const FILE_TEXT_MAX = 200 * 1024;
export function buildOutgoing(text, attachments, newId = () => "") {
  text = String(text || "").trim();
  const list = Array.isArray(attachments) ? attachments : [];
  const photos = [], files = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    if (a.kind === "image") {
      if (photos.length >= PHOTO_MAX_COUNT) return { err: `一次最多 ${PHOTO_MAX_COUNT} 张图` };
      const r = parseImageDataUrl(`data:${a.media_type};base64,${a.data}`, PHOTO_MAX_BYTES);
      if (r.err) return { err: r.err };
      photos.push({ ...r, id: newId() });
    } else if (a.kind === "text") {
      const name = String(a.name || "文件").replace(/[\u0000-\u001f〔〕]/g, "").slice(0, 80) || "文件";
      const body = String(a.text || "");
      if (body.length > FILE_TEXT_MAX) return { err: `「${name}」太大了,上限 200KB` };
      files.push({ name, body });
    }
  }
  if (!text && !photos.length && !files.length) return { err: "没有内容" };
  const marks = photos.map((p) => `〔图片：${p.id || "?"}〕`).concat(files.map((f) => `〔文件：${f.name}〕`));
  const display = [...marks, text].filter(Boolean).join("\n");
  let forHim = text || (photos.length ? (photos.length > 1 ? `(她发来${photos.length}张图片)` : "(她发来一张图片)") : "");
  for (const f of files) forHim += `${forHim ? "\n\n" : ""}〔文件：${f.name}〕\n${f.body}`;
  return { text: forHim, display, images: photos.map((p) => ({ mime: p.mime, data: p.buf.toString("base64") })), photos };
}

const WX_ZH = {
  113: "晴", 116: "多云", 119: "阴", 122: "阴天", 143: "薄雾",
  176: "零星小雨", 179: "零星小雪", 182: "雨夹雪", 185: "冻毛毛雨",
  200: "雷阵雨", 227: "吹雪", 230: "暴风雪", 248: "雾", 260: "冻雾",
  263: "毛毛雨", 266: "毛毛雨", 281: "冻毛毛雨", 284: "强冻毛毛雨",
  293: "零星小雨", 296: "小雨", 299: "阵雨", 302: "中雨", 305: "强阵雨",
  308: "大雨", 311: "冻雨", 314: "强冻雨", 317: "小雨夹雪", 320: "中雨夹雪",
  323: "小阵雪", 326: "小阵雪", 329: "中雪", 332: "中雪", 335: "大阵雪",
  338: "大雪", 350: "冰粒", 353: "小阵雨", 356: "中到大阵雨", 359: "暴雨",
  362: "小雨夹雪", 365: "中雨夹雪", 368: "小阵雪", 371: "大阵雪",
  374: "小冰雹", 377: "冰雹", 386: "雷阵雨", 389: "强雷阵雨",
  392: "雷雪", 395: "强雷雪",
};
function wxNum(v, dflt = null) { const n = parseInt(String(v), 10); return Number.isFinite(n) ? n : dflt; }
function wxDesc(o) {
  const code = wxNum(o?.weatherCode);
  if (code != null && WX_ZH[code]) return WX_ZH[code];
  return ((o?.weatherDesc || [])[0]?.value || "").trim() || "未知";
}
function wxRainy(desc) { return /雨|雷|雹/.test(desc) || /rain|drizzle|shower|storm|sleet|thunder/i.test(desc); }
function wxDay(dayObj) {
  const hourly = dayObj?.hourly || [];
  const mid = hourly[4] || hourly[Math.floor(hourly.length / 2)] || hourly[0] || {};
  let rain = 0;
  for (const h of hourly) rain = Math.max(rain, wxNum(h?.chanceofrain, 0) ?? 0);
  return { desc: wxDesc(mid), rain, min: wxNum(dayObj?.mintempC), max: wxNum(dayObj?.maxtempC) };
}

export function weatherCard(data) {
  const cur = (data?.current_condition || [])[0];
  const days = data?.weather || [];
  if (!cur || !days.length) return null;
  const today = wxDay(days[0]), desc = wxDesc(cur);
  return {
    desc, temp: wxNum(cur.temp_C), min: today.min, max: today.max, rain: today.rain,
    umbrella: today.rain >= 40 || wxRainy(desc) || wxRainy(today.desc),
  };
}
export const WX_ZH_TABLE = WX_ZH;

export const SONG_PROMPT =
  "(系统:每日一首。这不是她在说话,她也不会看到这一句。)\n" +
  "给她挑今天的一首歌,会放在她网页首页那张卡片上。用网易云工具挑:可以看她最近在听什么、红心、每日推荐,也可以按这两天你们聊的事。工具最多查两样就够了。\n" +
  "挑好之后只回一行,照这个格式,别的都不用说:\n" +
  "[今日歌:歌曲ID|歌名|歌手] 写给她的一句话(中文,三十字以内,别解释怎么挑的)";

export function songDay(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

export function parseSongReply(text) {
  const m = /\[今日歌\s*[:：]\s*(\d{3,15})\s*(?:[|｜]\s*([^|｜\]]*?)\s*)?(?:[|｜]\s*([^\]]*?)\s*)?\]\s*([^\n]*)/.exec(String(text || ""));
  if (!m) return null;
  const clip = (s, n) => String(s || "").replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").replace(/\s+/g, " ").trim().slice(0, n);
  const note = clip(m[4].replace(/\[[^\]]*\]/g, ""), 80);
  return { id: m[1], name: clip(m[2], 60), artist: clip(m[3], 60), note };
}

export function songFromDetail(j) {
  const s = (j?.songs || [])[0];
  if (!s || !s.name) return null;
  const cover = String(s.album?.picUrl || "").replace(/^http:/, "https:");
  return { name: String(s.name), artist: (s.artists || []).map((a) => a?.name).filter(Boolean).join(" / "),
           cover: /^https:\/\/[a-z0-9.-]+\.music\.126\.net\//.test(cover) ? cover : "" };
}

export function songOut(rec, today) {
  if (!rec) return { ok: false };
  return { ok: true, today: rec.day === today, day: rec.day, id: rec.id, name: rec.name, artist: rec.artist, cover: rec.cover || "",
           note: rec.note || "", app: `orpheus://song/${rec.id}`, web: `https://music.163.com/song?id=${rec.id}` };
}

export function periodMark(cfg, what, todayISO) {
  const c = cfg || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayISO || "")) return { err: "日期不对" };
  if (what === "start") {
    if (c.last_period_start === todayISO && !c.last_period_end) return { err: "今天已经记过了" };
    return { patch: { last_period_start: todayISO, last_period_end: null } };
  }
  if (what === "end") {
    if (!c.last_period_start) return { err: "还没记过开始" };
    if (c.last_period_end && c.last_period_end >= c.last_period_start) return { err: "这次已经记过结束了" };
    if (todayISO < c.last_period_start) return { err: "结束不能早于开始" };
    return { patch: { last_period_end: todayISO } };
  }
  return { err: "只认 start / end" };
}

export function periodOut(j) {
  const e = (j && j.effective) || {};
  if (!j || !j.on || !e.last_period_start) return { ok: false };
  return { ok: true, cfg: { last_period_start: e.last_period_start || null, last_period_end: e.last_period_end || null,
                            cycle_days: e.cycle_days ?? null, period_length: e.period_length ?? null } };
}

export function cacheSample(u, at) {
  if (!u || typeof u !== "object") return null;
  const read = +u.cache_read_input_tokens || 0, create = +u.cache_creation_input_tokens || 0, input = +u.input_tokens || 0;
  const tot = read + create + input;
  if (!(tot > 0)) return null;
  return { at: at || Math.floor(Date.now() / 1000), read, create, input, out: +u.output_tokens || 0, pct: Math.round(read / tot * 1000) / 10 };
}

export function usageSig(u) {
  if (!u || typeof u !== "object") return "";
  return [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens, u.output_tokens].join("|");
}


export const VITALS_SERVICES = [
  { key: "him", name: "Him", url: "" },
  { key: "memory", name: "Memory", url: "" },
  { key: "telegram", name: "Telegram", url: "" },
  { key: "imessage", name: "iMessage", url: "" },
  { key: "mail", name: "Mail", url: "" },
  { key: "browser", name: "Browser", url: "" },
  { key: "music", name: "Music", url: "" },
  { key: "ears", name: "Ears", url: "" },
];

export function judgeService(key, j) {
  if (!j || typeof j !== "object") return { ok: false, detail: "No response" };
  switch (key) {
    case "him": return j.ok === true ? { ok: true, detail: (j.auth === "direct" ? "Direct" : j.auth === "proxy" ? "Via proxy" : "Up") + (j.busy ? " · busy" : "") }
                                       : { ok: false, detail: "Not ok" };
    case "memory": return j.status === "ok" ? { ok: true, detail: (j.buckets != null ? j.buckets + " memories" : "Up") }
                                             : { ok: false, detail: "Status: " + String(j.status || "unknown").slice(0, 20) };
    case "telegram": return j.ok === true && j.polling !== false ? { ok: true, detail: j.pendingLosses ? j.pendingLosses + " pending" : "Polling" }
                                                                  : { ok: false, detail: j.ok ? "Not polling" : "Not ok" };
    case "imessage": {
      if (j.ok !== true) return { ok: false, detail: "Not ok" };
      if (j.connected === false) return { ok: false, detail: "Disconnected" };
      const bad = (+j.failed || 0) + (+j.dropped || 0);
      return { ok: true, detail: bad ? bad + " failed" : "Connected" };
    }
    case "mail": return j.status === "ok" ? { ok: true, detail: j.send_enabled ? "Read & send" : "Read only" } : { ok: false, detail: "Not ok" };
    case "browser": return j.ok === true ? { ok: true, detail: j.browser ? String(j.browser).slice(0, 1).toUpperCase() + String(j.browser).slice(1, 20) : "Up" } : { ok: false, detail: "Not ok" };
    case "music": if (j.status !== "ok") return { ok: false, detail: "Not ok" };
                  return j.loggedIn === false ? { ok: false, detail: "Logged out — scan to log in" } : { ok: true, detail: "Logged in" };
    case "ears": return j.ok === true ? { ok: true, detail: j.asr === false ? "No ASR" : "Listening" } : { ok: false, detail: "Not ok" };
    default: return { ok: !!(j.ok === true || j.status === "ok"), detail: "" };
  }
}

export function cacheOut(list, nowSec) {
  const now = nowSec || Math.floor(Date.now() / 1000);
  const day = (list || []).filter(s => s && s.at > now - 86400);
  const last = (list || []).length ? list[list.length - 1] : null;
  const avg = day.length ? Math.round(day.reduce((a, s) => a + s.pct, 0) / day.length * 10) / 10 : null;
  return { last, avg24: avg, n24: day.length, series: day.map(s => [s.at, s.pct]) };
}

export const HOST_NAMES = {
  "kelivo-shim": "Him", "ombre-brain": "Memory", "telegram-bridge": "Telegram", "imessage-bridge": "iMessage",
  "dwell-bridge": "Intertidal", "gmail-mcp": "Mail", "browser-hands": "Browser", "netease-mcp": "Music",
  "ears": "Ears", "chess-web": "Chess", "caddy": "Gateway",
};
export const HOST_RANGES = { "1h": 3600, "24h": 86400, "7d": 604800 };
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);

export function hostSeries(rows, nowSec, range, pts = 60) {
  const now = nowSec || Math.floor(Date.now() / 1000);
  const span = HOST_RANGES[range] || HOST_RANGES["24h"];
  const ok = (r) => r && typeof r.at === "number" && Array.isArray(r.cpu) && Array.isArray(r.mem);
  const list = (rows || []).filter(ok).sort((a, b) => a.at - b.at);
  const last = list[list.length - 1];
  if (!last) return { ok: false, why: "No data yet" };
  const from = now - span, w = span / pts;
  const blank = () => Array.from({ length: pts }, () => [0, 0]);
  const acc = { cpu: blank(), mem: blank(), rx: blank(), tx: blank() };
  const keys = Object.keys(last.ct || {});
  const sacc = Object.fromEntries(keys.map((k) => [k, { cpu: blank(), mem: blank() }]));
  const put = (b, i, v) => { if (v != null && isFinite(v)) { b[i][0] += v; b[i][1]++; } };
  const tot = { rx: 0, tx: 0 }, peak = { cpu: null, mem: null };
  let curCpu = null, curRx = null, curTx = null;
  for (let n = 1; n < list.length; n++) {
    const a = list[n - 1], b = list[n], dt = b.at - a.at;
    if (b.at < from || dt <= 0 || dt > 600) continue;
    const i = Math.min(pts - 1, Math.floor((b.at - from) / w));
    const dBusy = b.cpu[0] - a.cpu[0], dTot = b.cpu[1] - a.cpu[1];
    const cpu = dTot > 0 && dBusy >= 0 ? dBusy / dTot * 100 : null;
    const memPct = b.mem[0] ? (b.mem[0] - b.mem[1]) / b.mem[0] * 100 : null;
    const net = Array.isArray(a.net) && Array.isArray(b.net) ? [b.net[0] - a.net[0], b.net[1] - a.net[1]] : [-1, -1];
    const rx = net[0] >= 0 ? net[0] / dt : null, tx = net[1] >= 0 ? net[1] / dt : null;
    put(acc.cpu, i, cpu); put(acc.mem, i, memPct); put(acc.rx, i, rx); put(acc.tx, i, tx);
    if (net[0] > 0) tot.rx += net[0]; if (net[1] > 0) tot.tx += net[1];
    if (cpu != null && (peak.cpu == null || cpu > peak.cpu)) peak.cpu = cpu;
    if (memPct != null && (peak.mem == null || memPct > peak.mem)) peak.mem = memPct;
    for (const k of keys) { const c = (b.ct || {})[k]; if (c) { put(sacc[k].cpu, i, +c[0]); put(sacc[k].mem, i, +c[1]); } }
    if (b === last) { curCpu = cpu; curRx = rx; curTx = tx; }
  }
  const avg = (bk, f = r1) => bk.map(([s, c]) => (c ? f(s / c) : null));
  const [mt, ma, st, sf] = last.mem;
  const services = keys.map((k) => {
    const c = last.ct[k];
    const lim = +c[2] > 0 && +c[2] < mt * 0.95 ? +c[2] : null;
    return { key: k, name: HOST_NAMES[k] || k, cpu: r1(+c[0]), mem: +c[1] || 0, limit: lim, state: String(c[5] || ""), status: String(c[6] || ""),
             series: { cpu: avg(sacc[k].cpu), mem: avg(sacc[k].mem, (x) => Math.round(x)) } };
  }).sort((a, b) => b.mem - a.mem);
  return {
    ok: true, at: last.at, stale: now - last.at > 300, range: HOST_RANGES[range] ? range : "24h", step: w,
    cur: { cpu: r1(curCpu), ncpu: last.ncpu || null, load: last.load || null, memUsed: mt - ma, memTotal: mt,
           swapUsed: st - sf, swapTotal: st, diskUsed: (last.disk || [])[1] ?? null, diskTotal: (last.disk || [])[0] ?? null,
           rx: curRx == null ? null : Math.round(curRx), tx: curTx == null ? null : Math.round(curTx), up: last.up ?? null },
    peak: { cpu: r1(peak.cpu), mem: r1(peak.mem) }, totals: tot,
    series: { cpu: avg(acc.cpu), mem: avg(acc.mem), rx: avg(acc.rx, Math.round), tx: avg(acc.tx, Math.round) },
    services,
  };
}

export function cleanStickerName(name, takenTags, ownTags) {
  const t = Array.from(String(name ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "")
    .replace(/[〔〕\[\]]/g, "").replace(/\s+/g, " ").trim()).slice(0, 20).join("");
  if (!t) return { tag: "" };
  if (/^自制\d+$/.test(t) && !(ownTags || []).includes(t)) return { err: "「自制+数字」是留给没起名的,换一个吧" };
  if ((takenTags || []).includes(t) && !(ownTags || []).includes(t)) return { err: "已经有一张叫「" + t + "」了" };
  return { tag: t };
}

export function stickerForHim(builtin, name) {
  const named = builtin || (name && !/^自制\d+$/.test(name));
  return named ? { text: `(她发来一个贴纸:${name})`, withImage: false } : { text: "(她发来一个贴纸)", withImage: true };
}

const RESET_WORDS = ["换窗口", "开新窗口", "新窗口", "归档"];
function stripEnds(s) { return (s || "").trim().replace(/^[\s，,。.!！~～、]+|[\s，,。.!！~～、]+$/g, ""); }
export function detectReset(text) {
  const t = stripEnds(text);
  for (const w of RESET_WORDS) if (t === w || (t.length <= 8 && t.includes(w))) return "reset";
  return null;
}
export function mergeTurn(items) {
  const list = items || [];
  return {
    text: list.map((i) => i.text || "").filter(Boolean).join("\n"),
    images: list.flatMap((i) => i.images || []),
    mine: list.length ? list[list.length - 1].mine : null,
  };
}
