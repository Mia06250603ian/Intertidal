
import {
  makeSSEParser, makeStripper, makeEventLog, makeMsgLog,
  safeEqual, makeToken, buildShimBody, parseLog, tailLines, verFrom, memFrom,
  evEcho, evText, evThink, evToolUse, evToolDone, evFinal, evResult,
  parseAvatar, cleanPrefs, AVATAR_MAX_BYTES, engineOf, switchPlan,
  VOICE_END, formatEarsResult, voiceSegments, heSaidVoice, makeToolLines, pcmEnvelope,
  textHash, bubbleKey, setReaction, cleanReactInput, searchMsgs, parseStickerImage,
  weatherCard, WX_ZH_TABLE,
} from "./dwell-lib.mjs";
import { stripDemo } from "./strip-demo.mjs";
import fs from "node:fs";

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.error("  ✗ " + name); } };
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}\n    实际=${JSON.stringify(a)}\n    期望=${JSON.stringify(b)}`);

{
  const p = makeSSEParser();
  const f = p.push('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n');
  ok(f.length === 1, "SSE：一帧完整收到");
  eq(f[0].data.delta.text, "你好", "SSE：正文取出来了");
  eq(f[0].event, "content_block_delta", "SSE：事件名取出来了");
}
{

  const p = makeSSEParser();
  ok(p.push('event: content_block_delta\nda').length === 0, "SSE：半截帧不吐");
  ok(p.push('ta: {"type":"x","delta":{"type":"text_delta","tex').length === 0, "SSE：还是半截，仍不吐");
  const f = p.push('t":"拼好了"}}\n\n');
  ok(f.length === 1, "SSE：拼齐后吐一帧");
  eq(f[0].data.delta.text, "拼好了", "SSE：跨三块的内容拼对了");
}
{

  const p = makeSSEParser();
  const f = p.push('data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n');
  ok(f.length === 3, "SSE：一块里三帧全取出");
  eq(f.map((x) => x.data.type), ["a", "b", "c"], "SSE：三帧顺序没乱");
}
{
  const p = makeSSEParser();
  ok(p.push("data: 这不是JSON\n\n").length === 0, "SSE：坏 JSON 丢掉，不抛异常");
  const f = p.push('data: {"type":"ok"}\n\n');
  ok(f.length === 1, "SSE：坏帧之后照常工作");
}
{
  const p = makeSSEParser();
  ok(p.push("event: ping\n\n").length === 0, "SSE：没有 data 的帧忽略");
}

{
  const all = (chunks) => { const s = makeStripper(); const out = []; for (const c of chunks) out.push(...s.push(c)); out.push(...s.flush());
    return out.filter((p) => p.kind !== "text" || p.text).map((p) => p.kind === "text" ? p.text : p.kind === "react" ? `<回应${p.emoji}>` : p.kind === "check" ? "<查岗>" : `<${p.kind}>`).join(""); };
  eq(all(["好 我试一下 [查岗]"]), "好 我试一下 <查岗>", "剥：[查岗] 不显示");
  eq(all(["好【查岗】你看"]), "好<查岗>你看", "剥：【查岗】全角括号也剥");
  eq(all(["好 [ 查岗 ] 你看"]), "好 <查岗> 你看", "剥：标记里带空格也剥");
  eq(all(["好 [查", "岗] 你看"]), "好 <查岗> 你看", "剥：[查岗] 被切成两半也剥");
  eq(all(["抱抱[贴纸：贴贴]"]), "抱抱〔贴纸：贴贴〕", "剥：贴纸全角冒号");
  eq(all(["抱抱【贴纸:贴贴】"]), "抱抱〔贴纸：贴贴〕", "剥：贴纸全角括号");
  eq(all(["抱抱【贴纸：", "贴贴】好"]), "抱抱〔贴纸：贴贴〕好", "剥：全角贴纸被切断");
  eq(all(["【语音】Hi【/语音】嗯"]), "〔语音〕Hi⁣嗯", "剥：全角语音标记");
  eq(all(["嗯[回应 : ❤️ ]"]), "嗯<回应❤️>", "剥：回应带空格");
  eq(all(["[贴纸:贴贴]〔🔧 hold〕后"]), "〔贴纸：贴贴〕<tool>后", "剥：两个标记挤在一块,按出现先后处理(原来工具先处理,前面的贴纸会原样漏)");
  eq(all(["[查岗][回应:❤️]你好"]), "<查岗><回应❤️>你好", "剥：查岗 + 回应连着写");
  eq(all(["数组 [1, 2] 和 [查看] 照常"]), "数组 [1, 2] 和 [查看] 照常", "剥：普通方括号不误伤");
  eq(all(["[语音 没写完\n下一行"]), "[语音 没写完\n下一行", "剥：没闭合的开头隔了换行就放行,不一直扣着");
}
{
  const s = makeStripper();
  eq(s.push("今天天气不错"), [{ kind: "text", text: "今天天气不错" }], "剥：没有标记时原样过");
}
{
  const s = makeStripper();
  const out = s.push("想你了[贴纸:贴贴]晚安");
  eq(out, [
    { kind: "text", text: "想你了" },
    { kind: "text", text: "〔贴纸：贴贴〕" },
    { kind: "text", text: "晚安" },
  ], "剥：贴纸换成看得见的占位");
}
{

  const s = makeStripper();
  const a = s.push("想你了[贴");
  eq(a, [{ kind: "text", text: "想你了" }], "剥：半截标记不吐出去");
  const b = s.push("纸:贴贴]晚安");
  eq(b, [
    { kind: "text", text: "〔贴纸：贴贴〕" },
    { kind: "text", text: "晚安" },
  ], "剥：下一块拼齐后正确剥出");
}
{
  const s = makeStripper();
  const a = s.push("[语音]Good night");
  eq(a, [{ kind: "text", text: "〔语音〕" }, { kind: "text", text: "Good night" }], "剥：语音开标记换成提示，内容保留");
  ok(s.inVoice() === true, "剥：语音状态记住了");
  const b = s.push("[/语音]");
  eq(b, [{ kind: "text", text: VOICE_END }], "剥：语音闭标记换成看不见的收尾记号(2026-10-10;原来直接吃掉,网页不知道语音到哪结束)");
  ok(VOICE_END === "\u2063", "剥：收尾记号是 U+2063(看不见、不占宽 —— 官端显示一个像素都不变全靠它)");
  ok(s.inVoice() === false, "剥：语音状态复位");
}
{
  const s = makeStripper();
  const out = s.push("先想想〔🔧 ombre-brain__breath〕查到了");
  eq(out, [
    { kind: "text", text: "先想想" },
    { kind: "tool", name: "ombre-brain__breath" },
    { kind: "text", text: "查到了" },
  ], "剥：工具标记变成 tool 事件");
}
{

  const s = makeStripper();
  const a = s.push("先想想〔🔧 ombre");
  eq(a, [{ kind: "text", text: "先想想" }], "剥：工具标记没收完就扣住");
  const b = s.push("-brain__hold〕好了");
  eq(b, [{ kind: "tool", name: "ombre-brain__hold" }, { kind: "text", text: "好了" }], "剥：工具标记跨块拼对");
}
{
  const s = makeStripper();
  s.push("话说到一半[贴");
  eq(s.flush(), [{ kind: "text", text: "[贴" }], "剥：流结束时把扣住的残缺标记原样吐出，不吞字");
}
{
  const s = makeStripper();
  const out = s.push("[贴纸:哭哭][贴纸:贴贴]");
  eq(out, [
    { kind: "text", text: "〔贴纸：哭哭〕" },
    { kind: "text", text: "〔贴纸：贴贴〕" },
  ], "剥：连着两个标记都剥对");
}

{
  const q = makeEventLog();
  q.push(evText("a")); q.push(evText("b"));
  const r = q.since(0);
  ok(r.events.length === 2, "队列：从头取到两条");
  eq(r.next, 2, "队列：游标推进到 2");
  const r2 = q.since(2);
  ok(r2.events.length === 0, "队列：游标到位后没有新的");
  q.push(evText("c"));
  const r3 = q.since(2);
  ok(r3.events.length === 1, "队列：只给游标之后的");
  eq(r3.events[0].event.delta.text, "c", "队列：给的是对的那条");
}
{
  const q = makeEventLog({ cap: 3 });
  for (let i = 0; i < 10; i++) q.push(evText(String(i)));
  const r = q.since(0);
  ok(r.events.length === 3, "队列：超过上限只留最近的");
  eq(r.next, 10, "队列：游标仍是真实序号，不因截断回退");
}

{
  const m = makeMsgLog();
  m.addMe("在吗"); m.addThink("她在叫我"); m.addGu("在"); m.addTool("ombre-brain__breath");
  const r = m.slice({ limit: 400 });
  eq(r.msgs.map((x) => x.kind), ["me", "think", "gu", "tool"], "账本：四种 kind 都记下了");
  eq(r.upto, 4, "账本：upto 是最后一条的 seq");
  ok(r.more === false, "账本：没有更早的了");
  ok(r.msgs.every((x) => typeof x.at === "number"), "账本：每条都带时间");
}
{
  const m = makeMsgLog();
  for (let i = 1; i <= 10; i++) m.addMe("第" + i);
  const r = m.slice({ limit: 3 });
  eq(r.msgs.map((x) => x.text), ["第8", "第9", "第10"], "账本：limit 取最近的三条");
  ok(r.more === true, "账本：还有更早的，more 为真");
  const older = m.slice({ limit: 3, before: r.msgs[0].seq });
  eq(older.msgs.map((x) => x.text), ["第5", "第6", "第7"], "账本：before 往前翻一页");
}
{
  const m = makeMsgLog();
  eq(m.slice({}).upto, 0, "账本：空账本 upto 为 0");
  ok(m.slice({}).msgs.length === 0, "账本：空账本不报错");
}
{

  const m = makeMsgLog();
  const n = m.restore([
    { kind: "me", text: "昨天说的那件事", at: 1 },
    { kind: "gu", text: "记得", at: 2 },
    { kind: "x" },
    { kind: "tool", text: "ombre-brain__breath", at: 3, extra: "{}" },
  ]);
  ok(n === 3, "接回：坏行丢掉，只接回三条");
  const r = m.slice({ limit: 400 });
  eq(r.msgs.map((x) => x.text), ["昨天说的那件事", "记得", "ombre-brain__breath"], "接回：顺序和内容原样");
  eq(r.msgs.map((x) => x.seq), [1, 2, 3], "接回：seq 从 1 重新编号");
  m.addMe("今天又来了");
  eq(m.slice({ limit: 1 }).msgs[0].seq, 4, "接回：接着往下编号，不和旧的撞");
}

{
  const text = [
    JSON.stringify({ seq: 1, kind: "me", text: "在吗" }),
    JSON.stringify({ seq: 2, kind: "gu", text: "在" }),
    '{"kind":"me","text":"写到一半断',
    "",
  ].join("\n");
  const r = parseLog(text);
  eq(r.list.map((x) => x.text), ["在吗", "在"], "落盘：坏行丢掉，好的照常读回");
  eq(r.bad, 1, "落盘：坏行数出来了（开机日志会说丢了几行）");
}
{
  const r = parseLog("");
  eq(r.list.length, 0, "落盘：空文件不报错");
  eq(r.bad, 0, "落盘：空文件没有坏行");
}

{
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(JSON.stringify({ kind: "me", text: "第" + i }));
  const whole = lines.join("\n") + "\n";

  const cut = whole.slice(whole.length - 120);
  const r = tailLines(cut, { cap: 5, fromStart: false });
  ok(r.lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }),
     "尾部：被切断的那半行丢掉了，剩下的每行都完整");
  eq(JSON.parse(r.lines[r.lines.length - 1]).text, "第40", "尾部：最后一条是文件最后一条");
}
{
  const lines = [];
  for (let i = 1; i <= 40; i++) lines.push(JSON.stringify({ kind: "me", text: "第" + i }));
  const r = tailLines(lines.join("\n"), { cap: 5, fromStart: true });
  eq(r.lines.length, 5, "尾部：只取最后 cap 行");
  eq(JSON.parse(r.lines[0]).text, "第36", "尾部：取的是最后那一段");
  ok(r.enough === true, "尾部：够 cap 条时说够了");
}
{

  const r = tailLines("a\nb\nc", { cap: 10, fromStart: true });
  ok(r.enough === false, "尾部：不够 cap 条时说不够（让调用方读更大一段）");
  eq(r.lines.length, 3, "尾部：不够也把有的都给出来");
}
{

  const r = tailLines("\n{\"text\":\"完整的一条\"}\n{\"text\":\"最后一条\"}\n", { cap: 5, fromStart: false });
  eq(r.lines.length, 2, "尾部：这段正好从换行开始时，一条都不丢");
  eq(JSON.parse(r.lines[0]).text, "完整的一条", "尾部：第一条是完整的那条，没被当成半行丢掉");
}
{
  eq(tailLines("", { cap: 5 }).lines.length, 0, "尾部：空的不报错");
  eq(tailLines("只有半截一行", { cap: 5, fromStart: false }).lines.length, 0,
     "尾部：整段只有一行残行时，丢完就是空（不会把半行当成记录）");
}

{
  ok(verFrom("a", "b") === verFrom("a", "b"), "指纹：同样的内容算出同样的值");
  ok(verFrom("a", "b") !== verFrom("a", "c"), "指纹：任一文件变了值就变");
  ok(verFrom("a", "b") !== verFrom("ab", ""), "指纹：分段不会被揉成一串（a|b ≠ ab|）");
  ok(verFrom("x").length <= 10, "指纹：短到能塞进每个 poll 回复里");

  const q = makeEventLog({ ver: "deadbeef" });
  eq(q.since(0).ver, "deadbeef", "指纹：poll 回复里带着这一版的值");
  eq(makeEventLog().since(0).ver, "1", "指纹：不给就还是老的写死值（兼容）");
}

{
  const m = memFrom({ rss: 31138816, meminfo: "MemTotal:  3813404 kB\nMemAvailable:  1494616 kB\nCached: 1 kB\n" });
  eq(m.self, 29.7, "内存:本进程 RSS 换算成 MiB");
  eq(m.avail, 1460, "内存:整机可用换算成 MiB");
}
{

  const m = memFrom({});
  eq(m.self, null, "内存:没有 RSS 时给 null");
  eq(m.avail, null, "内存:读不到 meminfo 时给 null");
  eq(memFrom({ rss: NaN }).self, null, "内存:读数不是数时给 null 不给 NaN");
}
{
  eq(memFrom({ rss: 1048576, meminfo: "MemFree: 9 kB\nMemAvailable: 2048 kB" }).avail, 2,
     "内存:MemAvailable 不在首行也找得到");
}

{
  ok(safeEqual("abc", "abc") === true, "鉴权：相同为真");
  ok(safeEqual("abc", "abd") === false, "鉴权：不同为假");
  ok(safeEqual("abc", "abcd") === false, "鉴权：长度不同为假");
  ok(safeEqual(null, "") === true, "鉴权：null 当空串");
  ok(safeEqual(undefined, "x") === false, "鉴权：undefined 不等于非空");
}
{
  const a = makeToken("mypass", "salt1");
  ok(a === makeToken("mypass", "salt1"), "鉴权：同密码同盐得同令牌");
  ok(a !== makeToken("mypass", "salt2"), "鉴权：换盐令牌就变（重启即失效）");
  ok(a !== makeToken("otherpass", "salt1"), "鉴权：换密码令牌就变");
  ok(!a.includes("mypass"), "鉴权：令牌里不含明文密码");
}

{
  const b = buildShimBody("你好");
  eq(b.messages.length, 1, "请求体：只发一条——历史在他进程里，不重复喂");
  eq(b.messages[0].role, "user", "请求体：角色是 user");
  eq(b.messages[0].content, "你好", "请求体：纯文本时 content 就是字符串");
  ok(b.stream === true, "请求体：要流式");
  ok(!("model" in b), "请求体：**不许报模型**——报了会把她在 Kelivo 切的模型拽回去(2026-08-24 方案 B)");
}
{
  const b = buildShimBody("看这个", { images: [{ mime: "image/png", data: "AAAA" }] });
  ok(Array.isArray(b.messages[0].content), "请求体：带图时 content 是数组");
  eq(b.messages[0].content[0].type, "image", "请求体：图片在前");
  eq(b.messages[0].content[1].type, "text", "请求体：文字在后");
}

{
  eq(evEcho("嗨"), { type: "echo", text: "嗨" }, "形状：echo");
  eq(evText("字").event.delta.type, "text_delta", "形状：正文走 text_delta");
  eq(evThink("念").event.delta.type, "thinking_delta", "形状：思考走 thinking_delta");
  eq(evThink("念").event.delta.thinking, "念", "形状：思考的字段名是 thinking 不是 text");
  eq(evText("字").type, "stream_event", "形状：增量都包在 stream_event 里");
  eq(evToolUse("breath", "t1").message.content[0].type, "tool_use", "形状：工具卡片");
  eq(evToolDone("t1").message.content[0].tool_use_id, "t1", "形状：工具收尾对得上 id");
  eq(evToolDone("t1").type, "user", "形状：tool_result 走 user 事件");
  eq(evFinal("定稿").message.content[0].text, "定稿", "形状：定稿走 assistant");
  eq(evResult(false).type, "result", "形状：收尾事件");
  ok(evResult(false).is_error === false, "形状：正常收尾 is_error 为假");
  ok(evResult(true, "上游断了").result === "上游断了", "形状：出错收尾带原因");
}

{
  const fake = [
    "<script>",
    "/* ────────",
    "   演示模式。把 fetch 拦下来喂假数据。",
    "   ──────── */",
    "(function () {",
    "  const D = { 'api/said': {} };",
    "  const real = window.fetch;",
    "  window.fetch = function (input) { return Promise.resolve(); };",
    "})();",
    "",
    "const REAL = 1;",
    "</" + "script>",
  ].join("\n");
  const r = stripDemo(fake);
  ok(r.removed === true, "删演示：认出来了");
  ok(!r.text.includes("window.fetch ="), "删演示：拦截器没了");
  ok(!r.text.includes("api/said"), "删演示：假数据没了");
  ok(r.text.includes("const REAL = 1;"), "删演示：后面的真代码留着");
  ok(r.text.includes("<script>"), "删演示：前面的没被多切");
}
{
  const clean = "<script>const a = 1;</" + "script>";
  const r = stripDemo(clean);
  ok(r.removed === false, "删演示：没有演示块时不动手");
  eq(r.text, clean, "删演示：原样返回，一个字节不改");
}
{

  let threw = false;
  try { stripDemo("/* 演示模式 */\nwindow.fetch = function(){}"); } catch { threw = true; }
  ok(threw === true, "删演示：找得到开头找不到结尾时停下，不猜");
}

{
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const r = parseAvatar("data:image/jpeg;base64," + jpg.toString("base64"));
  ok(!r.err && r.ext === "jpg" && r.buf.equals(jpg), "头像：JPEG 收下");
  ok(parseAvatar("data:image/png;base64," + png.toString("base64")).ext === "png", "头像：PNG 收下");
  ok(!!parseAvatar("data:image/png;base64," + jpg.toString("base64")).err, "头像：自报 PNG 实为 JPEG → 拒");
  ok(!!parseAvatar("data:image/svg+xml;base64,PHN2Zz4=").err, "头像：SVG 一律拒(能带脚本)");
  ok(!!parseAvatar("https://example.com/a.jpg").err, "头像：不是 dataURL → 拒");
  ok(!!parseAvatar("").err && !!parseAvatar(null).err, "头像：空的 → 拒");
  const big = Buffer.concat([jpg, Buffer.alloc(AVATAR_MAX_BYTES)]);
  ok(/太大/.test(parseAvatar("data:image/jpeg;base64," + big.toString("base64")).err || ""), "头像：超上限 → 拒并说明");
  eq(cleanPrefs({ chatStyle: "tg", avatarMode: "each" }), { chatStyle: "tg", avatarMode: "each" }, "偏好：认识的键值照收");
  eq(cleanPrefs({ chatStyle: "imsg" }), { chatStyle: "imsg" }, "偏好：仿 iMessage 也认(2026-10-19)");
  eq(cleanPrefs({ chatStyle: "evil", avatarMode: "top", __proto__x: 1, skin: "x" }), { avatarMode: "top" }, "偏好：不认识的值和键都丢掉");
  eq(cleanPrefs(null), {}, "偏好：空的 → 空对象");
  eq(cleanPrefs({ meBubble: "#AABBCC", himBubble: "" }), { meBubble: "#aabbcc", himBubble: "" }, "偏好：气泡颜色收 #rrggbb(转小写),空串 = 跟皮肤");
  eq(cleanPrefs({ meBubble: "red", himBubble: "#abc", x: "#aabbcc" }), {}, "偏好：气泡颜色不是 #rrggbb 一律丢");
  eq(cleanPrefs({ chatFont: "15.5" }), { chatFont: "15.5" }, "偏好：聊天字号五档照收");
  eq(cleanPrefs({ chatFont: "40" }), {}, "偏好：聊天字号不在五档里的丢掉");
  eq(cleanPrefs({ chatFont: 15.5 }), {}, "偏好：聊天字号只收字符串(前端发的就是字符串)");
  eq(cleanPrefs({ himName: "  小 白\n " }), { himName: "小 白" }, "偏好：名字去头尾空白、换行并成空格");
  eq(cleanPrefs({ himName: "" }), { himName: "" }, "偏好：名字空串 = 用默认");
  eq(cleanPrefs({ himName: "一二三四五六七八九十一二三四五六七八" }).himName.length, 16, "偏好：名字最多 16 个字");
  eq(cleanPrefs({ himName: "白\u202e\u0007" }), { himName: "白" }, "偏好：名字去掉控制字符和方向控制符");
  eq(cleanPrefs({ himName: 42 }), {}, "偏好：名字只收字符串");
  const big2 = Buffer.concat([jpg, Buffer.alloc(600 * 1024)]);
  ok(!!parseAvatar("data:image/jpeg;base64," + big2.toString("base64")).err, "头像：600KB 超头像上限");
  ok(!parseAvatar("data:image/jpeg;base64," + big2.toString("base64"), 1536 * 1024).err, "壁纸：600KB 在壁纸上限内");
}

{
  ok(!("model" in buildShimBody("嗯")), "换模型：平时请求体不带 model(别把她在 Kelivo 切的拽回来)");
  eq(buildShimBody("嗯", { model: "claude-opus-5-5" }).model, "claude-opus-5-5", "换模型：点了之后那一句才带");
  const h = { model: "claude-opus-5-5", cli: "next", cliNext: "ready", nextModels: ["claude-opus-5-5"] };
  eq(engineOf("claude-opus-4-6-next", []), "next", "引擎：-next 后缀 = 新版");
  eq(engineOf("claude-opus-4-6", h.nextModels), "main", "引擎：普通 4.6 = 旧版");
  ok(switchPlan("claude-opus-4-6-next", h).keepsWindow, "5.5 → 4.6-next:原地换,不丢窗口");
  ok(!switchPlan("claude-opus-4-6", h).keepsWindow, "5.5 → 旧版 4.6:丢窗口");
  ok(!switchPlan("claude-opus-5-5", { ...h, model: "claude-opus-4-6", cli: "main" }).keepsWindow, "旧版 4.6 → 5.5:丢窗口");
  ok(!switchPlan("claude-opus-4-6-next", { ...h, cliNext: "missing" }).keepsWindow, "新版 CLI 不在:不敢说不丢");
  ok(switchPlan("claude-opus-5-5", h).current, "选的就是当前这个:标成当前");
}

if (fs.existsSync(new URL("./web/index.html", import.meta.url))) {
  const html = fs.readFileSync(new URL("./web/index.html", import.meta.url), "utf8");
  ok(!html.includes("window.fetch ="), "真前端：演示拦截器确实不在了");

  const isShell = html.includes('data-tab="chats"') && !html.includes("function handle(d)");
  if (isShell) {
    ok(html.includes('data-tab="home"') && html.includes('data-tab="diary"'), "新壳：底部三栏都在");
    ok(html.includes("id=\"tab-home\""), "新壳：首页那屏在");

    ok(html.includes("api/health"), "新壳：换版自动重载还连着（读 /api/health 的 ver）");
    ok(html.includes("d.ver"), "新壳：读的确实是 ver 这个字段");
    ok(html.includes("location.reload()"), "新壳：换版之后会自己重载");
      } else {
    ok(html.includes("function handle(d)"), "真前端：事件处理函数还在");
    ok(html.includes("api/poll?since="), "真前端：长轮询还在");
    ok(html.includes("api/messages?limit="), "真前端：历史回放还在");
    ok(html.includes("api/send"), "真前端：发送还在");
    ok(html.includes("d.ver"), "真前端：自动重载读的那个 ver 字段还在");
    ok(html.includes("location.reload()"), "真前端：换版之后会自己重载");
    ok(!html.includes("'api/said':"), "真前端：写死的演示数据没了");
  }
} else {
  console.log("  （跳过真前端检查：还没跑 fetch-frontend.sh）");
}

if (fs.existsSync(new URL("./web/chat.html", import.meta.url))) {
  const c = fs.readFileSync(new URL("./web/chat.html", import.meta.url), "utf8");
  ok(!c.includes("window.fetch ="), "聊天页：演示拦截器确实不在了");
  ok(c.includes("function handle(d)"), "聊天页：事件处理函数还在");
  ok(c.includes("api/poll?since="), "聊天页：长轮询还在");
  ok(c.includes("api/messages?limit="), "聊天页：历史回放还在");
  ok(c.includes("api/send"), "聊天页：发送还在");
  ok(c.includes("d.ver"), "聊天页：自动重载读的那个 ver 字段还在");
  ok(c.includes("location.reload()"), "聊天页：换版之后会自己重载");
  ok(!c.includes("'api/said':"), "聊天页：写死的演示数据没了");

  const idx = new URL("./web/index.html", import.meta.url);
  if (fs.existsSync(idx)) {
    const ih = fs.readFileSync(idx, "utf8");
    if (ih.includes('data-tab="chats"')) {
      ok(ih.includes('data-chat="chat.html"'), "外壳：Chats 那一行指向的确实是 chat.html");
    }
  }
} else {
  console.log("  （跳过聊天页检查：还没跑 fetch-frontend.sh）");
}

{

  ok(/（.+）$/.test(formatEarsResult({ text: "归档" })), "语音：永远带（…）注解 —— 语音说「归档」不会被当成重置词");
  eq(formatEarsResult({ text: "" }), null, "语音：没听清 = null");

  eq(voiceSegments("前面〔语音〕Good night" + VOICE_END + "后面〔语音〕Miss you"), ["Good night", "Miss you"], "语音：按收尾记号切段,没收尾的到行尾");
  eq(voiceSegments("〔语音〕Hello\n下一行"), ["Hello"], "语音：老记录没收尾,只算到这一行结束");
  const list = [{ kind: "me", text: "〔语音〕Fake" }, { kind: "gu", text: "嗯〔语音〕Good night, baby" + VOICE_END }];
  ok(heSaidVoice(list, "Good night, baby"), "语音：他说过的语音段才能合成");
  ok(!heSaidVoice(list, "Fake"), "语音：她的语音段不合成(那不是他的声音)");
  ok(!heSaidVoice(list, "随便一句"), "语音：记录里没有的话不合成(防烧积分)");
  ok(!heSaidVoice(list, ""), "语音：空串不合成");
  {

    const rate = 4000, buf = Buffer.alloc(rate * 2 * 2);
    for (let i = rate; i < rate * 2; i++) buf.writeInt16LE(i % 2 ? 12000 : -12000, i * 2);
    const e = pcmEnvelope(buf, rate, 8);
    eq(e.dur, 2, "真波形：时长按采样数算");
    eq(e.p, [0, 0, 0, 0, 1, 1, 1, 1], "真波形：静的段 0、响的段归一到 1");
    eq(pcmEnvelope(Buffer.alloc(0), rate, 4), { dur: 0, p: [0, 0, 0, 0] }, "真波形：空文件不崩");
    eq(pcmEnvelope(Buffer.alloc(800), rate, 4).p, [0, 0, 0, 0], "真波形：全静音不除以零");
  }
}

{
  const t = makeToolLines();
  const got = [...t.push("我想一下\n"), ...t.push('  → {"q":'), ...t.push('"x"}\n  ← 找到 3 条\n后面'), ...t.push("继续\n  ←✗ 超时"), ...t.flush()];
  eq(got, [{ kind: "think", text: "我想一下\n" }, { kind: "args", text: '{"q":"x"}' }, { kind: "result", text: "找到 3 条", err: false },
           { kind: "think", text: "后面" }, { kind: "think", text: "继续\n" }, { kind: "result", text: "超时", err: true }],
     "工具行：参数 / 返回值 / 报错按行认出来,半行跨块也拼得上");
  const u = makeToolLines();
  eq(u.push("说到一半  → 不是参数\n"), [{ kind: "think", text: "说到一半  → 不是参数\n" }], "工具行：不在行首的箭头照旧是思考文字");
  const v = makeToolLines();
  eq(v.push("  "), [], "工具行：行首两个空格先扣住(可能是箭头行)");
  eq(v.push("普通的缩进\n"), [{ kind: "think", text: "  普通的缩进\n" }], "工具行：扣住的不是箭头行就原样放出来,一个字不丢");
  eq(evToolDone("t1", "ok", true).message.content[0], { type: "tool_result", tool_use_id: "t1", is_error: true, content: "ok" }, "工具收尾事件带上返回值和报错");
}

{
  const s = makeStripper();
  eq([...s.push("好呀[回"), ...s.push("应:❤️]晚安【回应：👍】"), ...s.flush()],
     [{ kind: "text", text: "好呀" }, { kind: "react", emoji: "❤️" }, { kind: "text", text: "晚安" }, { kind: "react", emoji: "👍" }],
     "回应：[回应:x] 剥出来交给 server(不显示成字),跨块、全角括号 / 全角冒号都认");

  try {
    const html = fs.readFileSync(new URL("./web/chat.html", import.meta.url), "utf8");
    const src = /function th\(t\) \{[^\n]+\}/.exec(html);
    if (src) { const th = new Function(src[0] + "; return th;")(); for (const t of ["", "嗯", "晚安 我爱你", "Good night⁣"]) eq(th(t), textHash(t), "回应：前端 th() 与 dwell-lib textHash 同一个结果 " + JSON.stringify(t)); }
    else ok(false, "回应：真前端里找不到 th()");
  } catch { console.log("  （跳过前端哈希对账：还没跑 fetch-frontend.sh）"); }
  eq(bubbleKey("gu", "嗯", 2), "gu:" + textHash("嗯") + ":2", "回应：泡的身份 = kind + 原文哈希 + 第几颗");
  let L = setReaction([], { k: "gu:a:0", at: 100, e: "❤️", by: "me" });
  L = setReaction(L, { k: "gu:a:0", at: 150, e: "👍", by: "me" });
  eq(L, [{ k: "gu:a:0", at: 150, e: "👍", by: "me" }], "回应：同一颗泡同一个人只留一个(换表情 = 替换)");
  L = setReaction(L, { k: "gu:a:0", at: 1000, e: "😂", by: "me" });
  ok(L.length === 2, "回应：同一句话隔得久(>300 秒)算另一颗泡");
  L = setReaction(L, { k: "gu:a:0", at: 150, e: "", by: "me" });
  ok(L.length === 1 && L[0].e === "😂", "回应：空表情 = 撤掉");
  ok(setReaction(L, { k: "gu:a:0", at: 1000, e: "❤️", by: "him" }).length === 2, "回应：她的和他的各算各的");
  eq(cleanReactInput({ k: "me:abc:0", at: 5, e: "❤️" }), { k: "me:abc:0", at: 5, e: "❤️" }, "回应：合法输入照收");
  eq(cleanReactInput({ k: "../x", at: 5, e: "❤️" }), null, "回应：键不像泡的身份就拒");
  eq(cleanReactInput({ k: "me:abc:0", e: "<b>" }), null, "回应：表情里带尖括号就拒");
  const ML = [{ seq: 1, kind: "me", text: "今天下雨了", at: 1 }, { seq: 2, kind: "think", text: "下雨", at: 2 },
              { seq: 3, kind: "gu", text: "〔语音〕Rain⁣ 雨好大", at: 3 }, { seq: 4, kind: "me", text: "RAIN", at: 4 }];
  eq(searchMsgs(ML, "雨").map((x) => x.seq), [3, 1], "搜索：只搜她和他说的(不搜思考),新的在前");
  eq(searchMsgs(ML, "rain").map((x) => x.seq), [4, 3], "搜索：不分大小写");
  ok(!searchMsgs(ML, "Rain")[1].text.includes("⁣"), "搜索：结果里没有看不见的收尾记号");
  eq(searchMsgs(ML, "  "), [], "搜索：空关键词 = 空结果");
  const gif = "data:image/gif;base64," + Buffer.from("GIF89a\x01\x00\x01\x00", "latin1").toString("base64");
  eq(parseStickerImage(gif).ext, "gif", "自制贴纸：GIF 也收(会动的贴纸)");
  ok(!!parseStickerImage("data:image/gif;base64," + Buffer.from("\x89PNG\r\n\x1a\n0000").toString("base64")).err, "自制贴纸：类型和内容对不上就拒");
  ok(!!parseStickerImage("data:image/svg+xml;base64,PHN2Zz4=").err, "自制贴纸：不收 SVG(能带脚本)");
}

{
  const hr = (code, rain) => ({ weatherCode: String(code), chanceofrain: String(rain), weatherDesc: [{ value: "x" }] });
  const mk = (cur, rains, mid = 119, min = "28", max = "34") => ({
    current_condition: [{ weatherCode: String(cur), temp_C: "27", FeelsLikeC: "30", weatherDesc: [{ value: "Overcast" }] }],
    weather: [{ mintempC: min, maxtempC: max, hourly: rains.map((r, i) => hr(i === 4 ? mid : 113, r)) },
              { mintempC: "20", maxtempC: "25", hourly: [hr(113, 0)] }] });
  const A = mk(119, [10, 20, 30, 76, 50, 0, 0, 0]);
  eq(weatherCard(A), { desc: "阴", temp: 27, min: 28, max: 34, rain: 76, umbrella: true }, "天气:阴 27° 28~34° 降雨 76% 要带伞");
  eq(weatherCard(mk(113, [0, 10, 20, 0, 0, 0, 0, 0], 113)).umbrella, false, "天气:晴、降雨 20% 不提伞");
  eq(weatherCard(mk(296, [0, 0, 0, 0, 0, 0, 0, 0], 113)).umbrella, true, "天气:现在在下雨,概率再低也提伞");
  eq(weatherCard({ current_condition: [], weather: [] }), null, "天气:数据不完整给 null");
  eq(weatherCard(null), null, "天气:没数据给 null");
  eq(weatherCard(mk(999, [0])).desc, "Overcast", "天气:表里没有的 code 退回英文原文");
}

{
  const lib = await import("./dwell-lib.mjs");
  ok(lib.AVATAR_WHO.includes("cover"), "背景图:cover 是认得的存图槽");
  eq(lib.AVATAR_WHO.slice(0, 3), ["me", "him", "wall"], "背景图:原来三个槽一个没动");
}

{
  const lib = await import("./dwell-lib.mjs");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).toString("base64");
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
  let n = 0; const id = () => "id" + (++n);
  const a = lib.buildOutgoing("看这个", [{ kind: "image", media_type: "image/png", data: png }], id);
  eq(a.text, "看这个", "发图:配了字就把字交给他");
  eq(a.display, "〔图片：id1〕\n看这个", "发图:网页记录 = 图的占位 + 字");
  eq(a.images.length === 1 && a.images[0].mime, "image/png", "发图:图本身交给他");
  eq(lib.buildOutgoing("", [{ kind: "image", media_type: "image/jpeg", data: jpg }], id).text, "(她发来一张图片)", "发图:只发图 = 和贴纸同一种说法");
  eq(lib.buildOutgoing("", [{ kind: "image", media_type: "image/jpeg", data: jpg }, { kind: "image", media_type: "image/png", data: png }], id).text, "(她发来2张图片)", "发图:两张");
  ok(/对不上/.test(lib.buildOutgoing("", [{ kind: "image", media_type: "image/png", data: jpg }], id).err || ""), "发图:文件头和类型对不上 = 拒");
  ok(lib.buildOutgoing("", [{ kind: "image", media_type: "image/svg+xml", data: png }], id).err, "发图:SVG 不收");
  ok(/最多/.test(lib.buildOutgoing("", Array(5).fill({ kind: "image", media_type: "image/png", data: png }), id).err || ""), "发图:一次最多 4 张");
  const big = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(lib.PHOTO_MAX_BYTES)]).toString("base64");
  ok(/太大/.test(lib.buildOutgoing("", [{ kind: "image", media_type: "image/jpeg", data: big }], id).err || ""), "发图:超 4MB 拒");
  const f = lib.buildOutgoing("帮我看看", [{ kind: "text", name: "a.md", text: "# 标题" }], id);
  eq(f.text, "帮我看看\n\n〔文件：a.md〕\n# 标题", "文件:内容拼在那句话后面交给他");
  eq(f.display, "〔文件：a.md〕\n帮我看看", "文件:网页记录只留名字");
  ok(lib.buildOutgoing("", [], id).err, "什么都没有 = 拒");
  ok(lib.parseStickerImage("data:image/png;base64," + png).mime === "image/png", "贴纸那条路照旧能用(共用同一个解析)");
  eq(lib.cleanPrefs({ voiceText: "fold" }).voiceText, "fold", "语音文字:折叠能存");
  eq(lib.cleanPrefs({ voiceText: "hide" }).voiceText, undefined, "语音文字:不认识的值丢掉");
}
{
  const lib = await import("./dwell-lib.mjs");
  const r = lib.parseSongReply("好。\n[今日歌:1901371647|孤勇者|陈奕迅] 今天想让你听这首。\n");
  eq(r, { id: "1901371647", name: "孤勇者", artist: "陈奕迅", note: "今天想让你听这首。" }, "每日一首:认出那一行");
  eq(lib.parseSongReply("[今日歌：123456] 只给了 ID").id, "123456", "每日一首:全角冒号、只给 ID 也认");
  eq(lib.parseSongReply("[今日歌:123456|a|b] 带[贴纸:抱抱]标记").note, "带标记", "每日一首:一句话里的标记剥掉");
  eq(lib.parseSongReply("今天就不挑了"), null, "每日一首:没那一行 = null,不猜");
  eq(lib.parseSongReply("[今日歌:abc|x|y] 嗨"), null, "每日一首:ID 不是数字 = null");
  ok(lib.parseSongReply("[今日歌:123456|a|b] " + "长".repeat(200)).note.length <= 80, "每日一首:一句话最多 80 字");
  eq(lib.songDay(Date.UTC(2026, 9, 11, 23, 30)).day, "2026-10-12", "每日一首:按北京时间算今天(UTC 23:30 = 次日 7:30)");
  eq(lib.songDay(Date.UTC(2026, 9, 11, 23, 30)).hour, 7, "每日一首:北京时间小时");
  const d = lib.songFromDetail({ songs: [{ name: "孤勇者", artists: [{ name: "陈奕迅" }], album: { picUrl: "http://p2.music.126.net/x.jpg" } }] });
  eq(d, { name: "孤勇者", artist: "陈奕迅", cover: "https://p2.music.126.net/x.jpg" }, "每日一首:详情接口 → 歌名 / 歌手 / 封面(http 改 https)");
  eq(lib.songFromDetail({ songs: [{ name: "x", artists: [], album: { picUrl: "https://evil.example/x.jpg" } }] }).cover, "", "每日一首:封面只认网易云图床");
  eq(lib.songFromDetail({ songs: [] }), null, "每日一首:没这首 = null");
  const o = lib.songOut({ day: "2026-10-12", id: "123456", name: "a", artist: "b", note: "c" }, "2026-10-12");
  ok(o.today && o.app === "orpheus://song/123456" && o.web === "https://music.163.com/song?id=123456", "每日一首:给网页的那份带两个跳转");
  eq(lib.songOut(null, "x"), { ok: false }, "每日一首:还没有 = ok:false");
  ok(/x-system-turn/.test(fs.readFileSync(new URL("./server.js", import.meta.url), "utf8").match(/async function pickSong[\s\S]*?\n}\n/)?.[0] || ""), "每日一首:那一轮带 x-system-turn(不算她来说话)");
}
{
  const lib = await import("./dwell-lib.mjs");
  eq(lib.periodMark({}, "start", "2026-10-12"), { patch: { last_period_start: "2026-10-12", last_period_end: null } }, "经期:来了 = 今天开始、清掉结束");
  ok(lib.periodMark({ last_period_start: "2026-10-12" }, "start", "2026-10-12").err, "经期:同一天再点来了 = 拒");
  eq(lib.periodMark({ last_period_start: "2026-10-08" }, "end", "2026-10-12"), { patch: { last_period_end: "2026-10-12" } }, "经期:结束了 = 今天结束");
  ok(lib.periodMark({}, "end", "2026-10-12").err, "经期:没开始就点结束 = 拒");
  ok(lib.periodMark({ last_period_start: "2026-10-08", last_period_end: "2026-10-11" }, "end", "2026-10-12").err, "经期:这次已经结束了 = 拒");
  ok(lib.periodMark({}, "eat", "2026-10-12").err, "经期:只认 start / end");
  eq(lib.periodOut({ on: true, effective: { last_period_start: "2026-09-18", last_period_end: "2026-09-24", cycle_days: 29, period_length: 6 }, runtime: { notes: { x: 1 } } }),
     { ok: true, cfg: { last_period_start: "2026-09-18", last_period_end: "2026-09-24", cycle_days: 29, period_length: 6 } }, "经期:只交四个数,不交 shim 的运行时笔记");
  eq(lib.periodOut({ on: false, effective: {} }), { ok: false }, "经期:shim 没开 = ok:false");
}
{
  const lib = await import("./dwell-lib.mjs");
  const s = lib.cacheSample({ input_tokens: 3, cache_creation_input_tokens: 357, cache_read_input_tokens: 92226, output_tokens: 99 }, 100);
  eq(s.pct, 99.6, "Health:命中率 = 读缓存 ÷ (读 + 新写 + 没命中),线上真数 99.6%");
  eq(lib.cacheSample(null), null, "Health:shim 还没有 lastUsage = 不记");
  eq(lib.cacheSample({ input_tokens: 0, cache_read_input_tokens: 0 }), null, "Health:全是 0 = 不记(别除以 0)");
  ok(lib.usageSig({ input_tokens: 3, output_tokens: 9 }) !== lib.usageSig({ input_tokens: 3, output_tokens: 10 }), "Health:换了一轮指纹就变");
  eq(lib.usageSig(null), "", "Health:没有 = 空指纹");
  eq(lib.judgeService("music", { status: "ok", loggedIn: false }), { ok: false, detail: "Logged out — scan to log in" }, "Health:网易云登录掉了 = 不健康,并提示去扫码");
  eq(lib.judgeService("him", { ok: true, auth: "direct" }).ok, true, "Health:他 ok + 直连 = 好");
  eq(lib.judgeService("imessage", { ok: true, connected: false }).ok, false, "Health:iMessage 断线 = 不好");
  eq(lib.judgeService("memory", null), { ok: false, detail: "No response" }, "Health:没答上来 = 不好,如实写");
  eq(lib.judgeService("memory", { status: "ok", buckets: 393 }).detail, "393 memories", "Health:记忆库写桶数");
  const out = lib.cacheOut([{ at: 10, pct: 50 }, { at: 99000, pct: 98 }, { at: 99500, pct: 100 }], 100000);
  eq([out.n24, out.avg24, out.last.pct, out.series.length], [2, 99, 100, 2], "Health:只算 24 小时内的、平均、最近一笔");
  eq(lib.VITALS_SERVICES.length, 8, "Health:八个可选服务(他 / 记忆库 / TG / iMessage / 邮箱 / 浏览器 / 网易云 / 耳朵),没配地址的不显示");
}
{
  const lib = await import("./dwell-lib.mjs");
  const G = 1024 ** 3;
  const row = (at, busy, tot, avail, rx, ct) => ({ at, cpu: [busy, tot], ncpu: 2, load: [0.2, 0.1, 0], mem: [4 * G, avail, 2 * G, 2 * G], disk: [60 * G, 16 * G], net: [rx, rx / 2], up: 100, ct });
  const c = (cpu, mem, lim) => [cpu, mem, lim, 0, 0, "running", "Up 3 hours"];
  const rows = [
    row(1000, 0, 0, 3 * G, 0, { "kelivo-shim": c(1, 280e6, 3.9 * G) }),
    row(1060, 30, 200, 2 * G, 60000, { "kelivo-shim": c(2, 300e6, 3.9 * G), "browser-hands": c(0.5, 330e6, 1.5 * G) }),
    row(1120, 40, 400, 2 * G, 66000, { "kelivo-shim": c(4, 320e6, 3.9 * G), "browser-hands": c(0.5, 340e6, 1.5 * G) }),
  ];
  const d = lib.hostSeries(rows, 1150, "1h", 6);
  eq([d.ok, d.stale, d.cur.cpu, d.peak.cpu], [true, false, 5, 15], "Server:CPU = 两行之间「忙」的增量 ÷ 总增量;当前是最后一段,峰值取范围内最高");
  eq([d.cur.memUsed, d.cur.memTotal, d.cur.swapUsed], [2 * G, 4 * G, 0], "Server:内存用量 = 总 − 可用(不是 free,页缓存不算占用)");
  eq([d.cur.rx, d.cur.tx, d.totals.rx], [100, 50, 66000], "Server:网速 = 累计字节两两相减 ÷ 秒;范围内合计");
  eq(d.services.map(s => [s.name, s.limit]), [["Browser", 1.5 * G], ["Him", null]], "Server:服务按内存从大到小;上限 ≈ 整机内存 = 没设上限(null),浏览器那个 1.5G 是真上限");
  eq(d.series.cpu.filter(x => x != null).length, 1, "Server:同一段里的点取平均(两笔落进同一格只出一个数)");
  const gap = lib.hostSeries([row(1000, 0, 100, G, 0, {}), row(2000, 50, 200, G, 10, {})], 2100, "1h", 6);
  eq([gap.cur.cpu, gap.series.cpu.every(x => x == null)], [null, true], "Server:两行隔了十几分钟(机器重启 / 定时器停过)不连线、不编速率");
  const boot = lib.hostSeries([row(1000, 900, 1000, G, 5000, {}), row(1060, 10, 100, G, 100, {})], 1100, "1h", 6);
  eq([boot.cur.cpu, boot.cur.rx], [null, null], "Server:计数倒退(机器刚重启)= 这一段不算,不出负数");
  eq(lib.hostSeries(rows, 1150 + 400, "1h").stale, true, "Server:最新一行超过 5 分钟 = stale(采集停了),网页如实标出");
  eq(lib.hostSeries([], 1, "1h"), { ok: false, why: "No data yet" }, "Server:还没有数 = ok:false");
  eq(lib.hostSeries(rows, 1150, "乱写").range, "24h", "Server:不认识的范围按 24h");
}
{
  const lib = await import("./dwell-lib.mjs");
  const taken = ["s01", "自制1", "委屈巴巴"];
  eq(lib.cleanStickerName("  盯——​ ", taken), { tag: "盯——" }, "贴纸名:去不可见字符、去首尾空白");
  eq(lib.cleanStickerName("〔坏〕[名]", taken), { tag: "坏名" }, "贴纸名:去掉会切断「〔贴纸：…〕」的括号");
  eq(lib.cleanStickerName("", taken), { tag: "" }, "贴纸名:空 = 不起名(自动自制N)");
  ok(!!lib.cleanStickerName("委屈巴巴", taken).err, "贴纸名:和别的贴纸重名不收");
  eq(lib.cleanStickerName("委屈巴巴", taken, ["委屈巴巴"]), { tag: "委屈巴巴" }, "贴纸名:改回自己用过的名字可以");
  ok(!!lib.cleanStickerName("自制7", taken).err, "贴纸名:「自制+数字」留给没起名的");
  eq(Array.from(lib.cleanStickerName("一二三四五六七八九十一二三四五六七八九十多出来", []).tag).length, 20, "贴纸名:最多 20 字");
}
{
  const lib = await import("./dwell-lib.mjs");
  eq(lib.stickerForHim(true, "盯老婆"), { text: "(她发来一个贴纸:盯老婆)", withImage: false }, "贴纸给他:内置的只给名字,不给图");
  eq(lib.stickerForHim(false, "委屈巴巴"), { text: "(她发来一个贴纸:委屈巴巴)", withImage: false }, "贴纸给他:她起过名的只给名字");
  eq(lib.stickerForHim(false, "自制3"), { text: "(她发来一个贴纸)", withImage: true }, "贴纸给他:没起名的照旧给图");
  eq(lib.stickerForHim(false, null).withImage, true, "贴纸给他:找不到名字就给图");
}
{

  const lib = await import("./dwell-lib.mjs");
  const g = makeMsgLog();
  g.addMe("我在"); g.addGu("第一句\n第二句\n第三句"); const gu = g.last(); g.addMe("嗯");
  g.addHide(gu, 1, "第二句");
  const s1 = g.slice().msgs;
  eq(s1.length, 3, "删消息:只删一颗泡时那条还在");
  eq(s1[1].hide, [1], "删消息:带上删的是第几颗");
  eq(lib.searchMsgs(s1, "第二句").length, 0, "删消息:删掉的那颗搜不到");
  eq(lib.searchMsgs(s1, "第三句").length, 1, "删消息:同一条里没删的照样搜得到");
  g.addHide(g.find(1));
  eq(g.slice().msgs.map((m) => m.text), ["第一句\n第二句\n第三句", "嗯"], "删消息:整条删就不出现");
  eq(g.count(), 5, "删消息:账本一条没少(三条话 + 两笔 hide)");

  const h = makeMsgLog(); h.addMe("先来一条占位");
  const src = makeMsgLog(); src.restore([{ kind: "me", text: "我在", at: 5 }, { kind: "gu", text: "a\nb", at: 6 }]);
  src.addHide(src.find(2), 0, "a"); src.addHide(src.find(1));
  const saved = [{ kind: "me", text: "我在", at: 5 }, { kind: "gu", text: "a\nb", at: 6 }, src.find(3), src.find(4)].map((m) => JSON.parse(JSON.stringify(m)));
  h.restore(saved);
  const s2 = h.slice().msgs;
  eq(s2.map((m) => m.text), ["先来一条占位", "a\nb"], "删消息:重启后(seq 变了)整条删的照样藏");
  eq(s2[1].hide, [0], "删消息:重启后删了哪颗照样记得");
  eq(lib.hideKey({ kind: "gu", at: 6, text: "a" }) === lib.hideKey({ kind: "gu", at: 6, text: "b" }), false, "删消息:指纹分得清不同的字");
}

{
  const lib = await import("./dwell-lib.mjs");
  eq(lib.mergeTurn([{ text: "a", mine: 1 }, { text: "", images: ["i"], mine: 2 }, { text: "b", mine: 3 }]),
     { text: "a\nb", images: ["i"], mine: 3 }, "合并:文字换行拼、图带上、反应贴最后一句");
  eq(lib.mergeTurn([]), { text: "", images: [], mine: null }, "合并:空的不炸");
  eq(["归档", "归档。", "换窗口吧", "开新窗口", "新窗口！"].map(lib.detectReset), ["reset", "reset", "reset", "reset", "reset"], "重置词:认得出");
  eq(["今天不想归档那些旧东西了", "你好", ""].map(lib.detectReset), [null, null, null], "重置词:长句里提到不算");
  eq(["晚安", "晚安呀宝宝"].map(lib.detectReset), [null, null], "重置词:晚安刻意不算(老是误触发)");

}
console.log(fail ? `\n✗ ${pass} 过 / ${fail} 挂` : `\n✓ 全绿：${pass} 项`);
process.exit(fail ? 1 : 0);
