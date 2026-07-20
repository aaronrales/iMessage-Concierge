CREATE TYPE "public"."onboarding_status" AS ENUM('not_started', 'in_progress', 'completed');--> statement-breakpoint
CREATE TYPE "public"."profile_field_visibility" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('proposed', 'deciding', 'confirmed', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."poll_kind" AS ENUM('choice', 'date');--> statement-breakpoint
CREATE TYPE "public"."poll_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('drafted', 'pending_approval', 'approved', 'rejected', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."proactive_message_category" AS ENUM('occasion_reminder', 'plan_reminder', 'nudge', 'serendipity', 'timeline_nudge', 'payment_nudge', 'commitment_nudge');--> statement-breakpoint
CREATE TYPE "public"."feedback_kind" AS ENUM('rating', 'poll_winner', 'suggestion_accepted', 'suggestion_ignored', 'free_text');--> statement-breakpoint
CREATE TYPE "public"."occasion_kind" AS ENUM('birthday', 'anniversary', 'visit', 'other');--> statement-breakpoint
CREATE TYPE "public"."recommendation_outcome" AS ENUM('shown', 'picked', 'ignored', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."venue_tier" AS ENUM('pending_review', 'tier1', 'tier2', 'untiered');--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"phone_number" text NOT NULL,
	"display_name" text,
	"onboarding_status" "onboarding_status" DEFAULT 'not_started' NOT NULL,
	"contact_card_sent" boolean DEFAULT false NOT NULL,
	"source" text,
	"origin_thread_id" integer,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_number_unique" UNIQUE("phone_number")
);
--> statement-breakpoint
CREATE TABLE "activation_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"event" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"budget" text,
	"budget_visibility" "profile_field_visibility" DEFAULT 'private' NOT NULL,
	"dietary_needs" text,
	"dietary_needs_visibility" "profile_field_visibility" DEFAULT 'private' NOT NULL,
	"preferences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"preferences_visibility" "profile_field_visibility" DEFAULT 'public' NOT NULL,
	"past_choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"notes_visibility" "profile_field_visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" serial PRIMARY KEY NOT NULL,
	"sendblue_group_id" text,
	"primary_phone_number" text,
	"is_group" boolean DEFAULT false NOT NULL,
	"title" text,
	"pending_feedback_plan_id" integer,
	"introduced_at" timestamp with time zone,
	"home_city" text,
	"onboarding_recap_sent_at" timestamp with time zone,
	"admin_notes" text,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"needs_attention_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_sendblue_group_id_unique" UNIQUE("sendblue_group_id"),
	CONSTRAINT "threads_primary_phone_number_unique" UNIQUE("primary_phone_number")
);
--> statement-breakpoint
CREATE TABLE "thread_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"is_muted" boolean DEFAULT false NOT NULL,
	"disclosure_sent_at" timestamp with time zone,
	"onboarding_nudge_sent_at" timestamp with time zone,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_participants_thread_id_user_id_unique" UNIQUE("thread_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"user_id" integer,
	"direction" "message_direction" NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"sendblue_message_handle" text,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_sendblue_message_handle_unique" UNIQUE("sendblue_message_handle")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"project_id" integer,
	"title" text NOT NULL,
	"scheduled_for" timestamp with time zone,
	"venue" text,
	"attendee_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "plan_status" DEFAULT 'proposed' NOT NULL,
	"weather_rescue_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"type" text NOT NULL,
	"honoree" text,
	"honoree_user_id" integer,
	"date_range_start" timestamp with time zone,
	"date_range_end" timestamp with time zone,
	"status" text DEFAULT 'planning' NOT NULL,
	"organizer_user_id" integer,
	"commitment_deadline" timestamp with time zone,
	"headcount_target" integer,
	"commitment_poll_id" integer,
	"headcount_locked_at" timestamp with time zone,
	"headcount_locked_count" integer,
	"destination" text,
	"destination_poll_id" integer,
	"arrival_collection_request_id" integer,
	"lodging_per_person_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"group_thread_id" integer NOT NULL,
	"proposal_type" text NOT NULL,
	"proposal_content" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"organizer_reply" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"due_at" timestamp with time zone,
	"owner_user_id" integer,
	"source_step" text,
	"action_hint" text,
	"completion_trigger" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"notified_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "polls" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"plan_id" integer,
	"question" text NOT NULL,
	"kind" "poll_kind" DEFAULT 'choice' NOT NULL,
	"status" "poll_status" DEFAULT 'open' NOT NULL,
	"winning_option_id" integer,
	"tiebreak_option_id" integer,
	"tiebreak_announced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "poll_options" (
	"id" serial PRIMARY KEY NOT NULL,
	"poll_id" integer NOT NULL,
	"label" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"option_date" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"poll_id" integer NOT NULL,
	"option_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poll_votes_poll_id_user_id_option_id_unique" UNIQUE("poll_id","user_id","option_id")
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"plan_id" integer,
	"created_by_user_id" integer,
	"approver_user_id" integer,
	"title" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "booking_status" DEFAULT 'drafted' NOT NULL,
	"provider" text,
	"provider_booking_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "proactive_message_sends" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"user_id" integer,
	"category" "proactive_message_category" NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"plan_id" integer,
	"user_id" integer,
	"kind" "feedback_kind" NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "occasions" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"about_user_id" integer,
	"mentioned_by_user_id" integer,
	"kind" "occasion_kind" DEFAULT 'other' NOT NULL,
	"label" text NOT NULL,
	"occasion_date" timestamp with time zone NOT NULL,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "private_input_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"plan_id" integer,
	"question" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"aggregate_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "private_input_responses" (
	"id" serial PRIMARY KEY NOT NULL,
	"request_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"answer" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "destination_venue_extractions" (
	"id" serial PRIMARY KEY NOT NULL,
	"destination" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"venue_data" jsonb DEFAULT '[]'::jsonb,
	"venue_count" integer,
	"error_note" text,
	"extracted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendation_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"venue_id" integer,
	"thread_id" integer NOT NULL,
	"plan_id" integer,
	"outcome" "recommendation_outcome" NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_attributes" (
	"id" serial PRIMARY KEY NOT NULL,
	"venue_id" integer NOT NULL,
	"dimension" text NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0' NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venue_attributes_venue_dimension_unique" UNIQUE("venue_id","dimension")
);
--> statement-breakpoint
CREATE TABLE "venue_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"venue_id" integer,
	"thread_id" integer NOT NULL,
	"plan_id" integer,
	"user_id" integer,
	"rating" integer,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_population_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"neighborhood" text NOT NULL,
	"borough" text,
	"city" text,
	"venue_type" text DEFAULT 'restaurant' NOT NULL,
	"custom_query" text,
	"limit" integer DEFAULT 20 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"candidates_found" integer,
	"venues_written" integer,
	"venues_skipped" integer,
	"errors" jsonb DEFAULT '[]'::jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"venue_id" integer NOT NULL,
	"source" text NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0' NOT NULL,
	"source_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venue_signals_venue_source_unique" UNIQUE("venue_id","source")
);
--> statement-breakpoint
CREATE TABLE "venue_type_revalidation_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"venue_type" text NOT NULL,
	"cadence_days" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venue_type_revalidation_config_venue_type_unique" UNIQUE("venue_type")
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"venue_type" text DEFAULT 'restaurant' NOT NULL,
	"neighborhood" text NOT NULL,
	"borough" text,
	"city" text DEFAULT 'New York' NOT NULL,
	"address" text,
	"category" text,
	"tier" "venue_tier" DEFAULT 'pending_review' NOT NULL,
	"composite_score" numeric(6, 3),
	"first_party_weight" numeric(4, 3) DEFAULT '0' NOT NULL,
	"closure_suspected" boolean DEFAULT false NOT NULL,
	"candidate_source_ref" text,
	"google_place_id" text,
	"last_validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venues_name_neighborhood_unique" UNIQUE("name","neighborhood")
);
--> statement-breakpoint
CREATE TABLE "message_delivery_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_handle" text,
	"recipient_phone" text,
	"status" text NOT NULL,
	"error_code" text,
	"thread_id" integer,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turn_ratings" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"thread_id" integer NOT NULL,
	"rating" text NOT NULL,
	"failure_tag" text,
	"notes" text,
	"rated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "turn_ratings_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "agent_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "pending_deliverables" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" integer NOT NULL,
	"project_id" integer,
	"kind" text NOT NULL,
	"promised_text" text NOT NULL,
	"destination_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expected_by_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"delivery_content" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_origin_thread_id_threads_id_fk" FOREIGN KEY ("origin_thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activation_events" ADD CONSTRAINT "activation_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_honoree_user_id_users_id_fk" FOREIGN KEY ("honoree_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organizer_user_id_users_id_fk" FOREIGN KEY ("organizer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_proposals" ADD CONSTRAINT "project_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_proposals" ADD CONSTRAINT "project_proposals_group_thread_id_threads_id_fk" FOREIGN KEY ("group_thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "polls" ADD CONSTRAINT "polls_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_options" ADD CONSTRAINT "poll_options_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_option_id_poll_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."poll_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_message_sends" ADD CONSTRAINT "proactive_message_sends_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_message_sends" ADD CONSTRAINT "proactive_message_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occasions" ADD CONSTRAINT "occasions_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occasions" ADD CONSTRAINT "occasions_about_user_id_users_id_fk" FOREIGN KEY ("about_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occasions" ADD CONSTRAINT "occasions_mentioned_by_user_id_users_id_fk" FOREIGN KEY ("mentioned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_input_requests" ADD CONSTRAINT "private_input_requests_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_input_requests" ADD CONSTRAINT "private_input_requests_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_input_responses" ADD CONSTRAINT "private_input_responses_request_id_private_input_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."private_input_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_input_responses" ADD CONSTRAINT "private_input_responses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendation_events" ADD CONSTRAINT "recommendation_events_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_attributes" ADD CONSTRAINT "venue_attributes_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_feedback" ADD CONSTRAINT "venue_feedback_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_feedback" ADD CONSTRAINT "venue_feedback_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_feedback" ADD CONSTRAINT "venue_feedback_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_feedback" ADD CONSTRAINT "venue_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_signals" ADD CONSTRAINT "venue_signals_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_delivery_log" ADD CONSTRAINT "message_delivery_log_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_ratings" ADD CONSTRAINT "turn_ratings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_ratings" ADD CONSTRAINT "turn_ratings_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ledger_entries" ADD CONSTRAINT "project_ledger_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ledger_entries" ADD CONSTRAINT "project_ledger_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activation_events_user_event_unique" ON "activation_events" USING btree ("user_id","event");--> statement-breakpoint
CREATE INDEX "thread_participants_user_id_idx" ON "thread_participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_thread_id_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_one_active_per_thread" ON "projects" USING btree ("thread_id") WHERE status IN ('forming', 'planning', 'active');--> statement-breakpoint
CREATE INDEX "polls_thread_id_idx" ON "polls" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "poll_options_poll_id_idx" ON "poll_options" USING btree ("poll_id");--> statement-breakpoint
CREATE INDEX "poll_votes_option_id_idx" ON "poll_votes" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX "bookings_thread_id_idx" ON "bookings" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "bookings_plan_id_idx" ON "bookings" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "bookings_created_by_user_id_idx" ON "bookings" USING btree ("created_by_user_id");--> statement-breakpoint
CREATE INDEX "bookings_approver_user_id_idx" ON "bookings" USING btree ("approver_user_id");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");