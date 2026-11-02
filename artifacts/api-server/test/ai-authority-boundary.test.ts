/**
 * Claude 01, phase 05: model output cannot reach financial or order authority. The model's read
 * tools are party-scoped and its write-shaped tools only prepare pending actions; chat actions
 * all wait for the user's confirmation and none of them captures, refunds, cancels, settles,
 * changes commission or completes delivery. A change that widens this boundary must fail here
 * and be reviewed deliberately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "@workspace/db";
import {
  MODEL_LOOP_TOOL_ALLOWLIST,
  aiToolRegistry,
  executeRegisteredTool,
  modelToolDefinitions,
  ToolRejectedError,
} from "../src/ai/tool-registry";
import { CAPABILITY_NAMES, CAPABILITY_REGISTRY } from "../src/ai/capability-registry";
import { modelCapabilityToolDefinitions } from "../src/ai/model-capability-tools";
import { ACTION_REGISTRY } from "../src/ai/action-foundation";

test("the model sees the three F01 reads plus every F02 prepare/read, and no direct writer", () => {
  const names = modelToolDefinitions().map((definition: any) => definition.function?.name ?? definition.name).sort();
  assert.deepEqual(names, [
    "compareListings", "getResource", "openSurface",
    "prepareCartChange", "prepareInquiryMessage", "prepareListingDraft", "prepareNegotiationProposal",
    "readBusinessInquiries", "readCart", "readFulfillment", "readInventory", "readNegotiationStatus",
    "readOrders", "requestPublicationReview", "reviewCheckout", "searchListings",
  ]);
  assert.deepEqual([...MODEL_LOOP_TOOL_ALLOWLIST].sort(), ["compareListings", "getResource", "searchListings"],
    "the bounded turn loop still advertises exactly the three F01 marketplace reads");
  assert.equal(aiToolRegistry.compareListings?.exposedToModel, true);
  assert.equal(aiToolRegistry.compareListings?.idempotency, "READ_ONLY");
  assert.deepEqual(aiToolRegistry.compareListings?.permissions, ["marketplace.read"]);
  assert.equal(aiToolRegistry.addToCart?.exposedToModel, false, "addToCart runs only from confirmed user actions");
  assert.equal(names.includes("addToCart"), false, "the direct cart writer is never a model tool");
  for (const tool of Object.values(aiToolRegistry)) {
    const writes = tool.permissions.filter((permission) => permission !== "marketplace.read");
    assert.deepEqual(writes, tool.name === "addToCart" ? ["marketplace.cart.write"] : [], tool.name);
  }
});

test("every advertised capability is registered, non-admin and approved before any mutation", () => {
  const advertised = modelToolDefinitions().map((definition: any) => definition.function?.name ?? definition.name);
  const toolNames = CAPABILITY_NAMES.map((name) => CAPABILITY_REGISTRY[name].toolName);
  for (const name of advertised.filter((candidate) => candidate !== "openSurface"))
    assert.ok(toolNames.includes(name), `${name} maps to a capability`);
  for (const name of CAPABILITY_NAMES) {
    const definition = CAPABILITY_REGISTRY[name];
    assert.equal((definition.actors as readonly string[]).includes("ADMIN"), false, `${name} grants no admin`);
    assert.doesNotMatch(name, /ADMIN|CAPTURE|REFUND|SETTLE|COMMISSION|PAYOUT/i, name);
    if (definition.mutation !== "READ_ONLY") assert.equal(definition.confirmation, "USER_CONFIRMATION", name);
  }
  assert.equal(CAPABILITY_REGISTRY.prepareCartMutation.mutation, "MUTATING");
  assert.equal(CAPABILITY_REGISTRY.prepareCartMutation.toolName, "prepareCartChange");
  assert.equal(advertised.includes("addToCart"), false);
});

test("seller-only capabilities are not advertised to a buyer role and vice versa", () => {
  const buyer = modelCapabilityToolDefinitions(["BUYER"]).map((definition) => definition.name);
  const seller = modelCapabilityToolDefinitions(["SELLER"]).map((definition) => definition.name);
  for (const name of ["readInventory", "prepareListingDraft", "requestPublicationReview"])
    assert.equal(buyer.includes(name), false, `${name} is seller-only`);
  for (const name of ["readCart", "prepareCartChange", "reviewCheckout", "readFulfillment"])
    assert.equal(seller.includes(name), false, `${name} is buyer-only`);
  for (const name of ["readBusinessInquiries", "prepareInquiryMessage", "readNegotiationStatus", "prepareNegotiationProposal", "readOrders"]) {
    assert.equal(buyer.includes(name), true, name);
    assert.equal(seller.includes(name), true, name);
  }
  assert.equal(modelCapabilityToolDefinitions(["BUYER"]).length, 9);
  assert.equal(modelCapabilityToolDefinitions(["SELLER"]).length, 6);
});

test("a model-proposed financial or order tool is rejected before anything runs", async () => {
  for (const name of ["capturePayment", "refundPayment", "cancelOrder", "setCommission", "markDelivered", "confirmDelivery", "createOrder", "resolveDispute", "createPaymentIntent"])
    await assert.rejects(
      executeRegisteredTool(name, JSON.stringify({ orderId: "any", amountMinor: 1 }), { conversationId: "c", market: {} as any, actorId: "u" }),
      ToolRejectedError,
      name,
    );
});

test("every chat action waits for the user's confirmation and none holds financial authority", () => {
  const actions = Object.keys(ACTION_REGISTRY).sort();
  assert.deepEqual(actions, [
    "ACCEPT_DELIVERY", "ACCEPT_NEGOTIATION", "ADD_TO_CART", "COUNTER_NEGOTIATION", "CREATE_PAYMENT_INTENT",
    "CREATE_PROVIDER_CONNECTION", "PLACE_ORDER", "PUBLISH_LISTING", "REJECT_NEGOTIATION", "REQUEST_BEST_PRICE",
    "REVOKE_PROVIDER_CONNECTION", "ROTATE_PROVIDER_CREDENTIAL", "SEND_INQUIRY_MESSAGE", "SEND_NEGOTIATION_OFFER",
    "SUBMIT_DRIVER_PROFILE", "SWITCH_MARKET", "UPDATE_DISPLAY_NAME", "UPDATE_LISTING_PRICE", "WITHDRAW_NEGOTIATION",
  ]);
  for (const [name, definition] of Object.entries(ACTION_REGISTRY)) {
    assert.equal(definition.requiresConfirmation, true, `${name} requires confirmation`);
    assert.doesNotMatch(name, /CAPTURE|REFUND|COMMISSION|CANCEL|SETTLE|PAYOUT|DELIVERED|CONFIRM_RECEIPT|DISPUTE|OBLIGATION/, name);
  }
});

test("the AI layer imports no capture, refund, settlement or terminal-order authority", () => {
  const aiDir = path.resolve(import.meta.dirname ?? ".", "../src/ai");
  const forbidden = /\b(receivePaymentWebhook|createRefundRequest|attachProviderRefundId|recordRefundObligation|resolveRefundObligation|applyTerminalOrderAccounting|releaseExpiredReservations|expireOrderReservation|reconcilePayments|recordCourierCommissionAccrual)\b/;
  const offenders: string[] = [];
  for (const file of readdirSync(aiDir).filter((name) => name.endsWith(".ts")))
    if (forbidden.test(readFileSync(path.join(aiDir, file), "utf8"))) offenders.push(file);
  assert.deepEqual(offenders, []);
  // The single payment entry point is a confirmed, owner-checked SIMULATION_ONLY intent.
  const foundation = readFileSync(path.join(aiDir, "action-foundation.ts"), "utf8");
  assert.match(foundation, /import \{ createTestPaymentIntent, paymentSimulationEnabled \} from "\.\.\/routes\/payments";/);
});

test.after(() => pool.end());
