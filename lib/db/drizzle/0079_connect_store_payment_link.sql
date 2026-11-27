-- Store payment link inside the conversation (owner decision 2026-11-27): the connected store's own
-- system takes the payment. The owner maps where its write tool returns the checkout URL; the link
-- extracted after the person's confirmation is kept with that confirmation so it survives a reload.
-- Jassim never holds or records the money.
ALTER TABLE "connect_tools" ADD COLUMN "payment_link_mapping" jsonb;--> statement-breakpoint
ALTER TABLE "connect_action_confirmations" ADD COLUMN "payment_link" jsonb;
