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

export default router;
