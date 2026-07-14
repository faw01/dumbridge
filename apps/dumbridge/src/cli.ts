#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Option, pipe, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import packageJson from "../package.json" with { type: "json" };
import {
  type IrohTransportOptions,
  makeIrohTransport,
} from "./bridge/adapters/iroh";
import { pullRemote, runRemote } from "./bridge/client";
import { openBridge } from "./bridge/server";

export class CliError extends Schema.TaggedErrorClass<CliError>()("CliError", {
  message: Schema.String,
}) {}

const bridgeLink = Config.string("DUMBRIDGE_LINK").pipe(
  Effect.mapError(() => new CliError({ message: "DUMBRIDGE_LINK is not set." }))
);

const proxyEnvironmentNames = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
] as const;

export const resolveClientTransportOptions = (
  environment: Readonly<Record<string, string | undefined>> = process.env
): IrohTransportOptions => {
  const usesProxy = proxyEnvironmentNames.some((name) => environment[name]);
  return usesProxy
    ? {
        proxy: { _tag: "FromEnvironment" },
        reachability: "relay-only",
      }
    : { proxy: { _tag: "Disabled" } };
};

const clientTransport = () =>
  makeIrohTransport(resolveClientTransportOptions());

const write = (stream: NodeJS.WriteStream, value: string) =>
  Effect.sync(() => {
    stream.write(value);
  });

const serve = Command.make(
  "serve",
  { root: Argument.string("root") },
  ({ root }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* openBridge({
          root,
          transport: makeIrohTransport(),
        });
        yield* write(
          process.stdout,
          `Serving ${root} read-only until Ctrl-C.\nDUMBRIDGE_LINK=${server.link}\n`
        );
        yield* server.serve;
      })
    )
).pipe(
  Command.withDescription(
    "Run locally and copy the printed DUMBRIDGE_LINK into the cloud agent."
  )
);

const run = Command.make(
  "run",
  { script: Argument.string("script") },
  ({ script }) =>
    Effect.gen(function* () {
      const link = yield* bridgeLink;
      const result = yield* runRemote({
        link,
        script,
        transport: clientTransport(),
      });
      yield* write(process.stdout, result.stdout);
      yield* write(process.stderr, result.stderr);
      process.exitCode = result.exitCode;
    })
).pipe(
  Command.withDescription(
    "Run in the cloud agent using DUMBRIDGE_LINK to query the local served root."
  )
);

const pull = Command.make(
  "pull",
  // biome-ignore assist/source/useSortedKeys: Effect CLI reads positional arguments in declaration order.
  {
    remotePath: Argument.string("remote-path"),
    destination: Argument.string("destination").pipe(Argument.optional),
  },
  ({ destination, remotePath }) =>
    Effect.gen(function* () {
      const link = yield* bridgeLink;
      const request = {
        link,
        remotePath,
        transport: clientTransport(),
      };
      const result = yield* pullRemote(
        Option.isSome(destination)
          ? { ...request, destination: destination.value }
          : request
      );
      yield* write(
        process.stdout,
        `Pulled ${result.files} file${result.files === 1 ? "" : "s"} (${result.bytes} bytes) to ${result.destination}.\n`
      );
    })
).pipe(
  Command.withDescription(
    "Run in the cloud agent using DUMBRIDGE_LINK to pull one local path."
  )
);

const command = Command.make("dumbridge").pipe(
  Command.withDescription(
    "Run serve locally, set DUMBRIDGE_LINK in the cloud, then use run or pull."
  ),
  Command.withSubcommands([serve, run, pull])
);

const runCli = Command.runWith(command, {
  version: packageJson.version,
});

const pullErrorMessages: Readonly<Record<string, string>> = {
  PullDestinationExistsError: "The pull destination already exists.",
  PullIntegrityError: "The pulled data failed integrity verification.",
  PullIOError: "The pull could not be completed.",
  PullLimitError: "The pull exceeded a safety limit.",
  PullNotFoundError: "The remote path does not exist.",
  PullPathError: "The pull path is invalid.",
  PullRemoteLimitError: "The remote pull exceeded a safety limit.",
  PullSourceChangedError: "The remote source changed during the pull.",
  PullSymlinkError: "Symlinks cannot be pulled.",
};

export const publicErrorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const pullMessage = pullErrorMessages[String(error._tag)];
    if (pullMessage !== undefined) {
      return pullMessage;
    }
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const message = error.message.trim();
    if (message.length > 0) {
      return message;
    }
  }
  return "Dumbridge failed.";
};

const cliArguments = process.argv.slice(2);
const main = runCli(cliArguments.length === 0 ? ["--help"] : cliArguments).pipe(
  Effect.catch((error) =>
    write(process.stderr, `dumbridge: ${publicErrorMessage(error)}\n`).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          process.exitCode = 1;
        })
      )
    )
  )
);

if (import.meta.main) {
  pipe(main, Effect.provide(BunServices.layer), BunRuntime.runMain);
}
