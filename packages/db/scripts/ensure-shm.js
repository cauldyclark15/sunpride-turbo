#!/usr/bin/env bun
// F-025: expand Docker's runtime tmpfs without restarting PostgreSQL or removing DSM segments.
import { spawnSync } from "node:child_process";

const container = "sunpride-postgres";
const targetBytes = 1024 * 1024 * 1024;
/** @param {string[]} args */
function docker(args) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (r.status !== 0)
    throw new Error((r.stderr ?? "").trim() || "Docker operation failed");
  return r.stdout.trim();
}
function capacity() {
  const value = Number(
    docker(["exec", container, "df", "-B1", "--output=size", "/dev/shm"])
      .split("\n")
      .at(-1),
  );
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Cannot verify shared-memory capacity");
  return value;
}
const beforeState = JSON.parse(
  docker(["inspect", "--format", "{{json .State}}", container]),
);
if (!beforeState.Running) throw new Error("PostgreSQL must already be running");
const beforeBytes = capacity();
if (beforeBytes < targetBytes) {
  const image = docker(["inspect", "--format", "{{.Image}}", container]);
  const helper = `sunpride-shm-${process.pid}`;
  // Docker exec retains the container's mount restriction. A one-shot, network-isolated
  // local-image helper enters only this container's mount namespace; it never restarts it.
  docker([
    "run",
    "--rm",
    "--name",
    helper,
    "--pull=never",
    "--privileged",
    `--pid=container:${container}`,
    "--network=none",
    "--user",
    "root",
    "--entrypoint",
    "/usr/bin/nsenter",
    image,
    "--target",
    "1",
    "--mount",
    "--root",
    "--",
    "/bin/mount",
    "-o",
    "remount,size=1g",
    "/dev/shm",
  ]);
  if (
    docker(["ps", "-a", "--filter", `name=${helper}`, "--format", "{{.Names}}"])
      .split("\n")
      .includes(helper)
  )
    throw new Error("Maintenance helper cleanup was not verified");
}
const afterBytes = capacity();
const afterState = JSON.parse(
  docker(["inspect", "--format", "{{json .State}}", container]),
);
if (afterBytes < targetBytes || beforeState.StartedAt !== afterState.StartedAt)
  throw new Error(
    "Shared-memory increase or database continuity was not verified",
  );
const configuredBytes = Number(
  docker(["inspect", "--format", "{{.HostConfig.ShmSize}}", container]),
);
console.log(
  JSON.stringify({
    beforeBytes,
    afterBytes,
    configuredBytes,
    startedAt: afterState.StartedAt,
    checkedAt: new Date().toISOString(),
    restarted: false,
    alreadySized: beforeBytes >= targetBytes,
    reapplyAfterContainerRestart: configuredBytes < targetBytes,
  }),
);
