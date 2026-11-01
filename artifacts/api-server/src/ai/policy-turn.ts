/**
 * Policy review and acceptance in the conversation (W02-ULTRA B10).
 *
 * «راجع الشروط المحدثة» shows a POLICY_REVIEW card: each policy that requires acceptance, its
 * current version, effective date, legal-review status and a link to read it (/policies/:key).
 * The card's result set stores exactly the versions shown. «أوافق على الشروط المحدثة» records
 * acceptance of those versions only, and only while they are still current; «لا أوافق» records
 * nothing. Commerce stays refused by the server gate (lib/policy-gate.ts) until acceptance; the
 * conversation itself continues. Optional privacy consents are never touched here.
 *
 * The model has no part in this: the turn is deterministic and the acceptance is a server write
 * of the reviewed versions, answered with what was actually recorded.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { aiResultSets, db } from "@workspace/db";
import type { marketFor } from "../lib/markets";
import type { PolicyDocument } from "../lib/policies";
import { acceptReviewedPolicies, pendingPolicyAcceptances } from "../lib/policy-gate";
import { requiredAcceptanceVersions } from "../lib/policy-lifecycle";

/** The same required versions the commerce gate and the W09 consent API use. */
const requiredPolicies = async (): Promise<PolicyDocument[]> => (await requiredAcceptanceVersions()).map(({ document, version }) => ({ ...document, version }));
import type { ToolResult } from "./tool-registry";
import { normalizeBuyerText } from "./buyer-turn";

type Market = Awaited<ReturnType<typeof marketFor>>;
type Turn = { tool: string; version: number; result: ToolResult };

const REVIEW_TTL_MS = 30 * 60 * 1000;
const REVIEW =
  /^(?:(?:يا\s+)?دينار\s+)?(?:(?:راجع|اعرض|اعرضلي|وريني|افتح|ابي\s+اراجع|اريد\s+مراجعه)\s+)(?:لي\s+)?(?:ال)?(?:شروط|سياسات|سياسه|اتفاقيه)(?:\s+(?:و\s*)?(?:ال)?(?:خصوصيه|استخدام))?(?:\s+(?:المحدثه|الجديده|الحاليه))?$/u;
const ACCEPT = /^(?:(?:نعم|تمام)\s+)?(?:اوافق|موافق|اقبل|قبلت|وافقت)(?:\s+(?:علي|على))?(?:\s+(?:ال)?(?:شروط|سياسات))?(?:\s+(?:المحدثه|الجديده))?$/u;
const DECLINE = /^(?:لا\s+اوافق|ما\s+اوافق|مو\s+موافق|ارفض|لا\s+اقبل|لاحقا|ليس\s+الان)(?:\s+.*)?$/u;

export type PolicyReviewItem = {
  key: string;
  version: string;
  title: string;
  effectiveDate: string;
  path: string;
  legalReviewPending: boolean;
  accepted: boolean;
};
export type PolicyReview = {
  view: "REVIEW" | "ACCEPTED" | "DECLINED" | "CURRENT";
  reviewId?: string;
  policies: PolicyReviewItem[];
  /** Contract acceptance only; optional privacy consents are managed separately. */
  optionalConsentsUnaffected: true;
};

type StoredReview = { kind: "POLICY_REVIEW"; ownerId: string; status: "PENDING" | "ACCEPTED" | "DECLINED" | "SUPERSEDED"; policies: Array<{ key: string; version: string }> };

const item = (policy: PolicyDocument, accepted: boolean): PolicyReviewItem => ({
  key: policy.key,
  version: policy.version,
  title: policy.titleAr,
  effectiveDate: policy.effectiveDate,
  path: `/policies/${policy.key}`,
  legalReviewPending: policy.legalReviewStatus !== "APPROVED",
  accepted,
});

function card(review: PolicyReview, prompt: string, resultSetId?: string): Turn {
  return {
    tool: "policyReview",
    version: 1,
    result: { kind: "SURFACE", surface: "CLARIFY", query: {}, listings: [], ...(resultSetId ? { resultSetId } : {}), policyReview: review, prompt },
  };
}

async function latestReview(conversationId: string, marketId: string, actorId: string) {
  const sets = await db
    .select()
    .from(aiResultSets)
    .where(and(eq(aiResultSets.conversationId, conversationId), eq(aiResultSets.marketId, marketId)))
    .orderBy(desc(aiResultSets.createdAt))
    .limit(6);
  const found = sets.find((set) => (set.query as Partial<StoredReview>).kind === "POLICY_REVIEW" && (set.query as Partial<StoredReview>).ownerId === actorId);
  if (!found) return undefined;
  const query = found.query as StoredReview;
  const live = query.status === "PENDING" && (!found.expiresAt || found.expiresAt.getTime() > Date.now());
  return { set: found, query, live };
}

