// Temporary Command A probe: which handler claims each message, and does the model see it?
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import app from "../src/app";
import type { ConversationModelGateway, ModelMessage } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";

requireSafeReplitDevelopmentDatabase("BDINAR_G2_ACCEPTANCE");
const calls: string[] = [];
let replyLength = 200;
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages: ModelMessage[]) {
    calls.push(String(messages.at(-1)?.content ?? ""));
    return {
      id: "c", name: "dinarConversationTurn",
      arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.8, conversationalReply: "ج".repeat(replyLength) }),
    };
  },
};
app.locals.conversationModelGateway = gateway;
const server = app.listen(0);
await new Promise<void>((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
let ip = 0;
async function request(path: string, method = "GET", body?: unknown, cookie = "") {
  const res = await fetch(base + path, { method, headers: { ...(method !== "GET" ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(path.startsWith("/auth/") ? { "X-Forwarded-For": `198.51.${ip >> 8}.${(ip++ % 250) + 1}` } : {}) }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
  const raw = await res.text();
  let data: any; try { data = JSON.parse(raw); } catch { data = undefined; }
  return { status: res.status, data, raw, cookie: res.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
let offset = 0;
async function register() {
  const phoneNumber = String(51_300_000 + ((Date.now() + process.pid) % 400_000) + 7 * offset++);
  const started = await request("/auth/phone-verification/challenges", "POST", { phoneCountryCode: "+965", phoneNumber });
  const verified = await request("/auth/phone-verification/challenges/verify", "POST", { challengeId: started.data.challengeId, code: started.data.developmentCode });
  const password = `Probe-${randomUUID().slice(0, 12)}!`;
  const reg = await request("/auth/register", "POST", { displayName: "Probe", accountCountry: "KW", phoneCountryCode: "+965", phoneNumber, password, confirmPassword: password, acceptTerms: true, verificationToken: verified.data.verificationToken });
  await request("/account/market", "PATCH", { marketId: "JO" }, reg.cookie);
  return reg.cookie;
}

test("probe", async () => {
  const sellerCookie = await register();
  const cookie = await register();
  if (process.env.PROBE_SEED) {
    for (const [title, price] of [[`طاولة ${process.env.PROBE_SEED} أولى`, "10"], [`طاولة ${process.env.PROBE_SEED} ثانية`, "20"], [`طاولة ${process.env.PROBE_SEED} ثالثة`, "30"]])
      await request("/listings", "POST", { title, description: `probe ${title}`, category: "أخرى", categoryId: "other", area: "خلدا", city: "عمان", attributes: {}, unitPrice: price, inventoryMode: "LIMITED", availableQuantity: 4, fulfilmentType: "PICKUP", imageUrl: "", imageUrls: [] }, sellerCookie);
  }
  const messages = (process.env.PROBE_MESSAGES ?? "").split("|").filter(Boolean);
  for (const lengthCase of [1500]) {
    replyLength = lengthCase;
    const conv = (await request("/ai/conversations", "POST", {}, cookie)).data.id;
    for (const message of messages) {
      const before = calls.length;
      const res = await fetch(`${base}/ai/conversations/${conv}/turns`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify({ message }) });
      const raw = await res.text();
      const complete = raw.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5))).find((e) => e.type === "complete");
      const block = complete?.assistantMessage?.blocks?.[0];
      console.log(JSON.stringify({ replyLength, message, target: block?.payload?.purchaseReview?.listingId ?? block?.payload?.resourceId ?? null, rs: block?.payload?.resultSetId, status: res.status, model: calls.length > before, tool: complete?.tool, block: block?.type, surface: block?.payload?.surface, adviceKind: block?.payload?.advice?.kind, body: String(complete?.assistantMessage?.body ?? raw.slice(0, 160)).slice(0, 90) }));
    }
  }
  server.close();
});
