import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool, users, conversations, messages, markets } from "@workspace/db";
import { PersonalContextService, extractAmbiguousTopics, type Interaction } from "../src/ai/personal-context-service";
import { safeMemoryText, validateCandidate, decayedConfidence } from "../src/ai/personal-memory-policy";
import { executePersonalMemoryTurn, memoryAcknowledgement } from "../src/ai/personal-memory-turn";
import { executeAiConversationTurn } from "../src/ai/conversation-runtime";
import { GetAiConversationResponse } from "@workspace/api-zod";
import { normalizeMemory, MemorySummary } from "../../dinar/src/features/ai/MemorySummary";

test("personal intelligence: migration, persisted policy and existing runtime", async () => {
  const url = process.env.DINAR_PERSONAL_TEST_DATABASE_URL;
  assert.ok(url, "Use a disposable loopback database via DINAR_PERSONAL_TEST_DATABASE_URL");
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.port, "55479");
  const LocalPool = pool.constructor as new (config: { connectionString: string }) => typeof pool;
  const localPool = new LocalPool({ connectionString: url });
  const database = drizzle(localPool) as typeof db;
  let now = new Date("2026-10-08T12:00:00Z");
  const service = new PersonalContextService(database, () => now);
  const counters = { cross_user_memory_leak: 0, sensitive_inference_created: 0, duplicate_signal_inflation: 0, irrelevant_context_injected: 0, guest_persistent_memory_created: 0, auth_secret_memory: 0, precise_gps_memory: 0, financial_secret_memory: 0, one_shot_overfitting: 0 };
  try {
    await migrate(database, { migrationsFolder: "../../lib/db/drizzle" });
    // Restart-safe migration runner: applying the same journal twice is a no-op.
    await migrate(database, { migrationsFolder: "../../lib/db/drizzle" });
    const market = (await database.select().from(markets))[0];
    assert.ok(market);
    const ids = Array.from({ length: 8 }, () => randomUUID());
    for (const [i, id] of ids.entries()) await database.insert(users).values({ id, displayName: "Personal memory fixture", phoneCountryCode: "+962", phoneNumber: `7900000${i}`, normalizedPhone: `personal-${id}`, accountCountry: "JO", activeMarketId: market.id, passwordHash: "fixture-unused" });
    const interaction = (userId: string, text: string, eventId = randomUUID(), source: Interaction["source"] = "CONVERSATION"): Interaction => ({ userId, text, eventId, source, at: now });
    const record = async (id: string, text: string, eventId?: string, source?: Interaction["source"]) => service.processInteraction(interaction(id,text,eventId,source));
    const memories = (id: string) => service.listUserMemories(id);
    const active = async (id: string, topic: string, kind: string) => (await memories(id)).find(m => m.topic === topic && m.kind === kind && m.status === "ACTIVE");

    for (const text of ["أخبار ريال مدريد", "متى مباراة ريال مدريد", "أريد قميص ريال مدريد"]) await record(ids[0],text);
    const football = await active(ids[0],"real-madrid","INFERRED_INTERESTS");
    assert.equal(football?.signalCount,3); assert.ok(football!.confidence > 0.4); assert.equal(football?.parent,"football");
    for (const text of ["اشرح لي الديناميكا الحرارية", "عندي اختبار كيمياء", "ساعدني في مادة الهندسة", "اشرح لي كيمياء", "اشرح الهندسة"]) await record(ids[1],text);
    assert.ok(await active(ids[1],"science","INFERRED_INTERESTS"));
    assert.equal((await active(ids[1],"chemistry","INFERRED_INTERESTS"))?.signalCount,2);
    assert.equal((await active(ids[1],"engineering","INFERRED_INTERESTS"))?.signalCount,2);
    await record(ids[2],"أنا أحب البرادو والتخييم");
    assert.equal((await active(ids[2],"prado","EXPLICIT_PREFERENCES"))?.confidence,0.98);
    assert.ok(await active(ids[2],"camping","EXPLICIT_PREFERENCES"));
    await record(ids[3],"كم سعر كرة قدم؟");
    const single = await active(ids[3],"football","INFERRED_INTERESTS");
    counters.one_shot_overfitting = (await service.getInterestProfile(ids[3])).topInterests.length;
    assert.equal(counters.one_shot_overfitting,0);
    assert.equal(single?.signalCount,1); assert.ok(single!.confidence < 0.3);
    assert.equal((await service.getRelevantContext(ids[3],"كرة القدم")).length,0);
    const duplicate = interaction(ids[3],"أخبار كرة القدم");
    await Promise.all(Array.from({length:12},() => service.processInteraction(duplicate)));
    counters.duplicate_signal_inflation = (await active(ids[3],"football","INFERRED_INTERESTS"))!.signalCount - 2;
    assert.equal(counters.duplicate_signal_inflation,0);
    assert.equal((await active(ids[3],"football","INFERRED_INTERESTS"))?.signalCount,2);
    await record(ids[0],"لا أحب كرة القدم");
    assert.ok(await active(ids[0],"football","NEGATIVE_PREFERENCES"));
    assert.equal((await active(ids[0],"real-madrid","INFERRED_INTERESTS")),undefined);
    await record(ids[0],"أخبار ريال مدريد");
    assert.equal((await active(ids[0],"real-madrid","INFERRED_INTERESTS")),undefined);
    await record(ids[2],"تذكر أني أحب السيارات اليابانية");
    assert.ok(await active(ids[2],"japanese-cars","EXPLICIT_PREFERENCES"));
    const explicitToyota = interaction(ids[2],"أنا أحب تويوتا");
    await service.processInteraction(explicitToyota);
    const relevant = await service.getRelevantContext(ids[2],"أبي سيارة");
    counters.irrelevant_context_injected = relevant.filter(m => ["camping","football","chemistry"].includes(m.topic)).length;
    assert.equal(counters.irrelevant_context_injected,0);
    counters.cross_user_memory_leak = (await service.getRelevantContext(ids[4],"أبي سيارة")).length;
    assert.equal(counters.cross_user_memory_leak,0);
    assert.ok(relevant.some(m => m.topic === "prado"));
    assert.ok(relevant.some(m => m.topic === "toyota"));
    assert.ok(!relevant.some(m => m.topic === "camping"));
    const explicitFormalRequest = await service.getRelevantContext(ids[2], "أبي قميص رسمي");
    assert.equal(explicitFormalRequest.some(m => m.topic === "camping"), false);
    assert.equal((await service.getRelevantContext(ids[2],"أبي BMW")).length,0);
    assert.equal((await service.getRelevantContext(ids[1],"أبي سيارة")).length,0);
    assert.equal((await service.getRelevantContext(ids[4],"أبي سيارة")).length,0);
    await record(ids[4],"أنا أحب التخييم");
    const correction = interaction(ids[4],"كنت أبحث عن التخييم لصديقي، ليس لي");
    await record(ids[4],"التخييم");
    await executePersonalMemoryTurn(correction,service);
    assert.ok(await active(ids[4],"camping","EXPLICIT_PREFERENCES"), "friend correction preserves previously explicit preference");
    await record(ids[5],"التخييم"); await record(ids[5],"التخييم");
    await executePersonalMemoryTurn(interaction(ids[5],"كنت أبحث عن التخييم لصديقي، ليس لي"),service);
    assert.equal(await active(ids[5],"camping","INFERRED_INTERESTS"),undefined);
    for (const own of ["احذف الإعلان","احذف العرض الثاني","احذف المسودة","احذف طلبي"])
      assert.equal(await executePersonalMemoryTurn(interaction(ids[2],own),service),null,`«${own}» is a command on the user's own item, not memory`);
    const forget = interaction(ids[2],"انسَ اهتمام السيارات");
    const forgotten = await executePersonalMemoryTurn(forget,service);
    assert.equal(forgotten?.result.surface,"MEMORY_UPDATED");
    await executePersonalMemoryTurn(forget,service);
    await service.processInteraction(explicitToyota);
    assert.equal(await active(ids[2],"toyota","EXPLICIT_PREFERENCES"),undefined,"replay stays forgotten");
    assert.equal((await service.getRelevantContext(ids[2],"أبي سيارة")).length,0);
    await record(ids[2],"تويوتا");
    assert.equal(await active(ids[2],"toyota","INFERRED_INTERESTS"),undefined);
    await record(ids[2],"أنا أحب تويوتا");
    assert.ok(await active(ids[2],"toyota","EXPLICIT_PREFERENCES"));
    await executePersonalMemoryTurn(interaction(ids[2],"عدّل تفضيلي تويوتا إلى BMW"),service);
    assert.ok(await active(ids[2],"bmw","EXPLICIT_PREFERENCES"));
    assert.equal(await active(ids[2],"toyota","EXPLICIT_PREFERENCES"),undefined);
    await record(ids[7], "اللهجة الكويتية قد تناسب بعض المستخدمين");
    assert.equal(await active(ids[7], "arabic-dialect", "CONVERSATION_STYLE"), undefined);
    await record(ids[7], "لا أفضل اللهجة السعودية");
    assert.equal(await active(ids[7], "arabic-dialect", "CONVERSATION_STYLE"), undefined);
    await record(ids[7], "I prefer Saudi Arabic");
    assert.equal(
      (await active(ids[7], "arabic-dialect", "CONVERSATION_STYLE"))?.value,
      "saudi arabic",
    );
    await record(ids[6],"أخبار اللياقة والصحة"); await record(ids[6],"تمارين الجري والتغذية"); await record(ids[6],"اللياقة والصحة");
    assert.ok(await active(ids[6],"fitness","INFERRED_INTERESTS"));
    assert.ok(await active(ids[6],"general-health-content","INFERRED_INTERESTS"));
    const before = (await memories(ids[6])).length;
    for (const text of ["أنا أحب السكري", "أنا مريض سرطان", "I have bipolar disorder", "أنا مسلم", "I am gay", "I am bankrupt", "تذكر كلمة المرور abc", "تذكر OTP 123456", "أنا أحب بطاقة 4111111111111111", "تذكر موقعي 29.123456, 48.654321", "تذكر API key sk-exampleSecret", "أنا أحب IBAN JO123456789", "أنا أحب جواز السفر"]) {
      assert.equal(safeMemoryText(text),false,text);
      await record(ids[6],text);
    }
    assert.equal((await memories(ids[6])).length,before);
    const persisted = (await memories(ids[6])).map(m => `${m.topic} ${m.label} ${m.value ?? ""}`);
    counters.sensitive_inference_created = persisted.filter(t => !safeMemoryText(t)).length;
    counters.auth_secret_memory = persisted.filter(t => /password|OTP|sk-exampleSecret|كلمة المرور/i.test(t)).length;
    counters.financial_secret_memory = persisted.filter(t => /4111111111111111|IBAN|بطاقة/i.test(t)).length;
    counters.precise_gps_memory = persisted.filter(t => /29\.123456|48\.654321/.test(t)).length;
    assert.ok(Object.values(counters).every(n => n === 0));
    const hallucinated = { kind:"INFERRED_INTERESTS",topic:"camping",evidence:"chemistry" };
    assert.equal(validateCandidate(hallucinated,"chemistry","CONVERSATION",true),null);
    const forged = { kind:"EXPLICIT_PREFERENCES",topic:"chemistry",evidence:"chemistry" };
    assert.equal(validateCandidate(forged,"chemistry","CONVERSATION",true),null);
    let calls = 0;
    const gateway = { async proposeToolCall() { calls++; return { id:"candidate",name:"personalMemoryCandidates",arguments:JSON.stringify({candidates:[{kind:"INFERRED_INTERESTS",topic:"astronomy",evidence:"astronomy"}]}) }; } };
    await service.processInteraction(interaction(ids[7],"Explain astronomy"),gateway);
    assert.ok(await active(ids[7],"astronomy","INFERRED_INTERESTS")); assert.equal(calls,1);
    await service.processInteraction(interaction(ids[7],"astronomy for my friend"),gateway); assert.equal(calls,1);
    await extractAmbiguousTopics("OTP 123456",gateway); assert.equal(calls,1);
    await record(ids[7],"أنا أحب صناعة الفخار");
    assert.ok(await active(ids[7],"صناعة-الفخار","EXPLICIT_PREFERENCES"));
    await record(ids[7],"أنا طالب جامعي"); assert.ok(await active(ids[7],"university-study","LONG_TERM_FACTS"));
    await record(ids[7],"أفضل اجابات قصيرة"); assert.ok(await active(ids[7],"short-answers","CONVERSATION_STYLE"));
    assert.equal(memoryAcknowledgement("تذكر أني أفضل اجابات قصيرة")?.result.surface,"MEMORY_CONFIRMATION");
    const nowFootball = await active(ids[3],"football","INFERRED_INTERESTS");
    now = new Date("2028-10-08T12:00:00Z");
    assert.ok(decayedConfidence(nowFootball!,now) < 0.01);
    assert.ok(!(await service.getRelevantContext(ids[3],"كرة القدم")).length);
    const explicitCamping = await active(ids[4],"camping","EXPLICIT_PREFERENCES");
    assert.ok(decayedConfidence(explicitCamping!,now) > 0.45);
    now = new Date("2026-10-08T12:00:00Z");
    const continuity = await executePersonalMemoryTurn(interaction(ids[4],"نكمل موضوع التخييم"),service);
    assert.ok(continuity?.result.prompt?.includes("التخييم"));
    assert.ok(!continuity?.result.prompt?.includes("ريال مدريد"));
    const restoredService = new PersonalContextService(database,() => now);
    assert.ok((await restoredService.getRelevantContext(ids[4],"نكمل موضوع التخييم")).length);
    assert.equal((await service.getRelevantContext(ids[4],"التخييم","another-conversation")).some(m => m.kind === "SESSION_CONTEXT"),false);
    const purchase = interaction(ids[5],"التخييم",undefined,"PURCHASE");
    await service.processInteraction(purchase); await record(ids[5],"التخييم",undefined,"PURCHASE");
    await service.setPurchaseHistory(ids[5],false,randomUUID());
    await service.processInteraction(interaction(ids[5],"التخييم",undefined,"PURCHASE"));
    assert.equal(await active(ids[5],"camping","INFERRED_INTERESTS"),undefined);
    const conversationId = randomUUID();
    await database.insert(conversations).values({id:conversationId,kind:"AI",ownerUserId:ids[4],marketId:market.id});
    const messageId = randomUUID();
    await database.insert(messages).values({id:messageId,conversationId,actor:"USER",senderId:ids[4],body:"دينار ماذا تعرف عن اهتماماتي؟"});
    assert.equal(await service.ownsInteraction(ids[3],conversationId,messageId),false);
    const turn = await executeAiConversationTurn({conversationId,currentMessageId:messageId,message:"دينار ماذا تعرف عن اهتماماتي؟",actorId:ids[4],market:market as never},{personalContextService:service});
    assert.equal(turn.result.surface,"MY_INTERESTS");
    const memory = normalizeMemory(turn.result.memory);
    assert.ok(memory); const component = MemorySummary({memory});
    assert.equal(component?.props.dir,"rtl");
    assert.ok(JSON.stringify(memory).includes("التخييم"));
    assert.ok(!JSON.stringify(memory).includes("ريال مدريد"));
    let guestMemoryCalls = 0;
    const guestMemoryService = new Proxy(service, {
      get(target, property) {
        if (property === "ownsInteraction" || property === "processInteraction")
          return async (...args: any[]) => {
            guestMemoryCalls += 1;
            return (target as any)[property](...args);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await executeAiConversationTurn({
      conversationId,
      currentMessageId: randomUUID(),
      message: "أبي قميص رسمي",
      market: market as never,
    }, { personalContextService: guestMemoryService });
    counters.guest_persistent_memory_created = guestMemoryCalls;
    assert.equal(counters.guest_persistent_memory_created, 0);
    const block = {type:"SURFACE",version:1,payload:{resultSetId:randomUUID(),listings:[],surface:turn.result.surface,memory}};
    const envelope = { conversation: {id:conversationId,kind:"AI",title:"memory",marketId:market.id,createdAt:now.toISOString(),updatedAt:now.toISOString()}, messages:[{id:randomUUID(),actor:"ASSISTANT",body:turn.result.prompt,createdAt:now.toISOString(),blocks:[block]}] };
    assert.ok(GetAiConversationResponse.safeParse(envelope).success,"generated API accepts memory");
    console.log("PERSONAL_INTELLIGENCE_COUNTERS",JSON.stringify(counters));
    console.log("PASS: football, science, chemistry, engineering, cars, camping, fitness, general health, persistence, concurrent deduplication, explicit override, decay, relevance, current intent, forget/update, controls, isolation, RTL, existing runtime");
  } finally { await localPool.end(); await pool.end(); }
});
