/**
 * Manual "city bring-up" runner for the curated venue corpus population job
 * (see `lib/agent/venueCorpus/population.ts`). This is the tooling the
 * product owner uses to run the actual ~500-venue NYC population pass --
 * this repo intentionally does NOT run that pass itself.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server run populate-venues -- \
 *     --neighborhood "Williamsburg" --borough Brooklyn [--venue-type bar] [--limit 20]
 */
import { populateNeighborhood } from "../lib/agent/venueCorpus/population";
import { logger } from "../lib/logger";

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        result[key] = value;
        i++;
      }
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const neighborhood = args["neighborhood"];
  if (!neighborhood) {
    logger.error('Usage: populate-venues -- --neighborhood "<name>" [--borough <name>] [--venue-type restaurant|bar] [--limit <n>]');
    process.exit(1);
  }

  const venueType = args["venue-type"] === "bar" ? "bar" : "restaurant";
  const limit = args["limit"] ? Number.parseInt(args["limit"], 10) : undefined;

  logger.info({ neighborhood, borough: args["borough"], venueType, limit }, "Starting venue population run");

  const result = await populateNeighborhood({
    neighborhood,
    borough: args["borough"],
    venueType,
    limit,
  });

  logger.info(result, "Venue population run complete");

  if (result.errors.length > 0) {
    logger.warn({ errors: result.errors }, "Some candidates failed extraction and were skipped");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error({ error }, "Venue population run failed");
    process.exit(1);
  });
