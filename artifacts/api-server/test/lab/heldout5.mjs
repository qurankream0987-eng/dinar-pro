// Independent validation set H5: written after H4 and the precision regression informed the
// conservative relaxation bound, before that bound was built or run live.
import { writeFileSync } from "node:fs";

const HIDDEN = ["lab_draft_watch", "lab_paused_camera", "lab_archived_tablet", "lab_soldout_ipad", "lab_soldout_kettle"];
const positives = [
  ["بدي ثلاجة صغيرة مستعملة رخيصة للمكتب", "lab_fridge_small"], ["ابي مكيف شباك مستعمل للمطبخ", "lab_ac_window"], ["محتاج غسالة اوتوماتيك مستعملة للعمارة", "lab_washer"],
  ["عايز كنبة زاوية رمادية مستعملة للبيت", "lab_sofa_corner"], ["ابي تلفزيون ال جي سمارت جديد للغرفة", "lab_tv_lg"], ["بدي سماعات سوني مستعملة نظيفة للدراسة", "lab_headphones"],
  ["ابي لابتوب ديل للبرمجة والشغل", "lab_laptop_dell"], ["محتاج ماكينة خياطة صناعية مستعملة للورشة", "lab_machine_sewing"], ["بدي منسف بلدي لشخصين بكرة", "lab_food_mansaf"],
  ["ابي كنافة نابلسية طازجة للضيوف", "lab_food_kunafa"], ["عايز صيانة كمبيوتر وتنظيف للجهاز", "lab_svc_pc_fix"], ["بدي نقل عفش من بيت لبيت", "lab_svc_moving"],
  ["ابي ترجمة عربي انجليزي لشهادات", "lab_svc_translation"], ["محتاج تصميم شعار احترافي لشركتي", "lab_svc_design"], ["بدي سرير مزدوج مع فرشة نظيف", "lab_bed"],
  ["ابي طاولة سفرة مع كراسي مستعملة", "lab_table_dining"], ["عايز ايفون 15 مستعمل بطارية ممتازة", "lab_iphone15_used"], ["بدي سامسونج A14 للطالب رخيص", "lab_galaxy_a14"],
  ["ابي دراجة اطفال مستعملة لابني الصغير", "lab_kids_bike"], ["محتاج كوابل شحن تايب سي كثير", "lab_bulk_cables"],
];
const negatives = [
  "غسيل سيارتي", "بدلة عرس", "شاحن ساعة", "دهان جدران", "كاميرا مراقبة",
  "بدي عربية اطفال للمولود", "ابي ثريا كريستال للصالون", "محتاج سباك يصلح الحمام", "بدي كلب حراسة للمزرعة", "ابي ماكينة قهوة اسبريسو للبيت",
];
const cases = [
  ...positives.map(([say, id], i) => ({ id: `H5-POS-${String(i + 1).padStart(3, "0")}`, group: "H5-POS", type: "search-positive", actor: "lab_buyer", heldOut: true, intent: "≥3-word request with extra details; the target must appear", turns: [{ say, expect: { surfaceIn: ["LISTING_RESULTS"], delta: { cart: 0 }, itemsExclude: HIDDEN, itemsInclude: [id] } }] })),
  ...negatives.map((say, i) => ({ id: `H5-NEG-${String(i + 1).padStart(3, "0")}`, group: "H5-NEG", type: "search-negative", actor: "lab_buyer", heldOut: true, intent: "nothing in the market matches; no listing may be shown", turns: [{ say, expect: { delta: { cart: 0 }, itemsMax: 0, bodyNot: ["وجدت \\d+ عروض"] } }] })),
];
writeFileSync(process.argv[2], JSON.stringify({ catalog: "held-out-5", frozenAt: "2026-11-10", total: cases.length, cases }, null, 1));
console.log(JSON.stringify({ total: cases.length }));
