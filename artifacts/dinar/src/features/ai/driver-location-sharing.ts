/**
 * The driver's explicit, foreground-only location sharing for one assigned delivery.
 *
 * This is the only module in DINAR allowed to read location continuously (watchPosition), and
 * only between the driver's explicit start and stop. It:
 *  - runs only while the page is visible: a hidden tab or a locked phone pauses sharing (web
 *    browsers do not allow background collection, and DINAR does not pretend otherwise);
 *  - sends at most one fix every SEND_INTERVAL_MS with a strictly increasing sequence;
 *  - keeps only latitude, longitude, accuracy and the device timestamp (no speed, heading, altitude);
 *  - stops by itself when the server says the session or the delivery has ended.
 */
export const SEND_INTERVAL_MS = 5_000;

export type SharingState =
  | { kind: "IDLE" }
  | { kind: "WAITING_FOR_FIX" }
  | { kind: "SHARING"; lastSentAt: number }
  | { kind: "PAUSED_HIDDEN" }
  | { kind: "PERMISSION_DENIED" }
  | { kind: "UNAVAILABLE" }
  | { kind: "REJECTED"; code: string }
  | { kind: "ENDED" };

type Post = (path: string, body: unknown) => Promise<{ status: number; data: any }>;

const defaultPost: Post = async (path, body) => {
  const response = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { status: response.status, data };
};

export function createDriverLocationSharer(input: {
  orderId: string;
  initialSequence: number;
  onState: (state: SharingState) => void;
  post?: Post;
  geolocation?: Geolocation;
  now?: () => number;
}) {
  const geo = input.geolocation ?? (typeof navigator !== "undefined" ? navigator.geolocation : undefined);
  const post = input.post ?? defaultPost;
  const now = input.now ?? (() => Date.now());
  const path = `/api/courier/orders/${encodeURIComponent(input.orderId)}/location-sharing/location`;
  let sequence = input.initialSequence;
  let watchId: number | null = null;
  let lastSentAt = 0;
  let inFlight = false;
  let running = false;

  const clear = () => {
    if (watchId !== null && geo) geo.clearWatch(watchId);
    watchId = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    pending = null;
  };

  let pending: GeolocationPosition | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (delay: number) => {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      const next = pending;
      pending = null;
      if (next) void send(next);
    }, Math.max(250, delay));
  };

  const send = async (position: GeolocationPosition) => {
    if (!running) return;
    // Only the newest reading matters: an older pending one is replaced, never queued.
    const wait = SEND_INTERVAL_MS - (now() - lastSentAt);
    if (inFlight || wait > 0) {
      pending = position;
      schedule(inFlight ? 500 : wait);
      return;
    }
    inFlight = true;
    sequence += 1;
    try {
      const result = await post(path, {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyMeters: Math.round(position.coords.accuracy),
        observedAt: new Date(position.timestamp).toISOString(),
        sequence,
      });
      if (result.status === 202) {
        lastSentAt = now();
        input.onState({ kind: "SHARING", lastSentAt });
      } else if (result.status === 429) {
        lastSentAt = now();
        pending = pending ?? position;
        schedule(Number(result.data?.retryAfterMs) || SEND_INTERVAL_MS);
      } else if (result.status === 409 && result.data?.reason === "DUPLICATE_OR_OUT_OF_ORDER") {
        // Another tab or an older fix: the next reading carries a higher sequence.
      } else if (result.status === 409 || result.status === 404 || result.status === 503) {
        stop("ENDED");
      } else if (result.status === 422 || result.status === 400) {
        input.onState({ kind: "REJECTED", code: String(result.data?.code ?? "INVALID_POSITION") });
      }
    } catch {
      // Network loss: the next fix retries; nothing is queued, so no stale trail is replayed.
    } finally {
      inFlight = false;
    }
  };

  const watch = () => {
    if (!geo) {
      input.onState({ kind: "UNAVAILABLE" });
      return;
    }
    clear();
    input.onState({ kind: "WAITING_FOR_FIX" });
    watchId = geo.watchPosition(
      (position) => void send(position),
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          stop("PERMISSION_DENIED");
        }
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
    );
  };

  const onVisibility = () => {
    if (!running) return;
    if (document.visibilityState === "hidden") {
      clear();
      input.onState({ kind: "PAUSED_HIDDEN" });
    } else watch();
  };

  function stop(final: "ENDED" | "PERMISSION_DENIED" | "IDLE" = "IDLE") {
    running = false;
    clear();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    input.onState({ kind: final });
  }

  return {
    start() {
      if (running) return;
      running = true;
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
      if (typeof document !== "undefined" && document.visibilityState === "hidden") input.onState({ kind: "PAUSED_HIDDEN" });
      else watch();
    },
    stop: () => stop("IDLE"),
    get sequence() {
      return sequence;
    },
  };
}

/**
 * One sharer per order for the whole page: the same assignment can appear in several messages of
 * the conversation, and every copy of the control must drive the same session (never two
 * watchers sending competing sequences).
 */
type Shared = { sharer: ReturnType<typeof createDriverLocationSharer>; state: SharingState; listeners: Set<(state: SharingState) => void> };
const shared = new Map<string, Shared>();

export function sharedDriverLocationSharer(orderId: string, initialSequence: number) {
  let entry = shared.get(orderId);
  if (!entry) {
    const listeners = new Set<(state: SharingState) => void>();
    const created: Shared = { state: { kind: "IDLE" }, listeners, sharer: undefined as never };
    created.sharer = createDriverLocationSharer({
      orderId,
      initialSequence,
      onState: (state) => {
        created.state = state;
        listeners.forEach((listener) => listener(state));
        if (state.kind === "ENDED" || state.kind === "PERMISSION_DENIED" || state.kind === "IDLE") shared.delete(orderId);
      },
    });
    shared.set(orderId, created);
    entry = created;
  }
  const current = entry;
  return {
    start: () => current.sharer.start(),
    stop: () => current.sharer.stop(),
    subscribe(listener: (state: SharingState) => void) {
      current.listeners.add(listener);
      listener(current.state);
      return () => {
        current.listeners.delete(listener);
        // No visible control means no visible indicator: the device stops reading location.
        // The server session then goes STALE for the buyer and expires if not resumed.
        if (current.listeners.size === 0) current.sharer.stop();
      };
    },
  };
}
