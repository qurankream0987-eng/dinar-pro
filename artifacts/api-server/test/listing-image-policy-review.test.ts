import test from "node:test";
import assert from "node:assert/strict";
import {
  decideListingImagePolicyReview,
  ListingImagePolicyReviewError,
  parseListingImagePolicyReview,
  type ListingImagePolicyReviewProvider,
} from "../src/ai/listing-image-policy-review";
import {
  classifyListingImageOcrText,
  clearLocalListingImageDocumentScreenCacheForTests,
  screenListingImageLocally,
} from "../src/ai/local-listing-image-document-screen";
import { GroqListingImagePolicyReviewer } from "../src/ai/groq-listing-image-policy-reviewer";
import { reviewListingImagesForPublication } from "../src/lib/listing-image-publication-review";
import type OpenAI from "openai";
import type { ReviewedListingPhoto } from "../src/lib/listing-photos";

const syntheticPhotoPath =
  "/objects/listing-photos/seller-test/11111111-1111-4111-8111-111111111111.png";
const syntheticPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function reviewedPhoto(
  objectPath = syntheticPhotoPath,
): ReviewedListingPhoto {
  return {
    objectPath,
    contentType: "image/png",
    generation: "1",
    sha256: "a".repeat(64),
    bytes: syntheticPng,
  };
}

function reviewResponse(
  decisionCandidate: "SAFE" | "REVIEW_REQUIRED" | "POTENTIAL_POLICY_MATCH" | "ANALYSIS_FAILED",
  confidence?: number,
) {
  return {
    images: [
      {
        imageIndex: 0,
        decisionCandidate,
        observations:
          confidence === undefined
            ? []
            : [
                {
                  policyCode: "PROHIBITED_ITEM",
                  confidence,
                  evidence: "Synthetic visible evidence.",
                },
              ],
      },
    ],
  };
}

function publicationInput(
  overrides: Partial<
    Parameters<typeof reviewListingImagesForPublication>[0]
  > = {},
) {
  return {
    ownerId: "seller-test",
    marketId: "SA",
    categoryLabel: "Synthetic category",
    resourceType: "GOODS",
    data: { imageUrl: syntheticPhotoPath },
    policyVersion: "synthetic-policy-v1",
    policyText: "Synthetic prohibited-items policy.",
    activeProhibitedRules: [],
    env: {
      NODE_ENV: "development",
      DINAR_PUBLICATION_IMAGE_REVIEW: "enabled",
    },
    loadPhotos: async () => [reviewedPhoto()],
    localScreen: async () => "NO_TEXT_DETECTED" as const,
    ...overrides,
  };
}

await test("OCR screening flags synthetic English and Arabic identity-document text", () => {
  assert.equal(
    classifyListingImageOcrText("National identity card"),
    "POLICY_SIGNAL_DETECTED",
  );
  assert.equal(
    classifyListingImageOcrText("رقم الهوية الوطنية"),
    "POLICY_SIGNAL_DETECTED",
  );
  assert.equal(
    classifyListingImageOcrText("١٢٣٤٥٦٧٨"),
    "POLICY_SIGNAL_DETECTED",
  );
  assert.equal(classifyListingImageOcrText("Sony WH-1000XM"), "OCR_SUCCESS_WITH_TEXT");
  assert.equal(classifyListingImageOcrText(""), "NO_TEXT_DETECTED");
});

await test("local OCR cache stores only a content-keyed decision, not OCR text", async () => {
  clearLocalListingImageDocumentScreenCacheForTests();
  const sentinel = "Synthetic private document text National identity card";
  let scans = 0;
  const scan = async () => {
    scans += 1;
    return sentinel;
  };
  const first = await screenListingImageLocally(syntheticPng, scan);
  const second = await screenListingImageLocally(syntheticPng, scan);
  assert.equal(first, "POLICY_SIGNAL_DETECTED");
  assert.equal(second, "POLICY_SIGNAL_DETECTED");
  assert.equal(scans, 1);
  assert.equal(JSON.stringify({ first, second }).includes(sentinel), false);
  clearLocalListingImageDocumentScreenCacheForTests();
});

await test("policy-signaling OCR holds the image locally without calling the external reviewer", async () => {
  let externalCalls = 0;
  const reviewer: ListingImagePolicyReviewProvider = {
    async review() {
      externalCalls += 1;
      return reviewResponse("SAFE");
    },
  };

  await assert.rejects(
    reviewListingImagesForPublication(
      publicationInput({
        localScreen: async () => "POLICY_SIGNAL_DETECTED",
        reviewer,
      }),
    ),
    (error: unknown) =>
      error instanceof ListingImagePolicyReviewError &&
      error.code === "IMAGE_REVIEW_REQUIRED" &&
      error.status === 409,
  );
  assert.equal(externalCalls, 0);
});

