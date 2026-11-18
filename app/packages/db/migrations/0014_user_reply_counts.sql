CREATE TABLE "user_reply_counts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"replies" integer NOT NULL,
	"first_reply_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_reply_counts" ADD CONSTRAINT "user_reply_counts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Accounts that existed before the count: their next reply is not a first one (see schema/user-reply-counts.ts).
INSERT INTO "user_reply_counts" ("user_id", "day", "replies") SELECT "id", DATE '1970-01-01', 0 FROM "users" WHERE "is_deleted" = false;
