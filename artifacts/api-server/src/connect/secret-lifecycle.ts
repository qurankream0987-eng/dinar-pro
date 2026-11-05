import { eq } from "drizzle-orm";
import { connectSecrets, connectOauthStates } from "@workspace/db";
import type { ConnectTx } from "./partners";
/** Retire local authorization material without claiming provider-side revocation.
 * Invalidating verifier ciphertext also invalidates an already claimed exchange. */
export async function retireConnectSecrets(tx: ConnectTx, integrationId: string) {
  const now = new Date();
  await tx.update(connectSecrets).set({ revokedAt: now }).where(eq(connectSecrets.integrationId, integrationId));
  await tx.update(connectOauthStates).set({ consumedAt: now, verifierCiphertext: "RETIRED" }).where(eq(connectOauthStates.integrationId, integrationId));
}
