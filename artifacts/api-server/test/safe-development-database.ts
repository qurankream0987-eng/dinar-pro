import { resolveDatabaseUrl } from "@workspace/db/database-url";

const approvalMessages: Record<string, string> = {
  BDINAR_SEED: "BDINAR_SEED=development",
  BDINAR_TEST_DATABASE: "BDINAR_TEST_DATABASE=development",
  BDINAR_PHASE1_ACCEPTANCE: "BDINAR_PHASE1_ACCEPTANCE=development",
  BDINAR_PHASE2_ACCEPTANCE: "BDINAR_PHASE2_ACCEPTANCE=development",
  BDINAR_SECURITY_ACCEPTANCE: "BDINAR_SECURITY_ACCEPTANCE=development",
  BDINAR_WAVE3_ACCEPTANCE: "BDINAR_WAVE3_ACCEPTANCE=development",
  BDINAR_WAVE4_ACCEPTANCE: "BDINAR_WAVE4_ACCEPTANCE=development",
  BDINAR_W07_ACCEPTANCE: "BDINAR_W07_ACCEPTANCE=development",
  BDINAR_W08_ACCEPTANCE: "BDINAR_W08_ACCEPTANCE=development",
  BDINAR_W09_ACCEPTANCE: "BDINAR_W09_ACCEPTANCE=development",
  BDINAR_W10_ACCEPTANCE: "BDINAR_W10_ACCEPTANCE=development",
  BDINAR_W12C_ACCEPTANCE: "BDINAR_W12C_ACCEPTANCE=development",
  BDINAR_D1D2_ACCEPTANCE: "BDINAR_D1D2_ACCEPTANCE=development",
  BDINAR_INTEGRATION_ACCEPTANCE: "BDINAR_INTEGRATION_ACCEPTANCE=development",
  BDINAR_BLOCKA_ACCEPTANCE: "BDINAR_BLOCKA_ACCEPTANCE=development",
  BDINAR_BLOCKC_ACCEPTANCE: "BDINAR_BLOCKC_ACCEPTANCE=development",
  BDINAR_BLOCKD_ACCEPTANCE: "BDINAR_BLOCKD_ACCEPTANCE=development",
  BDINAR_BLOCKE_ACCEPTANCE: "BDINAR_BLOCKE_ACCEPTANCE=development",
  BDINAR_BLOCKF_ACCEPTANCE: "BDINAR_BLOCKF_ACCEPTANCE=development",
  BDINAR_G1_ACCEPTANCE: "BDINAR_G1_ACCEPTANCE=development",
  BDINAR_G2_ACCEPTANCE: "BDINAR_G2_ACCEPTANCE=development",
  BDINAR_G3_ACCEPTANCE: "BDINAR_G3_ACCEPTANCE=development",
  BDINAR_WAVE02_ACCEPTANCE: "BDINAR_WAVE02_ACCEPTANCE=development",
  BDINAR_W02U3_TEST_DATABASE: "BDINAR_W02U3_TEST_DATABASE=development",
  BDINAR_W02U3_BROWSER: "BDINAR_W02U3_BROWSER=development",
  BDINAR_GFINAL_ACCEPTANCE: "BDINAR_GFINAL_ACCEPTANCE=development",
  BDINAR_XP_ACCEPTANCE: "BDINAR_XP_ACCEPTANCE=development",
  BDINAR_UCC_ACCEPTANCE: "BDINAR_UCC_ACCEPTANCE=development",
  BDINAR_CLOSURE_ACCEPTANCE: "BDINAR_CLOSURE_ACCEPTANCE=development",
  BDINAR_D1D2_ACCEPTANCE: "BDINAR_D1D2_ACCEPTANCE=development",
  BDINAR_ACCEPTANCE_FIXTURES: "BDINAR_ACCEPTANCE_FIXTURES=development",
  BDINAR_DEEPSEEK_CHAT_ACCEPTANCE: "BDINAR_DEEPSEEK_CHAT_ACCEPTANCE=development",
};

