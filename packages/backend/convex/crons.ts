import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval(
  "activate due coverage plans",
  { minutes: 1 },
  internal.coverage.activation.activateDue,
  {},
);
crons.cron(
  "expire inventory lots",
  "15 0 * * *",
  internal.inventory.quality.expireDueLots,
  { now: 0 },
);
// SP-0135: live-map pings are kept 90 days.
crons.cron(
  "purge expired location pings",
  "40 19 * * *",
  internal.location.ingest.purgeExpired,
  {},
);
export default crons;
