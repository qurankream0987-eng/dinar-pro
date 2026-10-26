import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import {
  createDevelopmentListingPhotoSuggestionProvider,
  GroqListingPhotoSuggestionProvider,
  type ListingPhotoVisionCapability,
} from "../src/ai/groq-listing-photo-provider";
import {
  resolveDevelopmentVisionProviderConfiguration,
  type AIProviderConfiguration,
} from "../src/ai/model-gateway";
import type { ObjectStorageService } from "../src/lib/objectStorage";

const configuration: AIProviderConfiguration = {
  provider: "GROQ",
  requestedModel: "qwen/qwen3.8-27b",
  credentialName: "GROQ_API_KEY",
  baseURL: "https://api.groq.com/openai/v1",
};

function imagePaths(count: number) {
  const owner = `seller-${randomUUID()}`;
  return Array.from({ length: count }, (_, index) =>
    `/objects/listing-photos/${owner}/00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}.jpg`,
  );
}

function fakeStorage() {
  const bytes = Buffer.from("test image");
  const storage = {
    getObjectEntityFile: () => ({
      getMetadata: async () => [
        { contentType: "image/jpeg", size: String(bytes.length) },
      ],
      download: async () => [bytes],
    }),
  };
  return storage as unknown as Pick<
    ObjectStorageService,
    "getObjectEntityFile"
  >;
}

function fakeClient(
  respond: (request: Record<string, any>, callIndex: number) => unknown,
) {
  const requests: Record<string, any>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, any>) => {
          requests.push(request);
          return respond(request, requests.length - 1);
        },
      },
    },
  } as unknown as OpenAI;
  return { client, requests };
}

function strictResponse(
  suggestion: {
    field: string;
    value: string | number;
    confidence: number;
    imageIndex: number;
  },
  uncertainties: string[] = [],
) {
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            suggestions: [suggestion],
            uncertainties,
          }),
        },
      },
    ],
  };
}

function photoInput(imageObjectPaths: string[]) {
  return {
    imageObjectPaths,
    categories: [],
    actorId: imageObjectPaths[0]?.split("/")[3] ?? "seller-1",
  };
}

test("the wired photo-Vision adapter is explicitly development-only and fails closed without Groq", () => {
  assert.equal(
    resolveDevelopmentVisionProviderConfiguration({
      NODE_ENV: "production",
      GROQ_API_KEY: "test-groq-key",
    }),
    undefined,
  );
  assert.equal(
    resolveDevelopmentVisionProviderConfiguration({
      NODE_ENV: "development",
      DINAR_VISION_PROVIDER: "OPENAI",
      GROQ_API_KEY: "test-groq-key",
    }),
    undefined,
  );
  assert.equal(
    createDevelopmentListingPhotoSuggestionProvider({
      NODE_ENV: "development",
      DINAR_VISION_PROVIDER: "GROQ",
    }),
    undefined,
    "the adapter is not created without the selected provider credential",
  );
  const configuration = resolveDevelopmentVisionProviderConfiguration({
    NODE_ENV: "development",
    DINAR_VISION_PROVIDER: "GROQ",
    GROQ_API_KEY: "test-groq-key",
  });
  assert.deepEqual(configuration, {
    provider: "GROQ",
    requestedModel: "qwen/qwen3.8-27b",
    credentialName: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
  });
  const configured = createDevelopmentListingPhotoSuggestionProvider({
    NODE_ENV: "development",
    DINAR_VISION_PROVIDER: "GROQ",
    GROQ_API_KEY: "test-groq-key",
  });
  assert.equal(configured?.capability().state, "CONFIGURED");
  assert.doesNotMatch(JSON.stringify(configured?.capability()), /test-groq-key/);
});

