CREATE TYPE "public"."admin_role" AS ENUM('super_admin', 'campaign_manager', 'media_buyer', 'analyst', 'integration_developer');--> statement-breakpoint
CREATE TYPE "public"."attribution_confidence" AS ENUM('exact', 'campaign_level', 'estimated', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."destination_type" AS ENUM('website', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."link_status" AS ENUM('draft', 'active', 'paused', 'ended');--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "admin_role" NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"before_data" jsonb,
	"after_data" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"cost_date" date NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"source" text NOT NULL,
	"external_reference" text
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisher_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"attribution_window_days" integer DEFAULT 30 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "click_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"click_id" text NOT NULL,
	"smart_link_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"publisher_id" uuid NOT NULL,
	"creative_id" uuid,
	"destination_version_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visitor_token_hash" text,
	"publisher_click_id" text,
	"device_type" text,
	"os" text,
	"referrer" text,
	"ip_hash" text,
	"geo_country" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_content" text,
	"utm_term" text,
	"bot_score" double precision,
	"bot_flags" text,
	"is_filtered" boolean DEFAULT false NOT NULL,
	CONSTRAINT "click_events_click_id_unique" UNIQUE("click_id")
);
--> statement-breakpoint
CREATE TABLE "conversion_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"click_id" text,
	"lead_id" uuid,
	"campaign_id" uuid,
	"model" text NOT NULL,
	"confidence" "attribution_confidence" NOT NULL,
	"policy_version" text,
	"attributed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_reference" text
);
--> statement-breakpoint
CREATE TABLE "creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"format" text,
	"asset_reference" text,
	"approval_status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "destination_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"smart_link_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" uuid,
	"approval_reference" text
);
--> statement-breakpoint
CREATE TABLE "destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "destination_type" NOT NULL,
	"url" text NOT NULL,
	"approval_status" text DEFAULT 'pending' NOT NULL,
	"approval_reference" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ftd_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"external_transaction_id" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"click_id" text,
	"campaign_id" uuid,
	"method" text NOT NULL,
	"confidence" "attribution_confidence" NOT NULL,
	"reference_token" text,
	"attributed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"evidence_reference" text
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_key" text NOT NULL,
	"first_message_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_contact_key_unique" UNIQUE("contact_key")
);
--> statement-breakpoint
CREATE TABLE "publisher_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publisher_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"report_date" date NOT NULL,
	"impressions" bigint,
	"publisher_clicks" bigint,
	"spend" numeric(18, 2),
	"currency" char(3),
	"source_reference" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "publishers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"external_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_system" text NOT NULL,
	"external_user_id" text NOT NULL,
	"registered_at" timestamp with time zone NOT NULL,
	"contact_key" text,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"creative_id" uuid,
	"slug" text NOT NULL,
	"destination_type" "destination_type" NOT NULL,
	"active_destination_id" uuid,
	"active_destination_version" integer DEFAULT 0 NOT NULL,
	"status" "link_status" DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smart_links_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "website_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_key" text NOT NULL,
	"metadata" jsonb,
	CONSTRAINT "website_events_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "website_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"click_id" text,
	"session_token_hash" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"landing_url" text,
	"consent_status" text DEFAULT 'unknown' NOT NULL,
	"attribution_status" text DEFAULT 'unmatched' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_message_id" text,
	"event_type" text NOT NULL,
	"contact_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"campaign_reference" text,
	"payload_reference" text
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_admin_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_costs" ADD CONSTRAINT "campaign_costs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_smart_link_id_smart_links_id_fk" FOREIGN KEY ("smart_link_id") REFERENCES "public"."smart_links"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_destination_version_id_destination_versions_id_fk" FOREIGN KEY ("destination_version_id") REFERENCES "public"."destination_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_attributions" ADD CONSTRAINT "conversion_attributions_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_attributions" ADD CONSTRAINT "conversion_attributions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_attributions" ADD CONSTRAINT "conversion_attributions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "destination_versions" ADD CONSTRAINT "destination_versions_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ftd_events" ADD CONSTRAINT "ftd_events_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_attributions" ADD CONSTRAINT "lead_attributions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_attributions" ADD CONSTRAINT "lead_attributions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publisher_reports" ADD CONSTRAINT "publisher_reports_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publisher_reports" ADD CONSTRAINT "publisher_reports_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_links" ADD CONSTRAINT "smart_links_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_links" ADD CONSTRAINT "smart_links_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_links" ADD CONSTRAINT "smart_links_active_destination_id_destinations_id_fk" FOREIGN KEY ("active_destination_id") REFERENCES "public"."destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_events" ADD CONSTRAINT "website_events_session_id_website_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."website_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_time_idx" ON "audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_costs_campaign_date_source_unq" ON "campaign_costs" USING btree ("campaign_id","cost_date","source");--> statement-breakpoint
CREATE INDEX "campaigns_publisher_idx" ON "campaigns" USING btree ("publisher_id");--> statement-breakpoint
CREATE INDEX "click_events_campaign_time_idx" ON "click_events" USING btree ("campaign_id","occurred_at");--> statement-breakpoint
CREATE INDEX "click_events_publisher_time_idx" ON "click_events" USING btree ("publisher_id","occurred_at");--> statement-breakpoint
CREATE INDEX "click_events_visitor_time_idx" ON "click_events" USING btree ("visitor_token_hash","occurred_at");--> statement-breakpoint
CREATE INDEX "click_events_link_time_idx" ON "click_events" USING btree ("smart_link_id","occurred_at");--> statement-breakpoint
CREATE INDEX "conversion_attributions_click_idx" ON "conversion_attributions" USING btree ("click_id");--> statement-breakpoint
CREATE INDEX "conversion_attributions_registration_idx" ON "conversion_attributions" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "creatives_campaign_idx" ON "creatives" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "destination_versions_link_version_unq" ON "destination_versions" USING btree ("smart_link_id","version");--> statement-breakpoint
CREATE INDEX "destination_versions_link_effective_idx" ON "destination_versions" USING btree ("smart_link_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ftd_events_source_txn_unq" ON "ftd_events" USING btree ("source_system","external_transaction_id");--> statement-breakpoint
CREATE INDEX "ftd_events_registration_time_idx" ON "ftd_events" USING btree ("registration_id","completed_at");--> statement-breakpoint
CREATE INDEX "lead_attributions_click_idx" ON "lead_attributions" USING btree ("click_id");--> statement-breakpoint
CREATE INDEX "lead_attributions_lead_idx" ON "lead_attributions" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publisher_reports_pub_campaign_date_unq" ON "publisher_reports" USING btree ("publisher_id","campaign_id","report_date");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_source_user_unq" ON "registrations" USING btree ("source_system","external_user_id");--> statement-breakpoint
CREATE INDEX "registrations_contact_idx" ON "registrations" USING btree ("contact_key");--> statement-breakpoint
CREATE INDEX "smart_links_campaign_idx" ON "smart_links" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_inbox_provider_event_unq" ON "webhook_inbox" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "webhook_inbox_status_received_idx" ON "webhook_inbox" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "website_events_session_time_idx" ON "website_events" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "website_sessions_click_idx" ON "website_sessions" USING btree ("click_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_events_provider_event_unq" ON "whatsapp_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "whatsapp_events_contact_time_idx" ON "whatsapp_events" USING btree ("contact_id","occurred_at");