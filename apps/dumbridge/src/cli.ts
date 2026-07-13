#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, pipe } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import packageJson from "../package.json" with { type: "json" };

const serve = Command.make("serve", {
  root: Argument.string("root"),
}).pipe(Command.withDescription("Serve one local directory read-only."));

const run = Command.make("run", {
  script: Argument.string("script"),
}).pipe(
  Command.withDescription("Evaluate one script in the remote read shell.")
);

// biome-ignore assist/source/useSortedKeys: Effect CLI reads positional arguments in declaration order.
const pull = Command.make("pull", {
  remotePath: Argument.string("remote-path"),
  destination: Argument.string("destination").pipe(Argument.optional),
}).pipe(Command.withDescription("Pull one file or directory."));

const command = Command.make("dumbridge").pipe(
  Command.withDescription(
    "Give a cloud coding agent temporary, read-only access to one local directory."
  ),
  Command.withSubcommands([serve, run, pull])
);

const runCli = Command.runWith(command, {
  version: packageJson.version,
});

if (import.meta.main) {
  pipe(
    runCli(process.argv.slice(2)),
    Effect.provide(BunServices.layer),
    BunRuntime.runMain
  );
}
