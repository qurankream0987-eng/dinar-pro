export type ExternalAdPlatform = "META_FACEBOOK" | "META_INSTAGRAM" | "GOOGLE_ADS";
export interface ExternalAdPlatformSpec { platform: ExternalAdPlatform; status: "NOT_CONNECTED_YET"; requiredOAuthScopes: string[]; requiredEnvVars: string[]; supportsInChatDraftPreview: true; requiresExplicitOwnerApprovalBeforePublish: true; }

export const EXTERNAL_AD_PLATFORMS: Readonly<Record<ExternalAdPlatform, ExternalAdPlatformSpec>> = {
  META_FACEBOOK: { platform: "META_FACEBOOK", status: "NOT_CONNECTED_YET", requiredOAuthScopes: ["ads_management", "ads_read", "business_management"], requiredEnvVars: ["META_APP_ID", "META_APP_SECRET", "META_WEBHOOK_VERIFY_TOKEN"], supportsInChatDraftPreview: true, requiresExplicitOwnerApprovalBeforePublish: true },
  META_INSTAGRAM: { platform: "META_INSTAGRAM", status: "NOT_CONNECTED_YET", requiredOAuthScopes: ["ads_management", "instagram_basic", "pages_show_list"], requiredEnvVars: ["META_APP_ID", "META_APP_SECRET"], supportsInChatDraftPreview: true, requiresExplicitOwnerApprovalBeforePublish: true },
  GOOGLE_ADS: { platform: "GOOGLE_ADS", status: "NOT_CONNECTED_YET", requiredOAuthScopes: ["https://www.googleapis.com/auth/adwords"], requiredEnvVars: ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"], supportsInChatDraftPreview: true, requiresExplicitOwnerApprovalBeforePublish: true },
};
