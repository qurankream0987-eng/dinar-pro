from pathlib import Path
b=Path('/workspace/dinar-connect-evidence');p=b/'expanded-driver/wave63-delivery-journey-browser.mjs';s=p.read_text();needle='  const buyer = await open("BUYER");';assert needle in s
extra='''  const onboarding = await open("ONBOARDING");
  await send(onboarding,"دينار أريد أشتغل سائق");
  await send(onboarding,"سيارة");
  const registrationReview = await send(onboarding,env.W63_ONBOARDING_CITY);
  const registrationPanel = registrationReview.getByTestId("driver-panel");
  await registrationPanel.getByTestId("driver-confirm").waitFor();
  await fitAtRequiredWidths(onboarding,registrationPanel,"driver registration review");
  const registrationPath = `/api/ai/conversations/${env.W63_ONBOARDING_CONVERSATION_ID}`;
  const latestProfile = body => body.messages.flatMap(message=>(message.blocks??[]).map(block=>block.payload?.driver?.profile)).filter(Boolean).at(-1);
  const beforeSubmit = await api(onboarding,registrationPath);assert.equal(beforeSubmit.status,200);assert.equal(latestProfile(beforeSubmit.body).status,"DRAFT");
  await clickTurn(onboarding,registrationPanel.getByTestId("driver-confirm"));
  const afterSubmit = await api(onboarding,registrationPath);assert.equal(latestProfile(afterSubmit.body).status,"PENDING_VERIFICATION");
  await onboarding.reload();await onboarding.getByTestId("input-ai-composer").waitFor();
  await onboarding.getByTestId("driver-panel").last().getByText("بانتظار التحقق",{exact:false}).waitFor();
  const blockedWork = await send(onboarding,"اعرض لي طلبات توصيل");assert.equal(await blockedWork.locator('[data-testid^="driver-accept-"]').count(),0);
  const onboardingEvidence = {draftBeforeConfirmation:true,statusAfterConfirmation:"PENDING_VERIFICATION",reload:true,noApproval:true,noWorkAcceptance:true};
''';s=s.replace(needle,extra+needle).replace('    status: "PASS",','    status: "PASS",\n    onboardingEvidence,');p.write_text(s)
p=b/'expanded-driver/driver-entry.ts';s=p.read_text();needle='  const journeyBuyer = await register("Wave 6.3 signed browser buyer");';s=s.replace(needle,'  const onboardingActor = await register("Additional real browser driver onboarding");\n'+needle);needle='            W63_ORDER_ID: journeyOrderId,';s=s.replace(needle,'''            W63_ONBOARDING_COOKIE: onboardingActor.cookie,
            W63_ONBOARDING_USER_ID: onboardingActor.id,
            W63_ONBOARDING_CONVERSATION_ID: onboardingActor.conv,
            W63_ONBOARDING_CITY: CITY,
'''+needle);needle='    console.log("W63-17_SIGNED_BROWSER", JSON.stringify(browserResult));';s=s.replace(needle,'''    const onboardingRow = await profileOf(onboardingActor);
    assert.equal(onboardingRow?.status,"PENDING_VERIFICATION");
    assert.equal(onboardingRow?.vehicleType,"CAR");
    assert.equal(onboardingRow?.serviceCity,CITY);
    assert.equal(browserResult.onboardingEvidence.noApproval,true);
'''+needle);p.write_text(s)
