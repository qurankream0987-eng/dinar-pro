from pathlib import Path
import json
r=Path('/workspace/dinar-next-functional-audit');b=Path('/workspace/dinar-connect-evidence');o=b/'inline-report';o.mkdir(exist_ok=True)
s=(r/'artifacts/dinar/test/sc01-ui-journey.mjs').read_text().replace('import { chromium, expect } from "@playwright/test";','import {createRequire as reportEvidenceRequire} from "node:module";const {chromium,expect}=reportEvidenceRequire('+json.dumps(str(r/'artifacts/dinar/package.json'))+') ("@playwright/test");').replace('from "./sc-ui-session.mjs"','from '+json.dumps(str(r/'artifacts/dinar/test/sc-ui-session.mjs')));s=s.replace('let listingId;','let listingId;\nlet trustReport;')
needle='  // T3: the buyer asks about the stock of the listing in view.'
addon='''  // Separate buyer conversation: exercise the shipped in-chat listing/report surface.
  const activeBuyerPage = page;
  page = await openSession(buyerCookie);
  const reportPage = page;
  try {
    await newConversation();
    const reportResults = await sendTurn("أبي آيفون 13 مستعمل");
    const reportCard = reportResults.getByTestId(`card-ai-result-${listingId}`);
    const conversationUrl = page.url();
    await reportCard.getByRole("button",{name:"عرض التفاصيل",exact:true}).click();
    const inline = page.locator(".ai-workflow").filter({has:page.getByTestId("button-report-listing")}).last();
    await inline.getByTestId("button-report-listing").click();
    const dialog = page.getByTestId("dialog-report");await dialog.waitFor();
    const profiles=[];
    for(const width of [320,360,390,430,768,1024,1440,1920])for(const scheme of ["light","dark"]){
      await page.setViewportSize({width,height:900});await page.emulateMedia({colorScheme:scheme});
      await page.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
      const geometry=await dialog.evaluate(node=>({overflow:document.documentElement.scrollWidth-innerWidth,left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,rtl:document.documentElement.dir,dark:document.documentElement.classList.contains("dark")}));
      assert.equal(geometry.overflow,0);assert.equal(geometry.rtl,"rtl");assert.equal(geometry.dark,scheme==="dark");assert.ok(geometry.left>=0&&geometry.right<=width+1);profiles.push({width,scheme,...geometry});
      if(width===320||width===1920)await page.screenshot({path:process.env.DINAR_TRUST_EVIDENCE_DIR+`/inline-report-${width}-${scheme}.png`,fullPage:true,mask:[page.locator('input[type="password"]')]});
    }
    await page.setViewportSize({width:390,height:900});await page.emulateMedia({colorScheme:"light"});
    await dialog.getByTestId("select-report-reason").selectOption("MISLEADING_LISTING");
    await dialog.getByTestId("input-report-note").fill("بلاغ اختبار معزول لمراجعة المصدر المعروض");
    const receipt=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname==="/api/reports");
    await dialog.getByTestId("button-submit-report").click();const posted=await receipt;assert.equal(posted.status(),201);const saved=await posted.json();
    await page.getByText("وصل بلاغك وسيراجعه فريق السوق.",{exact:true}).waitFor();
    assert.equal(page.url(),conversationUrl,"inline details and reporting preserve the primary conversation route");
    const ownReports=await api("/reports/mine",buyerCookie);assert.ok(ownReports.some(row=>row.id===saved.report.id&&row.targetId===listingId&&row.status==="OPEN"));
    trustReport={id:saved.report.id,targetId:listingId,status:"OPEN",source:"shipped chat-only memory-router listing surface; no App.tsx override",profiles};
    checks.push("actual buyer inline report receipt and own persisted report; chat-only mode unchanged");
  } finally {await reportPage.context().close();page=activeBuyerPage;}

''';assert needle in s;s=s.replace(needle,addon+needle).replace('JSON.stringify({ failure, listingId, orderId, checks,','JSON.stringify({ failure, listingId, orderId, trustReport, checks,');(o/'sc01-inline-report-ui.mjs').write_text(s)
s=(r/'artifacts/api-server/test/sc01-browser-journey.test.ts').read_text().replace('db, offers, orders, orderItems, pool','db, offers, orders, orderItems, marketplaceReports, pool');s=s.replace('`${process.cwd()}/../dinar/test/sc01-ui-journey.mjs`',json.dumps(str(o/'sc01-inline-report-ui.mjs')))
needle='  console.log("SC01_SUMMARY",';assert needle in s;s=s.replace(needle,'''  const [savedReport] = await db.select().from(marketplaceReports).where(eq(marketplaceReports.id,report.trustReport.id));
  assert.equal(savedReport?.targetId,listing.id);
  assert.equal(savedReport?.reporterId,order.buyerId);
  assert.equal(savedReport?.status,"OPEN");
  assert.equal(savedReport?.reasonCode,"MISLEADING_LISTING");
  assert.equal(report.trustReport.profiles.length,16);
'''+needle);(o/'inline-report-entry.ts').write_text(s)
s=(b/'run-expanded-driver-entry.mjs').read_text().replace('expanded-driver/driver-entry.ts','inline-report/inline-report-entry.ts').replace('expanded-driver-evidence.mjs','inline-report-evidence.mjs');(b/'run-inline-report-entry.mjs').write_text(s)
s=(r/'artifacts/api-server/test/isolation/local-suite.sh').read_text().replace('HERE=$(cd "$(dirname "$0")" && pwd)','HERE='+str(r/'artifacts/api-server/test/isolation'));needle='  run node test/run.mjs "$SUITE" || suite_status=$?';s=s.replace(needle,'  if [ "$SUITE" = sc01-browser-journey.test ]; then\n    run node /workspace/dinar-connect-evidence/run-inline-report-entry.mjs || suite_status=$?\n  else\n'+needle+'\n  fi');(b/'inline-report-local-suite.sh').write_text(s)
