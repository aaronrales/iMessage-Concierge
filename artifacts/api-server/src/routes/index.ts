import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sendblueWebhookRouter from "./webhooks/sendblue";
import sendblueStatusWebhookRouter from "./webhooks/sendblue-status";
import usersRouter from "./users";
import threadsRouter from "./threads";
import bookingsRouter from "./bookings";
import venuesRouter from "./venues";
import plansRouter from "./plans";
import deliveryRouter from "./delivery";
import venuePopulationRunsRouter from "./venuePopulationRuns";
import turnsRouter from "./turns";
import agentConfigRouter from "./agent-config";
import conciergeVcfRouter from "./conciergeVcf";
import activationRouter from "./activation";
import operationsRouter from "./operations";
import privacyRouter from "./privacy";
import emulatorRouter from "./emulator";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sendblueWebhookRouter);
router.use(sendblueStatusWebhookRouter);
router.use(usersRouter);
router.use(threadsRouter);
router.use(bookingsRouter);
router.use(venuesRouter);
router.use("/plans", plansRouter);
router.use(deliveryRouter);
router.use(venuePopulationRunsRouter);
router.use(turnsRouter);
router.use(agentConfigRouter);
router.use(conciergeVcfRouter);
router.use(activationRouter);
router.use(operationsRouter);
// Privacy policy is mounted inside the /api router (same as all other routes),
// so it is reachable at /api/privacy externally. The Replit proxy routes /api/*
// to this service and strips the prefix before forwarding to Express, so the
// Express route is registered as /privacy here. The URL helper (publicUrl.ts)
// produces https://<domain>/api/privacy accordingly.
router.use(privacyRouter);
router.use(emulatorRouter);

export default router;
