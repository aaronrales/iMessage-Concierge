import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { db, profilesTable, usersTable, threadParticipantsTable, messagesTable } from "@workspace/db";
import { GetUserParams, GetUserResponse, ListUsersResponse, SendOnboardingNudgeParams } from "@workspace/api-zod";
import { getOnboardingProgressByUserId } from "../lib/agent/context";
import { sendOnboardingNudge } from "../lib/agent/scheduler";

const router: IRouter = Router();

router.get("/users", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ user: usersTable, profile: profilesTable })
    .from(usersTable)
    .leftJoin(profilesTable, eq(profilesTable.userId, usersTable.id))
    .orderBy(usersTable.createdAt);

  const progressByUserId = await getOnboardingProgressByUserId();

  res.json(
    ListUsersResponse.parse(
      rows.map(({ user, profile }) => {
        const progress = progressByUserId.get(user.id);
        return {
          ...user,
          profile: profile ?? null,
          onboardingDisclosedAt: user.onboardingStatus === "completed" ? null : progress?.disclosedAt ?? null,
          onboardingNudgedAt: progress?.nudgedAt ?? null,
        };
      }),
    ),
  );
});

router.get("/users/:id", async (req, res): Promise<void> => {
  const params = GetUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [row] = await db
    .select({ user: usersTable, profile: profilesTable })
    .from(usersTable)
    .leftJoin(profilesTable, eq(profilesTable.userId, usersTable.id))
    .where(eq(usersTable.id, params.data.id));

  if (!row) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const progress = (await getOnboardingProgressByUserId()).get(row.user.id);

  res.json(
    GetUserResponse.parse({
      ...row.user,
      profile: row.profile ?? null,
      onboardingDisclosedAt: row.user.onboardingStatus === "completed" ? null : progress?.disclosedAt ?? null,
      onboardingNudgedAt: progress?.nudgedAt ?? null,
    }),
  );
});

router.post("/users/:id/onboarding-nudge", async (req, res): Promise<void> => {
  const params = SendOnboardingNudgeParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.id));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Honor the global opt-out flag set by "forget me": a user who deleted
  // their data must never receive proactive outreach, including manual nudges.
  if (user.doNotContact) {
    res.json({ received: true });
    return;
  }

  // Reuses the same send-and-mark logic the scheduled scan calls, so a
  // manual nudge and an automatic one can never both fire for the same person.
  await sendOnboardingNudge(user.id);
  res.json({ received: true });
});

const DeleteUserParams = z.object({ id: z.coerce.number().int() });

/**
 * Hard-deletes a user and their associated records. Cascades to
 * thread_participants (on delete cascade) and messages sent by this user
 * where cascade is configured. This is a destructive, irreversible action.
 */
router.delete("/users/:id", async (req, res): Promise<void> => {
  const params = DeleteUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid user id" });
    return;
  }

  const [user] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, params.data.id));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Remove thread participation first (FK constraint) then the user row.
  await db.delete(threadParticipantsTable).where(eq(threadParticipantsTable.userId, params.data.id));
  await db.delete(messagesTable).where(eq(messagesTable.userId, params.data.id));
  await db.delete(profilesTable).where(eq(profilesTable.userId, params.data.id));
  await db.delete(usersTable).where(eq(usersTable.id, params.data.id));

  res.json({ deleted: true });
});

export default router;
