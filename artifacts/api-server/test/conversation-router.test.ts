import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONVERSATION_ACTION_REGISTRY,
  CONVERSATION_SURFACE_TOKENS,
  isRegisteredConversationSurface,
  modelOpenSurfaceSchema,
  resolveConversationActionId,
  conversationActionMessage,
} from "@workspace/api-zod/conversation-runtime";
import { ACTION_REGISTRY } from "../src/ai/action-foundation";
import { resolveConversationRoute } from "../src/ai/conversation-router";
import { conversationHistory, interpretWithModel, MAX_SERVER_CONTEXT, redactForModel } from "../src/ai/model-turn";
import type { ConversationModelGateway, ModelMessage } from "../src/ai/model-gateway";
import { conversationGuidance } from "../src/ai/conversation-guidance";
import { promotionIntent, searchTerms } from "../src/ai/intent";
import { hasExplicitMarketplaceSearchIntent } from "../src/ai/marketplace-intent";
import { isGeneralRequest } from "../src/ai/listing-draft";
import { normalizeNumberWords } from "../src/ai/arabic-normalization";

test("canonical action authorities stay aligned with shared conversation contracts", () => {
  const actionEntries = Object.entries(ACTION_REGISTRY);
  const conversationEntries = Object.entries(CONVERSATION_ACTION_REGISTRY);
  assert.equal(new Set(actionEntries.map(([id]) => id)).size, actionEntries.length);
  assert.equal(new Set(conversationEntries.map(([id]) => id)).size, conversationEntries.length);

  for (const [actionId, definition] of actionEntries) {
    const contract =
      CONVERSATION_ACTION_REGISTRY[
        actionId as keyof typeof CONVERSATION_ACTION_REGISTRY
      ];
    assert.ok(contract, `${actionId} is missing its conversation contract`);
    assert.equal(contract.actionId, actionId);
    assert.equal(contract.routeKind, "STATE_CHANGING_ACTION");
    assert.equal(contract.authorization, "AUTHENTICATED");
    assert.equal(typeof contract.marketRequired, "boolean");
    assert.equal(contract.confirmationRequired, definition.requiresConfirmation);
    assert.ok(contract.canonicalService.trim(), `${actionId} has no canonical service`);
  }

  for (const [actionId, contract] of conversationEntries) {
    assert.equal(contract.actionId, actionId, `${actionId} has a mismatched contract id`);
    assert.ok(contract.canonicalService.trim(), `${actionId} has no canonical service`);
    if (contract.canonicalService.startsWith("action-foundation:")) {
      const canonicalAction = contract.canonicalService.slice("action-foundation:".length);
      assert.ok(
        Object.prototype.hasOwnProperty.call(ACTION_REGISTRY, canonicalAction),
        `${actionId} points to missing canonical action ${canonicalAction}`,
      );
    }
  }
});

test("seller service requests distinguish capability, market, and authentication state", () => {
  const decision = resolveConversationRoute({
    message: "أنا مصور وأبي أعرض خدمتي",
    marketId: "jo",
    marketActive: true,
  });

  assert.equal(decision.actionId, "CREATE_SERVICE_DRAFT");
  assert.equal(decision.capabilityId, "SELL_SERVICE");
  assert.equal(decision.capabilityAvailability, "AVAILABLE");
  assert.equal(decision.marketState, "ACTIVE");
  assert.equal(decision.authenticationState, "GUEST");
  assert.equal(decision.kind, "AUTH_REQUIRED");
});

test("a guest asking to buy a numbered result is routed to authentication", () => {
  const message = "أبي الثاني";
  assert.equal(resolveConversationActionId(message), "BUY_LISTING");
  const decision = resolveConversationRoute({
    message,
    marketId: "jo",
    marketActive: true,
  });
  assert.equal(decision.kind, "AUTH_REQUIRED");
  assert.equal(decision.actionId, "BUY_LISTING");
});

