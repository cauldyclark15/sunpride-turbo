#!/usr/bin/env bun
import { createDb } from "../packages/db/src/client.js";
import { ApiError } from "../apps/api/src/core/errors.js";
import { parseCommand } from "./board/args.js";
import { runBoard } from "./board/commands.js";

/** @param {string[]} args @param {Record<string,string|undefined>} [env] */
export async function main(args, env = process.env) {
  /** @type {ReturnType<typeof createDb>|undefined} */
  let db;
  try {
    const command = parseCommand(args);
    if (!env.DATABASE_URL?.trim())
      throw new ApiError("configuration", 500, "DATABASE_URL is required");
    db = createDb(env.DATABASE_URL, { max: 1 });
    const result = await runBoard(db, command, env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (e) {
    // Driver/connection errors can include credentials or connection strings.
    const error = e instanceof ApiError ? e.code : "internal";
    const message = e instanceof ApiError ? e.message : "Board command failed";
    process.stderr.write(`${JSON.stringify({ error, message })}\n`);
    return e instanceof ApiError && e.status === 400
      ? 2
      : e instanceof ApiError && e.status === 404
        ? 3
        : 1;
  } finally {
    await db?.close();
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
