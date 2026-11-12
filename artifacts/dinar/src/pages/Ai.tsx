import { COMPOSE_EVENT } from "@/features/ai/AnswerCards";
import "./AiChat.css";
import "./PremiumMaterials.css";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { VERIFICATION_BLOCK_MS, replyForTurn, unfinishedTurn, verificationPollInterval } from "@/features/ai/turn-recovery";
import * as Dialog from "@radix-ui/react-dialog";
import { ConversationSidebar } from "@/features/ai/ConversationSidebar";
import {
  clearGuestHandoff,
  decideGuestHandoff,
  earlierGuestTopics,
  GUEST_HANDOFF_KEY,
  guestHandoffMessages,
  isFinalHandoffRejection,
  isSafeGuestHandoffText,
  restoreGuestConversation,
} from "@/features/ai/conversation-storage";
import type {
  GuestAuthIntent,
  GuestContext,
} from "@/features/ai/conversation-storage";
import { ChatComposer, type ReasoningEffort } from "@/features/ai/ChatComposer";
import { publishCardSync, useCardSync } from "@/features/ai/card-sync";
import { isChatVideoFile, uploadChatVideo, uploadListingPhoto, uploadVisualSearchPhoto } from "@/features/listing-photo-upload";
import { DEFAULT_PHOTO_SEARCH_MESSAGE, isSearchPhoto } from "@/features/ai/visual-search-photo";
import {
  MessageBubble,
  SearchRefinements,
} from "@/features/ai/ConversationContent";
import { ActiveConversationContext } from "@/features/ai/ControlSurface";
import {
  ConversationItem,
  Welcome,
} from "@/features/ai/ConversationHistory";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ArrowDown,
  ChevronLeft,
  GitCompareArrows,
  LayoutGrid,
  Lightbulb,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  Search,
  ShoppingBag,
  ShoppingCart,
  Settings,
  SquarePen,
  SlidersHorizontal,
  Trash2,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Listing } from "@workspace/api-client-react";
import { api, useAccount } from "@/account/Account";
import { useCart } from "@/cart/CartContext";
import { cn } from "@/lib/utils";
import { friendlyError } from "@/lib/errors";
import { iconButtonClass, buttonClass } from "@/ui/Button";
import { ErrorState, Skeleton } from "@/ui/Feedback";
import { ConfirmDialog } from "@/ui/Sheet";
import { MarketChip } from "@/features/MarketSelector";
import { Avatar, SmartImage } from "@/ui/Media";
import { DinarMark, DinarWordmark } from "@/ui/DinarMark";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  addAiListingToCartAction,
  normalizeDetail,
  sendAiConversationTurn,
  aiQueryKeys,
  useCreateAiConversation,
  useCopyAiConversation,
  useDeleteAiConversation,
  useRenameAiConversation,
  createAiGuestHandoff,
  useGetAiConversation,
  useGetAiConversations,
  type AiUiBlock,
  type AiMessage,
  type AiStreamEvent,
} from "@/features/ai/ai-api";
import type { LocationSubmission } from "@/features/ai/delivery-types";

type PendingGuestHandoff = {
  handoffId: string;
  marketId: string;
  targetUserId: string;
  messages: AiMessage[];
  authIntent?: GuestAuthIntent;
};

const UNSENT_DRAFT_KEY = "dinar-unsent-draft";
/** The draft stashed by a cart link before its navigation, removed once read. */
function takeStashedDraft(): string {
  try {
    const value = sessionStorage.getItem(UNSENT_DRAFT_KEY) ?? "";
    sessionStorage.removeItem(UNSENT_DRAFT_KEY);
    return value;
  } catch {
    return "";
  }
}

