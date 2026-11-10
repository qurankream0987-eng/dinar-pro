// Emoji never render in assistant answers (DINAR uses its own SVG marks); code stays verbatim.
import assert from "node:assert/strict";
import test from "node:test";
import { parseRichText, stripEmoji } from "../src/features/ai/rich-text";

test("emoji are removed from answer text", () => {
  for (const [input, expected] of [
    ["أهلاً وسهلاً! 👋 أنا دينار", "أهلاً وسهلاً! أنا دينار"],
    ["### 🚀 البداية", "### البداية"],
    ["- ✅ تم", "- تم"],
    ["  - 👉 فرعي", "  - فرعي"],
    ["👨‍👩‍👧 عائلة 🇯🇴", "عائلة"],
    ["👍🏽 تمام 1️⃣", "تمام"],
    ["© 2026 ™", "© 2026 ™"],
    ["شو بتحب؟ 🙂", "شو بتحب؟"],
  ]) assert.equal(stripEmoji(input!), expected);
});

test("code blocks keep their characters", () => {
  const [block] = parseRichText("```js\nconsole.log('🎉')\n```");
  assert.equal(block!.kind, "code");
  assert.ok((block as { code: string }).code.includes("🎉"));
});

test("a heading that was only an emoji prefix stays a heading", () => {
  const [block] = parseRichText("### 🚀 البداية");
  assert.equal(block!.kind, "heading");
});
