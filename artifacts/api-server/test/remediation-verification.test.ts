import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

test("Remediation-01: AiChat.css and InteractiveCircuitBg.tsx match 600x600 spotlight geometry and coarse-pointer guards", () => {
  const css = readFileSync(path.join(repoRoot, "artifacts/dinar/src/pages/AiChat.css"), "utf8");
  const tsx = readFileSync(path.join(repoRoot, "artifacts/dinar/src/features/ai/InteractiveCircuitBg.tsx"), "utf8");

  assert.ok(css.includes("contain: strict;"), "AiChat.css must include contain: strict on .jassim-circuit-bg");
  assert.ok(css.includes("width: 600px;") && css.includes("height: 600px;"), "AiChat.css must define 600x600 spotlight dimensions");
  assert.ok(css.includes("@media (pointer: coarse), (max-width: 1023px)"), "AiChat.css must disable spotlight & pulse on coarse pointers");
  assert.ok(!css.includes("460px circle at var(--mx) var(--my)"), "Legacy --mx/--my full-screen radial gradient must be removed");
  assert.ok(tsx.includes("translate3d(${Math.round(clientX - 300)}px, ${Math.round(clientY - 300)}px, 0)"), "InteractiveCircuitBg must offset by -300px (half of 600px)");
});

test("Remediation-02: Ai.tsx and ChatComposer.tsx pass stable callback references to memoized components", () => {
  const ai = readFileSync(path.join(repoRoot, "artifacts/dinar/src/pages/Ai.tsx"), "utf8");
  const comp = readFileSync(path.join(repoRoot, "artifacts/dinar/src/features/ai/ChatComposer.tsx"), "utf8");

  assert.ok(ai.includes("const handleComposerSubmit = useStableCallback("), "Ai.tsx must stabilize handleComposerSubmit");
  assert.ok(ai.includes("const handleComposerStop = useStableCallback("), "Ai.tsx must stabilize handleComposerStop");
  assert.ok(ai.includes("const handleComposerPhotosChange = useStableCallback("), "Ai.tsx must stabilize handleComposerPhotosChange");
  assert.ok(ai.includes("onSubmit={handleComposerSubmit}"), "ChatComposer must receive stable handleComposerSubmit");
  assert.ok(ai.includes("onPhotosChange={handleComposerPhotosChange}"), "ChatComposer must receive stable handleComposerPhotosChange");
  assert.ok(comp.includes("const toggleVoiceInput = useStableCallback("), "ChatComposer must stabilize toggleVoiceInput for VoiceWaveformBadge");
});

test("Remediation-03: vite.config.ts keeps charts lazy-loaded and Ai.tsx guards idle preloading with Save-Data & network type", () => {
  const vite = readFileSync(path.join(repoRoot, "artifacts/dinar/vite.config.ts"), "utf8");
  const ai = readFileSync(path.join(repoRoot, "artifacts/dinar/src/pages/Ai.tsx"), "utf8");

  assert.ok(!vite.includes("vendor-charts"), "vite.config.ts must not force recharts/d3 into eager vendor-charts preload");
  assert.ok(ai.includes("if (nav.connection?.saveData) return;"), "Ai.tsx must skip preloading when Save-Data is enabled");
  assert.ok(ai.includes('["slow-2g", "2g", "3g"].includes(nav.connection.effectiveType)'), "Ai.tsx must skip preloading on slow networks");
});

test("Remediation-04: Live conversation thread (RichText + ConversationContent) and conversation-runtime wire interactive cards and speed optimizer", () => {
  const rich = readFileSync(path.join(repoRoot, "artifacts/dinar/src/features/ai/RichText.tsx"), "utf8");
  const conv = readFileSync(path.join(repoRoot, "artifacts/dinar/src/features/ai/ConversationContent.tsx"), "utf8");
  const runtime = readFileSync(path.join(repoRoot, "artifacts/api-server/src/ai/conversation-runtime.ts"), "utf8");

  assert.ok(rich.includes("isLiveInteractiveCardLanguage") && rich.includes("LiveInteractiveCard"), "RichText must render LiveInteractiveCard");
  assert.ok(conv.includes("LiveInteractiveCard"), "ConversationContent must integrate LiveInteractiveCard");
  assert.ok(runtime.includes("classifyFastArabicIntent"), "conversation-runtime.ts must wire classifyFastArabicIntent");
});
