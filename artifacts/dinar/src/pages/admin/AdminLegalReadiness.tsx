import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import {
  getGetAdminCountryLegalReadinessQueryKey,
  getGetAdminMarketLegalCapabilitiesQueryKey,
  getGetAdminSecurityIncidentQueryKey,
  getListAdminCountryLegalReadinessQueryKey,
  getGetMarketsQueryKey,
  getListAdminSecurityIncidentsQueryKey,
  useGetAdminCountryLegalReadiness,
  useListAdminCountryLegalReadiness,
  useRecordAdminCountryCounselReview,
  useRequestAdminCountryCounselReview,
  useReviewAdminCountryLegalEvidence,
  useReviewAdminCountryLegalTopic,
  useSubmitAdminCountryLegalEvidence,
  useSuspendAdminCountryReadiness,
  useCreateAdminSecurityIncident,
  useDisableAdminMarketCapability,
  useEnableAdminMarketCapability,
  useGetAdminMarketLegalCapabilities,
  useGetAdminSecurityIncident,
  useGetMarkets,
  useListAdminSecurityIncidents,
  useRecordAdminMarketCapabilityCounselReview,
  useRequestAdminMarketCapabilityReview,
  useTransitionAdminSecurityIncident,
  type AdminMarketLegalCapabilityOverview,
  type CountryLegalReadinessDetail,
  type CountryLegalTopicKey,
  type LegalReadinessMarket,
  type SecurityIncident,
} from "@workspace/api-client-react";
import { useAccount } from "@/account/Account";
import { friendlyError } from "@/lib/errors";
import { Form } from "@/components/ui/form";
import { Button } from "@/ui/Button";
import { EmptyState, ErrorState, InlineAlert, Skeleton } from "@/ui/Feedback";
import { PageHeader } from "@/ui/Layout";

type Capability = AdminMarketLegalCapabilityOverview["capabilities"][number];
type Incident = SecurityIncident;
type IncidentFormValues = {
  summary: string;
  category: "SECURITY" | "PRIVACY" | "AVAILABILITY" | "DATA_INTEGRITY" | "THIRD_PARTY" | "OTHER";
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  affectedSystems: string;
  evidenceReference: string;
};
type CountryEvidenceDraft = {
  topicKey: CountryLegalTopicKey;
  evidenceType: string;
  documentVersion: string;
  referenceCode: string;
  issuedAt: string;
  expiresAt: string;
  idempotencyKey: string;
};
type CountryTopicReviewDraft = {
  disposition: "" | "REQUIRED" | "NOT_REQUIRED" | "NOT_APPLICABLE" | "BLOCKED";
  counselFinding: string;
  qualifications: string;
  requiredAmendments: string;
  officialReference: string;
  effectiveFrom: string;
  effectiveUntil: string;
  evidenceRequirementStatus: "" | "REQUIREMENTS_SET" | "NO_REQUIREMENTS";
  requiredEvidenceTypes: string;
  policyRequirementStatus: "" | "VERSIONS_SET" | "NO_POLICY_REQUIREMENT";
  requiredPolicyVersions: string;
};

const capabilityLabels: Record<string, string> = {
  INFORMATION_ONLY: "المعلومات العامة",
  BROWSING: "تصفح العروض",
  LISTING_PUBLICATION: "نشر العروض",
  TRANSACTIONS: "إنشاء الطلبات",
  CASH_PAYMENT: "الدفع النقدي المباشر",
  ELECTRONIC_PAYMENT: "الدفع الإلكتروني",
  BUSINESS_ONBOARDING: "تسجيل الأنشطة التجارية",
  DELIVERY_OPERATIONS: "التوصيل",
  RESTRICTED_CATEGORIES: "مراجعة التصنيفات المقيدة",
};

const capabilityStatusLabels: Record<string, string> = {
  DISABLED: "مغلق",
  COUNSEL_REVIEW_REQUIRED: "بانتظار مراجعة المستشار",
  OWNER_APPROVAL_REQUIRED: "بانتظار موافقة المالك",
  ENABLED: "مفعّل بقرار داخلي",
  BLOCKED: "محظور",
};

const incidentStatusLabels: Record<string, string> = {
  OPEN: "مفتوح",
  CONTAINED: "تم تسجيل الاحتواء",
  RECOVERED: "تم تسجيل التعافي",
  CLOSED: "مغلق بعد المراجعة",
};

const incidentSeverityLabels: Record<string, string> = {
  LOW: "منخفض",
  MEDIUM: "متوسط",
  HIGH: "مرتفع",
  CRITICAL: "حرج",
};

const countryReviewLabels: Record<string, string> = {
  NOT_REVIEWED: "لم تبدأ المراجعة",
  COUNSEL_REVIEW_REQUIRED: "بانتظار مراجعة المستشار",
  COUNSEL_REVIEWED: "سُجلت المراجعة فقط",
  BLOCKED: "محجوب",
};
const approvalLabels: Record<string, string> = {
  BLOCKED: "محجوب",
  APPROVED: "موافق عليه",
};
const technicalLabels: Record<string, string> = {
  NOT_RUN: "لم يُنفذ",
  PASSED: "اجتاز",
  FAILED: "لم يجتز",
};
const activationLabels: Record<string, string> = {
  DISABLED: "غير مفعّل",
  ACTIVE: "مفعّل داخلياً",
  SUSPENDED: "موقوف",
};

