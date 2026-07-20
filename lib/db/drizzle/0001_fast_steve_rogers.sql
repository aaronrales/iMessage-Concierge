CREATE TABLE "agent_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_rules_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "llm_cost_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer,
	"module" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closeout_prompt_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "occasions" ADD COLUMN "project_id" integer;