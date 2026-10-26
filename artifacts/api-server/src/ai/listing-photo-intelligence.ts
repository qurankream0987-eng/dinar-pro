import { z } from "zod";
import {
  validateCategoryAttributesAgainstSchema,
  type MarketplaceCategorySchema,
} from "@workspace/api-zod/marketplace-schemas";

export type ListingPhotoSuggestion = {
  field: string;
  value: string | number;
  confidence: number;
  imageObjectPath: string;
};

export type ListingPhotoSuggestionStatus =
  | "UNAVAILABLE"
  | "FAILED"
  | "NO_SUGGESTIONS"
  | "SUGGESTIONS";

export const LISTING_PHOTO_UNCERTAINTIES = [
  "CATEGORY_UNCERTAIN",
  "MODEL_UNCERTAIN",
  "VISIBILITY_LIMITED",
  "CONDITION_NOT_VERIFIABLE",
  "SERVICE_CREDENTIALS_NOT_VERIFIABLE",
  "PARTIAL_IMAGE_COVERAGE",
  "OTHER_DETAILS_NEED_SELLER",
] as const;
export type ListingPhotoUncertainty =
  (typeof LISTING_PHOTO_UNCERTAINTIES)[number];

export type ListingPhotoSuggestionResult = {
  status: ListingPhotoSuggestionStatus;
  suggestions: ListingPhotoSuggestion[];
  uncertainties?: ListingPhotoUncertainty[];
};

/**
 * Provider-neutral image boundary. A provider returns untrusted structured candidates;
 * nothing here applies them. When the seller has not chosen a category yet, the provider
 * may propose one as `{ field: "category", value: <registry id> }`.
 */
export interface ListingPhotoSuggestionProvider {
  suggest(input: {
    imageObjectPaths: readonly string[];
    category?: MarketplaceCategorySchema;
    categories: readonly Pick<
      MarketplaceCategorySchema,
      "id" | "label" | "resourceType" | "attributes"
    >[];
    actorId?: string;
  }): Promise<unknown>;
}

/** Test-only adapter for deterministic suggestion and validation coverage. */
export class DeterministicPhotoSuggestionProvider
  implements ListingPhotoSuggestionProvider
{
  constructor(private readonly result: unknown) {}

  async suggest(): Promise<unknown> {
    return structuredClone(this.result);
  }
}

const CandidateSuggestions = z.array(
  z.object({
    field: z.string().min(1).max(80),
    value: z.union([z.string().max(500), z.number().finite()]),
    confidence: z.number().min(0).max(1),
    imageObjectPath: z.string().min(1).max(500),
  }).strict(),
).max(12);

const forbiddenFields =
  /price|amount|cost|stock|quantity|seller|contact|phone|city|area|location|category|title|description|address|storage|capacity|warranty|authentic|ownership|mechanical|defect|modelVariant|license|credential|legal|market|identity/i;

const CandidateEnvelope = z.object({
  suggestions: CandidateSuggestions,
  uncertainties: z.array(z.enum(LISTING_PHOTO_UNCERTAINTIES)).max(7),
}).strict();

