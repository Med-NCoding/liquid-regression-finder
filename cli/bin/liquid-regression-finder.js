#!/usr/bin/env node
"use strict";

async function main() {
  const { runCli } = await import("../lib/cli.mjs");
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
}

main().catch((err) => {
  process.stderr.write(`Error [fatal]: ${err?.stack || err?.message || String(err)}\n`);
  process.exitCode = 2;
});
