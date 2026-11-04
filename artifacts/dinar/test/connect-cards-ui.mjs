import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
const base=process.env.CONNECT_WEB_BASE;
const report={widths:[],turns:0,pageErrors:[],consoleErrors:[],unexpectedExternalRequests:[]};
let browser;
try {
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH ?? process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const context=await browser.newContext({baseURL:base,viewport:{width:390,height:900},locale:"ar",reducedMotion:"reduce"});
  const cookie=process.env.CONNECT_COOKIE;const split=cookie.indexOf("=");
  await context.addCookies([{name:cookie.slice(0,split),value:cookie.slice(split+1),domain:new URL(base).hostname,path:"/",httpOnly:true,sameSite:"Lax"}]);
  await context.route("https://fonts.googleapis.com/**",r=>r.fulfill({status:200,contentType:"text/css",body:"/* isolated fixture */"}));
  await context.route("https://fonts.gstatic.com/**",r=>r.fulfill({status:200,body:""}));
  // A public-site fixture verifies the exact navigation destination. It supplies no
  // provider prices/availability and is not evidence of a live provider integration.
  // The isolation runner maps this origin to its logged local HTTPS navigation fixture.
  await context.addInitScript(()=>{globalThis.__connectFlights=0;document.addEventListener("dinar:cart-flight-start",()=>globalThis.__connectFlights++);});
  context.on("request",request=>{const url=new URL(request.url());if(/^https?:$/.test(url.protocol)&&url.host!==new URL(base).host&&!['fonts.googleapis.com','fonts.gstatic.com','dash.cloudflare.com'].includes(url.hostname))report.unexpectedExternalRequests.push(url.hostname);});
  const page=await context.newPage();page.on("pageerror",e=>report.pageErrors.push(e.message));page.on("console",m=>{if(m.type()==="error")report.consoleErrors.push(m.text());});
  page.on("request",r=>{if(r.method()==="POST"&&/\/conversations\/[^/]+\/turns$/.test(new URL(r.url()).pathname))report.turns++;});
  await page.goto("/");const input=page.getByTestId("input-ai-composer");await input.fill("دينار أريد دومين myshop.com بأرخص سعر.");await page.getByTestId("button-send-ai-message").click();
  const results=page.getByTestId("connect-results");await results.waitFor();
  assert.equal(await page.getByTestId("connect-card-cloudflare").count(),1);assert.equal(await page.getByTestId("connect-card-spaceship").count(),1);
  assert.ok((await results.innerText()).match(/غير معروف/g).length>=4);
  assert.ok((await results.innerText()).includes("لا توجد علاقة عمولة"));
  for(const width of [320,390,1280]) {await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0);report.widths.push(width);await page.screenshot({path:process.env.CONNECT_RESULT+`.domain-${width}.png`,fullPage:true});}
  const originalUrl=page.url();await input.fill("مسودة باقية في DINAR");
  const external=page.getByTestId("connect-external-cloudflare-0");await external.focus();assert.equal(await external.evaluate(e=>e===document.activeElement),true);
  const popupPromise=context.waitForEvent("page");await page.keyboard.press("Enter");const popup=await popupPromise;
  await popup.waitForURL("https://dash.cloudflare.com/");report.destination=popup.url();assert.equal(await popup.title(),"Isolated provider navigation fixture");report.destinationFixture=true;report.opener=await popup.evaluate(()=>window.opener);
  assert.equal(page.url(),originalUrl);assert.equal(await input.inputValue(),"مسودة باقية في DINAR");report.cartFlights=await page.evaluate(()=>globalThis.__connectFlights);
  await popup.close();await page.reload();await page.getByTestId("connect-results").waitFor();assert.equal(report.turns,1);
  const businessResponse=await context.request.post("/api/business/profiles",{data:{displayName:"شركة بوابة Connect",categoryKey:"OTHER",idempotencyKey:crypto.randomUUID()}});assert.equal(businessResponse.status(),201);
  await page.goto("/connect");await page.getByTestId("connect-portal").waitFor();await page.getByTestId("connect-register").click();await page.getByTestId("connect-partner-status").waitFor();assert.ok((await page.getByTestId("connect-partner-status").innerText()).includes("DRAFT"));
  assert.ok((await page.getByTestId("connect-portal").innerText()).includes("مجانية"));
  for(const width of [320,390,1280]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth),0);await page.screenshot({path:process.env.CONNECT_RESULT+`.portal-${width}.png`,fullPage:true});}
  report.partnerPortal="REAL_BROWSER_FREE_REGISTRATION";report.screenshotPrefix=process.env.CONNECT_RESULT;
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.unexpectedExternalRequests,[]);
} catch(error) {report.failure=error.stack??error.message;}finally{await browser?.close();writeFileSync(process.env.CONNECT_RESULT,JSON.stringify(report));}
