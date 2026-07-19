ALTER TABLE "threads" ADD COLUMN "needs_attention" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "needs_attention_at" timestamp with time zone;