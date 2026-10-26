/**
 * Claude 01, phase 05: model output cannot reach financial or order authority. The model's tools
 * are read-only except addToCart; chat actions all wait for the user's confirmation and none of
 * them captures, refunds, cancels, settles, changes commission or completes delivery. A change
 * that widens this boundary must fail here and be reviewed deliberately.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "@workspace/db";
import { aiToolRegistry, executeRegisteredTool, modelToolDefinitions, ToolRejectedError } from "../src/ai/tool-registry";
import { ACTION_REGISTRY } from "../src/ai/action-foundation";

test("the model sees only three read-only tools; the one registered writer is not exposed to it", () => {
  const names = modelToolDefinitions().map((definition: any) => definition.function?.name ?? definition.name).sort();
  assert.deepEqual(names, ["getResource", "openSurface", "searchListings"]);
  assert.equal(aiToolRegistry.addToCart?.exposedToModel, false, "addToCart runs only from confirmed user actions");
  for (const tool of Object.values(aiToolRegistry)) {
    const writes = tool.permissions.filter((permission) => permission !== "marketplace.read");
    assert.deepEqual(writes, tool.name === "addToCart" ? ["marketplace.cart.write"] : [], tool.name);
  }
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
