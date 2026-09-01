import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.cron(
  "expire inventory lots",
  "15 0 * * *",
  internal.inventory.quality.expireDueLots,
  { now: 0 },
);
export default crons;