test("order status remains available while live driver location is provider-gated", () => {
  const order = resolveConversationRoute({
    message: "وين طلبي",
    actorId: "buyer-1",
    marketId: "jo",
    marketActive: false,
  });
  assert.equal(order.kind, "READ_ACTION");
  assert.equal(order.actionId, "TRACK_ORDER");
  assert.equal(order.marketState, "INACTIVE");

  const gps = resolveConversationRoute({
    message: "وين المندوب على الخريطة",
    actorId: "buyer-1",
    marketId: "jo",
    marketActive: true,
  });
  assert.equal(gps.kind, "PROVIDER_REQUIRED");
  assert.equal(gps.actionId, "LIVE_DRIVER_LOCATION");
  assert.equal(gps.capabilityAvailability, "PROVIDER_NOT_CONFIGURED");
  assert.equal(gps.providerState, "NOT_CONFIGURED");

  const configuredGps = resolveConversationRoute({
    message: "وين المندوب على الخريطة",
    actorId: "buyer-1",
    marketId: "jo",
    marketActive: true,
    liveDriverLocationConfigured: true,
  });
  assert.equal(configuredGps.kind, "READ_ACTION");
  assert.equal(configuredGps.providerState, "CONFIGURED");
});

test("search requires a selected market without conflating that with capability state", () => {
  const decision = resolveConversationRoute({
    message: "ابحث عن جوال",
    actorId: "buyer-1",
  });

  assert.equal(decision.kind, "MARKET_REQUIRED");
  assert.equal(decision.capabilityAvailability, "AVAILABLE");
  assert.equal(decision.marketState, "NOT_SELECTED");
  assert.equal(decision.authenticationState, "AUTHENTICATED");
});

test("ordinary unknown requests remain general conversation, not an unsupported surface", () => {
  const decision = resolveConversationRoute({
    message: "هل ممكن تشرح لي الفرق بين الادخار والاستثمار؟",
    marketId: "jo",
    marketActive: true,
  });

  assert.equal(decision.kind, "CHAT");
  assert.equal(decision.actionId, "GENERAL_CHAT");
  assert.equal(modelOpenSurfaceSchema.safeParse("UNSUPPORTED").success, false);
  assert.equal(
    resolveConversationActionId("هل ممكن تشرح لي الفرق بين الادخار والاستثمار؟"),
    undefined,
  );
});

test("a word shared with commerce does not turn a general question into a listing action or a gate", () => {
  // General questions: no action, so no sign-in or market gate in front of the answer.
  for (const message of [
    "ارجع لموضوع الطاقة الشمسية",
    "ارجع للموضوع السابق",
    "رجع لي ملخص كلامنا",
    "قارن بين بايثون وجافاسكربت",
    "قارن بين الادخار والاستثمار",
    "كيف أبيع فكرتي للمستثمرين؟",
    "اشرح لي كيف تعمل الصور الرقمية",
    "كيف أبيع ملابس؟",
  ]) {
    assert.equal(resolveConversationActionId(message), undefined, message);
    assert.equal(resolveConversationRoute({ message }).kind, "CHAT", message);
  }
  // DINAR's own listings, results and features keep their actions.
  for (const [message, actionId] of [
    ["رجع الإعلان", "RESUME_LISTING"],
    ["استأنف الإعلان رقم 2", "RESUME_LISTING"],
    ["رجعه", "RESUME_LISTING"],
    ["قارن الأول والثاني", "COMPARE_LISTINGS"],
    ["قارن بين الأول والثالث", "COMPARE_LISTINGS"],
    ["قارنهم", "COMPARE_LISTINGS"],
    ["أيهم أفضل؟", "COMPARE_LISTINGS"],
    ["كيف أروّج إعلاني؟", "VIEW_TUTORIAL"],
    ["علمني كيف أنشر أول إعلان", "VIEW_TUTORIAL"],
    ["كيف أبيع؟", "VIEW_TUTORIAL"],
    ["كيف أبيع في دينار؟", "VIEW_TUTORIAL"],
    ["كيف أصور منتجي للبيع؟", "VIEW_TUTORIAL"],
  ] as const) assert.equal(resolveConversationActionId(message), actionId, message);
});

