import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { threadsTable } from "./threads";

/**
 * Persists delivery-status events (ERROR, BLOCKED, DELIVERED) from Sendblue's
 * outbound webhook and `line_blocked` callback. Provides the ops dashboard with
 * visibility into persistent failures and compliance events.
 *
 * Rows are insert-only: ERROR and BLOCKED rows are the primary concern; DELIVERED
 * rows are optionally written for completeness when the feature flag is on.
 */
export const messageDeliveryLogTable = pgTable("message_delivery_log", {
  id: serial("id").primaryKey(),
  /**
   * Sendblue message handle from the outbound event, or null for line_blocked
   * events that are not tied to a single outbound message.
   */
  messageHandle: text("message_handle"),
  /** Recipient phone number (E.164). */
  recipientPhone: text("recipient_phone"),
  /**
   * Delivery status from Sendblue: ERROR, DELIVERED, SENT, QUEUED, BLOCKED.
   * BLOCKED is synthetic — set when a `line_blocked` event is received.
   */
  status: text("status").notNull(),
  /** Sendblue error code when status is ERROR, otherwise null. */
  errorCode: text("error_code"),
  /**
   * Thread that the message was sent to, if known. Null for line_blocked events
   * where the blocked number doesn't correspond to an active thread.
   */
  threadId: integer("thread_id").references(() => threadsTable.id, { onDelete: "set null" }),
  /** Full raw webhook payload for post-hoc debugging. */
  rawPayload: jsonb("raw_payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MessageDeliveryLog = typeof messageDeliveryLogTable.$inferSelect;
