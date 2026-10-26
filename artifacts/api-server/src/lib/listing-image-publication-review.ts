import {
  decideListingImagePolicyReview,
  imagePolicyMatched,
  imageReviewRequired,
  imageReviewUnavailable,
  parseListingImagePolicyReview,
  type ListingImagePolicyReviewProvider,
  type ListingImagePolicyRule,
} from "../ai/listing-image-policy-review";
import { screenListingImageLocally } from "../ai/local-listing-image-document-screen";
import type { LocalDocumentScreenDecision } from "../ai/local-listing-image-document-screen";
import {
  loadListingPhotosForPolicyReview,
  type ReviewedListingPhoto,
} from "./listing-photos";
import { isOwnedListingPhotoPath } from "./listing-photos";
import { getCommercialPolicy } from "./commercial-policy";
import { holdPlatformAiSpend, settlePlatformAiSpend } from "./ai-spend";

/** The development reviewer's model (groq-listing-image-policy-reviewer). */
const REVIEW_MODEL = "qwen/qwen3.8-27b";

const enabledInDevelopment = (env: NodeJS.ProcessEnv) =>
  env.NODE_ENV === "development" &&
  env.DINAR_PUBLICATION_IMAGE_REVIEW === "enabled";

let defaultReviewer: ListingImagePolicyReviewProvider | null | undefined;

async function configuredReviewer(env: NodeJS.ProcessEnv) {
  if (defaultReviewer === undefined) {
    const { createDevelopmentListingImagePolicyReviewer } = await import(
      "../ai/groq-listing-image-policy-reviewer"
    );
    defaultReviewer =
      createDevelopmentListingImagePolicyReviewer(env) ?? null;
  }
  return defaultReviewer ?? undefined;
}

function listingImageReferences(data: Record<string, unknown>): string[] {
  const values = [data.imageUrl, ...(Array.isArray(data.imageUrls) ? data.imageUrls : [])];
  return values.filter(
    (value): value is string =>
      typeof value === "string" && Boolean(value.trim()),
  );
}

export async function reviewListingImagesForPublication(input: {
  ownerId: string;
  marketId: string;
  categoryLabel: string;
  resourceType: string;
  data: Record<string, unknown>;
  policyVersion: string;
  policyText: string;
  activeProhibitedRules: readonly ListingImagePolicyRule[];
  reviewer?: ListingImagePolicyReviewProvider;
  env?: NodeJS.ProcessEnv;
  localScreen?: (
    bytes: Buffer,
  ) => Promise<LocalDocumentScreenDecision>;
  loadPhotos?: (
    objectPaths: readonly string[],
    ownerId: string,
  ) => Promise<ReviewedListingPhoto[]>;
}): Promise<ReviewedListingPhoto[] | undefined> {
  const env = input.env ?? process.env;
  if (!enabledInDevelopment(env)) return undefined;

  const imageReferences = listingImageReferences(input.data);
  if (!imageReferences.length) return undefined;

  if (!input.policyVersion.trim() || !input.policyText.trim())
    throw imageReviewUnavailable();

  if (
    imageReferences.length > 4 ||
    imageReferences.some(
      (path) => !isOwnedListingPhotoPath(path, input.ownerId),
    )
  )
    throw imageReviewUnavailable();

  let photos: ReviewedListingPhoto[];
  try {
    photos = await (input.loadPhotos ?? loadListingPhotosForPolicyReview)(
      imageReferences,
      input.ownerId,
    );
  } catch {
    throw imageReviewUnavailable();
  }
  if (
    photos.length !== imageReferences.length ||
    photos.some((photo, index) => photo.objectPath !== imageReferences[index])
  )
    throw imageReviewUnavailable();

  const screen = input.localScreen ?? screenListingImageLocally;
  let foundDocumentLikeImage = false;
  try {
    // Finish local screening for the full set before sending any image externally.
    for (const photo of photos) {
      const result = await screen(photo.bytes);
      if (result === "OCR_TECHNICAL_FAILURE")
        throw imageReviewUnavailable();
      if (result === "POLICY_SIGNAL_DETECTED")
        foundDocumentLikeImage = true;
    }
  } catch {
    throw imageReviewUnavailable();
  }
  if (foundDocumentLikeImage)
    throw imageReviewRequired("DOCUMENT_LIKE");

  let reviewer: ListingImagePolicyReviewProvider | undefined;
  try {
    reviewer = input.reviewer ?? (await configuredReviewer(env));
  } catch {
    throw imageReviewUnavailable();
  }
  if (!reviewer) throw imageReviewUnavailable();

  // The configured reviewer is a paid platform call: it holds money under the global cap first
  // and fails closed (review unavailable) when the cap or its configuration refuses it.
  const metered = !input.reviewer;
  const policy = metered ? (await getCommercialPolicy(input.marketId)).aiUsage : undefined;
  const hold = policy ? await holdPlatformAiSpend({ purpose: "PLATFORM_IMAGE_POLICY_REVIEW", resource: "IMAGE_UNDERSTANDING", policy }) : undefined;
  if (hold && !hold.ok) throw imageReviewUnavailable();
  const settle = (outcome: "SUCCESS" | "FAILED") =>
    hold?.ok
      ? settlePlatformAiSpend(hold.hold.id, [{ kind: "PRIMARY", outcome, provider: "GROQ", model: REVIEW_MODEL, imageUnits: photos.length }], policy!.tokenEstimates.IMAGE_UNDERSTANDING).catch(() => undefined)
      : undefined;
  let raw: unknown;
  try {
    raw = await reviewer.review({
      actorId: input.ownerId,
      marketId: input.marketId,
      categoryLabel: input.categoryLabel,
      resourceType: input.resourceType,
      policyVersion: input.policyVersion,
      policyText: input.policyText,
      activeProhibitedRules: input.activeProhibitedRules,
      photos,
    });
  } catch {
    await settle("FAILED");
    throw imageReviewUnavailable();
  }
  await settle("SUCCESS");

  const candidates = parseListingImagePolicyReview(raw, photos.length);
  if (!candidates) throw imageReviewUnavailable();
  const decision = decideListingImagePolicyReview(candidates);
  if (decision.state === "POLICY_MATCH")
    throw imagePolicyMatched(decision.policyCode);
  if (decision.state === "REVIEW_REQUIRED")
    throw imageReviewRequired("AMBIGUOUS");
  if (decision.state === "ANALYSIS_FAILED")
    throw imageReviewUnavailable();

  return photos;
}
