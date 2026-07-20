import app from "./app";
import { logger } from "./lib/logger";
import { initScheduler } from "./lib/agent/scheduler";
import { seedAgentRules } from "./lib/agent/seedRules";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

initScheduler().catch((error) => {
  logger.error({ error }, "Failed to start proactive messaging scheduler");
});

seedAgentRules().catch((err) => {
  logger.error({ err }, "Failed to seed agent rules");
});
