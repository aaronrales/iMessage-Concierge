import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, profilesTable, usersTable } from "@workspace/db";
import { GetUserParams, GetUserResponse, ListUsersResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/users", async (_req, res): Promise<void> => {
  const rows = await db
    .select({ user: usersTable, profile: profilesTable })
    .from(usersTable)
    .leftJoin(profilesTable, eq(profilesTable.userId, usersTable.id))
    .orderBy(usersTable.createdAt);

  res.json(ListUsersResponse.parse(rows.map(({ user, profile }) => ({ ...user, profile: profile ?? null }))));
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

  res.json(GetUserResponse.parse({ ...row.user, profile: row.profile ?? null }));
});

export default router;
