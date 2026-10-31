/**
 * The future-operation contracts (operation-contracts.ts) with an in-memory test double standing
 * in for Qoder's backend. No finance, refund, policy or support backend is implemented or called.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  confirmationFromUser,
  operationAuthority,
  operationOutcomeText,
  parseOperationRequest,
  registerOperationAuthority,
  submitConfirmedOperation,
  type OperationAuthority,
  type OperationReceipt,
  type OperationReview,
  type UserConfirmation,
} from "../src/ai/operation-contracts";

const request = { operation: "REFUND_REQUEST", actorId: "user_1", marketId: "JO", target: { kind: "ORDER", id: "order_1" }, reasonCode: "NOT_RECEIVED", idempotencyKey: "turn:conv_1:msg_1" };

function double() {
  const submitted = new Map<string, OperationReceipt>();
  const calls = { review: 0, submit: 0 };
  const authority: OperationAuthority = {
    operation: "REFUND_REQUEST",
    async review(input) {
      calls.review++;
      if (input.target.id !== "order_1" || input.actorId !== "user_1") return { refused: true, code: "NOT_FOUND" };
      return { reviewId: "rev_1", operation: input.operation, actorId: input.actorId, target: input.target, idempotencyKey: input.idempotencyKey, facts: [{ label: "المبلغ", value: "12.500 JOD", source: "SERVER_RECORD" }], expiresAt: new Date(Date.now() + 60_000).toISOString(), requiresConfirmation: true };
    },
    async submit(review) {
      calls.submit++;
      const existing = submitted.get(review.idempotencyKey);
      if (existing) return existing;
      const receipt: OperationReceipt = { receiptId: `rcp_${submitted.size + 1}`, operation: review.operation, status: "SUBMITTED", recordedAt: new Date().toISOString(), facts: review.facts };
      submitted.set(review.idempotencyKey, receipt);
      return receipt;
    },
  };
  return { authority, calls, submitted };
}
let unregister: () => void = () => undefined;
beforeEach(() => unregister());

await test("OC-01 nothing is available until an owner registers an authority; the refusal changes nothing", async () => {
  const parsed = parseOperationRequest(request);
  assert.equal(parsed.ok, true);
  const review = await operationAuthority("REFUND_REQUEST").review((parsed as any).request);
  assert.deepEqual(review, { refused: true, code: "NOT_AVAILABLE" });
  assert.match(operationOutcomeText("REFUND_REQUEST", review as any), /غير متاح.*لم يُنفّذ/u);
});

await test("OC-02 a request carries references only: amounts, currency, status or approval are rejected", () => {
  for (const extra of [{ amountMinor: 1 }, { currency: "USD" }, { status: "REFUNDED" }, { approved: true }, { fee: "0" }])
    assert.deepEqual(parseOperationRequest({ ...request, ...extra }), { ok: false, code: "INVALID" }, JSON.stringify(extra));
  assert.deepEqual(parseOperationRequest({ ...request, target: { kind: "LISTING", id: "x" } }), { ok: false, code: "INVALID" }, "a refund targets an order only");
  assert.deepEqual(parseOperationRequest({ ...request, note: "س".repeat(501) }), { ok: false, code: "INVALID" });
});

await test("OC-03 only the user's own affirmative reply to that exact, unexpired review confirms", async () => {
  const { authority } = double();
  unregister = registerOperationAuthority(authority);
  const review = (await operationAuthority("REFUND_REQUEST").review(request as any)) as OperationReview;
  const base = { actorId: "user_1", reviewId: "rev_1" };
  assert.ok(confirmationFromUser(review, { ...base, utterance: "نعم" }));
  assert.ok(confirmationFromUser(review, { ...base, utterance: "أؤكد." }));
  for (const utterance of ["لا", "نعم لكن غيّر المبلغ إلى 50", "ربما", "الغاء"])
    assert.equal(confirmationFromUser(review, { ...base, utterance }), undefined, utterance);
  assert.equal(confirmationFromUser(review, { ...base, actorId: "user_2", utterance: "نعم" }), undefined, "another actor");
  assert.equal(confirmationFromUser(review, { ...base, reviewId: "rev_other", utterance: "نعم" }), undefined, "another review");
  assert.equal(confirmationFromUser(review, { ...base, utterance: "نعم", now: new Date(Date.now() + 120_000) }), undefined, "expired");
});

await test("OC-04 submit needs a matching confirmation, is idempotent, and success is said only from a receipt", async () => {
  const { authority, calls, submitted } = double();
  unregister = registerOperationAuthority(authority);
  const review = (await operationAuthority("REFUND_REQUEST").review(request as any)) as OperationReview;
  assert.deepEqual(await submitConfirmedOperation(review, undefined), { refused: true, code: "UNCONFIRMED" });
  const forged = { reviewId: "rev_1", actorId: "user_2", confirmedAt: new Date().toISOString() } as unknown as UserConfirmation;
  assert.deepEqual(await submitConfirmedOperation(review, forged), { refused: true, code: "UNCONFIRMED" });
  assert.equal(calls.submit, 0, "nothing reached the authority without the user's confirmation");
  const confirmation = confirmationFromUser(review, { actorId: "user_1", reviewId: "rev_1", utterance: "نعم" });
  const first = await submitConfirmedOperation(review, confirmation);
  const again = await submitConfirmedOperation(review, confirmation);
  assert.deepEqual(again, first, "a repeat returns the first receipt");
  assert.equal(submitted.size, 1, "exactly one recorded request");
  const text = operationOutcomeText("REFUND_REQUEST", first);
  assert.match(text, /سُجّل طلب الاسترداد \(رقم rcp_1\)/u);
  assert.match(text, /ليس استردادًا تمّ/u, "a refund request is never described as a completed refund");
  assert.deepEqual(await submitConfirmedOperation(review, confirmation, new Date(Date.now() + 120_000)), { refused: true, code: "EXPIRED" });
});

await test("OC-05 a stranger's target is not found, and registration is scoped to its operation", async () => {
  const { authority } = double();
  unregister = registerOperationAuthority(authority);
  assert.deepEqual(await operationAuthority("REFUND_REQUEST").review({ ...(request as any), actorId: "user_2" }), { refused: true, code: "NOT_FOUND" });
  assert.deepEqual(await operationAuthority("DISPUTE_OPEN").review({ ...(request as any), operation: "DISPUTE_OPEN" }), { refused: true, code: "NOT_AVAILABLE" });
  unregister();
  assert.deepEqual(await operationAuthority("REFUND_REQUEST").review(request as any), { refused: true, code: "NOT_AVAILABLE" });
});
