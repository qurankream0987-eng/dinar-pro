// Independent re-test set H2 (written after the held-out dialect failures were recorded, before the
// fix was evaluated). New vocabulary that appears in neither catalog nor in the canonical-request
// instruction's examples. Each case: one unseen dialect/loanword request; the matching fixture
// listing must appear and nothing may change.
import { writeFileSync } from "node:fs";

const HIDDEN = ["lab_draft_watch", "lab_paused_camera", "lab_archived_tablet", "lab_soldout_ipad", "lab_soldout_kettle"];
const rows = [
  ["ابي بايسكل للصغير", "lab_kids_bike"], ["بدي براد صغير للغرفة", "lab_fridge_small"], ["اريد تكييف شباك", "lab_ac_window"],
  ["ابي كنباية زاوية", "lab_sofa_corner"], ["دور على تيفي ال جي كبير", "lab_tv_lg"], ["بدي جهاز العاب بلاي ستيشن", "lab_ps5"],
  ["عندكم سماعة راس سوني؟", "lab_headphones"], ["بدي غسالة ملابس اوتوماتيك", "lab_washer"], ["ابغى دلة قهوة نحاس", "lab_dallah"],
  ["بدي لابتوب ماك", "lab_laptop_mac_air"], ["ابي سيارة كامري", "lab_camry_2019"], ["حدا بيصلح كمبيوترات؟", "lab_svc_pc_fix"],
  ["اريد عامل تنظيف للبيت", "lab_svc_cleaning"], ["مين بيعمل تصميم شعارات", "lab_svc_design"], ["ابي معلم برمجة بايثون اونلاين", "lab_svc_tutor"],
  ["بدي حدا ينقل عفشي", "lab_svc_moving"], ["ابي حلو كنافة", "lab_food_kunafa"], ["عايز شاشة ال جي ٥٥ بوصة", "lab_tv_lg"],
  ["ابي فون ١٣ نظيف", "lab_iphone13_a"], ["بدي جوال شاومي", "lab_redmi_note"], ["ابي ماوس العاب لوجيتك", "lab_mixed_lang"],
  ["بدي شاحن تايب سي", "lab_bulk_cables"], ["ابغا مكيف سبلت جديد", "lab_ac_split"], ["بدي تخت دبل مع فرشة", "lab_bed"],
  ["ابي طاولة اكل مع كراسي", "lab_table_dining"], ["بدي كرسي للمكتب", "lab_nophoto_chair"], ["اريد سماعات ابل لاسلكية", "lab_airpods"],
  ["ابي عطر رجالي للهدية", "lab_gift_perfume"], ["بدي ماكينة درزة صناعية", "lab_machine_sewing"], ["اريد كيا كهربا", "lab_kia_ev"],
];
const cases = rows.map(([say, id], i) => ({
  id: `H2-DIA-${String(i + 1).padStart(3, "0")}`, group: "H2-DIA", type: "dialect-search", actor: "lab_buyer", heldOut: true,
  intent: "unseen dialect/loanword search after the canonical-request fix",
  turns: [{ say, expect: { surfaceIn: ["LISTING_RESULTS"], delta: { cart: 0 }, itemsExclude: HIDDEN, itemsInclude: [id] } }],
}));
writeFileSync(process.argv[2], JSON.stringify({ catalog: "held-out-2", frozenAt: "2026-11-10", total: cases.length, cases }, null, 1));
console.log(JSON.stringify({ total: cases.length }));
