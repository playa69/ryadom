CREATE TABLE "diary_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period_start" date NOT NULL,
	"text" text NOT NULL,
	"stats" jsonb,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "diary_summaries_user_kind_period_unique" UNIQUE("user_id","kind","period_start"),
	CONSTRAINT "diary_summaries_kind_check" CHECK ("diary_summaries"."kind" in ('week', 'year'))
);
--> statement-breakpoint
CREATE TABLE "mood_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"mood" smallint NOT NULL,
	"factor" text,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mood_checkins_user_date_unique" UNIQUE("user_id","local_date"),
	CONSTRAINT "mood_checkins_mood_check" CHECK ("mood_checkins"."mood" between 1 and 5),
	CONSTRAINT "mood_checkins_factor_check" CHECK ("mood_checkins"."factor" is null or "mood_checkins"."factor" in ('work', 'people', 'health', 'money', 'sleep')),
	CONSTRAINT "mood_checkins_source_check" CHECK ("mood_checkins"."source" in ('app', 'widget', 'reminder', 'telegram'))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"local_date" date NOT NULL,
	"channel" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "notification_deliveries_user_kind_date_unique" UNIQUE("user_id","kind","local_date")
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mood_reminder_enabled" boolean DEFAULT true NOT NULL,
	"mood_reminder_time" time DEFAULT '20:00' NOT NULL,
	"paused_at" timestamp with time zone,
	"streak_reset_at" timestamp with time zone,
	"offer_answered_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"endpoint" text,
	"p256dh" text,
	"auth" text,
	"device_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "push_subscriptions_channel_check" CHECK ("push_subscriptions"."channel" in ('web_push', 'telegram', 'native_local'))
);
--> statement-breakpoint
CREATE TABLE "widget_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "widget_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" text DEFAULT 'Europe/Moscow' NOT NULL;--> statement-breakpoint
ALTER TABLE "diary_summaries" ADD CONSTRAINT "diary_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mood_checkins" ADD CONSTRAINT "mood_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_tokens" ADD CONSTRAINT "widget_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_id_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "widget_tokens_user_id_idx" ON "widget_tokens" USING btree ("user_id");