test("vision sends four attached photos in bounded strict-schema groups and caches the result", async () => {
  const paths = imagePaths(4);
  const { client, requests } = fakeClient((request, index) => {
    const userMessage = request.messages.find(
      (message: Record<string, any>) => message.role === "user",
    );
    const imageCount = userMessage.content.filter(
      (part: Record<string, any>) => part.type === "image_url",
    ).length;
    assert.ok(imageCount <= 3);
    assert.equal(
      request.response_format.json_schema.strict,
      true,
    );
    return strictResponse({
      field: index === 0 ? "title" : "description",
      value: index === 0 ? "Visible object" : "Visible front and rear details",
      confidence: 0.85,
      imageIndex: 0,
    });
  });
  let rateLimitCalls = 0;
  const provider = new GroqListingPhotoSuggestionProvider(
    client,
    configuration,
    {
      storage: fakeStorage(),
      rateLimiter: async (_identities, windowSeconds, maxAttempts) => {
        rateLimitCalls += 1;
        assert.equal(windowSeconds, 3600);
        assert.equal(maxAttempts, 5);
        return null;
      },
    },
  );

  assert.equal(
    (provider.capability() as ListingPhotoVisionCapability).state,
    "CONFIGURED",
  );
  const result = (await provider.suggest(photoInput(paths))) as {
    suggestions: {
      field: string;
      value: string;
      imageObjectPath: string;
    }[];
    uncertainties: string[];
  };
  assert.equal(requests.length, 2);
  assert.equal(rateLimitCalls, 1);
  assert.deepEqual(
    result.suggestions.map(({ field, imageObjectPath }) => [
      field,
      imageObjectPath,
    ]),
    [
      ["title", paths[0]],
      ["description", paths[3]],
    ],
  );
  assert.deepEqual(result.uncertainties, []);
  assert.equal(provider.capability().state, "HEALTHY");

  await provider.suggest(photoInput(paths));
  assert.equal(requests.length, 2, "cached images are not analyzed twice");
  assert.equal(rateLimitCalls, 1);
});

test("a failed image group does not suppress suggestions from the remaining images", async () => {
  const paths = imagePaths(4);
  let attempts = 0;
  const { client } = fakeClient((_request, index) => {
    attempts += 1;
    if (index === 0) throw new Error("provider failure");
    return strictResponse({
      field: "title",
      value: "Visible object",
      confidence: 0.7,
      imageIndex: 0,
    });
  });
  const provider = new GroqListingPhotoSuggestionProvider(
    client,
    configuration,
    {
      storage: fakeStorage(),
      rateLimiter: async () => null,
    },
  );

  const result = (await provider.suggest(photoInput(paths))) as {
    suggestions: { imageObjectPath: string }[];
    uncertainties: string[];
  };
  assert.equal(attempts, 2);
  assert.equal(result.suggestions[0]?.imageObjectPath, paths[3]);
  assert.deepEqual(result.uncertainties, ["PARTIAL_IMAGE_COVERAGE"]);
});

test("uncertainty output is limited to applicable, seller-facing warnings", async () => {
  const paths = imagePaths(1);
  const { client } = fakeClient(() =>
    strictResponse(
      {
        field: "title",
        value: "Visible object",
        confidence: 0.6,
        imageIndex: 0,
      },
      [
        "CATEGORY_UNCERTAIN",
        "MODEL_UNCERTAIN",
        "VISIBILITY_LIMITED",
        "CONDITION_NOT_VERIFIABLE",
        "SERVICE_CREDENTIALS_NOT_VERIFIABLE",
        "PARTIAL_IMAGE_COVERAGE",
        "OTHER_DETAILS_NEED_SELLER",
      ],
    ),
  );
  const provider = new GroqListingPhotoSuggestionProvider(
    client,
    configuration,
    {
      storage: fakeStorage(),
      rateLimiter: async () => null,
    },
  );

  const result = (await provider.suggest(photoInput(paths))) as {
    uncertainties: string[];
  };
  assert.deepEqual(result.uncertainties, [
    "CATEGORY_UNCERTAIN",
    "MODEL_UNCERTAIN",
    "VISIBILITY_LIMITED",
    "OTHER_DETAILS_NEED_SELLER",
  ]);
});

test("vision rejects an image path owned by another seller before reading storage", async () => {
  const paths = imagePaths(1);
  const { client, requests } = fakeClient(() => strictResponse({
    field: "title",
    value: "Visible object",
    confidence: 0.8,
    imageIndex: 0,
  }));
  let storageReads = 0;
  let rateLimitCalls = 0;
  const provider = new GroqListingPhotoSuggestionProvider(
    client,
    configuration,
    {
      storage: {
        getObjectEntityFile: async () => {
          storageReads += 1;
          return {} as never;
        },
      },
      rateLimiter: async () => {
        rateLimitCalls += 1;
        return null;
      },
    },
  );

  await assert.rejects(
    provider.suggest({ ...photoInput(paths), actorId: "different-seller" }),
    /image path is invalid/,
  );
  assert.equal(storageReads, 0);
  assert.equal(rateLimitCalls, 0);
  assert.equal(requests.length, 0);
});