export async function collectListingPhotoSuggestions(input: {
  imageObjectPaths: readonly string[];
  schema?: MarketplaceCategorySchema;
  /** Active registry categories; enables a category proposal while the draft has none. */
  categories?: readonly MarketplaceCategorySchema[];
  provider?: ListingPhotoSuggestionProvider;
  actorId?: string;
}): Promise<ListingPhotoSuggestionResult> {
  if (!input.imageObjectPaths.length)
    return { status: "NO_SUGGESTIONS", suggestions: [] };
  const canProposeCategory = !input.schema && Boolean(input.categories?.length);
  if (!input.provider || (!input.schema && !canProposeCategory))
    return { status: "UNAVAILABLE", suggestions: [] };

  try {
    const raw = await input.provider.suggest({
        imageObjectPaths: input.imageObjectPaths,
        ...(input.schema ? { category: input.schema } : {}),
        categories: (input.categories ?? []).map(
          ({ id, label, resourceType, attributes }) => ({
            id,
            label,
            resourceType,
            attributes,
          }),
        ),
        ...(input.actorId ? { actorId: input.actorId } : {}),
      });
    const envelope = CandidateEnvelope.safeParse(raw);
    const candidates = envelope.success
      ? envelope.data.suggestions
      : CandidateSuggestions.parse(raw);
    const uncertainties = envelope.success ? envelope.data.uncertainties : [];
    const attachedPhotos = new Set(input.imageObjectPaths);
    const accepted: ListingPhotoSuggestion[] = [];
    const seenFields = new Set<string>();
    const ranked = [...candidates].sort((a, b) => b.confidence - a.confidence);

    // A proposed category must be an existing registry entry; it stays a suggestion.
    let schema = input.schema;
    if (canProposeCategory) {
      const proposal = ranked.find(
        (candidate) =>
          candidate.field === "category" &&
          attachedPhotos.has(candidate.imageObjectPath) &&
          input.categories!.some((category) => category.id === candidate.value),
      );
      schema = proposal
        ? input.categories!.find((category) => category.id === proposal.value)
        : undefined;
      if (proposal && schema) {
        seenFields.add("category");
        accepted.push({
          field: "category",
          value: schema.label,
          confidence: proposal.confidence,
          imageObjectPath: proposal.imageObjectPath,
        });
      }
    }

    for (const candidate of ranked) {
      if (
        (candidate.field === "title" || candidate.field === "description") &&
        attachedPhotos.has(candidate.imageObjectPath) &&
        !seenFields.has(candidate.field) &&
        typeof candidate.value === "string"
      ) {
        const limit = candidate.field === "title" ? 120 : 500;
        const value = candidate.value.replace(/\s+/gu, " ").trim();
        const containsContact = /(?:\+?\d[\d\s().-]{6,}\d)/u.test(value);
        if (
          value.length >= (candidate.field === "title" ? 3 : 10) &&
          value.length <= limit &&
          !containsContact &&
          !/(?:أصلي|مقلد|ضمان|مكفول|مرخص|مرخّص|(?:بحالة|حالة)\s*(?:ممتاز|جيد|سيئ|جديد)|جديد|مستعمل|\b(?:original|genuine|authentic|new|used|refurbished|warrant(?:y|ed)|licensed|certified|working|functional)\b|\b(?:like[-\s]new|(?:excellent|good|poor|bad)\s+condition)\b)/iu.test(value)
        ) {
          seenFields.add(candidate.field);
          accepted.push({
            field: candidate.field,
            value,
            confidence: candidate.confidence,
            imageObjectPath: candidate.imageObjectPath,
          });
        }
        continue;
      }
      if (!schema) continue;
      const definition = schema.attributes[candidate.field];
      if (
        !definition ||
        forbiddenFields.test(candidate.field) ||
        !attachedPhotos.has(candidate.imageObjectPath) ||
        seenFields.has(candidate.field)
      )
        continue;
      const checked = validateCategoryAttributesAgainstSchema(
        schema.label,
        { [candidate.field]: candidate.value },
        schema,
        false,
      );
      if (!checked.ok) continue;
      const value = checked.attributes[candidate.field];
      if (value === undefined) continue;
      seenFields.add(candidate.field);
      if (
        candidate.field.replace(/^attributes\./u, "").toLowerCase() ===
        "condition"
      )
        uncertainties.push("CONDITION_NOT_VERIFIABLE");
      accepted.push({
        field: candidate.field,
        value,
        confidence: candidate.confidence,
        imageObjectPath: candidate.imageObjectPath,
      });
    }

    const genericCategory = (input.categories ?? []).find(
      (category) =>
        category.id.toLowerCase() === "other" ||
        ["أخرى", "اخرى", "other"].includes(category.label.trim().toLowerCase()),
    );
    if (
      canProposeCategory &&
      genericCategory &&
      !accepted.some((suggestion) => suggestion.field === "category")
    ) {
      accepted.push({
        field: "category",
        value: genericCategory.label,
        confidence: 0.35,
        imageObjectPath: input.imageObjectPaths[0]!,
      });
      uncertainties.push("CATEGORY_UNCERTAIN");
    }

    // Uncertainty codes lower the apparent confidence of candidates rather
    // than being presented as verified facts.
    const uncertaintyPenalty = uncertainties.length ? 0.15 : 0;
    const finalSuggestions = accepted.map((suggestion) => ({
      ...suggestion,
      confidence: Math.max(0, suggestion.confidence - uncertaintyPenalty),
    }));
    return {
      status: finalSuggestions.length ? "SUGGESTIONS" : "NO_SUGGESTIONS",
      suggestions: finalSuggestions,
      ...(uncertainties.length
        ? { uncertainties: [...new Set(uncertainties)] }
        : {}),
    };
  } catch {
    return { status: "FAILED", suggestions: [] };
  }
}
