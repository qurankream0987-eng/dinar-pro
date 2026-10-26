import assert from "node:assert/strict";
import OpenAI from "openai";
import {
  createConversationModelGateway,
  normalizeAIProviderError,
} from "../src/ai/model-gateway";
import { interpretWithModel } from "../src/ai/model-turn";

if (
  process.env.DINAR_RUN_LIVE_OPENROUTER_SMOKE !== "1" ||
  process.env.NODE_ENV !== "development" ||
  process.env.DINAR_AI_PROVIDER !== "OPENROUTER" ||
  !process.env.OPENROUTER_API_KEY
) {
  throw new Error(
    "Live provider smoke requires explicit development-only OpenRouter opt-in.",
  );
}

const gateway = await createConversationModelGateway();
assert.equal(gateway.providerInfo?.provider, "OPENROUTER");
assert.equal(gateway.providerInfo?.requestedModel, "openrouter/free");

const delay = () => new Promise((resolve) => setTimeout(resolve, 1500));
const structuredCases = [
  {
    name: "arabic-chat",
    prompt: "السلام عليكم، كيف أبدأ استخدام دينار؟",
  },
  {
    name: "marketplace-request",
    prompt: "أبحث عن هاتف مستعمل بسعر لا يتجاوز 100 دينار.",
  },
  {
    name: "ambiguous-arabic",
    prompt: "أبي الشيء الذي ذكرته قبل، لكن لم أذكر اسمه.",
  },
  {
    name: "structured-intent",
    prompt: "أريد شراء جوال مستعمل بحد أقصى 100 دينار، وعدد القطع 2.",
  },
];

for (const item of structuredCases) {
  const result = await interpretWithModel(gateway, item.prompt, {}, 25000);
  if (!result.ok) throw new Error(`${item.name} failed: ${result.reason}`);
  assert.ok(result.modelCall.actualModel, `${item.name} reported the actual model`);
  if (item.name === "marketplace-request") {
    assert.ok(result.turn.entities?.item, "marketplace intent extracted an item");
  }
  if (item.name === "ambiguous-arabic") {
    assert.equal(result.turn.responseKind, "CLARIFICATION_REQUIRED");
    assert.notEqual(result.turn.suggestedAction, "SEARCH_LISTINGS");
    assert.equal(result.turn.entities?.item, undefined);
  }
  if (item.name === "structured-intent") {
    assert.equal(result.turn.goal, "BUY");
    assert.ok(result.turn.entities?.item);
    assert.equal(result.turn.entities?.maxPrice, 100);
    assert.equal(result.turn.entities?.quantity, 2);
  }
  console.log(
    JSON.stringify({
      test: item.name,
      provider: result.modelCall.provider,
      requestedModel: result.modelCall.requestedModel,
      actualModel: result.modelCall.actualModel,
      latencyMs: result.modelCall.latencyMs,
      status: "success",
      structuredOutputValid: true,
      responseKind: result.turn.responseKind,
    }),
  );
  await delay();
}

const requestedModel = "openrouter/free";
const startedAt = Date.now();
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});
let description = "";
let descriptionModel: string | undefined;
try {
  const response = await client.chat.completions.create(
    {
      model: requestedModel,
      max_completion_tokens: 8192,
      messages: [
        {
          role: "system",
          content:
            "اكتب وصفًا عربيًا موجزًا لإعلان باستخدام الحقائق التي يذكرها المستخدم فقط. لا تضف مواصفات أو ضمانًا غير مذكور.",
        },
        {
          role: "user",
          content:
            "الحقائق: هاتف سامسونج مستعمل، لونه أسود، يعمل بشكل جيد. أعد الوصف فقط.",
        },
      ],
    },
    { timeout: 25000, maxRetries: 0 },
  );
  description = response.choices[0]?.message.content?.trim() ?? "";
  descriptionModel =
    typeof response.model === "string" &&
    /^[A-Za-z0-9._:/-]{1,120}$/.test(response.model)
      ? response.model
      : undefined;
} catch (error) {
  const normalized = normalizeAIProviderError(
    "OPENROUTER",
    requestedModel,
    error,
    Date.now() - startedAt,
  );
  console.log(
    JSON.stringify({
      test: "listing-description",
      provider: normalized.provider,
      requestedModel,
      latencyMs: normalized.latencyMs,
      httpStatus: normalized.httpStatus,
      failureCode: normalized.code,
      status: "failed",
    }),
  );
  throw new Error(`listing-description failed: ${normalized.code}`);
}

assert.ok(description.length >= 20, "listing description has useful text");
assert.ok(descriptionModel, "listing description reports the actual model");
console.log(
  JSON.stringify({
    test: "listing-description",
    provider: "OPENROUTER",
    requestedModel,
    actualModel: descriptionModel,
    latencyMs: Date.now() - startedAt,
    status: "success",
    generatedCharacters: description.length,
    includedUnsupportedWarrantyClaim: /ضمان|مضمون/u.test(description),
  }),
);