test("older user topics stay available to the model beyond the recent-turn window", () => {
  const history = [
    { actor: "USER", body: "دينار اشرح لي الطاقة الشمسية" },
    { actor: "ASSISTANT", body: "الطاقة الشمسية تحوّل ضوء الشمس إلى كهرباء." },
    ...Array.from({ length: 6 }, (_, index) => [
      { actor: "USER", body: `طلب تجاري ${index}` },
      { actor: "ASSISTANT", body: `رد ${index}` },
    ]).flat(),
  ];
  const { recent, earlierUserTopics } = conversationHistory({ history });
  assert.equal(recent.length, 10);
  assert.ok(!recent.some((turn) => String(turn.content).includes("الطاقة الشمسية")));
  // Only the user's own words, oldest first; never the assistant's replies.
  assert.deepEqual(earlierUserTopics, ["دينار اشرح لي الطاقة الشمسية", "طلب تجاري 0"]);
  assert.deepEqual(conversationHistory({ history: history.slice(-4) }).earlierUserTopics, []);
  // Hints are bounded and redacted like every other model input.
  const long = conversationHistory({
    history: [{ actor: "USER", body: `اتصل على 0791234567 ${"ك".repeat(400)}` }, ...history.slice(-10)],
  }).earlierUserTopics[0];
  assert.ok(long.length <= 160 && !long.includes("0791234567"), long);
});

test("model redaction keeps report dates and still removes phone numbers", () => {
  assert.equal(redactForModel("مبيعات (2026-10-01 – 2026-10-23، UTC)"), "مبيعات (2026-10-01 – 2026-10-23، UTC)");
  assert.equal(redactForModel("آخر طلب 2026-10-23"), "آخر طلب 2026-10-23");
  assert.equal(redactForModel("رقمي 0791234567"), "رقمي [رقم محذوف]");
  assert.equal(redactForModel("رقمي 079-123-4567"), "رقمي [رقم محذوف]");
  assert.equal(redactForModel("+962 79 123 4567"), "[رقم محذوف]");
});

test("the model always receives the whole server guidance, with providers and authority first", () => {
  for (const [countryCode, marketAvailable, authenticated] of [["JO", true, true], ["KW", false, false], ["ZZ", true, false]] as const) {
    const json = JSON.stringify(conversationGuidance({ id: countryCode, countryCode, currencyCode: "USD" }, marketAvailable, authenticated));
    assert.ok(json.length <= MAX_SERVER_CONTEXT, `${countryCode}: ${json.length} > ${MAX_SERVER_CONTEXT}`);
    const parsed = JSON.parse(json);
    assert.equal(parsed.providers.externalDelivery, "NOT_CONFIGURED");
    assert.equal(parsed.providers.payments, "SIMULATION_ONLY");
    assert.equal(parsed.authority.highImpact, "EXPLICIT_USER_CONFIRMATION_REQUIRED");
    assert.ok(json.indexOf('"providers"') < json.indexOf('"capabilities"'));
  }
});

