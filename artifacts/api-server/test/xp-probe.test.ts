import { randomUUID } from "node:crypto";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_G3_ACCEPTANCE");
let calls = 0; let lastUser = "";
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages) {
    calls += 1;
    lastUser = String((messages as any[]).filter((m) => m.role === "user").at(-1)?.content ?? "").slice(-80);
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: `MODEL#${calls}` }), usage: { inputTokens: 100, outputTokens: 20 } };
  },
};
app.locals.conversationModelGateway = gateway;
const server = app.listen(0); await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ip = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const res = await fetch(base + path, { method, headers: { ...(method !== "GET" ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.23.0.${++ip}` } : {}) }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
  const raw = await res.text(); let data: any; try { data = JSON.parse(raw); } catch {}
  return { status: res.status, data, raw, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
async function register() {
  const phoneNumber = String(51_700_000 + Math.floor(Math.random() * 90000));
  const s = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const v = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: s.data.challengeId, code: s.data.developmentCode });
  const pw = `Xp-${randomUUID().slice(0, 12)}!`;
  const r = await request("/auth/register", "POST", { displayName: "XP", accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password: pw, confirmPassword: pw, acceptTerms: true, verificationToken: v.data.verificationToken });
  await request("/account/market", "PATCH", { marketId: "JO" }, r.cookie);
  return r.cookie;
}
async function say(cookie: string, conv: string, message: string) {
  const before = calls;
  const res = await fetch(`${base}/ai/conversations/${conv}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ message }) });
  const raw = await res.text();
  const ev = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)));
  const c = ev.find((e) => e.type === "complete");
  const blocks = (c?.assistantMessage?.blocks ?? []).map((b: any) => `${b.type}${b.payload?.surface ? ":" + b.payload.surface : ""}`).join(",");
  console.log(`> ${message}\n   model=${calls > before} blocks=[${blocks}] body=${String(c?.assistantMessage?.body ?? JSON.stringify(ev.at(-1))).replace(/\s+/g, " ").slice(0, 160)}`);
}
const cookie = await register();
const scripts = (process.env.XP_SCRIPTS ?? "").split("||").map((s) => s.split("|"));
for (const lines of scripts) {
  const conv = (await request("/ai/conversations", "POST", {}, cookie)).data.id;
  console.log("=== new conversation");
  for (const line of lines) await say(cookie, conv, line);
}
server.close(); process.exit(0);
