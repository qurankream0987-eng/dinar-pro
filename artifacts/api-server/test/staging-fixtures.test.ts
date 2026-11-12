/** Staging configuration fixtures parse against the real schemas and keep their safety limits. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SubmitAdminCountryLegalEvidenceBody } from "@workspace/api-zod";
import { AiUsagePolicySchema } from "../src/lib/ai-usage-policy";
import { COUNTRY_LEGAL_TOPICS } from "../src/lib/country-legal-readiness";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../deploy/staging/${name}`, import.meta.url), "utf8"));

await test("AI staging policy: valid, $5/month platform cap, unpriced models refused, not self-approved", () => {
  const fixture = read("ai-staging-policy.json");
  const policy = AiUsagePolicySchema.parse(fixture.policy.aiUsage);
  assert.equal(policy.approved, false, "the owner flips approval, not the fixture");
  assert.equal(policy.spend.currencyCode, "USD");
  assert.equal(policy.spend.global.limitMicros, 5_000_000);
  assert.equal(policy.spend.global.period.kind, "CALENDAR_MONTH");
  assert.equal(policy.spend.unpricedModel, "REFUSE");
  for (const cap of [...Object.values(policy.spend.perAccount), ...Object.values(policy.spend.perPlan)])
    assert.ok(cap !== null && cap <= 5_000_000);
  assert.equal(policy.tiers.GUEST.requests.AGENT_MULTI_STEP, 0);
});

await test("JO staging evidence: one synthetic item per topic, never counsel findings", () => {
  const fixture = read("jo-staging-market-evidence.json");
  assert.equal(fixture.marketId, "JO");
  const topics = fixture.evidence.map((item: { topicKey: string }) => item.topicKey);
  assert.equal(new Set(topics).size, topics.length);
  assert.ok(!topics.includes("COUNSEL_FINDINGS"));
  const required = COUNTRY_LEGAL_TOPICS.map(([key]) => key).filter((key) => key !== "COUNSEL_FINDINGS");
  for (const key of required) assert.ok(topics.includes(key), key);
  for (const item of fixture.evidence) {
    SubmitAdminCountryLegalEvidenceBody.strict().parse(item);
    assert.equal(item.evidenceType, "STAGING_SYNTHETIC_PLACEHOLDER");
    assert.match(item.referenceCode, /^STG-JO-/);
  }
});
