/**
 * Conformance checks any real OperationAuthority (Qoder W07–W12) must pass before it is registered
 * (src/ai/operation-contracts.ts). It drives only the contract, so it runs unchanged against the
 * in-memory double here and against a real backend later. The authority is registered in this
 * process only for the duration of the check and always unregistered afterwards.
 *
 * Required behaviour:
 *  1. review() is read-only: calling it twice changes nothing the authority later reports.
 *  2. A stranger's target is NOT_FOUND (never NOT_ALLOWED, which would reveal it exists).
 *  3. Every review fact is SERVER_RECORD; the review requires confirmation and expires.
 *  4. submit() is idempotent by idempotencyKey: a repeat returns the same receipt.
 *  5. A receipt is SUBMITTED or ANSWERED — never a claim that money moved ("REFUNDED", "PAID").
 *  6. submitConfirmedOperation refuses before the authority without a matching user confirmation.
 */
import assert from "node:assert/strict";
import {
  confirmationFromUser,
  registerOperationAuthority,
  submitConfirmedOperation,
  type OperationAuthority,
  type OperationRequest,
  type OperationReview,
} from "../src/ai/operation-contracts";

export type ConformanceFixture = {
  /** A request by the target's owner that the authority accepts for review. */
  owned: OperationRequest;
  /** The same target requested by another account. */
  stranger: OperationRequest;
  /** Counts the authority's writes (submissions) as it records them. */
  writes: () => Promise<number>;
};

export async function assertOperationAuthorityConformance(authority: OperationAuthority, fixture: ConformanceFixture): Promise<string[]> {
  const unregister = registerOperationAuthority(authority);
  try {
    return await conformance(authority, fixture);
  } finally {
    unregister();
  }
}

async function conformance(authority: OperationAuthority, fixture: ConformanceFixture): Promise<string[]> {
  const checked: string[] = [];
  const writesBefore = await fixture.writes();
  const first = await authority.review(fixture.owned);
  const second = await authority.review(fixture.owned);
  assert.ok(!("refused" in first) && !("refused" in second), "the owner's request is reviewable");
  assert.equal(await fixture.writes(), writesBefore, "review() never writes");
  checked.push("review is read-only");

  assert.deepEqual(await authority.review(fixture.stranger), { refused: true, code: "NOT_FOUND" }, "a stranger gets NOT_FOUND");
  checked.push("stranger is NOT_FOUND");

  const review = first as OperationReview;
  assert.equal(review.requiresConfirmation, true);
  assert.ok(Date.parse(review.expiresAt) > Date.now(), "the review expires in the future");
  assert.ok(review.facts.every((fact) => fact.source === "SERVER_RECORD"), "every fact comes from the authority's records");
  checked.push("facts are server records; review expires");

  assert.deepEqual(await submitConfirmedOperation(review, undefined), { refused: true, code: "UNCONFIRMED" });
  assert.equal(await fixture.writes(), writesBefore, "nothing reaches the authority without the user's confirmation");
  checked.push("no write without confirmation");

  const confirmation = confirmationFromUser(review, { actorId: review.actorId, reviewId: review.reviewId, utterance: "نعم" });
  const receipt = await submitConfirmedOperation(review, confirmation);
  const again = await submitConfirmedOperation(review, confirmation);
  assert.ok(!("refused" in receipt), `the confirmed operation is recorded: ${JSON.stringify(receipt)}`);
  assert.deepEqual(again, receipt, "a repeat returns the first receipt");
  assert.equal(await fixture.writes(), writesBefore + 1, "exactly one write");
  checked.push("idempotent single write");

  assert.ok(["SUBMITTED", "ANSWERED"].includes((receipt as { status: string }).status), "a receipt never claims money moved");
  checked.push("receipt never claims settlement");
  return checked;
}
