ALTER TYPE "public"."proactive_message_category" ADD VALUE 'payment_nudge';--> statement-breakpoint
CREATE TABLE "project_ledger_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"kind" text NOT NULL,
	"user_id" integer,
	"amount_cents" integer,
	"note" text,
	"request_sent_at" timestamp with time zone,
	"last_nudged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_ledger_entries" ADD CONSTRAINT "project_ledger_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ledger_entries" ADD CONSTRAINT "project_ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;