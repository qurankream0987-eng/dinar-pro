import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const OCR_TIMEOUT_MS = 8_000;
const OCR_OUTPUT_LIMIT = 24_000;
const SCREEN_CACHE_TTL_MS = 10 * 60_000;
const SCREEN_CACHE_MAX_ENTRIES = 512;
const OCR_SCREEN_VERSION = "tesseract-ara-eng-document-screen-v2";

export type LocalDocumentScreenDecision =
  | "NO_TEXT_DETECTED"
  | "OCR_SUCCESS_WITH_TEXT"
  | "OCR_TECHNICAL_FAILURE"
  | "POLICY_SIGNAL_DETECTED";

type CacheableDocumentScreenDecision = Exclude<
  LocalDocumentScreenDecision,
  "OCR_TECHNICAL_FAILURE"
>;

const documentTerms = [
  "passport",
  "national id",
  "national identity",
  "identity card",
  "civil id",
  "date of birth",
  "date of issue",
  "date of expiry",
  "expiry date",
  "place of birth",
  "nationality",
  "resident permit",
  "residence permit",
  "driving license",
  "driving licence",
  "iqama",
  "رقم الهوية",
  "الهوية الوطنية",
  "بطاقة الهوية",
  "بطاقه الهويه",
  "جواز السفر",
  "جواز",
  "رقم الإقامة",
  "رقم الاقامة",
  "الإقامة",
  "اقامة",
  "رخصة القيادة",
  "رخصه القياده",
  "تاريخ الميلاد",
  "الجنسية",
  "رقم البطاقة",
  "الاحوال المدنية",
  "الأحوال المدنية",
  "وزارة الداخلية",
  "بطاقة مقيم",
];

const arabicDigitMap: Record<string, string> = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
};

function normalizeOcrText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[٠-٩]/gu, (digit) => arabicDigitMap[digit] ?? digit)
    .replace(/[\u064B-\u065F\u0670]/gu, "")
    .replace(/ـ/gu, "")
    .replace(/[إأآ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * OCR text is examined only in-process. It is never returned, cached, logged,
 * persisted, or included in the external image-review request.
 */
export function classifyListingImageOcrText(
  extractedText: string,
): CacheableDocumentScreenDecision {
  const text = normalizeOcrText(extractedText);
  if (!text) return "NO_TEXT_DETECTED";

  if (documentTerms.some((term) => text.includes(normalizeOcrText(term))))
    return "POLICY_SIGNAL_DETECTED";

  const digits = (text.match(/\d/gu) ?? []).length;
  const tokens = text.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const hasLongIdentifier = /\d(?:[\s./-]*\d){6,}/u.test(text);
  const hasDate = /\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/u.test(text);

  if (
    hasLongIdentifier ||
    hasDate ||
    text.length >= 120 ||
    tokens.length >= 10 ||
    (tokens.length >= 6 && digits >= 2)
  )
    return "POLICY_SIGNAL_DETECTED";

  return "OCR_SUCCESS_WITH_TEXT";
}

function runLocalTesseract(imageBytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "tesseract",
        ["stdin", "stdout", "-l", "ara+eng", "--psm", "11", "quiet"],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
    } catch {
      reject(new Error("Local OCR unavailable."));
      return;
    }

    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Local OCR timed out."));
    }, OCR_TIMEOUT_MS);

    const finish = (error?: Error, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(text ?? "");
    };

    const stdout = child.stdout;
    const stdin = child.stdin;
    if (!stdout || !stdin) {
      child.kill("SIGKILL");
      finish(new Error("Local OCR streams are unavailable."));
      return;
    }

    stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > OCR_OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        finish(new Error("Local OCR output exceeded its limit."));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });

    child.on("error", () => finish(new Error("Local OCR unavailable.")));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error("Local OCR failed."));
        return;
      }
      finish(undefined, Buffer.concat(chunks).toString("utf8"));
    });
    stdin.on("error", () => finish(new Error("Local OCR input failed.")));
    stdin.end(imageBytes);
  });
}

const screenCache = new Map<
  string,
  { decision: CacheableDocumentScreenDecision; expiresAt: number }
>();

function cachedScreen(key: string) {
  const cached = screenCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    screenCache.delete(key);
    return undefined;
  }
  screenCache.delete(key);
  screenCache.set(key, cached);
  return cached.decision;
}

function cacheScreen(
  key: string,
  decision: CacheableDocumentScreenDecision,
) {
  screenCache.delete(key);
  screenCache.set(key, {
    decision,
    expiresAt: Date.now() + SCREEN_CACHE_TTL_MS,
  });
  while (screenCache.size > SCREEN_CACHE_MAX_ENTRIES) {
    const oldest = screenCache.keys().next().value;
    if (oldest === undefined) break;
    screenCache.delete(oldest);
  }
}

export async function screenListingImageLocally(
  imageBytes: Buffer,
  runOcr: (imageBytes: Buffer) => Promise<string> = runLocalTesseract,
): Promise<LocalDocumentScreenDecision> {
  const digest = createHash("sha256")
    .update(OCR_SCREEN_VERSION)
    .update(imageBytes)
    .digest("hex");
  const cached = cachedScreen(digest);
  if (cached) return cached;

  try {
    const extractedText = await runOcr(imageBytes);
    const decision = classifyListingImageOcrText(extractedText);
    cacheScreen(digest, decision);
    return decision;
  } catch {
    // Do not cache a transient failure; a publication retry must run OCR again.
    return "OCR_TECHNICAL_FAILURE";
  }
}

export function clearLocalListingImageDocumentScreenCacheForTests() {
  screenCache.clear();
}
