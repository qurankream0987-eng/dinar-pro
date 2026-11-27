/**
 * Connect-05 — Smart Recovery & Alternative Partner Planner for Multi-Company Workflows.
 * Never hides already-committed steps; generates explicit user-confirmed recovery options
 * (retry failed step, swap to an alternative verified Connect partner, or request compensation).
 */

export interface ExecutedWorkflowStep {
  index: number;
  partnerId: string;
  partnerName: string;
  capability: string;
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  referenceId?: string;
  errorReason?: string;
}

export interface AlternativePartnerCandidate {
  partnerId: string;
  partnerName: string;
  capability: string;
  marketId: string;
  verified: boolean;
  rating: number;
}

export type RecoveryOption =
  | { kind: "RETRY_FAILED_STEP"; stepIndex: number; labelAr: string; requiresConfirmation: true }
  | { kind: "SWAP_ALTERNATIVE_PARTNER"; stepIndex: number; partnerId: string; partnerName: string; labelAr: string; requiresConfirmation: true }
  | { kind: "REQUEST_COMPENSATION"; committedStepIndices: number[]; labelAr: string; requiresConfirmation: true };

export interface WorkflowRecoveryPlan {
  failedStepIndex: number;
  committedSteps: ExecutedWorkflowStep[];
  options: RecoveryOption[];
}

export function buildWorkflowRecoveryPlan(input: {
  steps: readonly ExecutedWorkflowStep[];
  marketId: string;
  alternatives: readonly AlternativePartnerCandidate[];
}): WorkflowRecoveryPlan | null {
  const failed = input.steps.find((s) => s.status === "FAILED");
  if (!failed) return null;

  const committedSteps = input.steps.filter((s) => s.status === "SUCCEEDED");
  const options: RecoveryOption[] = [
    { kind: "RETRY_FAILED_STEP", stepIndex: failed.index, labelAr: `إعادة محاولة الخطوة مع ${failed.partnerName}`, requiresConfirmation: true },
  ];

  const matchingAlts = input.alternatives
    .filter((alt) => alt.verified && alt.marketId === input.marketId && alt.capability === failed.capability && alt.partnerId !== failed.partnerId)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 2);

  for (const alt of matchingAlts) {
    options.push({ kind: "SWAP_ALTERNATIVE_PARTNER", stepIndex: failed.index, partnerId: alt.partnerId, partnerName: alt.partnerName, labelAr: `استبدال بـ ${alt.partnerName} (تقييم ${alt.rating.toFixed(1)})`, requiresConfirmation: true });
  }

  if (committedSteps.length > 0) {
    options.push({ kind: "REQUEST_COMPENSATION", committedStepIndices: committedSteps.map((s) => s.index), labelAr: "طلب إلغاء أو استرداد الخطوات المكتملة سابقًا", requiresConfirmation: true });
  }

  return { failedStepIndex: failed.index, committedSteps, options };
}
