// Experience-upgrade visual QA server: built DINAR frontend + real API on a disposable loopback
// database, with a scripted (mock) model gateway so screenshots are deterministic. Not a live AI.
import express from "express";
import path from "node:path";
import app from "../src/app";
import type { ConversationModelGateway } from "../src/ai/model-gateway";
import { requireSafeReplitDevelopmentDatabase } from "./safe-development-database";
requireSafeReplitDevelopmentDatabase("BDINAR_G3_ACCEPTANCE");
const CODE_ANSWER = [
  "**React Hooks** دوال تتيح لك استخدام الحالة والتأثيرات داخل المكوّنات الوظيفية.",
  "",
  "### أهم الـ Hooks",
  "1. `useState` لحفظ الحالة.",
  "2. `useEffect` للتأثيرات الجانبية مثل جلب البيانات.",
  "3. `useMemo` لتجنب إعادة الحساب.",
  "",
  "```tsx",
  "function Counter() {",
  "  const [count, setCount] = useState(0);",
  "  useEffect(() => { document.title = `Count: ${count}`; }, [count]);",
  "  return <button onClick={() => setCount(count + 1)}>{count}</button>;",
  "}",
  "```",
  "",
  "| Hook | الاستخدام | متى يُعاد التنفيذ |",
  "|---|---|---|",
  "| useState | حالة محلية | عند استدعاء setter |",
  "| useEffect | تأثيرات جانبية بعد الرسم | عند تغيّر الاعتماديات |",
  "| useMemo | قيمة محسوبة مخزنة | عند تغيّر الاعتماديات |",
].join("\n");
const gateway: ConversationModelGateway = {
  async proposeToolCall(messages) {
    const last = String((messages as any[]).filter((m) => m.role === "user").at(-1)?.content ?? "");
    const reply = /react|hook|برمج|code|كود/iu.test(last) ? CODE_ANSWER : "سؤال جيد. باختصار: يعتمد ذلك على استهلاكك الشهري ومساحة السطح وساعات الشمس في منطقتك.\n\n- احسب استهلاكك الشهري بالكيلوواط ساعة.\n- اقسمه على (ساعات الشمس × 30 × قدرة اللوح).";
    return { id: "c", name: "dinarConversationTurn", arguments: JSON.stringify({ responseKind: "CONVERSATIONAL_RESPONSE", confidence: 0.9, conversationalReply: reply }), usage: { inputTokens: 100, outputTokens: 80 } };
  },
};
app.locals.conversationModelGateway = gateway;
const root = path.resolve("../dinar/dist/public");
app.use(express.static(root));
app.get("/{*path}", (_req, res) => res.sendFile(path.join(root, "index.html")));
const port = Number(process.env.QA_PORT ?? 4173);
app.listen(port, "127.0.0.1", () => console.log(`XP QA server: http://127.0.0.1:${port}`));
