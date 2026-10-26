import { z } from "zod";
import type { ReviewedListingPhoto } from "../lib/listing-photos";

export const LISTING_IMAGE_POLICY_CODES = ["PROHIBITED_ITEM"] as const;
export type ListingImagePolicyCode =
  (typeof LISTING_IMAGE_POLICY_CODES)[number];

export const LISTING_IMAGE_REVIEW_CANDIDATES = [
  "SAFE",
  "REVIEW_REQUIRED",
  "POTENTIAL_POLICY_MATCH",
  "ANALYSIS_FAILED",
] as const;
export type ListingImageReviewCandidate =
  (typeof LISTING_IMAGE_REVIEW_CANDIDATES)[number];

export const LISTING_IMAGE_POLICY_HIGH_CONFIDENCE = 0.98;
export const LISTING_IMAGE_POLICY_SCHEMA_VERSION = "listing-image-policy-v1";

const ObservationSchema = z
  .object({
    policyCode: z.enum(LISTING_IMAGE_POLICY_CODES),
    confidence: z.number().min(0).max(1),
    evidence: z.string().trim().min(3).max(300),
  })
  .strict();

const ImageCandidateSchema = z
  .object({
    imageIndex: z.number().int().min(0).max(3),
    decisionCandidate: z.enum(LISTING_IMAGE_REVIEW_CANDIDATES),
    observations: z.array(ObservationSchema).max(4),
  })
  .strict();

export const ListingImagePolicyReviewSchema = z
  .object({
    images: z.array(ImageCandidateSchema).min(1).max(4),
  })
  .strict();

export type ListingImagePolicyReviewCandidate = z.infer<
  typeof ListingImagePolicyReviewSchema
>["images"][number];

export type ListingImagePolicyRule = {
  kind: string;
  value: string;
};

export interface ListingImagePolicyReviewProvider {
  review(input: {
    actorId: string;
    marketId: string;
    categoryLabel: string;
    resourceType: string;
    policyVersion: string;
    policyText: string;
    activeProhibitedRules: readonly ListingImagePolicyRule[];
    photos: readonly ReviewedListingPhoto[];
  }): Promise<unknown>;
}

export type ListingImagePolicyDecision =
  | { state: "SAFE" }
  | { state: "REVIEW_REQUIRED" }
  | { state: "POLICY_MATCH"; policyCode: ListingImagePolicyCode }
  | { state: "ANALYSIS_FAILED" };

export class ListingImagePolicyReviewError extends Error {
  readonly status: number;

  constructor(
    readonly code:
      | "IMAGE_REVIEW_REQUIRED"
      | "IMAGE_REVIEW_UNAVAILABLE"
      | ListingImagePolicyCode,
    message: string,
    status: number,
  ) {
    super(message);
    this.name = "ListingImagePolicyReviewError";
    this.status = status;
  }
}

export function imageReviewRequired(
  reason: "DOCUMENT_LIKE" | "AMBIGUOUS",
) {
  const message =
    reason === "DOCUMENT_LIKE"
      ? "لم يُنشر الإعلان. قد تحتوي إحدى الصور على وثيقة رسمية أو بيانات خاصة؛ استبدلها بصورة للمنتج لا تتضمن وثائق أو بيانات ثم أعد المحاولة."
      : "لم يُنشر الإعلان. تحتاج إحدى الصور إلى تعديل أو مراجعة قبل النشر؛ استبدلها أو احذفها ثم أعد المحاولة.";
  return new ListingImagePolicyReviewError(
    "IMAGE_REVIEW_REQUIRED",
    message,
    409,
  );
}

export function imageReviewUnavailable() {
  return new ListingImagePolicyReviewError(
    "IMAGE_REVIEW_UNAVAILABLE",
    "تعذر فحص الصور حاليًا. لم يُنشر الإعلان؛ حاول لاحقًا.",
    503,
  );
}

export function imagePolicyMatched(policyCode: ListingImagePolicyCode) {
  const message =
    "لم يُنشر الإعلان لأن إحدى الصور تتضمن محتوى محظورًا وفق سياسة السوق. احذف الصورة أو استبدلها ثم أعد المحاولة.";
  return new ListingImagePolicyReviewError(policyCode, message, 409);
}

export function parseListingImagePolicyReview(
  raw: unknown,
  expectedImageCount: number,
): ListingImagePolicyReviewCandidate[] | undefined {
  const parsed = ListingImagePolicyReviewSchema.safeParse(raw);
  if (!parsed.success || parsed.data.images.length !== expectedImageCount)
    return undefined;

  const byIndex = new Map<number, ListingImagePolicyReviewCandidate>();
  for (const image of parsed.data.images) {
    if (image.imageIndex >= expectedImageCount || byIndex.has(image.imageIndex))
      return undefined;

    const hasObservation = image.observations.length > 0;
    if (
      (image.decisionCandidate === "SAFE" && hasObservation) ||
      (image.decisionCandidate === "POTENTIAL_POLICY_MATCH" && !hasObservation) ||
      (image.decisionCandidate === "ANALYSIS_FAILED" && hasObservation)
    )
      return undefined;

    byIndex.set(image.imageIndex, image);
  }

  if (byIndex.size !== expectedImageCount) return undefined;
  return Array.from({ length: expectedImageCount }, (_, index) =>
    byIndex.get(index),
  ).filter(
    (image): image is ListingImagePolicyReviewCandidate => image !== undefined,
  );
}

export function decideListingImagePolicyReview(
  candidates: readonly ListingImagePolicyReviewCandidate[],
): ListingImagePolicyDecision {
  if (!candidates.length) return { state: "ANALYSIS_FAILED" };
  if (candidates.some((image) => image.decisionCandidate === "ANALYSIS_FAILED"))
    return { state: "ANALYSIS_FAILED" };

  const highConfidenceMatch = candidates
    .filter((image) => image.decisionCandidate === "POTENTIAL_POLICY_MATCH")
    .flatMap((image) => image.observations)
    .find(
      (observation) =>
        observation.confidence >= LISTING_IMAGE_POLICY_HIGH_CONFIDENCE,
    );
  if (highConfidenceMatch)
    return {
      state: "POLICY_MATCH",
      policyCode: highConfidenceMatch.policyCode,
    };

  if (
    candidates.some(
      (image) =>
        image.decisionCandidate !== "SAFE" || image.observations.length > 0,
    )
  )
    return { state: "REVIEW_REQUIRED" };

  return { state: "SAFE" };
}
