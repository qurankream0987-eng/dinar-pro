import { eq } from "drizzle-orm";
import { db, users } from "@workspace/db";

/** Engine-side admin check; routes also check, but a privileged write must not rely on the route alone. */
export async function assertAdminActor(actorId: string, tx: any = db) {
  const [row] = await tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, actorId));
  if (row?.role !== "ADMIN") {
    throw Object.assign(new Error("هذا الإجراء متاح لإدارة المنصة فقط"), {
      status: 403,
      expose: true,
      code: "ADMIN_ONLY",
    });
  }
}
