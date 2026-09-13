ALTER TABLE "click_events" ADD COLUMN "geo_region" text;--> statement-breakpoint
ALTER TABLE "click_events" ADD COLUMN "geo_city" text;--> statement-breakpoint
ALTER TABLE "click_events" ADD COLUMN "geo_source" text;--> statement-breakpoint
CREATE INDEX "click_events_geo_time_idx" ON "click_events" USING btree ("geo_city","occurred_at");