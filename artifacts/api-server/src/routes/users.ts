import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, profilesTable, usersTable } from "@workspace/db";
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

  // Reuses the same send-and-mark logic the scheduled scan calls, so a
  // manual nudge and an automatic one can never both fire for the same
  // person.
  await sendOnboardingNudge(user.id);
  res.json({ received: true });
});

export default router;
