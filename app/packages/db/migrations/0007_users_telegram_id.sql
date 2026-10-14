ALTER TABLE "users" ADD COLUMN "telegram_id" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_telegram_id_unique" UNIQUE("telegram_id");