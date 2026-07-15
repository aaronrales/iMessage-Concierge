import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sendblueWebhookRouter from "./webhooks/sendblue";
import usersRouter from "./users";
import threadsRouter from "./threads";
import bookingsRouter from "./bookings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sendblueWebhookRouter);
router.use(usersRouter);
router.use(threadsRouter);
router.use(bookingsRouter);

export default router;
