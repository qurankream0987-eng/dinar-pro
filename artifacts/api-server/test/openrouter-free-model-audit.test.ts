import test from "node:test";
import assert from "node:assert/strict";
import { isApprovedFreeOpenRouterModel } from "../src/ai/free-model-policy";

/**
 * Public OpenRouter endpoint metadata snapshot retrieved 2026-11-13.
 * Compatibility evidence only; these fixtures do not authorize live calls or change defaults.
 */
type CatalogFixture = {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  supports_tool_choice?: { required?: boolean };
};

const snapshot: CatalogFixture[] = [
  {
    id: "google/gemma-4-31b-it:free",
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools", "tool_choice", "response_format"],
    supports_tool_choice: { required: true },
  },
  {
    id: "google/gemma-4-26b-a4b-it:free",
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools", "tool_choice", "response_format"],
    supports_tool_choice: { required: true },
  },
  {
    id: "liquid/lfm-3-1.7b:free",
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools", "tool_choice", "structured_outputs"],
    supports_tool_choice: { required: true },
  },
  {
    id: "baidu/ernie-5.5-flash-preview:free",
    pricing: { prompt: "0", completion: "0" },
    supported_parameters: ["tools", "tool_choice", "structured_outputs"],
    supports_tool_choice: { required: true },
  },
];

function hasRequiredDinarCatalogMetadata(model: CatalogFixture): boolean {
  const prompt = model.pricing?.prompt;
  const completion = model.pricing?.completion;
  const zero = (price: string | undefined) =>
    price !== undefined && price.trim() !== "" && Number.isFinite(Number(price)) && Number(price) === 0;
  return (
    model.id.endsWith(":free") &&
    zero(prompt) &&
    zero(completion) &&
    model.supported_parameters?.includes("tools") === true &&
    model.supported_parameters.includes("tool_choice") &&
    model.supports_tool_choice?.required === true
  );
}

await test("catalog eligibility requires exact free pricing and required DINAR tool support", () => {
  assert.deepEqual(snapshot.filter(hasRequiredDinarCatalogMetadata).map(({ id }) => id), [
    "google/gemma-4-31b-it:free",
    "google/gemma-4-26b-a4b-it:free",
    "liquid/lfm-3-1.7b:free",
    "baidu/ernie-5.5-flash-preview:free",
  ]);

  const gemma = snapshot[0]!;
  assert.equal(hasRequiredDinarCatalogMetadata({ ...gemma, pricing: { completion: "0" } }), false, "missing prompt price fails closed");
  assert.equal(hasRequiredDinarCatalogMetadata({ ...gemma, pricing: { prompt: "0" } }), false, "missing completion price fails closed");
  assert.equal(hasRequiredDinarCatalogMetadata({ ...gemma, pricing: { prompt: "0.0000001", completion: "0" } }), false, "nonzero prompt price fails");
  assert.equal(hasRequiredDinarCatalogMetadata({ ...gemma, pricing: { prompt: "0", completion: "0.0000001" } }), false, "nonzero completion price fails");
  assert.equal(hasRequiredDinarCatalogMetadata({ ...gemma, id: "google/gemma-4-31b-it" }), false, "paid/base IDs are not free variants");
  assert.equal(hasRequiredDinarCatalogMetadata({ ...gemma, id: "openrouter/free" }), false, "dynamic router aliases are not exact model IDs");
  assert.equal(hasRequiredDinarCatalogMetadata({ ...gemma, supported_parameters: ["tool_choice"] }), false, "missing tools support fails");
  assert.equal(hasRequiredDinarCatalogMetadata({ ...gemma, supported_parameters: ["tools"] }), false, "missing tool-choice support fails");
  assert.equal(hasRequiredDinarCatalogMetadata({ ...gemma, supports_tool_choice: { required: false } }), false, "auto-only tool choice fails");
});

await test("metadata compatibility does not expand DINAR's exact owner-reviewed allowlist", () => {
  const approved = ["google/gemma-4-31b-it:free", "google/gemma-4-26b-a4b-it:free"];
  const env = { DINAR_APPROVED_FREE_OPENROUTER_MODELS: approved.join(",") } as NodeJS.ProcessEnv;
  const emptyEnv = {} as NodeJS.ProcessEnv;

  for (const model of snapshot) {
    assert.equal(isApprovedFreeOpenRouterModel("OPENROUTER", model.id, env), approved.includes(model.id), model.id);
    assert.equal(isApprovedFreeOpenRouterModel("OPENROUTER", model.id, emptyEnv), false, "metadata alone must not activate a candidate");
  }
  assert.equal(
    isApprovedFreeOpenRouterModel("OPENROUTER", "openrouter/free", { ...env, DINAR_APPROVED_FREE_OPENROUTER_MODELS: "openrouter/free" } as NodeJS.ProcessEnv),
    false,
    "the dynamic alias stays rejected even if it appears in the environment list",
  );
  assert.equal(isApprovedFreeOpenRouterModel("OPENAI_COMPATIBLE", approved[0]!, env), false, "another provider cannot use this allowlist");
});