export function requireSafeReplitDevelopmentDatabase(
  operation: keyof typeof approvalMessages,
): void {
  const databaseUrl = resolveDatabaseUrl();
  let isDisposableLocalTestDatabase = false;
  if (process.env.BDINAR_DISPOSABLE_TEST_DATABASE === "1" && databaseUrl) {
    try {
      const parsed = new URL(databaseUrl);
      const databaseName = parsed.pathname.slice(1);
      isDisposableLocalTestDatabase =
        ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname) &&
        /^dinar_(?:test|acceptance|wave[0-9]+|migration)_[a-z0-9_]+$/i.test(databaseName);
    } catch {
      isDisposableLocalTestDatabase = false;
    }
  }
  if (operation === "BDINAR_BLOCKE_ACCEPTANCE" && !isDisposableLocalTestDatabase) {
    throw new Error(
      "Block E acceptance is restricted to an explicitly approved loopback disposable test database.",
    );
  }
  const isReplitEditor =
    Boolean(process.env.REPL_ID) &&
    process.env.REPLIT_DEPLOYMENT === undefined;
  const isDevelopment =
    process.env.NODE_ENV === "development" &&
    Boolean(databaseUrl);
  if (
    (!isReplitEditor && !isDisposableLocalTestDatabase) ||
    !isDevelopment ||
    process.env.REPLIT_DEPLOYMENT !== undefined ||
    process.env[operation] !== "development"
  ) {
    throw new Error(
      `${operationMessages[operation]} blocked. Requires the Replit editor's development database or an explicitly approved loopback disposable test database, NODE_ENV=development, no deployment marker, and ${approvalMessages[operation]}.`,
    );
  }
}

const operationMessages: Record<keyof typeof approvalMessages, string> = {
  BDINAR_SEED: "Development seed",
  BDINAR_TEST_DATABASE: "Database integration tests",
  BDINAR_PHASE1_ACCEPTANCE: "Phase-one acceptance run",
  BDINAR_PHASE2_ACCEPTANCE: "Phase-two acceptance run",
  BDINAR_SECURITY_ACCEPTANCE: "Security acceptance run",
  BDINAR_WAVE3_ACCEPTANCE: "Wave 3 privacy and moderation acceptance run",
  BDINAR_WAVE4_ACCEPTANCE: "Wave 4 payment acceptance run",
  BDINAR_W07_ACCEPTANCE: "Wave 07 financial journal and commission acceptance run",
  BDINAR_W08_ACCEPTANCE: "Wave 08 cash payment and cash refund acceptance run",
  BDINAR_W09_ACCEPTANCE: "Wave 09 policy lifecycle, consent and compliance acceptance run",
  BDINAR_W10_ACCEPTANCE: "Wave 10 trust, fraud, support and WhatsApp readiness acceptance run",
  BDINAR_W12C_ACCEPTANCE: "Wave 12.1 pre-integration contract hardening run",
  BDINAR_D1D2_ACCEPTANCE: "D1/D2 subscription and DINAR Business acceptance run",
  BDINAR_INTEGRATION_ACCEPTANCE: "Combined C1 + D1/D2 + W07–W12.1 + W02U-3 integration acceptance run",
  BDINAR_BLOCKA_ACCEPTANCE: "Block A conversational intelligence acceptance run",
  BDINAR_BLOCKC_ACCEPTANCE: "Block C employment acceptance run",
  BDINAR_BLOCKD_ACCEPTANCE: "Block D location and delivery acceptance run",
  BDINAR_BLOCKE_ACCEPTANCE: "Block E monetization and recommendation acceptance run",
  BDINAR_BLOCKF_ACCEPTANCE: "Block F conversational action foundation run",
  BDINAR_G1_ACCEPTANCE: "G1 provider source layer acceptance run",
  BDINAR_G2_ACCEPTANCE: "G2 smart conversation and negotiation acceptance run",
  BDINAR_G3_ACCEPTANCE: "G3 conversational UI browser acceptance run",
  BDINAR_GFINAL_ACCEPTANCE: "Block G final closure acceptance run",
  BDINAR_XP_ACCEPTANCE: "Experience upgrade acceptance run",
  BDINAR_UCC_ACCEPTANCE: "Universal conversational control acceptance run",
  BDINAR_CLOSURE_ACCEPTANCE: "Pre-integration engineering closure acceptance run",
  BDINAR_D1D2_ACCEPTANCE: "D1/D2 subscription and DINAR Business acceptance run",
  BDINAR_ACCEPTANCE_FIXTURES: "Disposable acceptance fixture setup",
  BDINAR_DEEPSEEK_CHAT_ACCEPTANCE: "DeepSeek canonical chat compatibility run",
};