export default function AdminLegalReadinessPage() {
  const { user } = useAccount();
  const queryClient = useQueryClient();
  const [selectedMarket, setSelectedMarket] = useState("");
  const [selectedCountry, setSelectedCountry] = useState("JO");
  const [selectedTopicKey, setSelectedTopicKey] =
    useState<CountryLegalTopicKey>("OPERATING_ENTITY");
  const [selectedIncidentId, setSelectedIncidentId] = useState("");
  const [references, setReferences] = useState<Record<string, string>>({});
  const [incidentNotes, setIncidentNotes] = useState<Record<string, string>>({});
  const [incidentReferences, setIncidentReferences] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [evidenceDraft, setEvidenceDraft] = useState<CountryEvidenceDraft>({
    topicKey: "OPERATING_ENTITY",
    evidenceType: "",
    documentVersion: "",
    referenceCode: "",
    issuedAt: "",
    expiresAt: "",
    idempotencyKey: "",
  });
  const [pendingEvidence, setPendingEvidence] = useState<CountryEvidenceDraft | null>(null);
  const [pendingEvidenceReview, setPendingEvidenceReview] = useState<{
    evidenceId: string;
    outcome: "COUNSEL_REVIEWED" | "REJECTED";
  } | null>(null);
  const [topicReviewDraft, setTopicReviewDraft] = useState<CountryTopicReviewDraft>({
    disposition: "",
    counselFinding: "",
    qualifications: "",
    requiredAmendments: "",
    officialReference: "",
    effectiveFrom: "",
    effectiveUntil: "",
    evidenceRequirementStatus: "",
    requiredEvidenceTypes: "",
    policyRequirementStatus: "",
    requiredPolicyVersions: "",
  });
  const [pendingTopicReview, setPendingTopicReview] = useState<CountryTopicReviewDraft | null>(null);
  const [pendingCountryAction, setPendingCountryAction] = useState<
    "REQUEST_COUNSEL_REVIEW" | "RECORD_COUNSEL_REVIEW" | "SUSPEND" | null
  >(null);
  const [countryReference, setCountryReference] = useState("");
  const incidentForm = useForm<IncidentFormValues>({
    defaultValues: {
      summary: "",
      category: "SECURITY",
      severity: "MEDIUM",
      affectedSystems: "api-server",
      evidenceReference: "",
    },
  });
  const incidentSummary = incidentForm.watch("summary");

  const marketsQuery = useGetMarkets({
    query: { queryKey: getGetMarketsQueryKey(), enabled: user?.role === "ADMIN" },
  });
  const markets = marketsQuery.data ?? [];
  const marketId = selectedMarket || markets[0]?.id || "";
  const countryListQuery = useListAdminCountryLegalReadiness({
    query: {
      queryKey: getListAdminCountryLegalReadinessQueryKey(),
      enabled: user?.role === "ADMIN",
    },
  });
  const countryPackages = countryListQuery.data ?? [];
  const countryId = countryPackages.some((country) => country.marketId === selectedCountry)
    ? selectedCountry
    : countryPackages[0]?.marketId ?? "JO";
  const countryDetailQuery = useGetAdminCountryLegalReadiness(countryId, {
    query: {
      queryKey: getGetAdminCountryLegalReadinessQueryKey(countryId),
      enabled: user?.role === "ADMIN" && Boolean(countryId),
    },
  });
  const countryDetail: CountryLegalReadinessDetail | undefined = countryDetailQuery.data;
  const countryTopics = countryDetail?.topics ?? [];
  const selectedTopic = countryTopics.find((topic) => topic.topicKey === selectedTopicKey);
  useEffect(() => {
    if (!selectedTopic) return;
    setEvidenceDraft((current) => ({ ...current, topicKey: selectedTopic.topicKey }));
    setTopicReviewDraft({
      disposition:
        selectedTopic.disposition === "UNRESOLVED" ? "" : selectedTopic.disposition,
      counselFinding: selectedTopic.counselFinding ?? "",
      qualifications: selectedTopic.qualifications ?? "",
      requiredAmendments: selectedTopic.requiredAmendments ?? "",
      officialReference: selectedTopic.officialReference ?? "",
      effectiveFrom: selectedTopic.effectiveFrom?.slice(0, 10) ?? "",
      effectiveUntil: selectedTopic.effectiveUntil?.slice(0, 10) ?? "",
      evidenceRequirementStatus:
        selectedTopic.evidenceRequirementStatus === "NOT_REVIEWED"
          ? ""
          : selectedTopic.evidenceRequirementStatus,
      requiredEvidenceTypes: selectedTopic.requiredEvidenceTypes.join(", "),
      policyRequirementStatus:
        selectedTopic.policyRequirementStatus === "NOT_REVIEWED"
          ? ""
          : selectedTopic.policyRequirementStatus,
      requiredPolicyVersions: selectedTopic.requiredPolicyVersions
        .map((item) => `${item.policyKey}=${item.version}`)
        .join(", "),
    });
  }, [countryId, selectedTopic]);
  const capabilitiesQuery = useGetAdminMarketLegalCapabilities(marketId, {
    query: {
      queryKey: getGetAdminMarketLegalCapabilitiesQueryKey(marketId),
      enabled: user?.role === "ADMIN" && Boolean(marketId),
    },
  });
  const incidentsQuery = useListAdminSecurityIncidents(undefined, {
    query: {
      queryKey: getListAdminSecurityIncidentsQueryKey(),
      enabled: user?.role === "ADMIN",
      staleTime: 0,
    },
  });
  const incidentDetailQuery = useGetAdminSecurityIncident(selectedIncidentId, {
    query: {
      queryKey: getGetAdminSecurityIncidentQueryKey(selectedIncidentId),
      enabled: user?.role === "ADMIN" && Boolean(selectedIncidentId),
    },
  });

  const refreshCapabilities = async () => {
    setActionError(null);
    setReferences({});
    await queryClient.invalidateQueries({
      queryKey: getGetAdminMarketLegalCapabilitiesQueryKey(marketId),
    });
  };
  const refreshCountryReadiness = async () => {
    setActionError(null);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getListAdminCountryLegalReadinessQueryKey(),
      }),
      queryClient.invalidateQueries({
        queryKey: getGetAdminCountryLegalReadinessQueryKey(countryId),
      }),
    ]);
  };
  const refreshIncidents = async () => {
    setActionError(null);
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getListAdminSecurityIncidentsQueryKey(),
      }),
      ...(selectedIncidentId
        ? [
            queryClient.invalidateQueries({
              queryKey: getGetAdminSecurityIncidentQueryKey(selectedIncidentId),
            }),
          ]
        : []),
    ]);
  };

  const requestReview = useRequestAdminMarketCapabilityReview({
    mutation: {
      onSuccess: refreshCapabilities,
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const counselReview = useRecordAdminMarketCapabilityCounselReview({
    mutation: {
      onSuccess: refreshCapabilities,
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const ownerApproval = useEnableAdminMarketCapability({
    mutation: {
      onSuccess: refreshCapabilities,
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const capabilityDisable = useDisableAdminMarketCapability({
    mutation: {
      onSuccess: refreshCapabilities,
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const countryEvidenceSubmit = useSubmitAdminCountryLegalEvidence({
    mutation: {
      onSuccess: async () => {
        setPendingEvidence(null);
        setEvidenceDraft({
          topicKey: selectedTopicKey,
          evidenceType: "",
          documentVersion: "",
          referenceCode: "",
          issuedAt: "",
          expiresAt: "",
          idempotencyKey: "",
        });
        await refreshCountryReadiness();
      },
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const countryEvidenceReview = useReviewAdminCountryLegalEvidence({
    mutation: {
      onSuccess: async () => {
        setPendingEvidenceReview(null);
        await refreshCountryReadiness();
      },
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const countryTopicReview = useReviewAdminCountryLegalTopic({
    mutation: {
      onSuccess: async () => {
        setPendingTopicReview(null);
        await refreshCountryReadiness();
      },
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const countryReviewRequest = useRequestAdminCountryCounselReview({
    mutation: {
      onSuccess: async () => {
        setPendingCountryAction(null);
        await refreshCountryReadiness();
      },
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const countryCounselReview = useRecordAdminCountryCounselReview({
    mutation: {
      onSuccess: async () => {
        setPendingCountryAction(null);
        await refreshCountryReadiness();
      },
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const countrySuspend = useSuspendAdminCountryReadiness({
    mutation: {
      onSuccess: async () => {
        setPendingCountryAction(null);
        setCountryReference("");
        await refreshCountryReadiness();
      },
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const createIncident = useCreateAdminSecurityIncident({
    mutation: {
      onSuccess: async () => {
        incidentForm.reset();
        await refreshIncidents();
      },
      onError: (error) => setActionError(friendlyError(error)),
    },
  });
  const incidentAction = useTransitionAdminSecurityIncident({
    mutation: {
      onSuccess: refreshIncidents,
      onError: (error) => setActionError(friendlyError(error)),
    },
  });

  const submitIncident = incidentForm.handleSubmit((values) => {
    createIncident.mutate({
      data: {
        category: values.category,
        severity: values.severity,
        summary: values.summary.trim(),
        affectedSystems: values.affectedSystems
          .split(",")
          .map((system) => system.trim())
          .filter(Boolean),
        ...(values.evidenceReference.trim()
          ? { evidenceReference: values.evidenceReference.trim() }
          : {}),
      },
    });
  });

  const prepareCountryEvidence = () => {
    setActionError(null);
    if (
      !evidenceDraft.evidenceType.trim() ||
      !evidenceDraft.documentVersion.trim() ||
      evidenceDraft.referenceCode.trim().length < 3
    ) {
      setActionError("أكمل نوع الدليل وإصداره ورمز المرجع قبل المعاينة.");
      return;
    }
    setPendingEvidence({
      ...evidenceDraft,
      evidenceType: evidenceDraft.evidenceType.trim().toUpperCase(),
      documentVersion: evidenceDraft.documentVersion.trim(),
      referenceCode: evidenceDraft.referenceCode.trim(),
      idempotencyKey: crypto.randomUUID(),
    });
  };
  const confirmCountryEvidence = () => {
    if (!pendingEvidence) return;
    countryEvidenceSubmit.mutate({
      marketId: countryId,
      data: {
        topicKey: pendingEvidence.topicKey,
        evidenceType: pendingEvidence.evidenceType,
        documentVersion: pendingEvidence.documentVersion,
        referenceCode: pendingEvidence.referenceCode,
        idempotencyKey: pendingEvidence.idempotencyKey,
        ...(pendingEvidence.issuedAt
          ? { issuedAt: `${pendingEvidence.issuedAt}T00:00:00.000Z` }
          : {}),
        ...(pendingEvidence.expiresAt
          ? { expiresAt: `${pendingEvidence.expiresAt}T00:00:00.000Z` }
          : {}),
      },
    });
  };
  const prepareTopicReview = () => {
    setActionError(null);
    if (
      !topicReviewDraft.disposition ||
      !topicReviewDraft.counselFinding.trim() ||
      topicReviewDraft.officialReference.trim().length < 3 ||
      !topicReviewDraft.evidenceRequirementStatus ||
      !topicReviewDraft.policyRequirementStatus
    ) {
      setActionError("اختر نتيجة البند ومتطلبات الأدلة والسياسات، وأدخل النتيجة والمرجع قبل المعاينة.");
      return;
    }
    const evidenceTypes = topicReviewDraft.requiredEvidenceTypes
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    const policyVersions = topicReviewDraft.requiredPolicyVersions
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const splitAt = value.indexOf("=");
        return splitAt > 0
          ? { policyKey: value.slice(0, splitAt).trim(), version: value.slice(splitAt + 1).trim() }
          : null;
      });
    if (
      (topicReviewDraft.evidenceRequirementStatus === "REQUIREMENTS_SET" && evidenceTypes.length === 0) ||
      (topicReviewDraft.evidenceRequirementStatus === "NO_REQUIREMENTS" && evidenceTypes.length > 0) ||
      (topicReviewDraft.policyRequirementStatus === "VERSIONS_SET" &&
        (policyVersions.length === 0 ||
          policyVersions.some(
            (value) => !value || !value.policyKey || !value.version,
          ))) ||
      (topicReviewDraft.policyRequirementStatus === "NO_POLICY_REQUIREMENT" &&
        policyVersions.length > 0) ||
      (topicReviewDraft.effectiveFrom &&
        topicReviewDraft.effectiveUntil &&
        topicReviewDraft.effectiveUntil < topicReviewDraft.effectiveFrom)
    ) {
      setActionError("أدخل المتطلبات صراحةً أو اختر عدم وجود متطلبات؛ تنسيق إصدار السياسة: المفتاح=الإصدار، وتحقق من فترة النفاذ.");
      return;
    }
    setPendingTopicReview({ ...topicReviewDraft });
  };
  const confirmTopicReview = () => {
    if (!pendingTopicReview) return;
    const evidenceTypes = pendingTopicReview.requiredEvidenceTypes
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean);
    const requiredPolicyVersions = pendingTopicReview.requiredPolicyVersions
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const splitAt = value.indexOf("=");
        return {
          policyKey: value.slice(0, splitAt).trim(),
          version: value.slice(splitAt + 1).trim(),
        };
      });
    countryTopicReview.mutate({
      marketId: countryId,
      topicKey: selectedTopicKey,
      data: {
        disposition: pendingTopicReview.disposition as Exclude<
          CountryTopicReviewDraft["disposition"],
          ""
        >,
        counselFinding: pendingTopicReview.counselFinding.trim(),
        qualifications: pendingTopicReview.qualifications.trim() || null,
        requiredAmendments: pendingTopicReview.requiredAmendments.trim() || null,
        officialReference: pendingTopicReview.officialReference.trim(),
        effectiveFrom: pendingTopicReview.effectiveFrom
          ? `${pendingTopicReview.effectiveFrom}T00:00:00.000Z`
          : null,
        effectiveUntil: pendingTopicReview.effectiveUntil
          ? `${pendingTopicReview.effectiveUntil}T00:00:00.000Z`
          : null,
        evidenceRequirementStatus: pendingTopicReview.evidenceRequirementStatus as
          | "REQUIREMENTS_SET"
          | "NO_REQUIREMENTS",
        requiredEvidenceTypes: evidenceTypes,
        policyRequirementStatus: pendingTopicReview.policyRequirementStatus as
          | "VERSIONS_SET"
          | "NO_POLICY_REQUIREMENT",
        requiredPolicyVersions,
      },
    });
  };
  const confirmEvidenceReview = () => {
    if (!pendingEvidenceReview) return;
    countryEvidenceReview.mutate({
      evidenceId: pendingEvidenceReview.evidenceId,
      data: { outcome: pendingEvidenceReview.outcome },
    });
  };
  const confirmCountryAction = () => {
    if (pendingCountryAction === "REQUEST_COUNSEL_REVIEW") {
      countryReviewRequest.mutate({ marketId: countryId, data: {} });
    } else if (pendingCountryAction === "RECORD_COUNSEL_REVIEW") {
      countryCounselReview.mutate({
        marketId: countryId,
        data: { referenceCode: countryReference.trim() },
      });
    } else if (pendingCountryAction === "SUSPEND") {
      countrySuspend.mutate({
        marketId: countryId,
        data: { referenceCode: countryReference.trim() },
      });
    }
  };

  const submitCapabilityReview = (capability: Capability) =>
    requestReview.mutate({ marketId, capability: capability.capability, data: {} });

  const submitCounselReview = (
    capability: Capability,
    outcome: "READY_FOR_OWNER_REVIEW" | "BLOCK",
  ) =>
    counselReview.mutate({
      marketId,
      capability: capability.capability,
      data: {
        outcome,
        reference: references[capability.capability]?.trim() ?? "",
      },
    });

  const submitOwnerApproval = (capability: Capability) =>
    ownerApproval.mutate({
      marketId,
      capability: capability.capability,
      data: { reference: references[capability.capability]?.trim() ?? "" },
    });

  const submitCapabilityDisable = (capability: Capability) =>
    capabilityDisable.mutate({
      marketId,
      capability: capability.capability,
      data: {},
    });

  const submitIncidentAction = (
    incident: Incident,
    action:
      | "RECORD_CONTAINMENT"
      | "RECORD_RECOVERY"
      | "CLOSE_WITH_POSTMORTEM"
      | "REQUEST_COUNSEL_REVIEW"
      | "RECORD_COUNSEL_REVIEW",
    summary?: string,
    reference?: string,
  ) =>
    incidentAction.mutate({
      id: incident.id,
      data: {
        action,
        ...(summary?.trim() ? { summary: summary.trim() } : {}),
        ...(reference?.trim() ? { reference: reference.trim() } : {}),
      },
    });

  const capabilities = capabilitiesQuery.data?.capabilities ?? [];
  const incidents = incidentsQuery.data ?? [];
  const capabilityPending =
    requestReview.isPending ||
    counselReview.isPending ||
    ownerApproval.isPending ||
    capabilityDisable.isPending;
  const countryPending =
    countryEvidenceSubmit.isPending ||
    countryEvidenceReview.isPending ||
    countryTopicReview.isPending ||
    countryReviewRequest.isPending ||
    countryCounselReview.isPending ||
    countrySuspend.isPending;
  const reviewedCountryTopicCount = countryTopics.filter(
    (topic) => topic.reviewStatus === "COUNSEL_REVIEWED",
  ).length;

  if (!user) return null;
  if (user.role !== "ADMIN") {
    return (
      <div className="container-app max-w-3xl py-6" dir="rtl">
        <PageHeader back="/" title="الجاهزية القانونية والأمنية" />
        <InlineAlert tone="danger" title="الوصول مقيّد">
          هذه الصفحة مخصصة للمسؤولين المخولين.
        </InlineAlert>
      </div>
    );
  }

  return (
    <main className="container-app max-w-5xl space-y-6 py-6" dir="rtl">
      <PageHeader back="/profile" title="الجاهزية القانونية والأمنية" />
      <InlineAlert tone="warning" title="حالة داخلية وليست موافقة قانونية">
        لا يعني تفعيل الصلاحية أن دينار حصل على موافقة حكومية أو ترخيص. لا تُفعّل أي دولة أو
        خدمة قبل مراجعة مستشار مختص وقرار المالك. المراجع هنا يسجل مراجع للقرار فقط، ولا تُرفع
        مستندات قانونية أو بيانات شخصية.
      </InlineAlert>

      {actionError && (
        <InlineAlert tone="danger" title="تعذر حفظ التغيير">
          {actionError}
        </InlineAlert>
      )}

      <section
        className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-6"
        data-testid="country-legal-readiness"
      >
        <div>
          <h2 className="text-lg font-semibold">حزم المراجعة القانونية حسب الدولة</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            الأردن والكويت والسعودية تبدأ دون أي استنتاج قانوني. لا ترفع مستندات أو بيانات
            شخصية؛ سجل رمزاً يشير إلى خزينة خاصة. مراجعة المرجع ليست توقيعاً أو موافقة قانونية.
          </p>
        </div>
        {countryListQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : countryListQuery.isError ? (
          <ErrorState
            title="تعذر تحميل حزم الدول"
            body={friendlyError(countryListQuery.error)}
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3" data-testid="country-readiness-matrix">
              {countryPackages.map((country) => (
                <button
                  type="button"
                  key={country.marketId}
                  className={`min-h-24 rounded-xl border p-3 text-right ${
                    countryId === country.marketId
                      ? "border-primary bg-primary/5"
                      : "border-border bg-background"
                  }`}
                  data-testid={`card-country-readiness-${country.marketId.toLowerCase()}`}
                  onClick={() => setSelectedCountry(country.marketId)}
                >
                  <span className="font-semibold">{country.countryNameAr}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {country.marketId} · {country.reviewedTopicCount}/{country.topicCount} بنود
                    مراجعة
                  </span>
                  <span className="mt-2 block text-xs">
                    مراجعة المستشار: {countryReviewLabels[country.reviewStatus] ?? country.reviewStatus}
                    {" · "}التفعيل: {activationLabels[country.activationStatus] ?? country.activationStatus}
                  </span>
                </button>
              ))}
            </div>
            <label className="block space-y-1 text-sm font-medium">
              حزمة الدولة المفتوحة
              <select
                className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                data-testid="select-country-legal-package"
                value={countryId}
                onChange={(event) => setSelectedCountry(event.target.value)}
              >
                {countryPackages.map((country) => (
                  <option key={country.marketId} value={country.marketId}>
                    {country.countryNameAr} ({country.marketId})
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {countryDetailQuery.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : countryDetailQuery.isError ? (
          <ErrorState
            title="تعذر تحميل تفاصيل الحزمة"
            body={friendlyError(countryDetailQuery.error)}
          />
        ) : countryDetail ? (
          <>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
              <div className="rounded-xl border border-border p-3">
                <span className="text-xs text-muted-foreground">مراجعة المستشار</span>
                <strong className="mt-1 block">
                  {countryReviewLabels[countryDetail.intake.reviewStatus] ??
                    countryDetail.intake.reviewStatus}
                </strong>
              </div>
              <div className="rounded-xl border border-border p-3">
                <span className="text-xs text-muted-foreground">اعتماد المستشار</span>
                <strong className="mt-1 block">
                  {approvalLabels[countryDetail.intake.counselApprovalStatus] ??
                    countryDetail.intake.counselApprovalStatus}
                </strong>
              </div>
              <div className="rounded-xl border border-border p-3">
                <span className="text-xs text-muted-foreground">موافقة المالك</span>
                <strong className="mt-1 block">
                  {approvalLabels[countryDetail.intake.ownerApprovalStatus] ??
                    countryDetail.intake.ownerApprovalStatus}
                </strong>
              </div>
              <div className="rounded-xl border border-border p-3">
                <span className="text-xs text-muted-foreground">التحقق الفني</span>
                <strong className="mt-1 block">
                  {technicalLabels[countryDetail.intake.technicalVerificationStatus] ??
                    countryDetail.intake.technicalVerificationStatus}
                </strong>
              </div>
              <div className="rounded-xl border border-border p-3">
                <span className="text-xs text-muted-foreground">حالة الحزمة</span>
                <strong className="mt-1 block">
                  {activationLabels[countryDetail.intake.activationStatus] ??
                    countryDetail.intake.activationStatus}
                </strong>
              </div>
            </div>

            <InlineAlert tone="warning" title="الاعتماد والتفعيل محجوبان">
              {countryDetail.intake.counselApprovalBlocker}: لا توجد آلية موثوقة للتحقق من هوية
              المستشار وتوقيعه، ولا توجد شهادة اختبار فني قابلة للتحقق آلياً. لا يستطيع طلب
              المراجعة أو مراجع المستند تجاوز ذلك.
            </InlineAlert>

            <div className="rounded-xl border border-border p-4" data-testid="country-readiness-blockers">
              <h3 className="font-semibold">المتطلبات والعوائق الحالية</h3>
              {countryDetail.blockers.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">لا توجد عوائق مسجلة.</p>
              ) : (
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                  {countryDetail.blockers.map((blocker) => (
                    <li key={blocker} dir="ltr" className="text-right">
                      {blocker}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-3 rounded-xl border border-border p-4">
              <h3 className="font-semibold">مراجعة بند قانوني</h3>
              <p className="text-sm text-muted-foreground">
                لا تسجل نتيجة أو متطلباً دون مرجع يقدمه المستشار. اختر «لا توجد متطلبات» صراحةً؛
                القائمة الفارغة وحدها لا تعني عدم وجود متطلب.
              </p>
              <label className="block space-y-1 text-sm">
                البند
                <select
                  className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                  data-testid="select-country-topic"
                  value={selectedTopicKey}
                  onChange={(event) =>
                    setSelectedTopicKey(event.target.value as CountryLegalTopicKey)
                  }
                >
                  {countryTopics.map((topic) => (
                    <option key={topic.topicKey} value={topic.topicKey}>
                      {topic.labelAr} · {topic.reviewStatus === "COUNSEL_REVIEWED" ? "راجعه المستشار" : "غير محسوم"}
                    </option>
                  ))}
                </select>
              </label>
              {selectedTopic && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      نتيجة المستشار
                      <select
                        className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                        value={topicReviewDraft.disposition}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            disposition: event.target.value as CountryTopicReviewDraft["disposition"],
                          }))
                        }
                      >
                        <option value="">اختر نتيجة</option>
                        <option value="REQUIRED">مطلوب</option>
                        <option value="NOT_REQUIRED">غير مطلوب بمرجع</option>
                        <option value="NOT_APPLICABLE">غير منطبق بمرجع</option>
                        <option value="BLOCKED">محجوب</option>
                      </select>
                    </label>
                    <label className="space-y-1 text-sm">
                      رمز المرجع الرسمي
                      <input
                        className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                        value={topicReviewDraft.officialReference}
                        maxLength={200}
                        placeholder="JO-LAW-REFERENCE-01"
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            officialReference: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm sm:col-span-2">
                      نتيجة المستشار ومصدرها
                      <textarea
                        className="min-h-20 w-full rounded-xl border border-border bg-background p-3"
                        maxLength={4000}
                        value={topicReviewDraft.counselFinding}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            counselFinding: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      التحفظات
                      <textarea
                        className="min-h-16 w-full rounded-xl border border-border bg-background p-3"
                        maxLength={2000}
                        value={topicReviewDraft.qualifications}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            qualifications: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      التعديلات المطلوبة
                      <textarea
                        className="min-h-16 w-full rounded-xl border border-border bg-background p-3"
                        maxLength={2000}
                        value={topicReviewDraft.requiredAmendments}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            requiredAmendments: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      تاريخ النفاذ
                      <input
                        type="date"
                        className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                        value={topicReviewDraft.effectiveFrom}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            effectiveFrom: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      نهاية النفاذ، إن وجدت
                      <input
                        type="date"
                        className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                        value={topicReviewDraft.effectiveUntil}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            effectiveUntil: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      متطلبات الأدلة
                      <select
                        className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                        value={topicReviewDraft.evidenceRequirementStatus}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            evidenceRequirementStatus: event.target.value as CountryTopicReviewDraft["evidenceRequirementStatus"],
                          }))
                        }
                      >
                        <option value="">اختر حالة المتطلبات</option>
                        <option value="REQUIREMENTS_SET">حدد الأنواع المطلوبة</option>
                        <option value="NO_REQUIREMENTS">لا توجد متطلبات وفق المراجعة</option>
                      </select>
                    </label>
                    <label className="space-y-1 text-sm">
                      أنواع الأدلة المطلوبة
                      <input
                        className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                        placeholder="REGISTRATION, LICENSE"
                        value={topicReviewDraft.requiredEvidenceTypes}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            requiredEvidenceTypes: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="space-y-1 text-sm">
                      متطلبات إصدارات السياسات
                      <select
                        className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                        value={topicReviewDraft.policyRequirementStatus}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            policyRequirementStatus: event.target.value as CountryTopicReviewDraft["policyRequirementStatus"],
                          }))
                        }
                      >
                        <option value="">اختر حالة السياسات</option>
                        <option value="VERSIONS_SET">حدد الإصدارات المطلوبة</option>
                        <option value="NO_POLICY_REQUIREMENT">لا توجد متطلبات وفق المراجعة</option>
                      </select>
                    </label>
                    <label className="space-y-1 text-sm">
                      إصدارات السياسة بصيغة المفتاح=الإصدار
                      <input
                        className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                        placeholder="TERMS=2.1, PRIVACY=3.0"
                        value={topicReviewDraft.requiredPolicyVersions}
                        onChange={(event) =>
                          setTopicReviewDraft((draft) => ({
                            ...draft,
                            requiredPolicyVersions: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <Button
                    variant="secondary"
                    disabled={countryPending || countryDetail.intake.reviewStatus !== "COUNSEL_REVIEW_REQUIRED"}
                    data-testid="button-preview-country-topic-review"
                    onClick={prepareTopicReview}
                  >
                    معاينة تسجيل مراجعة البند
                  </Button>
                  {pendingTopicReview && (
                    <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3" aria-live="polite">
                      <strong>معاينة للقراءة فقط</strong>
                      <p className="text-sm">
                        {selectedTopic.labelAr} · {pendingTopicReview.disposition} · المرجع{" "}
                        <code dir="ltr">{pendingTopicReview.officialReference}</code>
                      </p>
                      <p className="text-sm">{pendingTopicReview.counselFinding}</p>
                      <p className="text-xs text-muted-foreground">
                        سيُسجل هذا مراجعة بند فقط، ولا يمنح اعتماداً قانونياً أو تفعيلًا.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button disabled={countryPending} data-testid="button-confirm-country-topic-review" onClick={confirmTopicReview}>
                          تأكيد تسجيل المراجعة
                        </Button>
                        <Button variant="secondary" onClick={() => setPendingTopicReview(null)}>
                          إلغاء
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="space-y-3 rounded-xl border border-border p-4">
              <h3 className="font-semibold">سجل الأدلة والوثائق</h3>
              <p className="text-sm text-muted-foreground">
                أدخل بيانات مرجعية فقط. النظام لا يستقبل الملفات أو الصور ولا يعتبر أي مرجع توقيعاً.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm">
                  نوع الدليل
                  <input
                    className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                    value={evidenceDraft.evidenceType}
                    maxLength={64}
                    placeholder="REGISTRATION"
                    onChange={(event) =>
                      setEvidenceDraft((draft) => ({ ...draft, evidenceType: event.target.value }))
                    }
                  />
                </label>
                <label className="space-y-1 text-sm">
                  إصدار المستند
                  <input
                    className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                    value={evidenceDraft.documentVersion}
                    maxLength={80}
                    onChange={(event) =>
                      setEvidenceDraft((draft) => ({ ...draft, documentVersion: event.target.value }))
                    }
                  />
                </label>
                <label className="space-y-1 text-sm">
                  رمز المرجع في الخزينة الخاصة
                  <input
                    className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                    value={evidenceDraft.referenceCode}
                    maxLength={200}
                    placeholder="JO-REGISTRY-DOC-2026-01"
                    onChange={(event) =>
                      setEvidenceDraft((draft) => ({ ...draft, referenceCode: event.target.value }))
                    }
                  />
                </label>
                <label className="space-y-1 text-sm">
                  تاريخ الإصدار
                  <input
                    type="date"
                    className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                    value={evidenceDraft.issuedAt}
                    onChange={(event) =>
                      setEvidenceDraft((draft) => ({ ...draft, issuedAt: event.target.value }))
                    }
                  />
                </label>
                <label className="space-y-1 text-sm">
                  تاريخ الانتهاء
                  <input
                    type="date"
                    className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                    value={evidenceDraft.expiresAt}
                    onChange={(event) =>
                      setEvidenceDraft((draft) => ({ ...draft, expiresAt: event.target.value }))
                    }
                  />
                </label>
              </div>
              <Button
                variant="secondary"
                disabled={countryPending}
                data-testid="button-preview-country-evidence"
                onClick={prepareCountryEvidence}
              >
                معاينة مرجع الدليل
              </Button>
              {pendingEvidence && (
                <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3" aria-live="polite">
                  <strong>معاينة للقراءة فقط</strong>
                  <p className="text-sm">
                    {pendingEvidence.topicKey} · {pendingEvidence.evidenceType} · إصدار{" "}
                    {pendingEvidence.documentVersion}
                  </p>
                  <p className="text-sm">
                    المرجع: <code dir="ltr">{pendingEvidence.referenceCode}</code>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    سيُحفظ المرجع كـ«غير متحقق» إلى أن يراجعه مستشار معيّن. لا تُرسل أي ملف.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={countryPending}
                      data-testid="button-confirm-country-evidence"
                      onClick={confirmCountryEvidence}
                    >
                      تأكيد تسجيل المرجع
                    </Button>
                    <Button variant="secondary" onClick={() => setPendingEvidence(null)}>
                      إلغاء
                    </Button>
                  </div>
                </div>
              )}
              {countryDetail.evidence.length === 0 ? (
                <p className="text-sm text-muted-foreground">لا توجد مراجع أدلة مسجلة.</p>
              ) : (
                <ul className="space-y-2" data-testid="list-country-evidence">
                  {countryDetail.evidence.map((evidence) => (
                    <li className="rounded-lg border border-border p-3" key={evidence.id}>
                      <div className="flex flex-wrap justify-between gap-2 text-sm">
                        <strong>{evidence.topicKey} · {evidence.evidenceType}</strong>
                        <span>{evidence.expired ? "منتهي الصلاحية" : evidence.status}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        إصدار {evidence.documentVersion} · مرجع{" "}
                        <code dir="ltr">{evidence.referenceCode}</code>
                      </p>
                      {evidence.status === "SUBMITTED_UNVERIFIED" && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            disabled={countryPending}
                            onClick={() =>
                              setPendingEvidenceReview({
                                evidenceId: evidence.id,
                                outcome: "COUNSEL_REVIEWED",
                              })
                            }
                          >
                            معاينة مراجعة المرجع
                          </Button>
                          <Button
                            variant="secondary"
                            disabled={countryPending}
                            onClick={() =>
                              setPendingEvidenceReview({
                                evidenceId: evidence.id,
                                outcome: "REJECTED",
                              })
                            }
                          >
                            معاينة رفض المرجع
                          </Button>
                        </div>
                      )}
                      {pendingEvidenceReview?.evidenceId === evidence.id && (
                        <div className="mt-2 rounded-lg bg-muted/50 p-3" aria-live="polite">
                          <p className="text-sm">
                            تأكيد {pendingEvidenceReview.outcome === "COUNSEL_REVIEWED" ? "تسجيل مراجعة المرجع فقط" : "رفض المرجع"}{" "}
                            <code dir="ltr">{evidence.referenceCode}</code>؟
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            <Button disabled={countryPending} onClick={confirmEvidenceReview}>
                              تأكيد
                            </Button>
                            <Button variant="secondary" onClick={() => setPendingEvidenceReview(null)}>
                              إلغاء
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-3 rounded-xl border border-border p-4">
              <h3 className="font-semibold">خطوات المراجعة والتفعيل</h3>
              <p className="text-sm text-muted-foreground">
                الاعتماد القانوني يتطلب تحققاً مستقلاً من هوية المستشار وتوقيعه. التحقق الفني يتطلب
                شهادة نتائج قابلة للتحقق. لا توجد آلية حالية لهذين الأمرين، لذلك لن تتجاوز الواجهة
                حالة الحجب.
              </p>
              <label className="block space-y-1 text-sm">
                رمز مرجع الإجراء
                <input
                  className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                  value={countryReference}
                  maxLength={200}
                  placeholder="JO-REVIEW-2026-01"
                  onChange={(event) => setCountryReference(event.target.value)}
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={countryPending || countryDetail.intake.reviewStatus === "COUNSEL_REVIEW_REQUIRED"}
                  data-testid="button-request-country-counsel-review"
                  onClick={() => setPendingCountryAction("REQUEST_COUNSEL_REVIEW")}
                >
                  طلب مراجعة المستشار
                </Button>
                <Button
                  variant="secondary"
                  disabled={
                    countryPending ||
                    countryDetail.intake.reviewStatus !== "COUNSEL_REVIEW_REQUIRED" ||
                    reviewedCountryTopicCount !== countryDetail.topics.length ||
                    countryReference.trim().length < 3
                  }
                  data-testid="button-record-country-counsel-review"
                  onClick={() => setPendingCountryAction("RECORD_COUNSEL_REVIEW")}
                >
                  معاينة اكتمال مراجعة البنود
                </Button>
                <Button
                  variant="secondary"
                  disabled={countryPending || countryReference.trim().length < 3}
                  data-testid="button-suspend-country-readiness"
                  onClick={() => setPendingCountryAction("SUSPEND")}
                >
                  معاينة إيقاف الصلاحيات الجديدة
                </Button>
              </div>
              {pendingCountryAction && (
                <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3" aria-live="polite">
                  <strong>معاينة إجراء الحزمة</strong>
                  <p className="text-sm">
                    {pendingCountryAction === "REQUEST_COUNSEL_REVIEW"
                      ? "فتح طلب مراجعة للمستشار؛ لا يسجل نتيجة قانونية ولا يفعّل السوق."
                      : pendingCountryAction === "RECORD_COUNSEL_REVIEW"
                        ? "تسجيل اكتمال مراجعة البنود فقط؛ الاعتماد القانوني سيبقى محجوباً."
                        : "إيقاف الصلاحيات الجديدة في السوق؛ لا يحذف الطلبات أو السجلات السابقة."}
                  </p>
                  {pendingCountryAction !== "REQUEST_COUNSEL_REVIEW" && (
                    <p className="text-xs text-muted-foreground">
                      المرجع: <code dir="ltr">{countryReference}</code>
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={countryPending}
                      data-testid="button-confirm-country-action"
                      onClick={confirmCountryAction}
                    >
                      تأكيد الإجراء
                    </Button>
                    <Button variant="secondary" onClick={() => setPendingCountryAction(null)}>
                      إلغاء
                    </Button>
                  </div>
                </div>
              )}
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                <p>
                  اعتماد المستشار: {approvalLabels[countryDetail.intake.counselApprovalStatus] ?? countryDetail.intake.counselApprovalStatus}
                  {" · "}موافقة المالك: {approvalLabels[countryDetail.intake.ownerApprovalStatus] ?? countryDetail.intake.ownerApprovalStatus}
                  {" · "}التحقق الفني: {technicalLabels[countryDetail.intake.technicalVerificationStatus] ?? countryDetail.intake.technicalVerificationStatus}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  لا يمكن لمسؤول السوق تجاوز أي خطوة محجوبة. التفعيل لا يغيّر حالة السوق النشطة ولا يفعّل الدفع أو الذكاء الاصطناعي.
                </p>
              </div>
            </div>

            <div className="space-y-2 rounded-xl border border-border p-4">
              <h3 className="font-semibold">إصدارات السياسات المنشورة</h3>
              {countryDetail.publishedPolicyVersions.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  لا توجد إصدارات منشورة لهذا النطاق؛ لا يُفترض أن سياسة بعينها مطلوبة.
                </p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {countryDetail.publishedPolicyVersions.map((policy) => (
                    <li key={`${policy.marketScope}:${policy.policyKey}:${policy.version}`} dir="ltr">
                      {policy.marketScope} · {policy.policyKey} v{policy.version} · نافذ من{" "}
                      {policy.effectiveDate}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="space-y-2 rounded-xl border border-border p-4">
              <h3 className="font-semibold">سجل تدقيق الحزمة</h3>
              {countryDetail.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">لا توجد تغييرات مسجلة.</p>
              ) : (
                <ol className="space-y-2" data-testid="list-country-intake-events">
                  {countryDetail.events.map((event) => (
                    <li key={event.id} className="rounded-lg border border-border p-3 text-sm">
                      <div className="flex flex-wrap justify-between gap-2">
                        <strong>{event.eventType} · {event.topicKey ?? "الحزمة"}</strong>
                        <time dateTime={event.createdAt}>
                          {new Date(event.createdAt).toLocaleString("ar")}
                        </time>
                      </div>
                      <p className="text-xs text-muted-foreground" dir="ltr">
                        {event.fromStatus ?? "—"} → {event.toStatus} · {event.actorId}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </>
        ) : null}
      </section>

      <section className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
        <div className="flex items-center gap-2">
          <ShieldCheck className="text-primary" size={20} aria-hidden="true" />
          <h2 className="text-lg font-semibold">بوابات الدولة والخدمات</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          كل صلاحية تبدأ مغلقة. طلب المراجعة لا يفتحها؛ يلزم تسجيل مراجعة المستشار ثم موافقة
          مالك منفصل. تعطيل الصلاحية متاح للمسؤولين كإجراء احترازي.
        </p>

        {marketsQuery.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : marketsQuery.isError ? (
          <ErrorState title="تعذر تحميل الأسواق" body={friendlyError(marketsQuery.error)} />
        ) : markets.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="لا توجد أسواق مسجلة" />
        ) : (
          <label className="block space-y-1 text-sm font-medium">
            السوق
            <select
              className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
              data-testid="select-legal-readiness-market"
              value={marketId}
              onChange={(event) => setSelectedMarket(event.target.value)}
            >
              {markets.map((market) => (
                <option key={market.id} value={market.id}>
                  {market.countryNameAr || market.countryNameEn || market.id}
                </option>
              ))}
            </select>
          </label>
        )}

        {capabilitiesQuery.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : capabilitiesQuery.isError ? (
          <ErrorState
            title="تعذر تحميل الصلاحيات"
            body={friendlyError(capabilitiesQuery.error)}
          />
        ) : (
          <div className="space-y-3">
            {capabilities.map((capability) => {
              const reference = references[capability.capability] ?? "";
              const pending = capabilityPending;
              return (
                <article
                  className="space-y-3 rounded-xl border border-border p-4"
                  key={capability.capability}
                  data-testid={`card-market-capability-${capability.capability.toLowerCase()}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-semibold">
                      {capabilityLabels[capability.capability] ?? capability.capability}
                    </h3>
                    <span
                      data-testid={`status-market-capability-${capability.capability.toLowerCase()}`}
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        capability.enabled
                          ? "bg-amber-100 text-amber-900"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {capabilityStatusLabels[capability.status] ?? capability.status}
                    </span>
                  </div>
                  {capability.status === "COUNSEL_REVIEW_REQUIRED" && (
                    <div className="space-y-2">
                      <label className="block space-y-1 text-sm">
                        مرجع مراجعة المستشار
                        <input
                          className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                          data-testid={`input-counsel-reference-${capability.capability.toLowerCase()}`}
                          value={reference}
                          maxLength={200}
                          onChange={(event) =>
                            setReferences((current) => ({
                              ...current,
                              [capability.capability]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          data-testid={`button-counsel-ready-${capability.capability.toLowerCase()}`}
                          disabled={pending || reference.trim().length < 3}
                          onClick={() => submitCounselReview(capability, "READY_FOR_OWNER_REVIEW")}
                        >
                          إحالة لموافقة المالك
                        </Button>
                        <Button
                          variant="secondary"
                          data-testid={`button-counsel-block-${capability.capability.toLowerCase()}`}
                          disabled={pending || reference.trim().length < 3}
                          onClick={() => submitCounselReview(capability, "BLOCK")}
                        >
                          إبقاء الصلاحية محظورة
                        </Button>
                      </div>
                    </div>
                  )}
                  {capability.status === "OWNER_APPROVAL_REQUIRED" && (
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <label className="flex-1 space-y-1 text-sm">
                        مرجع قرار المالك
                        <input
                          className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                          data-testid={`input-owner-reference-${capability.capability.toLowerCase()}`}
                          value={reference}
                          maxLength={200}
                          onChange={(event) =>
                            setReferences((current) => ({
                              ...current,
                              [capability.capability]: event.target.value,
                            }))
                          }
                        />
                      </label>
                      <Button
                        className="self-end"
                        data-testid={`button-enable-capability-${capability.capability.toLowerCase()}`}
                        disabled={pending || reference.trim().length < 3}
                        onClick={() => submitOwnerApproval(capability)}
                      >
                        تفعيل بقرار المالك
                      </Button>
                    </div>
                  )}
                  {["DISABLED", "BLOCKED"].includes(capability.status) && (
                    <Button
                      variant="secondary"
                      data-testid={`button-request-capability-review-${capability.capability.toLowerCase()}`}
                      disabled={pending}
                      onClick={() => submitCapabilityReview(capability)}
                    >
                      طلب مراجعة المستشار
                    </Button>
                  )}
                  {capability.enabled && (
                    <Button
                      variant="secondary"
                      data-testid={`button-disable-capability-${capability.capability.toLowerCase()}`}
                      disabled={pending}
                      onClick={() => submitCapabilityDisable(capability)}
                    >
                      تعطيل الصلاحية
                    </Button>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {!capabilitiesQuery.isLoading && !capabilitiesQuery.isError && (
          <div className="space-y-2 border-t border-border pt-4" data-testid="list-market-capability-events">
            <h3 className="font-semibold">سجل قرارات الصلاحيات</h3>
            {(capabilitiesQuery.data?.events ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                لم تسجل أحداث مراجعة بعد.
              </p>
            ) : (
              <ol className="space-y-2">
                {(capabilitiesQuery.data?.events ?? []).map((event) => (
                  <li
                    className="rounded-lg border border-border bg-muted/20 p-3 text-sm"
                    key={event.id}
                    data-testid={`row-market-capability-event-${event.id}`}
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <strong>
                        {capabilityLabels[event.capability] ?? event.capability} ·{" "}
                        {event.eventType}
                      </strong>
                      <time dateTime={event.createdAt}>
                        {new Date(event.createdAt).toLocaleString("ar")}
                      </time>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      {event.fromStatus ?? "—"} → {event.toStatus} · المسؤول:{" "}
                      <span dir="ltr">{event.actorId}</span>
                    </p>
                    {event.reference && (
                      <p className="mt-1 text-muted-foreground">
                        المرجع: <code dir="ltr">{event.reference}</code>
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-6">
        <div className="flex items-center gap-2">
          <ShieldAlert className="text-primary" size={20} aria-hidden="true" />
          <h2 className="text-lg font-semibold">سجل حوادث الأمن والخصوصية</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          سجّل ملخصاً ومرجعاً داخلياً فقط. لا تضع كلمات مرور أو رموز وصول أو محتوى بيانات
          العملاء في هذا السجل. لا يرسل النظام إشعارات قانونية تلقائية.
        </p>
        <Form {...incidentForm}>
          <form
            className="space-y-3"
            onSubmit={submitIncident}
            data-testid="form-create-security-incident"
            aria-busy={createIncident.isPending}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm">
                ملخص الحادث
                <textarea
                  className="min-h-20 w-full rounded-xl border border-border bg-background p-3"
                  maxLength={1200}
                  aria-label="ملخص الحادث"
                  data-testid="input-security-incident-summary"
                  {...incidentForm.register("summary", {
                    required: true,
                    minLength: 3,
                    maxLength: 1200,
                  })}
                />
              </label>
              <label className="space-y-1 text-sm">
                الأنظمة المتأثرة، مفصولة بفواصل
                <input
                  className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                  maxLength={960}
                  data-testid="input-security-incident-systems"
                  {...incidentForm.register("affectedSystems")}
                />
              </label>
              <label className="space-y-1 text-sm">
                مرجع دليل داخلي، إن وجد
                <input
                  className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                  maxLength={200}
                  placeholder="INC-2026-001"
                  data-testid="input-security-incident-evidence-reference"
                  {...incidentForm.register("evidenceReference")}
                />
              </label>
              <label className="space-y-1 text-sm">
                النوع
                <select
                  className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                  aria-label="نوع الحادث"
                  data-testid="select-security-incident-category"
                  {...incidentForm.register("category")}
                >
                  <option value="SECURITY">أمن</option>
                  <option value="PRIVACY">خصوصية</option>
                  <option value="AVAILABILITY">توفر الخدمة</option>
                  <option value="DATA_INTEGRITY">سلامة البيانات</option>
                  <option value="THIRD_PARTY">طرف خارجي</option>
                  <option value="OTHER">أخرى</option>
                </select>
              </label>
              <label className="space-y-1 text-sm">
                الخطورة
                <select
                  className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                  aria-label="خطورة الحادث"
                  data-testid="select-security-incident-severity"
                  {...incidentForm.register("severity")}
                >
                  <option value="LOW">منخفضة</option>
                  <option value="MEDIUM">متوسطة</option>
                  <option value="HIGH">مرتفعة</option>
                  <option value="CRITICAL">حرجة</option>
                </select>
              </label>
            </div>
            <Button
              type="submit"
              disabled={createIncident.isPending || incidentSummary.trim().length < 3}
              data-testid="button-create-security-incident"
            >
              تسجيل حادث
            </Button>
          </form>
        </Form>

        {incidentsQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : incidentsQuery.isError ? (
          <ErrorState
            title="تعذر تحميل الحوادث"
            body={friendlyError(incidentsQuery.error)}
          />
        ) : incidents.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title="لا توجد حوادث مسجلة"
            body="لا تُنشئ سجلاً تجريبياً في بيئة حقيقية."
            testId="empty-security-incidents"
          />
        ) : (
          <div className="space-y-3" data-testid="list-security-incidents">
            {incidents.map((incident) => {
              const note = incidentNotes[incident.id] ?? "";
              const pending =
                incidentAction.isPending &&
                incidentAction.variables?.id === incident.id;
              return (
                <article
                  className="space-y-3 rounded-xl border border-border p-4"
                  key={incident.id}
                  data-testid={`card-security-incident-${incident.id}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h3 className="font-semibold" data-testid={`text-security-incident-summary-${incident.id}`}>
                        {incident.summary}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {incident.category} · {incidentSeverityLabels[incident.severity] ?? incident.severity} ·{" "}
                        <span data-testid={`status-security-incident-${incident.id}`}>
                          {incidentStatusLabels[incident.status] ?? incident.status}
                        </span>
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground" data-testid={`text-security-incident-detected-${incident.id}`}>
                      {new Date(incident.detectedAt).toLocaleString("ar")}
                    </span>
                  </div>
                  <label className="block space-y-1 text-sm">
                    ملاحظة الإجراء
                    <textarea
                      className="min-h-16 w-full rounded-xl border border-border bg-background p-3"
                      data-testid={`input-incident-action-note-${incident.id}`}
                      value={note}
                      maxLength={1200}
                      onChange={(event) =>
                        setIncidentNotes((current) => ({
                          ...current,
                          [incident.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  {incident.counselAssessment === "REVIEW_REQUIRED" && (
                    <label className="block space-y-1 text-sm">
                      مرجع المستشار، معرّف داخلي فقط
                      <input
                        className="min-h-11 w-full rounded-xl border border-border bg-background px-3"
                        value={incidentReferences[incident.id] ?? ""}
                        maxLength={200}
                        pattern="^[A-Za-z][A-Za-z0-9._:/-]{2,199}$"
                        data-testid={`input-incident-counsel-reference-${incident.id}`}
                        onChange={(event) =>
                          setIncidentReferences((current) => ({
                            ...current,
                            [incident.id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {incident.status === "OPEN" && (
                      <Button
                        disabled={pending || note.trim().length < 3}
                        data-testid={`button-record-incident-containment-${incident.id}`}
                        onClick={() =>
                          submitIncidentAction(incident, "RECORD_CONTAINMENT", note)
                        }
                      >
                        تسجيل الاحتواء
                      </Button>
                    )}
                    {incident.status === "CONTAINED" && (
                      <Button
                        disabled={pending || note.trim().length < 3}
                        data-testid={`button-record-incident-recovery-${incident.id}`}
                        onClick={() =>
                          submitIncidentAction(incident, "RECORD_RECOVERY", note)
                        }
                      >
                        تسجيل التعافي
                      </Button>
                    )}
                    {incident.status === "RECOVERED" && (
                      <Button
                        disabled={pending || note.trim().length < 3}
                        data-testid={`button-close-security-incident-${incident.id}`}
                        onClick={() =>
                          submitIncidentAction(incident, "CLOSE_WITH_POSTMORTEM", note)
                        }
                      >
                        إغلاق بعد المراجعة
                      </Button>
                    )}
                    {incident.counselAssessment === "NOT_ASSESSED" && (
                      <Button
                        variant="secondary"
                        disabled={pending}
                        data-testid={`button-request-incident-counsel-review-${incident.id}`}
                        onClick={() =>
                          submitIncidentAction(incident, "REQUEST_COUNSEL_REVIEW")
                        }
                      >
                        طلب مراجعة المستشار
                      </Button>
                    )}
                    {incident.counselAssessment === "REVIEW_REQUIRED" && (
                      <Button
                        variant="secondary"
                        disabled={
                          pending ||
                          (incidentReferences[incident.id]?.trim().length ?? 0) < 3
                        }
                        data-testid={`button-record-incident-counsel-review-${incident.id}`}
                        onClick={() =>
                          submitIncidentAction(
                            incident,
                            "RECORD_COUNSEL_REVIEW",
                            undefined,
                            incidentReferences[incident.id],
                          )
                        }
                      >
                        تسجيل مرجع مراجعة المستشار
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      disabled={pending}
                      data-testid={`button-toggle-incident-events-${incident.id}`}
                      onClick={() =>
                        setSelectedIncidentId((current) =>
                          current === incident.id ? "" : incident.id,
                        )
                      }
                    >
                      {selectedIncidentId === incident.id
                        ? "إخفاء سجل الأحداث"
                        : "عرض سجل الأحداث"}
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {selectedIncidentId && (
          <section
            className="space-y-3 rounded-xl border border-border bg-muted/20 p-4"
            aria-live="polite"
            data-testid={`section-incident-events-${selectedIncidentId}`}
          >
            <h3 className="font-semibold">سجل الأحداث غير القابل للتعديل</h3>
            {incidentDetailQuery.isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : incidentDetailQuery.isError ? (
              <ErrorState
                title="تعذر تحميل سجل الأحداث"
                body={friendlyError(incidentDetailQuery.error)}
              />
            ) : (
              <ol className="space-y-2">
                {(incidentDetailQuery.data?.events ?? []).map((event) => (
                  <li
                    className="rounded-lg border border-border bg-card p-3 text-sm"
                    key={event.id}
                    data-testid={`row-incident-event-${event.id}`}
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <strong>{event.eventType}</strong>
                      <time dateTime={event.createdAt}>
                        {new Date(event.createdAt).toLocaleString("ar")}
                      </time>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      {event.fromStatus ?? "—"} → {event.toStatus} · المسؤول:{" "}
                      <span dir="ltr">{event.actorId}</span>
                    </p>
                    {event.reference && (
                      <p className="mt-1 text-muted-foreground">
                        المرجع: <code dir="ltr">{event.reference}</code>
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
