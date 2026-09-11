ALTER TABLE "webhook_inbox" ADD COLUMN "event_id_source" text;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "headers" jsonb;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "content_type" text;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "source_ip_hash" text;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "signature_status" text DEFAULT 'not_configured' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD COLUMN "duplicate_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_inbox_provider_received_idx" ON "webhook_inbox" USING btree ("provider","received_at");