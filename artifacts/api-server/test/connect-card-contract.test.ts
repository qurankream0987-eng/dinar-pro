import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UniversalCardSchema,
  DomainOfferSchema,
} from "@workspace/api-zod/connect";
import { searchDomains } from "../src/connect/domains";

const base = {
  version: 1,
  id: "synthetic",
  kind: "EXTERNAL_PRODUCT",
  commerceMode: "EXTERNAL_REFERRAL",
  title: "عرض شريك",
  providerId: "approved-partner",
  facts: [{ label: "المخزون", value: null, source: "UNKNOWN" }],
  price: null,
  availability: "UNKNOWN",
  checkedAt: null,
  sourceLabel: "شريك موثّق",
  externalActions: [
    {
      kind: "EXTERNAL_LINK",
      providerId: "approved-partner",
      targetId: "stored-target",
      intent: "VIEW_ON_PROVIDER",
      label: "افتح لدى المزوّد",
    },
  ],
  disclosure: "الشراء خارج جاسم؛ لا يوجد طلب أو دفع داخلي.",
};
await test("external cards cannot acquire internal order/cart identities or arbitrary URLs", () => {
  assert.equal(UniversalCardSchema.safeParse(base).success, true);
  for (const patch of [
    { internalResourceId: "internal-listing" },
    { kind: "INTERNAL_PRODUCT" },
    { cartAction: "ADD" },
    {
      externalActions: [
        { ...base.externalActions[0], url: "https://evil.example" },
      ],
    },
    {
      externalActions: [
        { ...base.externalActions[0], providerId: "other-partner" },
      ],
    },
    { commerceMode: "EXTERNAL_AUTHORIZED_ACTION" },
  ])
    assert.equal(
      UniversalCardSchema.safeParse({ ...base, ...patch }).success,
      false,
    );
  assert.equal(
    UniversalCardSchema.safeParse({
      ...base,
      kind: "INTERNAL_PRODUCT",
      commerceMode: "INTERNAL_DINAR",
      internalResourceId: "canonical-listing",
      externalActions: [],
      providerId: undefined,
      disclosure: undefined,
    }).success,
    true,
  );
});
await test("unknown facts and unverified money cannot masquerade as verified attributes", () => {
  assert.equal(
    UniversalCardSchema.safeParse({
      ...base,
      facts: [{ label: "المخزون", value: "10", source: "UNKNOWN" }],
    }).success,
    false,
  );
  assert.equal(
    UniversalCardSchema.safeParse({
      ...base,
      price: { amountMinor: 100, currency: "USD", minorUnitScale: 2 },
    }).success,
    false,
  );
});
await test("an unconfigured registrar cannot publish availability, pricing or a checked timestamp", async () => {
  const [unknown] = await searchDomains("myshop.com", []);
  for (const patch of [
    { availability: "AVAILABLE" },
    { premium:true },
    { premium:false },
    {
      registrationPrice: { amountMinor: 1, currency: "USD", minorUnitScale: 2 },
    },
    { lastCheckedAt: new Date().toISOString() },
    { affiliateRelationship: true },
  ])
    assert.equal(
      DomainOfferSchema.safeParse({ ...unknown, ...patch }).success,
      false,
    );
});
await test("card kind cannot mislabel external commerce as internal or omit its canonical identity",()=>{
 assert.equal(UniversalCardSchema.safeParse({...base,commerceMode:"INTERNAL_DINAR",externalActions:[]}).success,false);
 assert.equal(UniversalCardSchema.safeParse({...base,kind:"INTERNAL_SERVICE",commerceMode:"INTERNAL_DINAR",externalActions:[]}).success,false);
 assert.equal(UniversalCardSchema.safeParse({...base,kind:"DOMAIN_REGISTRATION"}).success,false);
});
