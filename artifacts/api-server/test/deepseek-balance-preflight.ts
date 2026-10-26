export type DeepSeekBalanceInfo = {
  currency: "USD" | "CNY";
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
};

export type DeepSeekBalanceResult =
  | { ok: true; isAvailable: boolean; balances: DeepSeekBalanceInfo[] }
  | { ok: false; classification: "AUTHENTICATION_FAILED" | "ACCESS_DENIED" | "RATE_LIMITED" | "PROVIDER_UNAVAILABLE" | "HTTP_ERROR" | "INVALID_JSON" | "UNEXPECTED_SCHEMA" | "TIMEOUT" | "NETWORK_OR_REDIRECT_ERROR" };

export async function fetchDeepSeekBalance(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<DeepSeekBalanceResult> {
  try {
    const response = await fetcher("https://api.deepseek.com/user/balance", {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(12_000),
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      const classification = response.status === 401 ? "AUTHENTICATION_FAILED"
        : response.status === 403 ? "ACCESS_DENIED"
        : response.status === 429 ? "RATE_LIMITED"
        : response.status >= 500 ? "PROVIDER_UNAVAILABLE"
        : "HTTP_ERROR";
      return { ok: false, classification };
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { return { ok: false, classification: "INVALID_JSON" }; }
    if (!payload || typeof payload !== "object" ||
        typeof (payload as { is_available?: unknown }).is_available !== "boolean" ||
        !Array.isArray((payload as { balance_infos?: unknown }).balance_infos))
      return { ok: false, classification: "UNEXPECTED_SCHEMA" };
    const balances = (payload as { balance_infos: unknown[] }).balance_infos.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (!["USD", "CNY"].includes(String(row.currency)) ||
          ![row.total_balance, row.granted_balance, row.topped_up_balance].every((value) =>
            typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value)))
        return [];
      return [{
        currency: row.currency as "USD" | "CNY",
        total_balance: row.total_balance as string,
        granted_balance: row.granted_balance as string,
        topped_up_balance: row.topped_up_balance as string,
      }];
    });
    return { ok: true, isAvailable: (payload as { is_available: boolean }).is_available, balances };
  } catch (error) {
    return { ok: false, classification: error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
      ? "TIMEOUT"
      : "NETWORK_OR_REDIRECT_ERROR" };
  }
}