await test("no-text synthetic photos continue to policy review without a false OCR block", async () => {
  clearLocalListingImageDocumentScreenCacheForTests();
  const localDecision = await screenListingImageLocally(syntheticPng);
  assert.equal(localDecision, "NO_TEXT_DETECTED");

  let externalCalls = 0;
  const reviewer: ListingImagePolicyReviewProvider = {
    async review() {
      externalCalls += 1;
      return reviewResponse("SAFE");
    },
  };
  const approved = await reviewListingImagesForPublication(
    publicationInput({
      reviewer,
      localScreen: (bytes) => screenListingImageLocally(bytes),
    }),
  );
  assert.equal(approved?.[0]?.objectPath, syntheticPhotoPath);
  assert.equal(externalCalls, 1);
  clearLocalListingImageDocumentScreenCacheForTests();
});

await test("OCR technical failures are retryable and never call the external reviewer", async () => {
  clearLocalListingImageDocumentScreenCacheForTests();
  const failed = await screenListingImageLocally(syntheticPng, async () => {
    throw new Error("Synthetic OCR execution failure.");
  });
  assert.equal(failed, "OCR_TECHNICAL_FAILURE");

  let externalCalls = 0;
  const reviewer: ListingImagePolicyReviewProvider = {
    async review() {
      externalCalls += 1;
      return reviewResponse("SAFE");
    },
  };
  await assert.rejects(
    reviewListingImagesForPublication(
      publicationInput({
        reviewer,
        localScreen: async () => failed,
      }),
    ),
    (error: unknown) =>
      error instanceof ListingImagePolicyReviewError &&
      error.code === "IMAGE_REVIEW_UNAVAILABLE" &&
      error.status === 503,
  );
  assert.equal(externalCalls, 0);

  let retryScans = 0;
  const retried = await screenListingImageLocally(syntheticPng, async () => {
    retryScans += 1;
    return "";
  });
  assert.equal(retried, "NO_TEXT_DETECTED");
  assert.equal(retryScans, 1);
  clearLocalListingImageDocumentScreenCacheForTests();
});

await test("OCR text with no policy signal receives a strict SAFE candidate before publication", async () => {
  let externalCalls = 0;
  const reviewer: ListingImagePolicyReviewProvider = {
    async review({ photos, categoryLabel, resourceType, ...context }) {
      externalCalls += 1;
      assert.equal(photos.length, 1);
      assert.equal(categoryLabel, "Synthetic category");
      assert.equal(resourceType, "GOODS");
      assert.equal("data" in context, false);
      return reviewResponse("SAFE");
    },
  };

  const approved = await reviewListingImagesForPublication(
    publicationInput({
      data: {
        imageUrl: syntheticPhotoPath,
        title: "Synthetic private seller text",
      },
      localScreen: async () => "OCR_SUCCESS_WITH_TEXT",
      reviewer,
    }),
  );
  assert.equal(approved?.[0]?.objectPath, syntheticPhotoPath);
  assert.equal(externalCalls, 1);
});

await test("only high-confidence canonical matches block; uncertain candidates require replacement", async () => {
  const high = parseListingImagePolicyReview(
    reviewResponse("POTENTIAL_POLICY_MATCH", 0.99),
    1,
  );
  assert.ok(high);
  assert.deepEqual(decideListingImagePolicyReview(high), {
    state: "POLICY_MATCH",
    policyCode: "PROHIBITED_ITEM",
  });

  const low = parseListingImagePolicyReview(
    reviewResponse("POTENTIAL_POLICY_MATCH", 0.8),
    1,
  );
  assert.ok(low);
  assert.deepEqual(decideListingImagePolicyReview(low), {
    state: "REVIEW_REQUIRED",
  });
});

await test("malformed or failed provider candidates fail closed without exposing evidence", async () => {
  for (const output of [
    { images: [] },
    { images: [{ imageIndex: 0, decisionCandidate: "SAFE", observations: [] , extra: true }] },
    reviewResponse("ANALYSIS_FAILED"),
  ]) {
    const reviewer: ListingImagePolicyReviewProvider = {
      async review() {
        return output;
      },
    };
    await assert.rejects(
      reviewListingImagesForPublication(
        publicationInput({ reviewer }),
      ),
      (error: unknown) =>
        error instanceof ListingImagePolicyReviewError &&
        error.code === "IMAGE_REVIEW_UNAVAILABLE" &&
        !error.message.includes("Synthetic"),
    );
  }
});

