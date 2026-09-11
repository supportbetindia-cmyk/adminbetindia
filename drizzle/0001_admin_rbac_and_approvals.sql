CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'active', 'paused', 'ended');--> statement-breakpoint
CREATE TYPE "public"."publisher_eligibility" AS ENUM('unconfirmed', 'eligible', 'ineligible');--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"user_agent" text,
	"ip_hash" text,
	CONSTRAINT "admin_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
--
-- Hand-edited: drizzle-kit emits a bare SET DATA TYPE, which PostgreSQL
-- rejects on a text column that has a default and existing rows. The default
-- is dropped, the values are cast explicitly, then the default is restored.
--
ALTER TABLE "campaigns" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "status" SET DATA TYPE campaign_status USING "status"::campaign_status;--> statement-breakpoint
ALTER TABLE "campaigns" ALTER COLUMN "status" SET DEFAULT 'draft';--> statement-breakpoint
ALTER TABLE "creatives" ALTER COLUMN "approval_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "creatives" ALTER COLUMN "approval_status" SET DATA TYPE approval_status USING "approval_status"::approval_status;--> statement-breakpoint
ALTER TABLE "creatives" ALTER COLUMN "approval_status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "destinations" ALTER COLUMN "approval_status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "destinations" ALTER COLUMN "approval_status" SET DATA TYPE approval_status USING "approval_status"::approval_status;--> statement-breakpoint
ALTER TABLE "destinations" ALTER COLUMN "approval_status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "password_hash" text;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "mfa_enrolled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_users" ADD COLUMN "last_login_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_email" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "actor_role" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "approval_reference" text;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "ip_hash" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "timezone" text DEFAULT 'Asia/Kolkata' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "placement" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "budget_amount" numeric(18, 2);--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "approval_reference" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "placement_id" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "approval_reference" text;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "creatives" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "destinations" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "destinations" ADD COLUMN "publisher_id" uuid;--> statement-breakpoint
ALTER TABLE "destinations" ADD COLUMN "approval_notes" text;--> statement-breakpoint
ALTER TABLE "destinations" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "contact_name" text;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "permitted_destination_types" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "tracking_macros" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "tracking_url_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "scripts_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "postbacks_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "destination_change_policy" text;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "approval_evidence" text;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "reporting_access_notes" text;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "eligibility" "publisher_eligibility" DEFAULT 'unconfirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "publishers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "smart_links" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "smart_links" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_admin_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_sessions_user_idx" ON "admin_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_sessions_expires_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "destinations" ADD CONSTRAINT "destinations_publisher_id_publishers_id_fk" FOREIGN KEY ("publisher_id") REFERENCES "public"."publishers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "destinations_approval_idx" ON "destinations" USING btree ("approval_status");--> statement-breakpoint
CREATE INDEX "smart_links_status_idx" ON "smart_links" USING btree ("status");