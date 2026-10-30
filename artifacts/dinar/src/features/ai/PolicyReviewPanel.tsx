import type { ComposedSurfaceInput, SurfaceAction } from "@workspace/api-zod/surface-composition";
import { ComposedSurfaceView } from "./surface/ComposedSurface";

/**
 * Policy review card (W02-ULTRA B10), composed from the shared primitives. The server decides
 * the versions shown and records an acceptance only of those versions; the buttons are
 * utterances that re-enter the conversation runtime, and «اقرأ» opens the policy page.
 */
export type PolicyReview = {
  view: "REVIEW" | "ACCEPTED" | "DECLINED" | "CURRENT";
  reviewId?: string;
  policies: { key: string; version: string; title: string; effectiveDate: string; path: string; legalReviewPending: boolean; accepted: boolean }[];
  optionalConsentsUnaffected: true;
};

export function isPolicyReview(value: unknown): value is PolicyReview {
  const item = value as Partial<PolicyReview> | undefined;
  return Boolean(item && typeof item.view === "string" && Array.isArray(item.policies));
}

const HEADLINE: Record<PolicyReview["view"], string> = {
  REVIEW: "مراجعة الشروط المحدّثة",
  ACCEPTED: "سُجّلت موافقتك",
  DECLINED: "لم تُسجَّل موافقة",
  CURRENT: "موافقاتك على الشروط محدّثة",
};

export function policyReviewSurface(review: PolicyReview): ComposedSurfaceInput {
  const reviewing = review.view === "REVIEW";
  const actions: SurfaceAction[] = reviewing
    ? [
        { kind: "SEND", label: "أوافق على الشروط المحدّثة", message: "أوافق على الشروط المحدثة", emphasis: "PRIMARY", icon: "CHECK", actionId: "ACCEPT", testId: "button-accept-policies" },
        { kind: "SEND", label: "لا أوافق الآن", message: "لا أوافق", emphasis: "SECONDARY", icon: "CLOSE", actionId: "DECLINE", testId: "button-decline-policies" },
      ]
    : [];
  return {
    version: 1,
    label: HEADLINE[review.view],
    size: "MEDIUM",
    state: reviewing ? "PENDING_REVIEW" : review.view === "DECLINED" ? "CANCELLED" : "CONFIRMED",
    tone: reviewing ? "INFO" : review.view === "DECLINED" ? "WARNING" : "SUCCESS",
    testId: "policy-review",
    status: review.view,
    sections: [
      { type: "header", title: HEADLINE[review.view], icon: "INFO", source: "سياسات DINAR" },
      {
        type: "options",
        label: "السياسات",
        items: review.policies.slice(0, 6).map((policy) => ({
          key: `policy-${policy.key}`.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64),
          title: policy.title,
          subtitle: `نسخة ${policy.version} · سارية من ${policy.effectiveDate}`,
          badge: policy.accepted ? { label: "موافَق عليها", tone: "SUCCESS" } : { label: "بانتظار موافقتك", tone: "WARNING" },
          ...(policy.legalReviewPending ? { facts: [{ label: "المراجعة القانونية", value: "بانتظار الاعتماد" }] } : {}),
          actions: [{ kind: "NAVIGATE", label: `اقرأ ${policy.title}`.slice(0, 80), path: policy.path, emphasis: "QUIET" }],
          status: policy.accepted ? "ACCEPTED" : "PENDING",
          testId: `policy-${policy.key}`.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64),
        })),
      },
      {
        type: "notice",
        tone: reviewing ? "PENDING" : "INFO",
        text: reviewing
          ? "لن تُسجَّل موافقة قبل أن تختار. الموافقة على الشروط منفصلة عن موافقاتك الاختيارية على الخصوصية، ولا تغيّرها."
          : "موافقاتك الاختيارية على الخصوصية لم تتغير.",
      },
      ...(actions.length ? [{ type: "actions" as const, items: actions }] : []),
    ],
  };
}

export function PolicyReviewPanel({ review, active, onSend }: { review: PolicyReview; active: boolean; onSend?: (text: string) => void }) {
  return <ComposedSurfaceView surface={policyReviewSurface(review)} active={active} onSend={onSend} />;
}
