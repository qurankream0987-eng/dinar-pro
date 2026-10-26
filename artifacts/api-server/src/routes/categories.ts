import { Router } from "express";
import { randomUUID } from "node:crypto";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import {
  CreateMarketplaceCategoryBody,
  CreateMarketplaceCategoryResponse,
  GetAdminMarketplaceCategoryAuditResponse,
  GetAdminMarketplaceCategoriesResponse,
  GetMarketplaceCategoriesResponse,
  UpdateMarketplaceCategoryBody,
  UpdateMarketplaceCategoryResponse,
} from "@workspace/api-zod";
import { validateMarketplaceCategoryRules } from "@workspace/api-zod/marketplace-schemas";
import type { MarketplaceCategorySchema } from "@workspace/api-zod/marketplace-schemas";
import {
  db,
  markets,
  marketAudit,
  marketplaceCategories,
  marketplaceCategoryAudit,
  offers,
  users,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import {
  categoryApiRecord,
  categoryById,
  listMarketplaceCategories,
} from "../lib/marketplace-categories";

const router = Router();
const fail = (status: number, message: string) =>
  Object.assign(new Error(message), { status });

router.get("/categories", async (_req, res): Promise<void> => {
  const rows = await listMarketplaceCategories();
  res.json(GetMarketplaceCategoriesResponse.parse(rows.map(categoryApiRecord)));
});

router.use("/admin/categories", requireAuth, (req, res, next) => {
  if (req.actor?.role !== "ADMIN") {
    res.status(403).json({ error: "تحتاج إلى صلاحية إدارة التصنيفات" });
    return;
  }
  next();
});

router.get("/admin/categories", async (_req, res): Promise<void> => {
  const rows = await listMarketplaceCategories(true);
  res.json(
    GetAdminMarketplaceCategoriesResponse.parse(rows.map(categoryApiRecord)),
  );
});

router.get(
  "/admin/categories/:id/audit",
  async (req, res): Promise<void> => {
    const id = String(req.params.id);
    if (!(await categoryById(id))) throw fail(404, "الفئة غير موجودة.");
    const rows = await db
      .select({
        id: marketplaceCategoryAudit.id,
        categoryId: marketplaceCategoryAudit.categoryId,
        actorId: marketplaceCategoryAudit.actorId,
        actorName: users.displayName,
        action: marketplaceCategoryAudit.action,
        before: marketplaceCategoryAudit.before,
        after: marketplaceCategoryAudit.after,
        createdAt: marketplaceCategoryAudit.createdAt,
      })
      .from(marketplaceCategoryAudit)
      .innerJoin(users, eq(marketplaceCategoryAudit.actorId, users.id))
      .where(eq(marketplaceCategoryAudit.categoryId, id))
      .orderBy(desc(marketplaceCategoryAudit.createdAt))
      .limit(100);
    res.json(GetAdminMarketplaceCategoryAuditResponse.parse(rows));
  },
);

function validateDefinitionKeys(
  attributes: Record<string, unknown> | undefined,
  searchFilters: Record<string, unknown> | undefined,
): void {
  for (const key of [
    ...Object.keys(attributes ?? {}),
    ...Object.keys(searchFilters ?? {}),
  ]) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(key))
      throw fail(400, `اسم الخاصية غير صالح: ${key}`);
  }
}

router.post("/admin/categories", async (req, res): Promise<void> => {
  const body = CreateMarketplaceCategoryBody.strict().parse(req.body);
  validateDefinitionKeys(body.attributes, body.searchFilters);
  const rulesValidation = validateMarketplaceCategoryRules({
    id: body.id,
    attributes: body.attributes,
    rules: body.rules,
  });
  if (!rulesValidation.ok) throw fail(400, rulesValidation.reason);
  const row = await db.transaction(async (tx) => {
    if (body.parentId && !(await categoryById(body.parentId, tx)))
      throw fail(400, "الفئة الرئيسية غير موجودة.");
    const [existingId] = await tx
      .select({ id: marketplaceCategories.id })
      .from(marketplaceCategories)
      .where(eq(marketplaceCategories.id, body.id))
      .limit(1);
    const [existingLabel] = await tx
      .select({ id: marketplaceCategories.id })
      .from(marketplaceCategories)
      .where(eq(marketplaceCategories.label, body.label))
      .limit(1);
    if (existingId || existingLabel)
      throw fail(409, "معرّف الفئة أو اسمها مستخدم.");
    const [created] = await tx
      .insert(marketplaceCategories)
      .values({
        ...body,
        parentId: body.parentId ?? null,
        aliases: body.aliases,
        attributes: body.attributes,
        searchFilters: body.searchFilters,
        allowAdditionalAttributes: body.allowAdditionalAttributes ?? false,
        isActive: body.isActive ?? true,
      })
      .returning();
    await tx.insert(marketplaceCategoryAudit).values({
      id: randomUUID(),
      categoryId: created.id,
      actorId: req.actor!.id,
      action: "CREATE",
      before: null,
      after: created,
    });
    return created;
  });
  res
    .status(201)
    .json(CreateMarketplaceCategoryResponse.parse(categoryApiRecord(row)));
});

