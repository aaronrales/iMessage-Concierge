import { Router, type IRouter } from "express";
import healthRouter from "./health";
import sendblueWebhookRouter from "./webhooks/sendblue";
import usersRouter from "./users";
import threadsRouter from "./threads";
import bookingsRouter from "./bookings";
import venuesRouter from "./venues";

const router: IRouter = Router();

router.use(healthRouter);
router.use(sendblueWebhookRouter);
router.use(usersRouter);
router.use(threadsRouter);
router.use(bookingsRouter);
router.use(venuesRouter);

export default router;
