#!/usr/bin/env bun
import { runHostServer } from "@yaade/host-server";

const argv = process.argv.slice(2);
const hasPortOverride =
  process.env.JET_PORT !== undefined ||
  argv.some((argument) => argument === "--port" || argument.startsWith("--port="));

runHostServer(hasPortOverride ? argv : [...argv, "--port", "4747"]);
