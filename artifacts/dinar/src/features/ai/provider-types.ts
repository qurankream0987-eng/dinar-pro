import { CONVERSATION_SURFACE_FAMILIES } from "@workspace/api-zod/conversation-runtime";

export const PROVIDER_SURFACES = CONVERSATION_SURFACE_FAMILIES.provider;
export type ProviderSurface = (typeof PROVIDER_SURFACES)[number];

type Scope = { scope: string; label: string };
export type Connection = {
  id: string;
  name: string;
  marketId: string;
  status: string;
  scopes: Scope[];
  keyPrefix: string | null;
  mappedListings: number;
  linkedDrivers: number;
  lastSuccessfulSyncAt: string | null;
};
export type ProviderPayload = {
  view: "REVIEW" | "SECRET_ONCE" | "STATUS";
  review?: { actionId: string; lines: string[] };
  limits?: string[];
  connections?: Connection[];
  connection?: Connection | null;
  warning?: string;
};

export function isProviderPayload(value: unknown): value is ProviderPayload {
  const item = value as Partial<ProviderPayload> | undefined;
  return Boolean(item && ["REVIEW", "SECRET_ONCE", "STATUS"].includes(String(item.view)));
}