test("guest topic hints: sanitized, bounded, merged with stored ones and measured", async () => {
  const merged = conversationHistory({
    history: [{ actor: "USER", body: "سؤال مخزن قديم" }, ...Array.from({ length: 10 }, (_, i) => ({ actor: i % 2 ? "ASSISTANT" : "USER", body: `دور ${i}` }))],
    earlierUserTopics: ["  اشرح الطاقة   الشمسية  ", "اتصل 0791234567", ...Array.from({ length: 6 }, (_, i) => `موضوع ${i} ${"ن".repeat(300)}`)],
  }).earlierUserTopics;
  assert.equal(merged.length, 6);
  assert.equal(merged.at(-1), "سؤال مخزن قديم", "stored topics are the most recent hints");
  assert.ok(merged.every((topic) => topic.length <= 160 && !topic.includes("0791234567")));

  // Measured overhead per model call: whole guidance plus six full-length hints.
  const sizes: number[] = [];
  const gateway: ConversationModelGateway = {
    async proposeToolCall(input: ModelMessage[]) {
      sizes.push(input.reduce((sum, message) => sum + String(message.content).length, 0));
      return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: "ok" }) };
    },
  };
  const serverContext = conversationGuidance({ id: "JO", countryCode: "JO", currencyCode: "JOD" }, true, false);
  const truncatedGuidance = { truncated: JSON.stringify(serverContext).slice(0, 1000) };
  await interpretWithModel(gateway, "مرحبا", { history: [], serverContext: truncatedGuidance });
  await interpretWithModel(gateway, "مرحبا", { history: [], serverContext });
  await interpretWithModel(gateway, "مرحبا", { history: [], serverContext, earlierUserTopics: Array.from({ length: 6 }, (_, i) => `${i}${"ن".repeat(200)}`) });
  const [before, guidance, hints] = sizes;
  console.log("MODEL_CONTEXT_CHARS", JSON.stringify({ previousTruncatedGuidance: before, fullGuidance: guidance, withSixHints: hints, guidanceOverhead: guidance! - before!, maxHintOverhead: hints! - guidance! }));
  assert.ok(hints! - guidance! <= 1100, "six hints add at most ~1.1 KB");
});

test("shared parsers: address, sell-for-me, activity wants, topic return, clitic numbers, amounts and ids", () => {
  assert.equal(searchTerms("دينار ابحث لي عن ثلاجة"), "ثلاجة");
  assert.equal(searchTerms("يا دينار، دورلي على ايفون 13"), "ايفون 13");
  assert.equal(searchTerms("دينارين ساعة"), "دينارين ساعة", "a word that starts with «دينار» is not the address");
  assert.notEqual(promotionIntent("شلون أقنع مديري يبيع لي فكرة المشروع؟")?.kind, "EXPLAIN");
  assert.equal(promotionIntent("وش يعني روح بيع لي؟")?.kind, "EXPLAIN");
  for (const message of ["أبي أتعلم كيف أصور منتجات احترافية", "بدي افهم الذكاء الاصطناعي", "حاب أسافر تركيا"])
    assert.equal(hasExplicitMarketplaceSearchIntent(message), false, message);
  for (const message of ["أبي ايفون 13", "بدي ثلاجة مستعملة", "أريد أشتري سيارة"])
    assert.equal(hasExplicitMarketplaceSearchIntent(message), true, message);
  for (const message of ["ارجع لموضوع الطاقة الشمسية", "نرجع للموضوع الأول", "back to the topic"]) assert.ok(isGeneralRequest(message), message);
  for (const message of ["رجعنا للجاكيت", "الأرخص", "ايفون 13"]) assert.equal(isGeneralRequest(message), false, message);
  assert.match(normalizeNumberWords("اقل بعشره بالمئه"), /اقل ب 10 بالمئه/u);
  assert.equal(normalizeNumberWords("بين البيوت"), "بين البيوت");
  for (const kept of ["2 500 000 دينار", "1500000 د.ك", "AB-1200-3400-C", "174f6878-7754-4335-a1b2-c3d4e5f60718", "الطلب 2026-10-01"])
    assert.ok(redactForModel(`قيمة ${kept} هنا`).includes(kept), kept);
  for (const phone of ["0791234567", "079-123-4567", "+962 79 123 4567", "5555 1234 99"])
    assert.ok(!redactForModel(`رقمي ${phone}`).includes(phone), phone);
});

test("every wire surface is registered and action buttons use the shared action text", () => {
  assert.ok(CONVERSATION_SURFACE_TOKENS.every(isRegisteredConversationSurface));
  for (const [actionId, definition] of Object.entries(CONVERSATION_ACTION_REGISTRY)) {
    if (!("buttonMessage" in definition)) continue;
    const text = conversationActionMessage(
      actionId as keyof typeof CONVERSATION_ACTION_REGISTRY,
      { position: 2 },
    );
    assert.equal(resolveConversationActionId(text), actionId);
  }
  assert.equal(conversationActionMessage("PROMOTE_LISTING", { position: 2 }), "روّج الإعلان رقم 2");
});