await test("provider timeouts become retryable review-unavailable responses", async () => {
  const reviewer: ListingImagePolicyReviewProvider = {
    async review() {
      throw Object.assign(
        new Error("Synthetic private provider timeout sentinel."),
        { name: "APIConnectionTimeoutError" },
      );
    },
  };

  await assert.rejects(
    reviewListingImagesForPublication(publicationInput({ reviewer })),
    (error: unknown) =>
      error instanceof ListingImagePolicyReviewError &&
      error.code === "IMAGE_REVIEW_UNAVAILABLE" &&
      error.status === 503 &&
      !error.message.includes("timeout sentinel"),
  );
});

await test("external HTTPS images are never fetched or sent to image review", async () => {
  let loadCalls = 0;
  let externalCalls = 0;
  const reviewer: ListingImagePolicyReviewProvider = {
    async review() {
      externalCalls += 1;
      return reviewResponse("SAFE");
    },
  };
  await assert.rejects(
    reviewListingImagesForPublication(
      publicationInput({
        data: { imageUrl: "https://images.example.invalid/private.png" },
        loadPhotos: async () => {
          loadCalls += 1;
          return [reviewedPhoto()];
        },
        reviewer,
      }),
    ),
    (error: unknown) =>
      error instanceof ListingImagePolicyReviewError &&
      error.code === "IMAGE_REVIEW_UNAVAILABLE",
  );
  assert.equal(loadCalls, 0);
  assert.equal(externalCalls, 0);
});

await test("Groq request omits owner paths and cached candidates discard model-authored evidence", async () => {
  const evidenceSentinel = "Synthetic private OCR-like evidence";
  let providerCalls = 0;
  let rateLimitCalls = 0;
  let requestArguments: any;
  let requestOptions: any;
  const client = {
    chat: {
      completions: {
        async create(args: any, options: any) {
          providerCalls += 1;
          requestArguments = args;
          requestOptions = options;
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    images: [
                      {
                        imageIndex: 0,
                        decisionCandidate: "POTENTIAL_POLICY_MATCH",
                        observations: [
                          {
                            policyCode: "PROHIBITED_ITEM",
                            confidence: 0.99,
                            evidence: evidenceSentinel,
                          },
                        ],
                      },
                    ],
                  }),
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
  const reviewer = new GroqListingImagePolicyReviewer(
    client,
    {
      provider: "GROQ",
      requestedModel: "qwen/qwen3.8-27b",
      credentialName: "GROQ_API_KEY",
      baseURL: "https://api.groq.com/openai/v1",
    },
    (async () => {
      rateLimitCalls += 1;
      return null;
    }) as any,
  );
  const input = {
    actorId: "seller-test",
    marketId: "SA",
    categoryLabel: "Synthetic category",
    resourceType: "GOODS",
    policyVersion: "synthetic-policy-v1",
    policyText: "Synthetic prohibited-items policy.",
    activeProhibitedRules: [],
    photos: [reviewedPhoto()],
  };
  const first = (await reviewer.review(input)) as any;
  const second = (await reviewer.review({
    ...input,
    actorId: "another-seller",
    photos: [
      reviewedPhoto(
        "/objects/listing-photos/another-seller/22222222-2222-4222-8222-222222222222.png",
      ),
    ],
  })) as any;
  await reviewer.review({
    ...input,
    categoryLabel: "Different synthetic category",
  });

  assert.equal(providerCalls, 2);
  assert.equal(rateLimitCalls, 2);
  assert.deepEqual(requestOptions, { timeout: 20_000, maxRetries: 0 });
  assert.equal(
    JSON.stringify(requestArguments).includes(syntheticPhotoPath),
    false,
  );
  assert.equal(
    JSON.stringify(requestArguments).includes("seller-test"),
    false,
  );
  assert.equal(
    second.images[0].observations[0].evidence,
    "Visible policy evidence.",
  );
  assert.equal(
    JSON.stringify(second).includes(evidenceSentinel),
    false,
  );
  assert.equal(
    first.images[0].observations[0].evidence,
    "Visible policy evidence.",
  );
  assert.equal(JSON.stringify(first).includes(evidenceSentinel), false);
});
