CREATE TABLE "voice_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"pipeline" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "voice_settings_single_row" CHECK ("voice_settings"."id" = 1),
	CONSTRAINT "voice_settings_pipeline_check" CHECK (pipeline in ('sber', 'gemini'))
);
