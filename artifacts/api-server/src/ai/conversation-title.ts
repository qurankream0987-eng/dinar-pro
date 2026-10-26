/** Cheap, deterministic titles; no model call and no operational meaning. */
export function conversationTitle(message: string): string {
  const text = message.replace(/\s+/g, " ").trim();
  const selling = text.match(
    /^(?:أريد|اريد|ابي|أبي|عايز)\s+(?:أن\s+)?(?:أبيع|ابيع|بيع)\s+(.+)$/,
  );
  // A starter such as «أريد أن أبيع شيئًا» names no item: the title says what the chat is for.
  const vague = (value: string) => /^(?:شيء|شيئا|شيئ|شي|حاجة|حاجه|منتج|غرض|أي شيء|اي شيء)$/u.test(value.replace(/[\u064B-\u0652.؟?!]/gu, "").trim());
  if (selling) return vague(selling[1]!) ? "عرض منتج للبيع" : `بيع ${selling[1]}`.slice(0, 72);
  const buying = text.match(
    /^(?:أريد|اريد|ابي|أبي|أبحث عن|ابحث عن)\s+(?:(?:أن\s+)?(?:أشتري|اشتري|شراء)\s+)?(.+)$/,
  );
  if (buying) return vague(buying[1]!) ? "طلب شراء" : `البحث عن ${buying[1]}`.slice(0, 72);
  return text.slice(0, 72) || "محادثة جديدة";
}
