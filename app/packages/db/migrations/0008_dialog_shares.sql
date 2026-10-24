CREATE TABLE "dialog_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"dialog_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"up_to_message_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"view_count" integer DEFAULT 0 NOT NULL,
	"last_viewed_at" timestamp with time zone,
	CONSTRAINT "dialog_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "dialog_shares" ADD CONSTRAINT "dialog_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dialog_shares_user_id_idx" ON "dialog_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dialog_shares_expires_at_idx" ON "dialog_shares" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dialog_shares_active_dialog_idx" ON "dialog_shares" USING btree ("user_id","dialog_id") WHERE "dialog_shares"."revoked_at" is null;