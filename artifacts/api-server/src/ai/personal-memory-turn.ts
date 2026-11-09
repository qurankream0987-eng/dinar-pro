import { personalContext, type Interaction } from "./personal-context-service";
import { discoverTopics, extractDeterministic, normalizeTopic, safeMemoryText, topicIdentity } from "./personal-memory-policy";
import type { ToolResult } from "./tool-registry";

export type MemorySurface = "MY_INTERESTS" | "MEMORY_SUMMARY" | "MEMORY_CONFIRMATION" | "MEMORY_UPDATED";
export type MemorySummary = { view: MemorySurface; groups: { label: string; items: { topic: string; label: string; reason: string }[] }[] };
function response(view: MemorySurface, prompt: string, groups: MemorySummary["groups"] = []) {
  const result: ToolResult = { kind: "SURFACE", surface: view, query: {}, listings: [], prompt, memory: { view, groups } };
  return { tool: "personalContext", version: 1, result };
}
/** The user's own marketplace items (normalized: hamza folded, no diacritics), optionally with a pronoun or ordinal. */
const OWN_ITEM = /^(?:ال)?(?:اعلان|اعلانات|عرض|عروض|مسوده|مسودة|طلب|طلبات|وظيفه|وظيفة|سله|سلة|صوره|صورة|صور|منشور)(?:ي|ه|ها|اتي)?(?:\s|$)/;
export async function executePersonalMemoryTurn(input: Interaction, service = personalContext) {
  const n = normalizeTopic(input.text).replace(/^دينار\s+/, "");
  // «نكمل الإعلان / المسودة» resumes the user's own DINAR item, which its authority handles.
  const namesOwnItem = n.split(/\s+/).some((word) => OWN_ITEM.test(word.replace(/^(?:لل|ل|بال|ب)(?=ال|ا)/, "")));
  if (/نكمل|كنا نتكلم|المرة الماضية|continue|last time/i.test(n) && !namesOwnItem) {
    const relevant = await service.getRelevantContext(input.userId, input.text, input.conversationId);
    const topics = relevant.filter(m => m.kind !== "CONVERSATION_STYLE" && m.kind !== "NEGATIVE_PREFERENCES").slice(0,3);
    return response("MEMORY_SUMMARY", topics.length
      ? `السياق المرتبط بطلبك هو ${topics.map(m => m.label).join("، ")}. كيف تحب نكمل؟ يمكنك تحديد ما تريد البحث عنه أو مناقشته.`
      : "لا أملك سياقًا كافيًا لتحديد الموضوع السابق. اذكر الموضوع أو الشيء الذي أعجبك لنكمل.",
      topics.length ? [{ label: "سياق المحادثة", items: topics.map(m => ({ topic: m.topic, label: m.label, reason: m.reason })) }] : []);
  }
  if (/ماذا تعرف|وش تعرف|what do you know|(?:اعرض|show) (?:اهتماماتي|ذاكرتي|my memory)/i.test(n)) {
    const p = await service.getInterestProfile(input.userId);
    const groups: MemorySummary["groups"] = [
      { label: "تفضيلات صرحت بها", items: p.explicitPreferences.map(m => ({ topic: m.topic, label: m.label, reason: "قلت إنك تفضلها" })) },
      { label: "اهتمامات متكررة", items: p.topInterests.map(m => ({ topic: m.topic, label: m.label, reason: "تكررت في تفاعلاتك، ويمكنك تصحيحها" })) },
      { label: "أشياء لا تفضلها", items: p.negativePreferences.map(m => ({ topic: m.topic, label: m.label, reason: "طلبت عدم اقتراحها" })) },
      { label: "طريقة الرد", items: p.communicationPreferences.map(m => ({ topic: m.topic, label: m.value ?? m.label, reason: "تفضيلك في المحادثة" })) },
    ].filter(g => g.items.length);
    return response(/اهتماماتي/.test(n) ? "MY_INTERESTS" : "MEMORY_SUMMARY", groups.length ? "هذه المعلومات المختصرة التي أستخدمها عندما تكون مفيدة. يمكنك طلب تعديل أو حذف أي اهتمام." : "ليس لدي اهتمامات مؤكدة عنك بعد. يمكنك قول: تذكر أني أحب التخييم.", groups);
  }
  if (/لا تستخدم.*(?:مشترياتي|تاريخ الشراء)|don.t use.*purchase/i.test(n)) {
    await service.setPurchaseHistory(input.userId, false, input.eventId);
    return response("MEMORY_UPDATED", "لن أستخدم تاريخ مشترياتك في الاقتراحات، وحذفت إشاراته من الذاكرة الشخصية.");
  }
  if (/^(?:استخدم.*مشترياتي|use my purchase history)/i.test(n)) {
    await service.setPurchaseHistory(input.userId, true, input.eventId);
    return response("MEMORY_UPDATED", "يمكن استخدام إشارات المشتريات الجديدة في الاقتراحات.");
  }
  const forget = n.match(/^(?:انس[يى]?|انسي|احذف|forget|delete)\s+(?:اهتمام(?:ي)?\s+|تفضيل(?:ي)?\s+)?(.+)$/i);
  // «احذف الإعلان / العرض / المسودة / الطلب …» names the user's own DINAR item, not an interest;
  // those commands belong to their own authorities (e.g. listing archive review), never to memory.
  if (forget && !/^(?:اهتمام|تفضيل)/.test(n.replace(/^\S+\s+/, "")) && OWN_ITEM.test(forget[1])) return null;
  // «احذف كلمة … من الوصف / العنوان» edits a listing draft, never the personal memory.
  if (forget && /من\s+(?:ال)?(?:وصف|عنوان|اعلان|مسوده|مسودة)/.test(forget[1])) return null;
  if (forget && safeMemoryText(forget[1])) {
    const topic = discoverTopics(forget[1])[0] ?? topicIdentity(forget[1]);
    await service.forgetMemory(input.userId, topic.key, input.eventId);
    return response("MEMORY_UPDATED", `حذفت اهتمام ${topic.label} وإشاراته، ولن أعيده من التفاعلات القديمة. يمكنك تذكره مجددًا بطلب صريح.`);
  }
  if (/لصديقي|لصديق|ليس لي|مو لي|for .*friend|not for me/i.test(n)) {
    for (const t of discoverTopics(input.text)) await service.forgetMemory(input.userId, t.key, `${input.eventId}:${t.key}`, true);
    return response("MEMORY_UPDATED", "لن أعتبر البحث لهذا الشخص اهتمامًا شخصيًا لك، وأزلت الاستنتاج المرتبط به.");
  }
  const update = n.match(/^(?:عدل تفضيلي|update my preference)\s+(.+?)\s+(?:الي|الى|to)\s+(.+)$/i);
  if (update && safeMemoryText(input.text)) {
    const candidate = { kind: "EXPLICIT_PREFERENCES" as const, topic: update[2], evidence: update[2] };
    await service.updatePreference({ ...input, source: "USER_CORRECTION" }, update[1], candidate);
    return response("MEMORY_UPDATED", `عدلت تفضيلك إلى ${topicIdentity(update[2]).label}.`);
  }
  if (/^(?:عدل تفضيلي|update my preference)/i.test(n)) return response("MEMORY_CONFIRMATION", "اذكر التفضيل القديم والجديد، مثل: عدّل تفضيلي تويوتا إلى BMW.");
  return null;
}
export function memoryAcknowledgement(text: string) {
  const n = normalizeTopic(text);
  if (!safeMemoryText(text)) return null;
  if (!extractDeterministic(text).some(c => c.kind === "EXPLICIT_PREFERENCES" || c.kind === "NEGATIVE_PREFERENCES" || c.kind === "CONVERSATION_STYLE")) return null;
  if (/^(?:دينار )?(?:تذكر|انا احب|انا ما احب|لا احب|لا تقترح|i like|i love|remember)/i.test(n))
    return response("MEMORY_CONFIRMATION", /ما احب|لا احب|لا تقترح|don.t like/i.test(n) ? "تذكرت ما لا تفضله، وسأراعيه عندما يكون مرتبطًا بطلبك. يمكنك تعديله أو حذفه." : "تذكرت تفضيلك، وسأستخدمه عندما يكون مفيدًا لطلبك. يمكنك تعديله أو حذفه.");
  return null;
}