async function openReview(input: { conversationId: string; market: Market; actorId: string }, lead = ""): Promise<Turn> {
  const pending = await pendingPolicyAcceptances(input.actorId);
  const required = (await requiredPolicies());
  if (!pending.length)
    return card(
      { view: "CURRENT", policies: required.map((policy) => item(policy, true)), optionalConsentsUnaffected: true },
      `${lead}وافقت على النسخ الحالية من ${required.map((policy) => `«${policy.titleAr}» (${policy.version})`).join(" و")}. لا يلزم شيء الآن.`,
    );
  const previous = await latestReview(input.conversationId, input.market.id, input.actorId);
  if (previous?.live)
    await db.update(aiResultSets).set({ query: { ...previous.query, status: "SUPERSEDED" } }).where(eq(aiResultSets.id, previous.set.id));
  const id = randomUUID();
  const stored: StoredReview = { kind: "POLICY_REVIEW", ownerId: input.actorId, status: "PENDING", policies: pending.map((policy) => ({ key: policy.key, version: policy.version })) };
  await db.insert(aiResultSets).values({ id, conversationId: input.conversationId, marketId: input.market.id, query: stored, resourceIds: [], expiresAt: new Date(Date.now() + REVIEW_TTL_MS) });
  const pendingLegal = pending.some((policy) => policy.legalReviewStatus !== "APPROVED");
  return card(
    { view: "REVIEW", reviewId: id, policies: required.map((policy) => item(policy, !pending.some((entry) => entry.key === policy.key))), optionalConsentsUnaffected: true },
    `${lead}راجع النسخ الحالية قبل الموافقة: ${pending.map((policy) => `«${policy.titleAr}» (نسخة ${policy.version})`).join(" و")}. اقرأها من الروابط، ثم اكتب «أوافق على الشروط المحدثة» أو «لا أوافق». ${pendingLegal ? "هذه النصوص بانتظار المراجعة القانونية. " : ""}الموافقة على الشروط لا تغيّر موافقاتك الاختيارية على الخصوصية.`,
    id,
  );
}

export async function executePolicyTurn(input: {
  conversationId: string;
  message: string;
  market: Market;
  actorId?: string;
}): Promise<Turn | null> {
  if (!input.actorId) return null;
  const actor = { ...input, actorId: input.actorId };
  const text = normalizeBuyerText(input.message);
  if (REVIEW.test(text)) return openReview(actor);

  const accept = ACCEPT.test(text);
  const decline = DECLINE.test(text);
  if (!accept && !decline) return null;
  const review = await latestReview(input.conversationId, input.market.id, input.actorId);
  // «أوافق» / «لا أوافق» answer a review this user saw in this conversation, nothing else.
  if (!review?.live) {
    // A bare «موافق» may confirm another review (an inquiry, a purchase): only a reply that names
    // the terms is about them when no policy review is open.
    if (accept && /(?:شروط|سياسات)/u.test(text))
      return (await pendingPolicyAcceptances(input.actorId)).length
        ? openReview(actor, "لم أسجّل موافقة على نسخة لم تراجعها هنا. ")
        : openReview(actor);
    return null;
  }
  if (decline) {
    await db.update(aiResultSets).set({ query: { ...review.query, status: "DECLINED" } }).where(eq(aiResultSets.id, review.set.id));
    const required = (await requiredPolicies());
    const pending = await pendingPolicyAcceptances(input.actorId);
    return card(
      { view: "DECLINED", policies: required.map((policy) => item(policy, !pending.some((entry) => entry.key === policy.key))), optionalConsentsUnaffected: true },
      "لم أسجّل أي موافقة. يبقى النشر والشراء موقوفين حتى توافق على النسخ الحالية، ويمكنك متابعة المحادثة العامة. اكتب «راجع الشروط المحدثة» متى أردت.",
    );
  }
  const outcome = await acceptReviewedPolicies(input.actorId, review.query.policies);
  if (outcome.stale) {
    await db.update(aiResultSets).set({ query: { ...review.query, status: "SUPERSEDED" } }).where(eq(aiResultSets.id, review.set.id));
    return openReview(actor, "تغيّرت إحدى السياسات بعد مراجعتك، فلم أسجّل الموافقة على النسخة القديمة. ");
  }
  await db.update(aiResultSets).set({ query: { ...review.query, status: "ACCEPTED" } }).where(eq(aiResultSets.id, review.set.id));
  const required = (await requiredPolicies());
  const pending = await pendingPolicyAcceptances(input.actorId);
  return card(
    { view: "ACCEPTED", policies: required.map((policy) => item(policy, !pending.some((entry) => entry.key === policy.key))), optionalConsentsUnaffected: true },
    `سُجّلت موافقتك على ${outcome.accepted.map((entry) => `«${required.find((policy) => policy.key === entry.key)?.titleAr ?? entry.key}» (نسخة ${entry.version})`).join(" و")}. يمكنك الآن النشر والشراء كالمعتاد. موافقاتك الاختيارية على الخصوصية لم تتغير.`,
  );
}
