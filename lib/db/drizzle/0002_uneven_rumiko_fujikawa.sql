CREATE TABLE "tool_call_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"tool_name" text NOT NULL,
	"outcome" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"thread_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
