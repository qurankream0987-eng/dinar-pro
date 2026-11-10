// Independent validation set H4: written after H3 exposed relaxation false positives, before the
// corrected relaxation was built or run. 20 positives (target listing must appear) and 10
// negatives (nothing in the market matches; any listing shown is a false positive).
import { writeFileSync } from "node:fs";

const HIDDEN = ["lab_draft_watch", "lab_paused_camera", "lab_archived_tablet", "lab_soldout_ipad", "lab_soldout_kettle"];
const positives = [
  ["بدي ثلاجة كبيرة للمطبخ الجديد", "lab_fridge_big"], ["ابي مكيف سبليت للغرفة الكبيرة", "lab_ac_split"], ["محتاج غسالة للشقة", "lab_washer"],
  ["ابي كنب زاوية بيج للمجلس", "lab_sofa_corner_b"], ["بدي ماك بوك اير للشغل", "lab_laptop_mac_air"], ["عايز ريدمي نوت جديد للوالدة", "lab_redmi_note"],
  ["ابي بروستد للعشا الليلة", "lab_food_broast"], ["بدي مكتب خشب في اربد للدراسة", "lab_irbid_desk"], ["محتاج تصميم شعار لمحلي الجديد", "lab_svc_design"],
  ["ابي دلال قهوة للضيوف", "lab_dallah"], ["بدي كيبلات شحن تايب سي بالجملة", "lab_bulk_cables"], ["ابي كامري 2019 فحص كامل", "lab_camry_2019"],
  ["عايز سماعات سوني لاسلكية للجيم", "lab_headphones"], ["بدي تلفزيون 55 بوصة للصالة", "lab_tv_lg"], ["ابي سرير مزدوج للضيوف", "lab_bed"],
  ["محتاج صيانة مكيف بالبيت", "lab_svc_ac_fix"], ["ابي طاولة صغيرة للدراسة بالبيت", "lab_table_small"], ["بدي ماوس لوجيتك للالعاب", "lab_mixed_lang"],
  ["ابي ثلاجة مستعملة بالزرقاء", "lab_zarqa_fridge"], ["عايز دراجة هوائية رياضية بالعقبة", "lab_aqaba_bike"],
];
const negatives = [
  "بدي بيانو للبيت", "ابي قارب صيد للبحر", "محتاج خيمة للتخييم بعمان", "بدي جاكوزي للحمام", "ابي طابعة ثلاثية الابعاد للمكتب",
  "عايز حصان عربي اصيل", "بدي ساعة رولكس اصلية", "ابي تذاكر طيران للعقبة", "محتاج مولد كهربا للبيت", "بدي سجاد فارسي للصالون",
];
const cases = [
  ...positives.map(([say, id], i) => ({ id: `H4-POS-${String(i + 1).padStart(3, "0")}`, group: "H4-POS", type: "search-positive", actor: "lab_buyer", heldOut: true, intent: "request with purpose/place details; the target must appear", turns: [{ say, expect: { surfaceIn: ["LISTING_RESULTS"], delta: { cart: 0 }, itemsExclude: HIDDEN, itemsInclude: [id] } }] })),
  ...negatives.map((say, i) => ({ id: `H4-NEG-${String(i + 1).padStart(3, "0")}`, group: "H4-NEG", type: "search-negative", actor: "lab_buyer", heldOut: true, intent: "nothing in the market matches; no listing may be shown", turns: [{ say, expect: { delta: { cart: 0 }, itemsMax: 0, bodyNot: ["وجدت \\d+ عروض"] } }] })),
];
writeFileSync(process.argv[2], JSON.stringify({ catalog: "held-out-4", frozenAt: "2026-11-10", total: cases.length, cases }, null, 1));
console.log(JSON.stringify({ total: cases.length }));