router.patch("/admin/categories/:id", async (req, res): Promise<void> => {
  const body = UpdateMarketplaceCategoryBody.strict().parse(req.body);
  if (!Object.keys(body).length) throw fail(400, "أرسل حقلاً واحدًا على الأقل.");
  const id = String(req.params.id);
  validateDefinitionKeys(body.attributes, body.searchFilters);
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(marketplaceCategories)
      .where(eq(marketplaceCategories.id, id))
      .for("update");
    if (!existing) throw fail(404, "الفئة غير موجودة.");
    const rulesValidation = validateMarketplaceCategoryRules({
      id,
      attributes: (body.attributes ??
        existing.attributes) as MarketplaceCategorySchema["attributes"],
      rules: (body.rules ??
        existing.rules) as MarketplaceCategorySchema["rules"],
    });
    if (!rulesValidation.ok) throw fail(400, rulesValidation.reason);
    if (body.parentId && body.parentId !== existing.parentId) {
      if (body.parentId === id || !(await categoryById(body.parentId, tx)))
        throw fail(400, "الفئة الرئيسية غير صالحة.");
    }
    if (body.label && body.label !== existing.label) {
      const [duplicate] = await tx
        .select({ id: marketplaceCategories.id })
        .from(marketplaceCategories)
        .where(
          and(
            eq(marketplaceCategories.label, body.label),
            ne(marketplaceCategories.id, id),
          ),
        )
        .limit(1);
      if (duplicate) throw fail(409, "اسم الفئة مستخدم.");
    }
    const [updatedCategory] = await tx
      .update(marketplaceCategories)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(marketplaceCategories.id, id))
      .returning();
    await tx.insert(marketplaceCategoryAudit).values({
      id: randomUUID(),
      categoryId: id,
      actorId: req.actor!.id,
      action: "UPDATE",
      before: existing,
      after: updatedCategory,
    });
    if (body.label && body.label !== existing.label) {
      const now = new Date();
      await tx
        .update(offers)
        .set({
          data: sql`jsonb_set(jsonb_set(${offers.data}, '{category}', to_jsonb(${body.label}::text), true), '{categoryId}', to_jsonb(${id}::text), true)`,
          updatedAt: now,
        })
        .where(
          or(
            sql`${offers.data} ->> 'categoryId' = ${id}`,
            sql`${offers.data} ->> 'category' = ${existing.label}`,
          ),
        );
      const marketRows = await tx.select().from(markets).for("update");
      for (const market of marketRows) {
        if (!market.restrictedCategories.includes(existing.label)) continue;
        const updatedRestrictions = market.restrictedCategories.map((value) =>
          value === existing.label ? id : value,
        );
        await tx
          .update(markets)
          .set({ restrictedCategories: updatedRestrictions, updatedAt: now })
          .where(eq(markets.id, market.id));
        await tx.insert(marketAudit).values({
          id: randomUUID(),
          marketId: market.id,
          actorId: req.actor!.id,
          action: "CATEGORY_POLICY",
          data: {
            before: { restrictedCategories: market.restrictedCategories },
            after: { restrictedCategories: updatedRestrictions },
            reason: "CATEGORY_RENAMED",
            categoryId: id,
          },
        });
      }
    }
    return updatedCategory;
  });
  res.json(UpdateMarketplaceCategoryResponse.parse(categoryApiRecord(row)));
});

export default router;