// Independent re-test set H3: written after H2 informed the subset-relaxation fix and before that
// fix was built or run. Phrasings, extra details and spelling variants not used in any earlier set.
import { writeFileSync } from "node:fs";

const HIDDEN = ["lab_draft_watch", "lab_paused_camera", "lab_archived_tablet", "lab_soldout_ipad", "lab_soldout_kettle"];
const rows = [
  ["محتاج ثلاجة صغيرة للسكن الجامعي", "lab_fridge_small"], ["ابي مكيف شباك يبرد زين", "lab_ac_window"], ["بدي سرير مزدوج مريح", "lab_bed"],
  ["ابغى غسالة اوتوماتيك للبيت", "lab_washer"], ["عايز تلفزيون LG سمارت للصالة", "lab_tv_lg"], ["فيه بلايستيشن 5 مع يدين؟", "lab_ps5"],
  ["ابي سماعات سوني بلوتوث للسفر", "lab_headphones"], ["بدي كنبة زاوية رمادي للصالون", "lab_sofa_corner"], ["اريد طاولة سفرة خشب كبيرة", "lab_table_dining"],
  ["ابغى دراجة اطفال لبنتي", "lab_kids_bike"], ["بدي شاورما دجاج عشا", "lab_food_shawarma"], ["ابي منسف بلدي للعزيمة", "lab_food_mansaf"],
  ["محتاج تصليح غسالة بالبيت اليوم", "lab_svc_washer_fix"], ["بدي صيانة لابتوب بطيء", "lab_svc_pc_fix"], ["ابي تنظيف شقة كامل", "lab_svc_cleaning"],
  ["بدي ترجمة اوراق رسمية", "lab_svc_translation"], ["ابي مقلوبة دجاج للغدا", "lab_food_maqluba"], ["عايز ايربودز برو اصلية", "lab_airpods"],
  ["ابي سلك اتش دي ام اي طويل", "lab_decimal_price"], ["بدي مكتب خشب بإربد", "lab_irbid_desk"], ["ابي لابتوب لينوفو للجامعة", "lab_laptop_lenovo"],
  ["محتاج ماكينة خياطة للمحل", "lab_machine_sewing"], ["بدي كوب مطبوع عليه اسم", "lab_gift_mug"], ["ابي سامسونج A54 لون اسود", "lab_galaxy_a54"],
  ["عايز تويوتا كورولا مستعملة", "lab_corolla_2018"], ["ابغى هيونداي سوناتا هايبرد", "lab_hyundai_hybrid"], ["بدي نقل اثاث داخل عمان", "lab_svc_moving"],
  ["ابي صيانة مكيفات قبل الصيف", "lab_svc_ac_fix"], ["بدي كنافة نابلسية سخنة", "lab_food_kunafa"], ["اريد درس بايثون للمبتدئين", "lab_svc_tutor"],
];
const cases = rows.map(([say, id], i) => ({
  id: `H3-DIA-${String(i + 1).padStart(3, "0")}`, group: "H3-DIA", type: "dialect-search", actor: "lab_buyer", heldOut: true,
  intent: "unseen request with extra details/variants after the subset-relaxation fix",
  turns: [{ say, expect: { surfaceIn: ["LISTING_RESULTS"], delta: { cart: 0 }, itemsExclude: HIDDEN, itemsInclude: [id] } }],
}));
writeFileSync(process.argv[2], JSON.stringify({ catalog: "held-out-3", frozenAt: "2026-11-10", total: cases.length, cases }, null, 1));
console.log(JSON.stringify({ total: cases.length }));
