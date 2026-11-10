/**
 * DINAR NEXT G1: questions about the user's own AI allowance («كم باقي من حصتي؟», «متى تتجدد
 * حصتي؟», «لماذا توقف الذكاء عندي؟»). Kept dependency-free so every adapter that could read
 * «كم باقي» as stock or a search can defer to the usage card.
 */
import { foldArabicLetters, normalizeDigits } from "./arabic-normalization";

const ALLOWANCE_QUESTION =
  /(?:استهلاكي|استهلاك\s+(?:ال)?(?:ذكاء|محادثات|حصه|حصتي)|(?:نسبه|كم)\s+(?:ال)?استهلاك|حصتي|(?:كم\s+)?(?:باقي|بقي|متبقي|ظل|ضل)\s+(?:لي\s+)?(?:من\s+)?(?:ال)?(?:محادثات|حصه|حصتي|رسائل|رصيد\s+(?:ال)?(?:ذكاء|مساعد|محادثات))(?:\s|$)|(?:كم\s+)?(?:رساله|رسائل|محادثه|سؤال)\s+(?:باقي|باقيه|بقيت|متبقيه|ضايل|ضايله)\s+(?:لي\s+)?(?:اليوم|هالشهر|الشهر)|تتجدد\s+(?:ال)?حص|(?:متي|امتي)\s+(?:تتجدد|يتجدد)|(?:ليش|لماذا|ليه|شو\s+سبب|ما\s+سبب)\s+(?:وقف|توقف|يوقف|ما\s+يرد|ما\s+يشتغل)\s+(?:ال)?(?:ذكاء|مساعد)|(?:ال)?ذكاء\s+(?:وقف|توقف|ما\s+يشتغل)\s+(?:عندي|معي)|استخدامي\s+(?:لل)?(?:ذكاء|مساعد)|(?:كم\s+)?(?:باقي|بقي|متبقي|ظل|ضل)\s+(?:لي\s+)?(?:من\s+)?(?:استخدامي|اشتراكي|(?:ال)?استخدام)(?:\s|$))/u;

// Shared with deterministic commerce routing as well as model re-entry guards.
export const AI_USAGE_QUESTION = new RegExp(`${ALLOWANCE_QUESTION.source}|(?:خلص|انتهي|نفد)\\s+(?:ال)?رصيد(?:ي)?\\s+(?:من\\s+)?(?:ال)?(?:رسائل|رسائلي|محادثات)(?:\\s|$)`, "u");

export function normalizeUsageText(message: string): string {
  return foldArabicLetters(normalizeDigits(message))
    .toLowerCase()
    .replace(/ة/g, "ه")
    .replace(/[ًٌٍَُِّْ]/gu, "")
    .replace(/[؟?!،,؛;:.()«»"'\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isAiUsageQuestion(message: string): boolean {
  const text = normalizeUsageText(message);
  return AI_USAGE_QUESTION.test(text);
}
