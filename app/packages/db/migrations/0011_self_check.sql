CREATE TABLE "self_check_consent_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"version" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "self_check_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"test_id" text NOT NULL,
	"test_version" integer NOT NULL,
	"score" numeric(6, 2) NOT NULL,
	"subscores" jsonb,
	"band" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "self_check_consent_events" ADD CONSTRAINT "self_check_consent_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "self_check_results" ADD CONSTRAINT "self_check_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "self_check_consent_events_user_id_idx" ON "self_check_consent_events" USING btree ("user_id","at");--> statement-breakpoint
CREATE INDEX "self_check_results_user_test_taken_idx" ON "self_check_results" USING btree ("user_id","test_id","taken_at" DESC NULLS LAST);