export default function AiPage() {
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("medium");
  const {
    user,
    market,
    refresh,
    refreshMarkets,
    loading: accountLoading,
    verifying: identityVerifying,
  } = useAccount();
  const queryClient = useQueryClient();
  const sending = useRef(false);
  const creating = useRef(false);
  const previousScope = useRef<string | undefined>(undefined);
  const guestMarketResumeInProgress = useRef(false);
  const loadedGuestMarket = useRef<string | undefined>(undefined);
  const guestContext = useRef<GuestContext>({});
  const guestHandoffId = useRef<string | undefined>(undefined);
  const authIntent = useRef<GuestAuthIntent | null>(null);
  const guestHandoffToResume = useRef<PendingGuestHandoff | null>(null);
  const guestHandoffInProgress = useRef(false);
  /** The identity whose guest handoff has been decided on this page; decided once per identity. */
  const handoffDecidedFor = useRef<string | undefined>(undefined);
  const [activeId, setActiveId] = useState<string>();
  const ordersEntryHandled = useRef(false);
  const sellEntryHandled = useRef(false);
  const askEntryHandled = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("dinar-ai-sidebar-collapsed") === "true";
    } catch {
      return false;
    }
  });
  const [contextOpen, setContextOpen] = useState(true);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [showAllConversations, setShowAllConversations] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [draft, setDraft] = useState("");
  const [selectedPhotos, setSelectedPhotos] = useState<File[]>([]);
  const uploadedPhotoPaths = useRef(new Map<File, string>());
  const [historyQuery, setHistoryQuery] = useState("");
  useEffect(() => {
    try {
      window.localStorage.setItem("dinar-ai-sidebar-collapsed", String(sidebarCollapsed));
    } catch {
      // Sidebar state is only a convenience preference.
    }
  }, [sidebarCollapsed]);
  const [visibleMessageCount, setVisibleMessageCount] = useState(40);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [addingListingId, setAddingListingId] = useState<string>();
  // Screen-reader confirmation of a server-confirmed cart add (the receipt is also in the thread).
  const [cartNotice, setCartNotice] = useState("");
  // A stored cart receipt is returned again on every retry. It is shown and acknowledged once.
  const confirmedReceipts = useRef<Set<string>>(new Set());
  const { refreshFromServer: refreshCartFromServer, unitCount } = useCart();
  const [conversationToDelete, setConversationToDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [deleteConversationError, setDeleteConversationError] = useState("");
  const [localMessages, setLocalMessages] = useState<AiMessage[] | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [stage, setStage] = useState<
    "understanding" | "searching" | "uploading" | null
  >(null);
  const [error, setError] = useState("");
  const [guestHandoffFailed, setGuestHandoffFailed] = useState(false);
  const [guestHandoffRetry, setGuestHandoffRetry] = useState(0);
  const [failedTurn, setFailedTurn] = useState<{
    text: string;
    messageId: string;
    conversationId?: string;
    imageObjectPaths?: string[];
  } | null>(null);
  /** A turn the server may have recorded whose response never arrived; never claimed as failed. */
  const [verifyingTurn, setVerifyingTurn] = useState<{
    text: string;
    messageId: string;
    conversationId: string;
    startedAt: number;
  } | null>(null);
  /** Counts signals that say "re-read the server": another tab, focus, or a card expiry. */
  const [externalCardSync, setExternalCardSync] = useState(0);
  const localMessagesRef = useRef<AiMessage[] | null>(null);
  localMessagesRef.current = localMessages;
  const conversationViewportRef = useRef<HTMLDivElement>(null);
  const conversationSearchRef = useRef<HTMLInputElement>(null);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const focusConversationSearchOnOpen = useRef(false);
  const threadContentRef = useRef<HTMLDivElement>(null);
  const shouldAutoFollow = useRef(true);
  const previousScrollHeight = useRef<number | null>(null);
  const userScrollUntil = useRef(0);
  /** The viewport geometry at the previous scroll event (W02-ULTRA scroll stability). */
  const lastScrollGeometry = useRef<{ top: number; height: number; client: number } | null>(null);
  const touchOrigin = useRef<{ x: number; y: number } | null>(null);
  const requestEpoch = useRef(0);
  const activeStream = useRef<{ controller: AbortController; dispatched: boolean; stoppable: boolean } | null>(null);
  useEffect(() => () => {
    requestEpoch.current++;
    activeStream.current?.controller.abort();
  }, []);
  const initializedId = useRef<string | undefined>(undefined);
  // Verification blocks a new send in this conversation only while automatic verification
  // reads are still running (turn-recovery budget). After that the composer is usable again;
  // «تحقق من النتيجة» stays available and nothing is ever resent automatically.
  const [, setVerificationTick] = useState(0);
  useEffect(() => {
    if (!verifyingTurn) return;
    const remaining = VERIFICATION_BLOCK_MS - (Date.now() - verifyingTurn.startedAt);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setVerificationTick((value) => value + 1), remaining + 50);
    return () => clearTimeout(timer);
  }, [verifyingTurn]);
  const verifyingActiveTurn = Boolean(
    verifyingTurn &&
      verifyingTurn.conversationId === activeId &&
      Date.now() - verifyingTurn.startedAt < VERIFICATION_BLOCK_MS,
  );
  const conversations = useGetAiConversations({ enabled: Boolean(user) });
  const detail = useGetAiConversation(activeId, {
    enabled: Boolean(user && activeId),
    refetchInterval: verifyingActiveTurn && verifyingTurn
      ? () => verificationPollInterval(verifyingTurn.startedAt) : false,
  });
  const createConversation = useCreateAiConversation();
  const copyConversation = useCopyAiConversation();
  const deleteConversation = useDeleteAiConversation();
  const renameConversation = useRenameAiConversation();
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const conversationList = useMemo(
    () => conversations.data ?? [],
    [conversations.data],
  );
  const filteredConversations = useMemo(() => {
    const query = historyQuery.trim().toLocaleLowerCase();
    if (!query) return conversationList;
    return conversationList.filter((item) =>
      item.title.toLocaleLowerCase().includes(query),
    );
  }, [conversationList, historyQuery]);
  const visibleConversations = useMemo(
    () =>
      !showAllConversations && !historyQuery.trim()
        ? filteredConversations.slice(0, 5)
        : filteredConversations,
    [filteredConversations, historyQuery, showAllConversations],
  );
  const conversationGroups = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
    const labels = ["اليوم", "أمس", "آخر 7 أيام", "آخر 30 يومًا", "أقدم"];
    const grouped = new Map(labels.map((label) => [label, [] as typeof visibleConversations]));
    for (const conversation of visibleConversations) {
      const updated = new Date(conversation.updatedAt).getTime();
      const label =
        updated >= startOfToday ? labels[0] :
        updated >= startOfYesterday ? labels[1] :
        updated >= startOfToday - 7 * 24 * 60 * 60 * 1000 ? labels[2] :
        updated >= startOfToday - 30 * 24 * 60 * 60 * 1000 ? labels[3] : labels[4];
      grouped.get(label)!.push(conversation);
    }
    return [...grouped].filter(([, conversations]) => conversations.length > 0);
  }, [visibleConversations]);
  const activeConversation = detail.data;
  const messages = localMessages ?? activeConversation?.messages ?? [];
  const showWelcome =
    messages.length === 0 && !detail.isLoading && !detail.isError;
  const visibleMessages = messages.slice(-visibleMessageCount);
  const hasOlderMessages = messages.length > visibleMessages.length;
  useLayoutEffect(() => {
    if (!focusConversationSearchOnOpen.current || !showAllConversations) return;
    const compactLayout = window.matchMedia("(max-width: 1023px)").matches;
    if (compactLayout && !sidebarOpen) return;
    focusConversationSearchOnOpen.current = false;
    conversationSearchRef.current?.focus();
  }, [showAllConversations, sidebarOpen]);

  useEffect(() => {
    if (accountLoading || !market) return;
    try {
      if (user) {
        // Decided once, when this identity appears: afterwards the messages on screen are the
        // account's own and are never re-sent as a guest transcript.
        if (streaming || handoffDecidedFor.current === user.id) return;
        handoffDecidedFor.current = user.id;
        const cameFromGuest =
          previousScope.current === `guest:${market.id}` ||
          loadedGuestMarket.current === market.id;
        const decision = decideGuestHandoff({
          userId: user.id,
          marketId: market.id,
          raw: sessionStorage.getItem(GUEST_HANDOFF_KEY),
          cameFromGuest,
          localMessages,
        });
        if (decision.kind === "CAPTURE") {
          const { messages: transcript, saved } = decision;
          const handoffId =
            saved?.handoffId ?? guestHandoffId.current ?? crypto.randomUUID();
          const intentCandidate =
            authIntent.current?.marketId === market.id
              ? authIntent.current
              : saved?.authIntent;
          const intentMessage = intentCandidate
            ? transcript.find(
                (message) =>
                  message.id === intentCandidate.messageId &&
                  message.role === "USER",
              )
            : undefined;
          const snapshot: PendingGuestHandoff = {
            handoffId,
            marketId: market.id,
            targetUserId: user.id,
            messages: transcript,
            ...(intentMessage && intentCandidate
              ? {
                  authIntent: {
                    messageId: intentMessage.id,
                    marketId: market.id,
                    message: intentMessage.body,
                    ...(intentCandidate.listingId ? { listingId: intentCandidate.listingId } : {}),
                  },
                }
              : {}),
          };
          guestHandoffId.current = handoffId;
          guestHandoffToResume.current = snapshot;
          setLocalMessages(transcript);
          // Bound to this account: a reload resumes it, any other identity discards it.
          sessionStorage.setItem(
            GUEST_HANDOFF_KEY,
            JSON.stringify({
              marketId: market.id,
              handoffId,
              targetUserId: user.id,
              messages: transcript,
              context: {},
              authIntent: snapshot.authIntent
                ? {
                    messageId: snapshot.authIntent.messageId,
                    marketId: snapshot.authIntent.marketId,
                    ...(snapshot.authIntent.listingId ? { listingId: snapshot.authIntent.listingId } : {}),
                  }
                : undefined,
            }),
          );
        } else {
          if (decision.kind === "MARKET_CHANGED")
            setError("لم أنقل المحادثة لأن سوقها لا يطابق السوق الحالي.");
          if (decision.kind === "MARKET_CHANGED" || decision.clearStored)
            clearGuestHandoff();
          guestHandoffToResume.current = null;
          if (cameFromGuest) setLocalMessages(null);
        }
        authIntent.current = null;
        guestContext.current = {};
        loadedGuestMarket.current = undefined;
        return;
      }
      handoffDecidedFor.current = undefined;
      if (loadedGuestMarket.current !== market.id) {
        loadedGuestMarket.current = market.id;
        const restored = restoreGuestConversation(
          sessionStorage.getItem(GUEST_HANDOFF_KEY),
          market.id,
        );
        // A record already bound to an account is that account's; a guest never sees it.
        const saved = restored?.targetUserId ? null : restored;
        if (restored?.targetUserId) clearGuestHandoff();
        guestHandoffId.current = saved?.handoffId ?? crypto.randomUUID();
        guestContext.current = saved?.context ?? {};
        authIntent.current = saved?.authIntent ?? null;
        setLocalMessages(saved?.messages ?? []);
        return;
      }
      // Only a real guest transcript is stored; an empty one leaves no marker behind.
      if (!localMessages?.length) {
        if (localMessages) clearGuestHandoff();
      } else
        sessionStorage.setItem(
          GUEST_HANDOFF_KEY,
          JSON.stringify({
            marketId: market.id,
            messages: localMessages,
            context: guestContext.current,
            handoffId: guestHandoffId.current ?? crypto.randomUUID(),
            authIntent: authIntent.current
              ? {
                  messageId: authIntent.current.messageId,
                  marketId: authIntent.current.marketId,
                  ...(authIntent.current.listingId ? { listingId: authIntent.current.listingId } : {}),
                }
              : undefined,
          }),
        );
    } catch {
      /* Private browsing/storage quota must not interrupt a live turn. */
    }
  }, [user?.id, market?.id, accountLoading, localMessages, streaming]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const syncViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        document.documentElement.style.setProperty(
          "--chat-visual-height",
          `${Math.round(viewport.height)}px`,
        );
        // An on-screen keyboard shrinks the visual viewport well below the layout one.
        setKeyboardOpen(window.innerHeight - viewport.height > 140);
      });
    };
    syncViewport();
    viewport.addEventListener("resize", syncViewport);
    viewport.addEventListener("scroll", syncViewport);
    window.addEventListener("orientationchange", syncViewport);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", syncViewport);
      viewport.removeEventListener("scroll", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      document.documentElement.style.removeProperty("--chat-visual-height");
    };
  }, []);

  useEffect(() => {
    const toggle = () => {
      if (window.matchMedia("(max-width: 1023px)").matches)
        setSidebarOpen((value) => !value);
    };
    window.addEventListener("dinar:history", toggle);
    return () => window.removeEventListener("dinar:history", toggle);
  }, []);

  useEffect(() => {
    const open = (surface: "ACCOUNT" | "SETTINGS") => {
      shouldAutoFollow.current = true;
      userScrollUntil.current = 0;
      setLocalMessages((prior) => {
        const list = prior ?? activeConversation?.messages ?? [];
        if (
          list
            .at(-1)
            ?.blocks.some(
              (block) =>
                block.type === "SURFACE" && block.payload.surface === surface,
            )
        )
          return list;
        return [
          ...list,
          {
            id: crypto.randomUUID(),
            role: "ASSISTANT",
            body: surface === "ACCOUNT" ? "حسابك" : "الإعدادات",
            createdAt: new Date().toISOString(),
            blocks: [
              {
                type: "SURFACE",
                version: 1,
                payload: {
                  resultSetId: crypto.randomUUID(),
                  listings: [],
                  surface,
                },
              },
            ],
          },
        ];
      });
    };
    const account = () => open("ACCOUNT");
    const settings = () => open("SETTINGS");
    window.addEventListener("dinar:account", account);
    window.addEventListener("dinar:settings", settings);
    return () => {
      window.removeEventListener("dinar:account", account);
      window.removeEventListener("dinar:settings", settings);
    };
  }, [activeConversation]);

  const scope = `${user?.id ?? "guest"}:${market?.id ?? ""}`;
  useEffect(() => {
    if (accountLoading || !market) return;
    const restoringTargetedHandoff =
      Boolean(user) &&
      guestHandoffToResume.current?.targetUserId === user?.id;
    const resumingGuestMarket =
      guestMarketResumeInProgress.current &&
      previousScope.current?.startsWith("guest:") === true &&
      scope.startsWith("guest:");
    // A confirmed market switch moves the open conversation to the new market, and MarketSurface
    // stores it under the new market's key before refreshing: keep it on screen, not a reload.
    let movedWithMarketSwitch = false;
    try {
      movedWithMarketSwitch =
        Boolean(user && activeId) &&
        previousScope.current?.startsWith(`${user!.id}:`) === true &&
        localStorage.getItem(`dinar-conversation:${user!.id}:${market.id}`) === activeId;
    } catch {
      movedWithMarketSwitch = false;
    }
    if (
      previousScope.current &&
      previousScope.current !== scope &&
      !(previousScope.current === `guest:${market.id}` && user) &&
      !restoringTargetedHandoff &&
      !resumingGuestMarket &&
      !movedWithMarketSwitch
    ) {
      setActiveId(undefined);
      initializedId.current = undefined;
      setLocalMessages(null);
      guestContext.current = {};
      guestHandoffId.current = undefined;
      authIntent.current = null;
      guestHandoffToResume.current = null;
      guestHandoffInProgress.current = false;
      setGuestHandoffFailed(false);
      setError("");
      setDraft("");
      setHistoryQuery("");
      setFailedTurn(null);
      setVerifyingTurn(null);
      setExternalCardSync(0);
      requestEpoch.current += 1;
      activeStream.current?.controller.abort();
      activeStream.current = null;
      sending.current = false;
      creating.current = false;
      setStreaming(false);
      setStage(null);
      setAddingListingId(undefined);
    }
    previousScope.current = scope;
  }, [scope, accountLoading, market?.id]);

  const historyScope =
    user && market ? `dinar-conversation:${user.id}:${market.id}` : null;
  useEffect(() => {
    // Resuming the last conversation is for a page that has none. A conversation the page is
    // already starting (an entry link such as /orders, or a first message) owns the view: a
    // restore landing mid-create would switch to the old conversation, and the stale transcript
    // reset that follows could drop the new conversation's answer (F5-25).
    if (!historyScope || creating.current) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(historyScope);
    } catch {
      return;
    }
    if (
      !activeId &&
      saved &&
      conversationList.some((item) => item.id === saved)
    )
      setActiveId(saved);
  }, [historyScope, conversationList, activeId]);
  useEffect(() => {
    try {
      if (historyScope && activeId)
        localStorage.setItem(historyScope, activeId);
    } catch {
      /* History remains on the server. */
    }
  }, [historyScope, activeId]);

  useEffect(() => {
    if (activeId !== initializedId.current) {
      initializedId.current = undefined;
      setLocalMessages(null);
    }
    if (!activeConversation || !activeId) return;
    if (initializedId.current !== activeId) {
      initializedId.current = activeId;
      setLocalMessages(activeConversation.messages);
      return;
    }
    // A sibling tab, a focus return or a card expiry asked for a re-read: adopt the server's
    // messages once they are at least as new as what is on screen, so a settled card is never
    // revived from a local copy and an in-flight turn is never rolled back.
    if (!externalCardSync) return;
    if (streaming || sending.current || creating.current || failedTurn || verifyingTurn)
      return;
    const newest = (list: AiMessage[]) =>
      list.reduce(
        (latest, message) => Math.max(latest, Date.parse(message.createdAt) || 0),
        0,
      );
    if (newest(activeConversation.messages) < newest(localMessagesRef.current ?? []))
      return;
    setLocalMessages(activeConversation.messages);
  }, [activeConversation, activeId, externalCardSync, streaming, failedTurn, verifyingTurn]);

  useEffect(() => {
    setVisibleMessageCount(40);
    setError("");
    setFailedTurn(null);
    setVerifyingTurn(null);
    shouldAutoFollow.current = true;
    userScrollUntil.current = 0;
    setShowJumpToBottom(false);
  }, [activeId]);

  useEffect(() => {
    if (!activeConversation || !activeId || streaming || sending.current) return;
    const pending = unfinishedTurn(activeConversation.messages);
    const checkedTurn = verifyingTurn?.conversationId === activeId
      ? activeConversation.messages.find((message) => message.id === verifyingTurn.messageId)
      : activeConversation.messages.at(-1);
    if (!pending && checkedTurn?.role === "USER" && checkedTurn.turnStatus === "failed" && !replyForTurn(activeConversation.messages, checkedTurn.id)) {
      setLocalMessages(activeConversation.messages);
      setVerifyingTurn(null);
      setFailedTurn(null);
      setError("لم يكتمل الرد المحفوظ في DINAR. لم نُعِد إرسال طلبك. راجع سجل الإجراءات قبل إرسال طلب جديد.");
      return;
    }
    if (verifyingTurn?.conversationId === activeId && replyForTurn(activeConversation.messages, verifyingTurn.messageId)) {
      setLocalMessages(activeConversation.messages);
      setVerifyingTurn(null);
      setFailedTurn(null);
      setError("");
      return;
    }
    if (pending && pending.id !== verifyingTurn?.messageId) {
      setVerifyingTurn({ text: pending.body, messageId: pending.id, conversationId: activeId, startedAt: Date.now() });
      setError("طلبك محفوظ في DINAR ونتحقق من نتيجته. لا حاجة لإعادة الإرسال.");
    }
    if (pending?.turnStatus === "uncertain") {
      setError("نتيجة التنفيذ غير مؤكدة في سجل DINAR. لم نُعِد إرسال طلبك؛ راجع سجل الإجراءات والطلبات قبل أي محاولة جديدة.");
    }
  }, [activeConversation, activeId, streaming, verifyingTurn?.messageId]);

  useLayoutEffect(() => {
    const viewport = conversationViewportRef.current;
    if (!viewport) return;
    if (previousScrollHeight.current !== null) {
      viewport.scrollTop +=
        viewport.scrollHeight - previousScrollHeight.current;
      previousScrollHeight.current = null;
      return;
    }
    if (shouldAutoFollow.current) {
      viewport.scrollTop = viewport.scrollHeight;
      setShowJumpToBottom(false);
    }
  }, [
    messages.length,
    messages.at(-1)?.body,
    messages.at(-1)?.blocks.length,
    streaming,
    stage,
    visibleMessages.length,
    showJumpToBottom,
  ]);

  useEffect(() => {
    const viewport = conversationViewportRef.current;
    const content = threadContentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => {
      const distanceFromBottom =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
      if (shouldAutoFollow.current) {
        viewport.scrollTop = viewport.scrollHeight;
        setShowJumpToBottom(false);
      } else {
        setShowJumpToBottom(distanceFromBottom >= 96);
      }
    });
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [messages.length, visibleMessages.length]);

  const refreshConversationData = (conversationId: string) => {
    void queryClient.invalidateQueries({
      queryKey: aiQueryKeys().conversations,
    });
    void queryClient.invalidateQueries({
      queryKey: aiQueryKeys().conversation(conversationId),
    });
  };

  const syncFromServer = (conversationId?: string) => {
    setExternalCardSync((value) => value + 1);
    const target = conversationId ?? activeId;
    if (target) refreshConversationData(target);
  };

  // Another tab of this account announced a settled change: re-read, never copy its payload.
  useCardSync(user?.id, market?.id, (event) => {
    syncFromServer(event.conversationId);
  });

  // A tab that was hidden may have missed a BroadcastChannel message; returning to it re-reads.
  useEffect(() => {
    if (!user) return;
    const revalidate = () => {
      if (document.visibilityState !== "visible" || !activeId) return;
      // Integration: the identity is re-read on the same event; re-read the conversation only if
      // this tab is still the same account (a signed-out or switched tab must not ask at all).
      const expected = user.id;
      void queryClient.refetchQueries({ queryKey: ["identity"] }).then(() => {
        const current = queryClient.getQueryData<{ user: { id: string } | null }>(["identity"]);
        if (current?.user?.id === expected) syncFromServer(activeId);
      });
    };
    document.addEventListener("visibilitychange", revalidate);
    window.addEventListener("focus", revalidate);
    return () => {
      document.removeEventListener("visibilitychange", revalidate);
      window.removeEventListener("focus", revalidate);
    };
  }, [activeId, user?.id]);

  // A pending review has a server expiry. When it passes, only a re-read is requested: the
  // server shortens the card to EXPIRED; the client never extends or executes it.
  useEffect(() => {
    if (!activeId || !messages.length) return;
    const now = Date.now();
    let nextAt = Number.POSITIVE_INFINITY;
    for (const message of messages)
      for (const block of message.blocks) {
        if (block.type !== "SURFACE") continue;
        const card = (
          block.payload as {
            card?: { status?: { lifecycle?: string }; expiresAt?: string };
          }
        ).card;
        if (card?.status?.lifecycle !== "PENDING_REVIEW") continue;
        if (typeof card.expiresAt !== "string") continue;
        const at = Date.parse(card.expiresAt);
        if (Number.isFinite(at) && at > now) nextAt = Math.min(nextAt, at);
      }
    if (!Number.isFinite(nextAt)) return;
    const timer = window.setTimeout(
      () => syncFromServer(activeId),
      Math.min(nextAt - now + 1_000, 2_000_000_000),
    );
    return () => window.clearTimeout(timer);
  }, [activeId, messages]);

  const guestTurn = async (
    value: string,
    retryId?: string,
    resume?: { marketId: string; messageId: string },
  ) => {
    const targetMarketId = resume?.marketId ?? market?.id;
    if (!targetMarketId) {
      setError("تعذر تحديد السوق الحالي. حاول مجددًا.");
      return;
    }
    const text = value.trim();
    if (!text || streaming || sending.current) return;
    const transcript = localMessages ?? [];
    const resumeIndex = resume
      ? transcript.findIndex(
          (message) =>
            message.id === resume.messageId && message.role === "USER",
        )
      : -1;
    if (resume && resumeIndex < 0) {
      setError("تعذر استئناف الطلب الأصلي. أعد كتابته للمتابعة.");
      return;
    }
    sending.current = true;
    const epoch = requestEpoch.current;
    const now = new Date().toISOString();
    setDraft((current) => (retryId && current !== text ? current : ""));
    shouldAutoFollow.current = true;
    userScrollUntil.current = 0;
    setShowJumpToBottom(false);
    setStreaming(true);
    setError("");
    setFailedTurn(null);
    setStage("understanding");
    const entry: AiMessage =
      resume && resumeIndex >= 0
        ? transcript[resumeIndex]
        : {
            id: retryId ?? crypto.randomUUID(),
            role: "USER",
            body: text,
            createdAt: now,
            blocks: [],
          };
    const historyMessages = resume
      ? transcript.slice(0, resumeIndex)
      : transcript;
    const requestContext = resume
      ? {
          ...(guestContext.current.query !== undefined
            ? { query: guestContext.current.query }
            : {}),
          ...(guestContext.current.searchState
            ? { searchState: guestContext.current.searchState }
            : {}),
        }
      : { ...guestContext.current };
    if (!resume)
      setLocalMessages((prior) => [
        ...(prior ?? []).filter((message) => message.id !== entry.id),
        entry,
      ]);
    try {
      const response = await api("/ai/preview", "POST", {
        message: text,
        marketId: targetMarketId,
        reasoningEffort,
        history: historyMessages
          .slice(-10)
          .map((message) => ({
            actor: message.role,
            body: message.body.slice(0, 1200),
          })),
        earlierUserTopics: earlierGuestTopics(historyMessages),
        ...requestContext,
      });
      if (epoch !== requestEpoch.current) return;
      authIntent.current =
        response.requiresAuth === true && isSafeGuestHandoffText(text)
          ? {
              messageId: entry.id,
              marketId: targetMarketId,
              message: text,
              ...(requestContext.resourceIds?.length === 1
                ? { listingId: requestContext.resourceIds[0] }
                : {}),
            }
        : null;
      const responseBlocks: AiUiBlock[] = (response.blocks ?? []).map(
        (block: AiUiBlock) =>
          block.type === "SURFACE" &&
          block.payload.surface === "MARKET_SELECTOR"
            ? {
                ...block,
                payload: {
                  ...block.payload,
                  resumeMessageId: entry.id,
                },
              }
            : block,
      );
      if (
        resume &&
        responseBlocks.some(
          (block) =>
            block.type === "SURFACE" &&
            block.payload.surface === "MARKET_SELECTOR",
        )
      ) {
        try {
          await refreshMarkets();
        } catch {
          // Keep the server's selector visible even if the catalog refresh fails.
        }
      }
      if (response.query !== undefined)
        guestContext.current = {
          query: response.query,
          resourceIds:
            responseBlocks?.[0]?.payload?.listings?.map(
              (listing: Listing) => listing.id,
            ) ?? [],
          ...(response.searchState
            ? { searchState: response.searchState }
            : {}),
        };
      else if (
        responseBlocks.some(
          (block) =>
            block.type === "SURFACE" &&
            block.payload.surface === "MARKET_SELECTOR",
        )
      )
        guestContext.current = requestContext;
      else guestContext.current = {};
      setLocalMessages((prior) => {
        const current = prior ?? [];
        const withoutResumedSelector = resume
          ? current.map((message) => ({
              ...message,
              blocks: message.blocks.filter(
                (block) =>
                  !(
                    block.type === "SURFACE" &&
                    block.payload.surface === "MARKET_SELECTOR" &&
                    block.payload.resumeMessageId === entry.id
                  ),
              ),
            }))
          : current;
        return [
          ...withoutResumedSelector,
          {
            id: crypto.randomUUID(),
            role: "ASSISTANT",
            body: response.body,
            createdAt: now,
            blocks: responseBlocks,
          },
        ];
      });
    } catch (cause) {
      if (epoch !== requestEpoch.current) return;
      setError(friendlyError(cause));
      setDraft((current) => current || text);
      setFailedTurn({ text, messageId: entry.id });
    } finally {
      if (epoch === requestEpoch.current) {
        sending.current = false;
        setStreaming(false);
        setStage(null);
      }
    }
  };

  const resumeGuestMarket = useStableCallback(async (
    marketId: string,
    resumeMessageId: string,
  ) => {
    if (user) return;
    const original = (localMessages ?? []).find(
      (message) =>
        message.id === resumeMessageId && message.role === "USER",
    );
    if (!original) throw new Error("تعذر استئناف الطلب الأصلي.");
    try {
      await api("/account/market", "PATCH", { marketId });
    } catch (error) {
      try {
        await refreshMarkets();
      } catch {
        // Preserve the server's selection error for the inline card.
      }
      throw error;
    }
    const previousContext = guestContext.current;
    guestContext.current = {
      ...(previousContext.query !== undefined
        ? { query: previousContext.query }
        : {}),
      ...(previousContext.searchState
        ? { searchState: previousContext.searchState }
        : {}),
    };
    guestMarketResumeInProgress.current = true;
    try {
      loadedGuestMarket.current = marketId;
      await refresh();
      await guestTurn(original.body, original.id, {
        marketId,
        messageId: resumeMessageId,
      });
    } finally {
      guestMarketResumeInProgress.current = false;
    }
  });

  const startConversation = async (
    firstMessage?: string,
    photos: File[] = selectedPhotos,
  ) => {
    if (
      streaming ||
      createConversation.isPending ||
      creating.current ||
      sending.current
    )
      return;
    if (!firstMessage) {
      setDraft("");
      setFailedTurn(null);
    }
    shouldAutoFollow.current = true;
    userScrollUntil.current = 0;
    setShowJumpToBottom(false);
    if (!user) {
      if (photos.length) {
        setError(photos.some(isSearchPhoto) ? "سجّل الدخول للبحث بصورة." : "سجّل الدخول لرفع صور الإعلان.");
        return;
      }
      if (firstMessage) await guestTurn(firstMessage);
      else {
        setLocalMessages([]);
        guestContext.current = {};
        guestHandoffId.current = crypto.randomUUID();
        authIntent.current = null;
        guestHandoffToResume.current = null;
        try {
          clearGuestHandoff();
        } catch {
          /* A fresh guest conversation still works without session storage. */
        }
      }
      setSidebarOpen(false);
      return;
    }
    guestContext.current = {};
    setError("");
    creating.current = true;
    const epoch = requestEpoch.current;
    const firstMessageId = crypto.randomUUID();
    if (firstMessage) {
      setDraft("");
      setLocalMessages([
        {
          id: firstMessageId,
          role: "USER",
          body: firstMessage.trim(),
          createdAt: new Date().toISOString(),
          blocks: [],
        },
      ]);
    }
    try {
      const conversation = await createConversation.mutateAsync();
      if (epoch !== requestEpoch.current) return;
      setActiveId(conversation.id);
      initializedId.current = conversation.id;
      setLocalMessages([]);
      setSidebarOpen(false);
      if (firstMessage)
        await sendMessage(
          conversation.id,
          firstMessage,
          [],
          firstMessageId,
          photos,
        );
    } catch (cause) {
      setError(friendlyError(cause));
      if (epoch !== requestEpoch.current) return;
      if (firstMessage) {
        setDraft((current) => current || firstMessage);
        setFailedTurn({ text: firstMessage, messageId: firstMessageId });
      }
    } finally {
      if (epoch === requestEpoch.current) creating.current = false;
    }
  };

  /**
   * A turn whose response was lost is decided by the server record, never by the browser's guess:
   * an answered turn is adopted, a delivered but unfinished turn waits for verification, and only
   * an unsent turn becomes a retry (with the same client message id, so the server cannot repeat it).
   */
  const reconcileDeliveredTurn = async (
    conversationId: string,
    text: string,
    messageId: string,
    epoch: number,
  ): Promise<boolean> => {
    try {
      const restored = normalizeDetail(
        await api(`/ai/conversations/${conversationId}`),
      );
      if (epoch !== requestEpoch.current) return true;
      const index = restored.messages.findIndex(
        (message) => message.id === messageId,
      );
      const answered = Boolean(replyForTurn(restored.messages, messageId));
      setLocalMessages(restored.messages);
      if (answered) {
        setError("");
        setFailedTurn(null);
        setVerifyingTurn(null);
        setDraft((current) => (current === text ? "" : current));
        if (user && market) publishCardSync(user.id, market.id, conversationId);
        setExternalCardSync((value) => value + 1);
        return true;
      }
      if (index >= 0) {
        setFailedTurn(null);
        if (restored.messages[index]?.turnStatus === "failed") {
          setVerifyingTurn(null);
          setError("لم يكتمل الرد المحفوظ في DINAR. لم نُعِد إرسال طلبك. راجع سجل الإجراءات قبل إرسال طلب جديد.");
          return true;
        }
        setVerifyingTurn({ text, messageId, conversationId, startedAt: Date.now() });
        setError(
          restored.messages[index]?.turnStatus === "uncertain"
            ? "نتيجة التنفيذ غير مؤكدة في سجل DINAR. لم نُعِد إرسال طلبك؛ راجع سجل الإجراءات والطلبات قبل أي محاولة جديدة."
            : "وصل طلبك إلى DINAR، لكن تأكيد الرد لم يكتمل بعد. نتحقق من السجل — لا حاجة لإعادة الإرسال.",
        );
        return true;
      }
      setVerifyingTurn(null);
      setDraft((current) => current || text);
      setFailedTurn({ text, messageId, conversationId });
      setError("لم يصل طلبك إلى DINAR. أعد المحاولة بأمان.");
      return true;
    } catch {
      return false;
    }
  };

  const verifyTurn = async () => {
    if (!verifyingTurn || sending.current || streaming) return;
    const pending = verifyingTurn;
    const handled = await reconcileDeliveredTurn(
      pending.conversationId,
      pending.text,
      pending.messageId,
      requestEpoch.current,
    );
    if (handled) return;
    setError("تعذر التحقق من السجل الآن. تحقق من النتيجة مجددًا قبل إرسال طلب آخر.");
  };

  const sendMessage = async (
    conversationId: string,
    value: string,
    prior: AiMessage[] = messages,
    retryId?: string,
    photos: File[] = selectedPhotos,
    retryImageObjectPaths?: string[],
    location?: LocationSubmission,
  ) => {
    const text = value.trim();
    if (!text || streaming || createConversation.isPending || sending.current || verifyingTurn?.conversationId === conversationId)
      return;
    const controller = new AbortController();
    const transport = { controller, dispatched: false, stoppable: !location };
    activeStream.current = transport;
    sending.current = true;
    const epoch = requestEpoch.current;
    setError("");
    setVerifyingTurn(null);
    const now = new Date().toISOString();
    const userMessage: AiMessage = {
      id: retryId ?? crypto.randomUUID(),
      role: "USER",
      body: text,
      createdAt: now,
      blocks: [],
    };
    const assistantId = `local-assistant-${now}`;
    const assistantMessage: AiMessage = {
      id: assistantId,
      role: "ASSISTANT",
      body: "",
      createdAt: now,
      blocks: [],
    };
    setDraft((current) => (retryId && current !== text ? current : ""));
    shouldAutoFollow.current = true;
    userScrollUntil.current = 0;
    setShowJumpToBottom(false);
    setLocalMessages((current) => [
      ...prior.filter((message) => message.id !== userMessage.id),
      userMessage,
      assistantMessage,
    ]);
    setStreaming(true);
    setFailedTurn(null);
    setStage("understanding");
    let imageObjectPaths = retryImageObjectPaths ?? [];
    let photoPathsReady = retryImageObjectPaths !== undefined;
    try {
      if (!retryImageObjectPaths) {
        imageObjectPaths = [];
        if (photos.length) setStage("uploading");
        for (const file of photos) {
          let objectPath = uploadedPhotoPaths.current.get(file);
          if (!objectPath) {
            objectPath = await (isChatVideoFile(file) ? uploadChatVideo(file) : isSearchPhoto(file) ? uploadVisualSearchPhoto(file) : uploadListingPhoto(file));
            uploadedPhotoPaths.current.set(file, objectPath);
          }
          imageObjectPaths.push(objectPath);
        }
        photoPathsReady = true;
        setStage("understanding");
      }
      if (epoch !== requestEpoch.current || controller.signal.aborted) return;
      transport.dispatched = true;
      await sendAiConversationTurn(
        conversationId,
        text,
        (event: AiStreamEvent) => {
          if (epoch !== requestEpoch.current) return;
          if (event.type === "status") setStage(event.stage);
          if (event.type === "delta") {
            setStage(null);
            setLocalMessages((current) =>
              (current ?? []).map((message) =>
                message.id === assistantId
                  ? { ...message, body: message.body + event.content }
                  : message,
              ),
            );
          }
          if (event.type === "complete") {
            const blocks = event.assistantMessage.blocks?.length
              ? event.assistantMessage.blocks
              : (event.blocks ?? []);
            const serverAssistant = { ...event.assistantMessage, blocks };
            setLocalMessages((current) => {
              const list = current ?? [];
              return list.map((message) =>
                message.id === userMessage.id
                  ? event.userMessage
                  : message.id === assistantId
                    ? serverAssistant
                    : message,
              );
            });
            refreshConversationData(conversationId);
            setStage(null);
            setVerifyingTurn(null);
            if (user && market)
              publishCardSync(user.id, market.id, conversationId);
            if (photos.length) {
              setSelectedPhotos([]);
              for (const file of photos)
                uploadedPhotoPaths.current.delete(file);
            }
          }
          if (event.type === "error") {
            refreshConversationData(conversationId);
            setError(
              friendlyError(new Error(event.message), "تعذر إكمال الرد الآن."),
            );
            if (location) {
              // A location is never kept for a later resend; the user shares again explicitly.
              setLocalMessages((current) =>
                (current ?? []).filter((message) => message.id !== assistantId),
              );
              return;
            }
            setDraft((current) => current || text);
            setFailedTurn({
              text,
              messageId: userMessage.id,
              conversationId,
              imageObjectPaths: photoPathsReady ? imageObjectPaths : undefined,
            });
            setLocalMessages((current) =>
              (current ?? []).filter((message) => message.id !== assistantId),
            );
          }
        },
        controller.signal,
        userMessage.id,
        imageObjectPaths,
        location,
        reasoningEffort,
      );
    } catch (cause) {
      if (epoch !== requestEpoch.current) return;
      // A lost response, or a retry the server says is already settled, is reconciled from the
      // record. The UI never claims that a possibly-executed turn failed, and never sends it again.
      const status = (cause as { status?: unknown })?.status;
      const deliveryUnknown =
        (cause as { deliveryUnknown?: unknown })?.deliveryUnknown === true ||
        status === 409;
      if (deliveryUnknown && !location) {
        const handled = await reconcileDeliveredTurn(
          conversationId,
          text,
          userMessage.id,
          epoch,
        );
        if (handled) return;
      }
      refreshConversationData(conversationId);
      setError(friendlyError(cause));
      if (location) {
        setLocalMessages((current) =>
          (current ?? []).filter((message) => message.id !== assistantId),
        );
        return;
      }
      setDraft((current) => current || text);
      setFailedTurn({
        text,
        messageId: userMessage.id,
        conversationId,
        imageObjectPaths: photoPathsReady ? imageObjectPaths : undefined,
      });
      setLocalMessages((current) =>
        (current ?? []).filter((message) => message.id !== assistantId),
      );
    } finally {
      if (activeStream.current?.controller === controller) activeStream.current = null;
      if (epoch === requestEpoch.current) {
        sending.current = false;
        setStreaming(false);
        setStage(null);
      }
    }
  };

  const addListing = useStableCallback(
    async (listing: Listing, resultSetId: string) => {
      if (sending.current || streaming || verifyingActiveTurn) return false;
      if (!user) {
        setError("سجّل الدخول لإضافة العرض إلى سلتك.");
        return false;
      }
      if (!activeId) {
        setError("ابدأ محادثة محفوظة ثم أعد البحث لإضافة العرض إلى السلة.");
        return false;
      }
      sending.current = true;
      const epoch = requestEpoch.current;
      setAddingListingId(listing.id);
      setError("");
      try {
        const assistantMessage = await addAiListingToCartAction(activeId, {
          resultSetId,
          resourceId: listing.id,
        });
        if (epoch !== requestEpoch.current) return false;
        const alreadyConfirmed =
          confirmedReceipts.current.has(assistantMessage.id) ||
          (messages ?? []).some((message) => message.id === assistantMessage.id);
        if (!alreadyConfirmed) {
          confirmedReceipts.current.add(assistantMessage.id);
          setLocalMessages((current) => [
            ...(current ?? messages),
            assistantMessage,
          ]);
        }
        await refreshCartFromServer();
        if (!alreadyConfirmed) setCartNotice(`أُضيف «${listing.title}» إلى السلة.`);
        refreshConversationData(activeId);
        if (user && market) publishCardSync(user.id, market.id, activeId);
        return !alreadyConfirmed;
      } catch (cause) {
        if (epoch !== requestEpoch.current) return false;
        setError(friendlyError(cause));
        return false;
      } finally {
        if (epoch === requestEpoch.current) {
          sending.current = false;
          setAddingListingId(undefined);
        }
      }
    },
  );

  const submit = async () => {
    const value =
      draft.trim() ||
      (selectedPhotos.some(isChatVideoFile) ? "أرفقت فيديو" : selectedPhotos.some(isSearchPhoto) ? DEFAULT_PHOTO_SEARCH_MESSAGE : selectedPhotos.length ? "أريد انشر إعلان" : "");
    if (!value || streaming || createConversation.isPending || sending.current)
      return;
    if (!activeId) {
      await startConversation(value, selectedPhotos);
      return;
    }
    await sendMessage(activeId, value, messages, undefined, selectedPhotos);
  };

  /**
   * A surface button sends the same conversational command the user could type.
   * Stable identity keeps memoized message bubbles from re-rendering on every update.
   */
  const quickReplyState = useRef({
    activeId,
    streaming,
    messages,
    sendMessage,
    startConversation,
    creating: createConversation.isPending,
  });
  quickReplyState.current = {
    activeId,
    streaming,
    messages,
    sendMessage,
    startConversation,
    creating: createConversation.isPending,
  };
  const sendQuickReply = useCallback(
    (text: string, location?: LocationSubmission) => {
      const current = quickReplyState.current;
      if (current.streaming || current.creating || sending.current) return;
      if (!current.activeId) {
        // Guest choices follow the same preview path as typing. Location submissions
        // still require an authenticated conversation and its server-owned request.
        if (!location) void current.startConversation(text);
        return;
      }
      // Quick replies keep the existing photo behaviour; a location turn never carries photos.
      void current.sendMessage(
        current.activeId,
        text,
        current.messages,
        undefined,
        location ? [] : undefined,
        undefined,
        location,
      );
    },
    [],
  );

  const retryTurn = async () => {
    if (!failedTurn || sending.current || streaming || !online) return;
    const failed = failedTurn;
    const epoch = requestEpoch.current;
    if (!failed.conversationId) {
      if (user) await startConversation(failed.text, selectedPhotos);
      else await guestTurn(failed.text, failed.messageId);
      return;
    }
    try {
      const restored = normalizeDetail(
        await api(`/ai/conversations/${failed.conversationId}`),
      );
      if (epoch !== requestEpoch.current) return;
      const index = restored.messages.findIndex(
        (message) => message.id === failed.messageId,
      );
      setLocalMessages(restored.messages);
      if (
        index >= 0 &&
        restored.messages
          .slice(index + 1)
          .some((message) => message.role === "ASSISTANT")
      ) {
        setError("");
        setFailedTurn(null);
        setDraft((current) => (current === failed.text ? "" : current));
        return;
      }
      await sendMessage(
        failed.conversationId,
        failed.text,
        restored.messages,
        failed.messageId,
        selectedPhotos,
        failed.imageObjectPaths,
      );
    } catch (cause) {
      setError(friendlyError(cause));
    }
  };

  const editOwnMessage = useStableCallback(async (messageId: string, body: string) => {
    if (!user || !activeId || streaming || sending.current) return;
    const edited = messages.find((message) => message.id === messageId);
    if (!edited || edited.role !== "USER") throw new Error("هذه ليست رسالتك.");
    const branch = await copyConversation.mutateAsync(activeId, messageId);
    initializedId.current = branch.id;
    shouldAutoFollow.current = true;
    setActiveId(branch.id);
    setLocalMessages(branch.messages);
    setVisibleMessageCount(40);
    setSidebarOpen(false);
    await sendMessage(branch.id, body, branch.messages, undefined, []);
  });

  const loadOlderMessages = () => {
    const viewport = conversationViewportRef.current;
    if (!viewport || !hasOlderMessages) return;
    previousScrollHeight.current = viewport.scrollHeight;
    setVisibleMessageCount((count) => count + 40);
  };

  const confirmDeleteConversation = async () => {
    const target = conversationToDelete;
    if (!target) return;
    setDeleteConversationError("");
    try {
      await deleteConversation.mutateAsync(target.id, () => {
        if (activeId !== target.id) return;
        initializedId.current = undefined;
        shouldAutoFollow.current = true;
        setActiveId(undefined);
        setLocalMessages(null);
        setVisibleMessageCount(40);
        setShowJumpToBottom(false);
        try {
          if (historyScope && localStorage.getItem(historyScope) === target.id)
            localStorage.removeItem(historyScope);
        } catch {
          /* The server already forgot the conversation. */
        }
      });
      setConversationToDelete(null);
    } catch (cause) {
      setDeleteConversationError(friendlyError(cause));
    }
  };

  const jumpToLatest = () => {
    const viewport = conversationViewportRef.current;
    if (!viewport) return;
    shouldAutoFollow.current = true;
    userScrollUntil.current = 0;
    setShowJumpToBottom(false);
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };

  const handleConversationScroll = (event: UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    const distanceFromBottom =
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    const pinnedToBottom = distanceFromBottom < 96;
    // Moving up while the content and viewport keep their size is the reader going to an older
    // card (find-in-page, a link, an element scrolled into view), not new content arriving. It
    // stops auto-follow, so a later resize (rotation, keyboard, width change) no longer snaps
    // the thread back to the bottom. Growth changes the size; jumping to the latest moves down.
    const previous = lastScrollGeometry.current;
    lastScrollGeometry.current = { top: viewport.scrollTop, height: viewport.scrollHeight, client: viewport.clientHeight };
    if (
      shouldAutoFollow.current &&
      !pinnedToBottom &&
      previous &&
      previous.height === viewport.scrollHeight &&
      previous.client === viewport.clientHeight &&
      viewport.scrollTop < previous.top
    )
      shouldAutoFollow.current = false;
    if (Date.now() < userScrollUntil.current || !shouldAutoFollow.current) {
      shouldAutoFollow.current = pinnedToBottom;
    }
    setShowJumpToBottom(!shouldAutoFollow.current && !pinnedToBottom);
  };

  const latestResultMessageId = [...messages]
    .reverse()
    .find((item) =>
      item.blocks.some((block) => block.type === "LISTING_RESULTS"),
    )?.id;
  const latestWorkflowMessageId = [...messages]
    .reverse()
    .find((item) => item.blocks.some((block) => block.type === "SURFACE"))?.id;
  const latestContextBlock = [...messages]
    .reverse()
    .flatMap((message) => [...message.blocks].reverse())
    .find(
      (block) =>
        block.type === "LISTING_RESULTS" || block.type === "SURFACE",
    );
  const currentSearchState =
    latestContextBlock?.type === "LISTING_RESULTS"
      ? latestContextBlock.payload.searchState
      : undefined;
  const searchContext =
    currentSearchState &&
    (currentSearchState.search.trim() ||
      currentSearchState.categoryId ||
      currentSearchState.filters.length ||
      currentSearchState.sort)
      ? currentSearchState
      : undefined;
  useEffect(() => {
    if (!searchContext) setContextDrawerOpen(false);
  }, [searchContext]);
  const editSearchContext = () => {
    setDraft((current) => (current.trim() ? current : "عدّل البحث: "));
    setContextDrawerOpen(false);
    window.requestAnimationFrame(() =>
      document
        .querySelector<HTMLTextAreaElement>(
          '[data-testid="input-ai-composer"]',
        )
        ?.focus(),
    );
  };

  const contextListings: Listing[] =
    latestContextBlock?.type === "LISTING_RESULTS"
      ? ((latestContextBlock.payload.listings ?? []) as Listing[])
      : [];
  const contextHero = contextListings.find((listing) => listing.imageUrl);
  // The panel title is the buyer's own query: free text, else the named values they asked for.
  const contextTitle =
    searchContext?.search.trim() ||
    searchContext?.filters
      .filter((filter) => typeof filter.value === "string" && (filter.operator === "eq" || filter.operator === "contains") && !/city|area|location|condition/i.test(filter.field))
      .slice(0, 2)
      .map((filter) => filter.value)
      .join(" ") ||
    "سياق البحث";
  // Navigation entries are real conversation commands: an empty chat takes the command,
  // otherwise it opens a fresh conversation. Pending photos never ride along.
  // The cart link navigates through /cart, which remounts this page: the unsent draft is kept in
  // this tab's sessionStorage for that one navigation and taken back by the read command.
  const stashDraft = () => {
    try { if (draft.trim()) sessionStorage.setItem(UNSENT_DRAFT_KEY, draft.slice(0, 4000)); } catch { /* storage unavailable */ }
  };
  // A read command (cart, orders, listings) opens its surface without discarding what the user was
  // typing: the unsent draft is put back once the command's conversation has started.
  // An answer card's choice is sent as the user's next message in the open conversation.
  useEffect(() => {
    const onCompose = (event: Event) => {
      const text = String((event as CustomEvent).detail ?? "").trim().slice(0, 200);
      if (!text) return;
      if (activeId) void sendMessage(activeId, text);
      else void startConversation(text, []);
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  });
  const runCommand = (value: string) => {
    setSidebarOpen(false);
    const unsent = draft || takeStashedDraft();
    const restore = () => { if (unsent.trim()) setDraft((current) => current || unsent); };
    if (showWelcome && activeId) void sendMessage(activeId, value).finally(restore);
    else void startConversation(value, []).finally(restore);
  };
  useEffect(() => {
    if (ordersEntryHandled.current || accountLoading || identityVerifying || !market || detail.isLoading)
      return;
    const params = new URLSearchParams(window.location.search);
    // These links request existing read-only surfaces through the same runtime as the sidebar.
    // A URL cannot supply an arbitrary command or execute a commercial action.
    const readCommands = new Map([
      ["cart", "اعرض السلة"],
      ["listings", "اعرض إعلاناتي"],
      ["sales", "دينار أعطني إحصائيات مبيعاتي"],
      ["dues", "اعرض مستحقاتي"],
    ]);
    const command = params.get("openOrders") === "1"
      ? "طلباتي"
      : readCommands.get(params.get("openSurface") ?? "");
    if (!command) return;
    ordersEntryHandled.current = true;
    if (params.has("openSurface")) window.history.replaceState(null, "", window.location.pathname);
    runCommand(command);
  }, [accountLoading, identityVerifying, market?.id, detail.isLoading, runCommand]);
  useEffect(() => {
    if (sellEntryHandled.current || accountLoading || !market || detail.isLoading)
      return;
    if (new URLSearchParams(window.location.search).get("sell") !== "1")
      return;
    sellEntryHandled.current = true;
    setDraft((current) => current || "أريد أن أبيع ");
    window.history.replaceState(null, "", window.location.pathname);
  }, [accountLoading, market?.id, detail.isLoading]);
  // A page outside the chat (e.g. a negotiable listing) may pre-type a request; it is only a
  // draft in the composer and is never sent without the user.
  useEffect(() => {
    if (askEntryHandled.current || accountLoading || !market || detail.isLoading)
      return;
    const ask = new URLSearchParams(window.location.search).get("ask")?.trim();
    if (!ask) return;
    askEntryHandled.current = true;
    setDraft((current) => current || ask.slice(0, 200));
    window.history.replaceState(null, "", window.location.pathname);
  }, [accountLoading, market?.id, detail.isLoading]);
  // Business shortcuts are ordinary conversation commands, shown to signed-in users only.
  const navItems: {
    label: string;
    icon: LucideIcon;
    testId: string;
    onSelect: () => void;
  }[] = user
    ? [
        {
          label: "إعلاناتي",
          icon: LayoutGrid,
          testId: "nav-my-listings",
          onSelect: () => runCommand("اعرض إعلاناتي"),
        },
        {
          label: "طلباتي",
          icon: ShoppingBag,
          testId: "nav-my-orders",
          onSelect: () => runCommand("طلباتي"),
        },
      ]
    : [];
  const openConversationSearch = () => {
    focusConversationSearchOnOpen.current = true;
    setSidebarCollapsed(false);
    setShowAllConversations(true);
    if (window.matchMedia("(max-width: 1023px)").matches) setSidebarOpen(true);
    window.requestAnimationFrame(() => conversationSearchRef.current?.focus());
  };
  // A starter that needs the user's own words fills the composer; nothing is sent.
  const composeStarter = (prefill: string) => {
    setDraft(prefill);
    window.requestAnimationFrame(() => {
      const composer = document.querySelector<HTMLTextAreaElement>('[data-testid="input-ai-composer"]');
      if (!composer) return;
      composer.focus();
      composer.setSelectionRange(prefill.length, prefill.length);
    });
  };
  const contextBody = searchContext && (
    <>
      <div className="ai-context-hero">
        {contextHero && (
          <SmartImage src={contextHero.imageUrl} alt="" className="ai-context-hero-image" />
        )}
        <div className="ai-context-hero-copy">
          <span className="ai-context-kicker">
            <SlidersHorizontal size={14} aria-hidden /> نتائج البحث
            {contextListings.length > 0 && <span className="num"> · {contextListings.length}</span>}
          </span>
          <h2>{contextTitle}</h2>
        </div>
      </div>
      <SearchRefinements state={searchContext} variant="panel" />
      <button
        type="button"
        className="ai-context-edit-search"
        data-testid="button-edit-search-context"
        onClick={editSearchContext}
      >
        <SlidersHorizontal size={17} aria-hidden />
        تعديل البحث
      </button>
      {contextListings.length > 0 && (
        <section className="ai-context-card" aria-label="نصائح من دينار">
          <h3>
            <span className="ai-context-card-icon is-gold" aria-hidden><Lightbulb size={18} /></span>
            نصائح من دينار
          </h3>
          <p>رأي مبني على نتائج هذا البحث داخل دينار فقط، مع ذكر ما لا نعرفه.</p>
          <button type="button" className="ai-context-link" disabled={streaming} onClick={() => sendQuickReply("وش تنصحني؟")} data-testid="button-context-advice">
            اطلب نصيحة دينار
            <ChevronLeft size={16} aria-hidden />
          </button>
        </section>
      )}
      {contextListings.length > 0 && (
        <section className="ai-context-card" aria-label="إجراءات سريعة">
          <h3>إجراءات سريعة</h3>
          <div className="ai-context-actions">
            {contextListings.length > 1 && (
              <button type="button" disabled={streaming} onClick={() => sendQuickReply("قارن الأول والثاني")} data-testid="button-context-compare">
                <GitCompareArrows size={17} aria-hidden />
                قارن أول نتيجتين
              </button>
            )}
            <button type="button" disabled={streaming} onClick={() => sendQuickReply("الأول")} data-testid="button-context-first">
              <LayoutGrid size={17} aria-hidden />
              تفاصيل النتيجة الأولى
            </button>
          </div>
        </section>
      )}
    </>
  );

  const startConversationRef = useRef(startConversation);
  startConversationRef.current = startConversation;
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  useEffect(() => {
    const handoff = guestHandoffToResume.current;
    if (
      accountLoading ||
      !user ||
      !market ||
      !handoff ||
      guestHandoffInProgress.current ||
      streaming ||
      createConversation.isPending ||
      guestHandoffFailed
    )
      return;
    if (handoff.marketId !== market.id) {
      setError("تغيّر السوق؛ لم أنقل المحادثة السابقة.");
      return;
    }
    if (handoff.targetUserId !== user.id) {
      setError("المحادثة محفوظة للحساب الذي بدأها؛ سجّل الدخول إليه لنقلها.");
      return;
    }

    guestHandoffInProgress.current = true;
    const epoch = requestEpoch.current;
    void (async () => {
      try {
        const result = await createAiGuestHandoff({
          handoffId: handoff.handoffId,
          userId: handoff.targetUserId,
          marketId: handoff.marketId,
          messages: guestHandoffMessages(
            handoff.messages,
            handoff.authIntent?.messageId,
          ),
          ...(handoff.authIntent
            ? {
                continuation: {
                  messageId: handoff.authIntent.messageId,
                  body: handoff.authIntent.message,
                  ...(handoff.authIntent.listingId ? { listingId: handoff.authIntent.listingId } : {}),
                },
              }
            : {}),
        });
        if (epoch !== requestEpoch.current) return;

        setActiveId(result.id);
        setLocalMessages(null);
        setError("");
        setGuestHandoffFailed(false);
        guestContext.current = {};
        authIntent.current = null;
        refreshConversationData(result.id);

        if (
          handoff.authIntent &&
          (result.continuationStatus === "NOT_STARTED" ||
            result.continuationStatus === "FAILED")
        ) {
          await sendMessageRef.current(
            result.id,
            handoff.authIntent.message,
            result.messages,
            handoff.authIntent.messageId,
            [],
          );
        }
        if (epoch !== requestEpoch.current) return;

        try {
          clearGuestHandoff();
        } catch {
          /* The authenticated conversation is already safely stored. */
        }
        guestHandoffToResume.current = null;
        guestHandoffId.current = undefined;
        authIntent.current = null;
      } catch (cause) {
        if (epoch !== requestEpoch.current) return;
        setError(friendlyError(cause));
        if (isFinalHandoffRejection(cause)) {
          // The server refused this handoff id for good: keep the refusal visible, but do not
          // offer it again or resend it after a reload.
          clearGuestHandoff();
          guestHandoffToResume.current = null;
          guestHandoffId.current = undefined;
        } else setGuestHandoffFailed(true);
      } finally {
        guestHandoffInProgress.current = false;
      }
    })();
  }, [
    user?.id,
    market?.id,
    accountLoading,
    activeId,
    streaming,
    createConversation.isPending,
    guestHandoffFailed,
    guestHandoffRetry,
  ]);

  // Dialogs and popovers render in portals under <body>; while the dark workspace is
  // mounted they take its palette instead of the light admin one.
  useEffect(() => {
    document.body.classList.add("dinar-dark-portals");
    return () => document.body.classList.remove("dinar-dark-portals");
  }, []);

  useEffect(() => {
    const newChat = () => {
      void startConversationRef.current();
    };
    // Ctrl/⌘ + Shift + O starts a new conversation, as in other chat assistants.
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        newChat();
      }
    };
    window.addEventListener("dinar:new-conversation", newChat);
    window.addEventListener("keydown", shortcut);
    return () => {
      window.removeEventListener("dinar:new-conversation", newChat);
      window.removeEventListener("keydown", shortcut);
    };
  }, []);

  const chatComposer = (
    <ChatComposer
      draft={draft}
      onDraftChange={setDraft}
      onSubmit={() => void submit()}
      onStop={streaming && activeStream.current?.dispatched && activeStream.current.stoppable
        ? () => activeStream.current?.controller.abort() : undefined}
      photos={selectedPhotos}
      onPhotosChange={(files) => {
        setSelectedPhotos(files);
        if (failedTurn?.imageObjectPaths) setFailedTurn(null);
      }}
      canUploadPhotos={Boolean(user)}
      busy={
        streaming || createConversation.isPending || Boolean(addingListingId) || verifyingActiveTurn
      }
      offline={!online}
      reasoningEffort={reasoningEffort}
      onReasoningEffortChange={setReasoningEffort}
    />
  );

  const composerRegion = (
    <div className="dinar-chat-dock">
      <p className="sr-only" role="status" aria-live="polite" data-testid="cart-confirmation-status">{cartNotice}</p>
      {error && (
        <div
          className="mx-4 mb-2 rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive md:mx-10"
          role="alert"
        >
          <p>{error}</p>
          {verifyingTurn && (
            <button
              type="button"
              disabled={streaming}
              onClick={() => void verifyTurn()}
              className={buttonClass("ghost", "sm", false, "mt-1")}
              data-testid="button-verify-ai-turn"
            >
              تحقق من النتيجة
            </button>
          )}
          {failedTurn && (
            <button
              type="button"
              disabled={streaming || !online}
              onClick={() => void retryTurn()}
              className={buttonClass("ghost", "sm", false, "mt-1")}
              data-testid="button-retry-ai-turn"
            >
              إعادة المحاولة
            </button>
          )}
          {guestHandoffFailed && (
            <button
              type="button"
              disabled={streaming || !online}
              onClick={() => {
                setGuestHandoffFailed(false);
                setGuestHandoffRetry((attempt) => attempt + 1);
              }}
              className={buttonClass("ghost", "sm", false, "mt-1")}
              data-testid="button-retry-guest-handoff"
            >
              إعادة نقل المحادثة
            </button>
          )}
        </div>
      )}
      {!online && (
        <p
          role="status"
          className="px-4 pb-2 text-center text-xs text-muted-foreground"
        >
          أنت غير متصل. ستبقى رسالتك هنا حتى يعود الاتصال.
        </p>
      )}
      {chatComposer}
    </div>
  );

  if (accountLoading) {
    return (
      <div
        className="container-app space-y-4 pt-8"
        aria-busy="true"
        aria-label="جارٍ التحميل"
      >
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-[55dvh] w-full rounded-2xl" />
      </div>
    );
  }

  const tip = (label: string, shortcut?: string) => (
    <TooltipContent side="right" align="center" sideOffset={8} collisionPadding={12} className="ai-tooltip">
      {label}
      {shortcut && <kbd dir="ltr">{shortcut}</kbd>}
    </TooltipContent>
  );

  return (
    <div
      className="dinar-chatgpt ai-shell ai-home relative"
      data-keyboard={keyboardOpen ? "open" : undefined}
      data-identity={identityVerifying ? "verifying" : undefined}
    >
      {identityVerifying && (
        // Back from another tab: nothing private shows or can be used until the server confirms
        // who is signed in now.
        <p className="ai-identity-check" role="status" data-testid="identity-verifying">
          يتحقق DINAR من الحساب…
        </p>
      )}
      <button
        type="button"
        aria-label="فتح الشريط الجانبي"
        aria-controls="ai-conversation-history"
        data-testid="button-toggle-conversation-history"
        aria-expanded={sidebarOpen}
        className="ai-mobile-sidebar-trigger pressable"
        onClick={() => setSidebarOpen(true)}
      >
        <DinarMark size={27} aria-hidden />
      </button>
      <Link
        href="/cart"
        onClick={stashDraft}
        aria-label={unitCount ? `السلة، ${unitCount} وحدة` : "السلة"}
        data-testid="link-cart"
        className="ai-mobile-cart-trigger pressable"
      >
        <ShoppingCart size={22} aria-hidden />
        {unitCount > 0 && (
          <span
            key={unitCount}
            data-testid="badge-cart-units"
            className="num absolute end-0.5 top-0.5 flex h-[18px] min-w-[18px] animate-pop items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground ring-2 ring-background"
          >
            {unitCount > 99 ? "99+" : unitCount}
          </span>
        )}
      </Link>
      <div className="ai-home-content flex h-full min-h-0 flex-col" inert={identityVerifying || undefined}>
        <div
          className="ai-layout"
          data-history-open="true"
          data-sidebar-collapsed={sidebarCollapsed}
          data-has-context={Boolean(searchContext)}
          data-context-open={contextOpen}
        >
          <nav className="ai-desktop-rail" aria-label="أدوات DINAR">
            <TooltipProvider delayDuration={300} skipDelayDuration={100}>
              <span className="ai-rail-brand" aria-hidden="true">
                <DinarMark size={30} />
              </span>
              <div className="ai-rail-actions">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="ai-rail-action pressable"
                      aria-label="فتح الشريط الجانبي"
                      aria-controls="ai-conversation-history"
                      aria-expanded={!sidebarCollapsed}
                      data-testid="button-expand-conversation-sidebar"
                      onClick={() => setSidebarCollapsed(false)}
                    >
                      <PanelLeftOpen size={19} aria-hidden />
                    </button>
                  </TooltipTrigger>
                  {tip("فتح الشريط الجانبي")}
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="محادثة جديدة"
                      aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
                      data-testid="button-new-conversation-header"
                      data-active={showWelcome}
                      className="ai-rail-action pressable"
                      onClick={() => window.dispatchEvent(new Event("dinar:new-conversation"))}
                    >
                      <SquarePen size={19} aria-hidden />
                    </button>
                  </TooltipTrigger>
                  {tip("محادثة جديدة", "Ctrl ⇧ O")}
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      aria-label="البحث في المحادثات"
                      aria-controls="ai-conversation-history"
                      data-testid="button-search-conversations"
                      className="ai-rail-action pressable"
                      onClick={openConversationSearch}
                    >
                      <Search size={19} aria-hidden />
                    </button>
                  </TooltipTrigger>
                  {tip("البحث في المحادثات")}
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Link
                      href="/cart"
        onClick={stashDraft}
                      className="ai-rail-action pressable relative"
                      aria-label={unitCount ? `السلة، ${unitCount} وحدة` : "السلة"}
                      data-testid="sidebar-cart"
                    >
                      <ShoppingCart size={19} aria-hidden />
                      {unitCount > 0 && (
                        <span
                          key={unitCount}
                          data-testid="badge-cart-units"
                          className="num absolute end-0.5 top-0.5 flex h-[18px] min-w-[18px] animate-pop items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accent-foreground ring-2 ring-background"
                        >
                          {unitCount > 99 ? "99+" : unitCount}
                        </span>
                      )}
                    </Link>
                  </TooltipTrigger>
                  {tip("السلة")}
                </Tooltip>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={user ? `حسابي، ${user.displayName}` : "تسجيل الدخول"}
                    data-testid="button-rail-account"
                    className="ai-rail-profile pressable"
                    onClick={() => window.dispatchEvent(new Event("dinar:account"))}
                  >
                    {user ? (
                      <Avatar name={user.displayName} src={user.avatarObjectPath ? `/api/storage${user.avatarObjectPath}` : undefined} size={32} />
                    ) : (
                      <UserRound size={19} aria-hidden />
                    )}
                  </button>
                </TooltipTrigger>
                {tip(user ? "حسابي" : "تسجيل الدخول")}
              </Tooltip>
            </TooltipProvider>
          </nav>
          <ConversationSidebar
            open={sidebarOpen && !identityVerifying}
            onOpenChange={setSidebarOpen}
            collapsed={sidebarCollapsed}
          >
            <div className="ai-history-header">
              <span className="ai-sidebar-mark" aria-hidden="true">
                <DinarMark size={30} />
              </span>
              <DinarWordmark className="ai-sidebar-wordmark" />
              <button
                type="button"
                className="ai-sidebar-collapse is-wide-only"
                aria-label="طي الشريط الجانبي"
                aria-expanded={!sidebarCollapsed}
                aria-controls="ai-conversation-history"
                data-testid="button-collapse-conversation-sidebar"
                onClick={() => setSidebarCollapsed(true)}
              >
                <PanelLeftClose size={18} aria-hidden />
              </button>
              <button
                type="button"
                className="ai-sidebar-collapse is-narrow-only"
                aria-label="إغلاق القائمة"
                data-testid="button-close-conversation-drawer"
                onClick={() => setSidebarOpen(false)}
              >
                <X size={19} aria-hidden />
              </button>
            </div>
            <button
              type="button"
              className="ai-sidebar-new pressable"
              disabled={streaming || createConversation.isPending}
              aria-busy={createConversation.isPending || undefined}
              aria-keyshortcuts="Control+Shift+O Meta+Shift+O"
              onClick={() => void startConversation()}
              data-testid="button-new-conversation"
            >
              <SquarePen size={17} aria-hidden />
              <span>محادثة جديدة</span>
              <kbd dir="ltr" className="max-[1023px]:hidden">Ctrl ⇧ O</kbd>
            </button>
            <label className="ai-history-search">
              <Search size={16} aria-hidden />
              <input
                ref={conversationSearchRef}
                id="input-conversation-search"
                type="search"
                value={historyQuery}
                onChange={(event) => setHistoryQuery(event.target.value)}
                placeholder="ابحث في محادثاتك"
                aria-label="البحث في المحادثات"
                data-testid="input-conversation-search"
              />
            </label>
            <div className="ai-history-heading">
              <p>
                {showAllConversations ? "كل المحادثات" : "المحادثات الأخيرة"}
              </p>
              {conversations.data && conversations.data.length > 5 && (
                <button
                  type="button"
                  className="ai-history-toggle"
                  aria-controls="conversation-history-list"
                  aria-expanded={showAllConversations}
                  data-testid="button-toggle-all-conversations"
                  onClick={() => {
                    setShowAllConversations((showAll) => !showAll);
                    setHistoryQuery("");
                  }}
                >
                  {showAllConversations ? "عرض الأحدث" : "عرض الكل"}
                </button>
              )}
            </div>
            <div id="conversation-history-list" className="ai-history-list">
              {!user ? (
                <p className="ai-history-empty">
                  سجّل الدخول لحفظ محادثاتك والعودة إليها من أي جهاز.
                </p>
              ) : conversations.isLoading ? (
                <div className="space-y-2 px-2" aria-busy="true">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </div>
              ) : conversations.isError ? (
                <ErrorState compact onRetry={() => conversations.refetch()} />
              ) : visibleConversations.length === 0 ? (
                <p className="ai-history-empty">
                  {historyQuery.trim() ? "لا توجد محادثات مطابقة." : "لا توجد محادثات بعد."}
                </p>
              ) : (
                <div className="ai-history-groups">
                  {conversationGroups.map(([label, group]) => (
                    <section key={label} className="ai-history-group" aria-label={label}>
                      <h3>{label}</h3>
                      {group.map((conversation) => (
                        <ConversationItem
                          key={conversation.id}
                          conversation={conversation}
                          active={activeId === conversation.id}
                          deleteDisabled={streaming || deleteConversation.isPending || copyConversation.isPending}
                          copyDisabled={streaming || copyConversation.isPending}
                          onCopy={async () => {
                            if (streaming) return;
                            const copy = await copyConversation.mutateAsync(conversation.id);
                            initializedId.current = copy.id;
                            setActiveId(copy.id);
                            setLocalMessages(copy.messages);
                            setVisibleMessageCount(40);
                            setSidebarOpen(false);
                          }}
                          onClick={() => {
                            if (streaming) return;
                            shouldAutoFollow.current = true;
                            setShowJumpToBottom(false);
                            setActiveId(conversation.id);
                            setSidebarOpen(false);
                          }}
                          onRename={(title) => renameConversation.mutateAsync(conversation.id, title)}
                          onDelete={() => {
                            setDeleteConversationError("");
                            setConversationToDelete({
                              id: conversation.id,
                              title: conversation.title || "محادثة جديدة",
                            });
                          }}
                        />
                      ))}
                    </section>
                  ))}
                </div>
              )}
            </div>
            <div className="ai-sidebar-footer">
              {navItems.length > 0 && (
                <nav className="ai-sidebar-management" aria-label="إدارة دينار">
                  {navItems.map(({ label, icon: Icon, testId, onSelect }) => (
                    <button
                      key={testId}
                      type="button"
                      className="ai-sidebar-management-link"
                      data-testid={testId}
                      disabled={streaming}
                      onClick={onSelect}
                    >
                      <Icon size={16} aria-hidden />
                      <span>{label}</span>
                    </button>
                  ))}
                </nav>
              )}
              <Link
                href="/cart"
        onClick={stashDraft}
                className="ai-sidebar-cart pressable"
                data-testid="footer-cart"
                aria-label={unitCount ? `السلة، ${unitCount} وحدة` : "السلة"}
              >
                <ShoppingCart size={16} aria-hidden />
                <span>السلة</span>
                {unitCount > 0 && (
                  <span
                    className="ai-sidebar-cart-count num"
                    data-testid="badge-cart-units"
                  >
                    {unitCount > 99 ? "99+" : unitCount}
                  </span>
                )}
              </Link>
              <MarketChip className="ai-sidebar-market w-full justify-between" />
              <div className="ai-sidebar-account-row">
                <button
                  type="button"
                  onClick={() => {
                    setSidebarOpen(false);
                    window.dispatchEvent(new Event("dinar:account"));
                  }}
                  className="ai-sidebar-account"
                  data-testid="link-history-account"
                >
                  {user ? (
                    <Avatar name={user.displayName} src={user.avatarObjectPath ? `/api/storage${user.avatarObjectPath}` : undefined} size={32} />
                  ) : (
                    <span className="ai-sidebar-account-guest" aria-hidden><UserRound size={17} /></span>
                  )}
                  <span className="min-w-0 flex-1 text-start">
                    <strong>{user ? user.displayName : "تسجيل الدخول"}</strong>
                    <span className="block truncate">{user ? "حسابي" : "احفظ محادثاتك وأدِر أعمالك"}</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSidebarOpen(false);
                    window.dispatchEvent(new Event("dinar:settings"));
                  }}
                  className="ai-sidebar-settings"
                  aria-label="الإعدادات"
                  title="الإعدادات"
                  data-testid="link-history-settings"
                >
                  <Settings size={18} aria-hidden />
                </button>
              </div>
            </div>
          </ConversationSidebar>

          <section
            className={cn(
              "dinar-chat-conversation ai-conversation",
              showWelcome && "dinar-chat-empty",
            )}
            data-has-context={Boolean(searchContext && !showWelcome)}
            aria-label="محادثة DINAR"
          >
            {searchContext && !showWelcome && (
              <button
                type="button"
                className="ai-context-launch"
                aria-controls="ai-context-drawer"
                aria-expanded={contextDrawerOpen}
                data-testid="button-open-search-context-desktop"
                onClick={() => setContextDrawerOpen(true)}
              >
                <SlidersHorizontal size={16} aria-hidden />
                سياق البحث
              </button>
            )}
            {detail.isError ? (
              <div className="ai-state-region flex items-center justify-center px-5">
                <ErrorState compact onRetry={() => detail.refetch()} />
              </div>
            ) : detail.isLoading && activeId && !localMessages?.length ? (
              <div
                className="ai-state-region space-y-5 p-5 md:p-8"
                aria-busy="true"
              >
                <Skeleton className="h-16 w-3/4" />
                <Skeleton className="ms-auto h-24 w-2/3" />
                <Skeleton className="h-36 w-full" />
              </div>
            ) : messages.length === 0 ? (
              <>
                <div
                  className="ai-home-scroll"
                  data-testid="home-scroll-region"
                >
                  <div className="ai-home-stack">
                    <Welcome
                      onStarter={(value) =>
                        activeId
                          ? sendMessage(activeId, value)
                          : startConversation(value)
                      }
                      onCompose={composeStarter}
                      busy={!online || streaming || createConversation.isPending}
                      onImage={() => {
                        composeStarter("ابحث عن منتج مشابه للصورة المرفقة: ");
                        document.querySelector<HTMLButtonElement>('[data-testid="button-ai-attachment-info"]')?.click();
                      }}
                    />
                    {composerRegion}
                  </div>
                </div>
              </>
            ) : (
              <div className="ai-thread-region">
                <div
                  ref={conversationViewportRef}
                  role="log"
                  aria-live="off"
                  onScroll={handleConversationScroll}
                  onWheel={(event) => {
                    if (event.deltaY)
                      userScrollUntil.current = Date.now() + 1500;
                  }}
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget)
                      userScrollUntil.current = Date.now() + 1500;
                  }}
                  onTouchStart={(event) => {
                    const touch = event.touches[0];
                    if (touch)
                      touchOrigin.current = {
                        x: touch.clientX,
                        y: touch.clientY,
                      };
                  }}
                  onTouchMove={(event) => {
                    const touch = event.touches[0];
                    const origin = touchOrigin.current;
                    if (
                      touch &&
                      origin &&
                      Math.abs(touch.clientY - origin.y) >
                        Math.abs(touch.clientX - origin.x)
                    )
                      userScrollUntil.current = Date.now() + 1500;
                  }}
                  onKeyDown={(event) => {
                    if (
                      [
                        "ArrowUp",
                        "ArrowDown",
                        "PageUp",
                        "PageDown",
                        "Home",
                        "End",
                        " ",
                      ].includes(event.key)
                    )
                      userScrollUntil.current = Date.now() + 1500;
                  }}
                  onFocusCapture={() => {
                    userScrollUntil.current = Date.now() + 1500;
                  }}
                  data-testid="conversation-thread"
                  className="ai-thread"
                >
                  <ActiveConversationContext.Provider value={activeId}>
                  <div
                    ref={threadContentRef}
                    className="mx-auto flex w-full max-w-[960px] flex-col gap-6"
                  >
                    {hasOlderMessages && (
                      <button
                        type="button"
                        className={buttonClass("ghost", "sm", false, "mx-auto")}
                        onClick={loadOlderMessages}
                        data-testid="button-load-older-messages"
                      >
                        تحميل رسائل أقدم
                      </button>
                    )}
                    {visibleMessages
                      .filter(
                        (message) => message.body || message.blocks.length,
                      )
                      .map((message) => (
                        <MessageBubble
                          key={message.id}
                          message={message}
                          onEdit={user && activeId ? editOwnMessage : undefined}
                          activeWorkflow={
                            message.id === latestWorkflowMessageId
                          }
                          activeResults={Boolean(
                            user &&
                            activeId &&
                            message.id === latestResultMessageId,
                          )}
                          addingListingId={addingListingId}
                          onAdd={addListing}
                          onSend={sendQuickReply}
                          onSelectMarket={resumeGuestMarket}
                          busy={streaming || createConversation.isPending || verifyingActiveTurn}
                        />
                      ))}
                    {stage && (
                      <div
                        role="status"
                        className="ai-typing ai-message-in"
                        data-testid="ai-typing"
                        data-stage={stage}
                      >
                        <span className="ai-assistant-avatar ai-typing-avatar" aria-hidden>
                          <DinarMark size={20} className="ai-typing-mark" />
                        </span>
                        <span className="ai-typing-label">
                          {stage === "uploading"
                            ? "أرفع الصور…"
                            : stage === "understanding"
                              ? "أجهز ردك…"
                              : "أبحث داخل DINAR…"}
                        </span>
                      </div>
                    )}
                  </div>
                  </ActiveConversationContext.Provider>
                </div>
                {showJumpToBottom && (
                  <div className="ai-jump-to-bottom">
                    <button
                      type="button"
                      aria-label="العودة للأسفل"
                      title="العودة للأسفل"
                      className={`${iconButtonClass("outline")} pointer-events-auto`}
                      onClick={jumpToLatest}
                      data-testid="button-return-to-latest"
                    >
                      <ArrowDown size={16} aria-hidden />
                      <span className="sr-only">العودة للأسفل</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {!showWelcome && composerRegion}
          </section>
          {searchContext && (
            <aside
              className={cn("ai-context-panel", !contextOpen && "is-collapsed")}
              dir="rtl"
              aria-label="سياق البحث الحالي"
              data-testid="search-context-panel"
            >
              <div className="ai-context-heading">
                <span className="ai-context-heading-label">سياق المحادثة</span>
                <button
                  type="button"
                  aria-label={contextOpen ? "طي سياق البحث" : "إظهار سياق البحث"}
                  aria-expanded={contextOpen}
                  className="ai-context-toggle"
                  onClick={() => setContextOpen((open) => !open)}
                >
                  <PanelRightClose size={17} aria-hidden />
                </button>
              </div>
              {contextOpen && <div className="ai-context-content">{contextBody}</div>}
            </aside>
          )}
          {searchContext && (
            <Dialog.Root
              open={contextDrawerOpen && !identityVerifying}
              onOpenChange={setContextDrawerOpen}
            >
              <Dialog.Portal>
                <Dialog.Overlay className="ai-context-overlay" />
                <Dialog.Content
                  id="ai-context-drawer"
                  dir="rtl"
                  className="ai-context-drawer"
                  data-testid="search-context-drawer"
                  onCloseAutoFocus={(event) => {
                    event.preventDefault();
                    contextButtonRef.current?.focus();
                  }}
                >
                  <Dialog.Title className="sr-only">سياق البحث</Dialog.Title>
                  <Dialog.Description className="sr-only">
                    معايير البحث المرتبطة بالنتائج الحالية.
                  </Dialog.Description>
                  <div className="ai-context-drawer-header">
                    <span className="ai-context-heading-label">سياق المحادثة</span>
                    <Dialog.Close asChild>
                      <button
                        type="button"
                        className="ai-context-toggle"
                        aria-label="إغلاق سياق البحث"
                      >
                        <X size={18} aria-hidden />
                      </button>
                    </Dialog.Close>
                  </div>
                  <div className="ai-context-content">{contextBody}</div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={Boolean(conversationToDelete)}
        onOpenChange={(open) => {
          if (deleteConversation.isPending) return;
          if (!open) {
            setConversationToDelete(null);
            setDeleteConversationError("");
          }
        }}
        title="حذف المحادثة؟"
        body={
          conversationToDelete
            ? `سيتم حذف «${conversationToDelete.title}» مع جميع رسائلها وبطاقاتها نهائيًا. لا يمكن التراجع عن هذا الإجراء.`
            : undefined
        }
        confirmLabel="حذف المحادثة"
        cancelLabel="إبقاء المحادثة"
        tone="danger"
        onConfirm={() => void confirmDeleteConversation()}
        loading={deleteConversation.isPending}
        icon={<Trash2 size={20} aria-hidden />}
      >
        {deleteConversationError && (
          <p
            className="rounded-lg bg-destructive-soft px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {deleteConversationError}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
