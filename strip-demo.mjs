
import fs from "node:fs";

const MARK = "演示模式";

export function stripDemo(src) {
  const at = src.indexOf(MARK);
  if (at < 0) return { text: src, removed: false, why: "没找到演示块（可能上游已删）" };

  const start = src.lastIndexOf("/*", at);
  if (start < 0) return { text: src, removed: false, why: "找到标记却找不到注释开头" };

  const fetchAt = src.indexOf("window.fetch =", at);
  if (fetchAt < 0) return { text: src, removed: false, why: "找到注释却没有 window.fetch，形状变了" };
  const end = src.indexOf("})();", fetchAt);
  if (end < 0) throw new Error("找到开头找不到结尾——停下，别猜");

  const text = src.slice(0, start)
    + "/* 演示拦截块已由 strip-demo.mjs 删除——真数据走同源 api/ */\n"
    + src.slice(end + "})();".length);
  return { text, removed: true, why: "" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , inp, out] = process.argv;
  if (!inp || !out) { console.error("用法：node strip-demo.mjs <输入> <输出>"); process.exit(2); }
  const r = stripDemo(fs.readFileSync(inp, "utf8"));
  console.log(r.removed ? "演示拦截块已删。" : `！${r.why}`);
  if (r.text.includes("window.fetch =")) {
    console.error("！删完文件里仍有 window.fetch 改写，停下,别上线");
    process.exit(1);
  }
  fs.writeFileSync(out, r.text);
}
