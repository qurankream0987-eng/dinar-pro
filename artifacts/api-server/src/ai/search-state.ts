import { z } from "zod";
import {
  SEARCH_OPERATORS,
  SEARCH_SORTS,
} from "@workspace/api-zod/marketplace-schemas";

/** The one server-side validator for structured search state (tool input, storage, guest preview). */
export const SearchFilterInput = z
  .object({
    field: z.string().min(1).max(80),
    operator: z.enum(SEARCH_OPERATORS),
    value: z.union([z.string().max(200), z.number().finite()]),
  })
  .strict();

export const SearchSortInput = z.enum(SEARCH_SORTS);

export const SearchStateInput = z
  .object({
    search: z.string().max(200),
    categoryId: z.string().max(80).optional(),
    filters: z.array(SearchFilterInput).max(12),
    sort: SearchSortInput.optional(),
  })
  .strict();
