#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { redactBridgeKey } from "@dumbridge/bridge-key";
import {
  type IrohTransportOptions,
  makeIrohTransport,
} from "@dumbridge/bridge-transport/iroh";
import type { PullErrorTag } from "@dumbridge/pull-transfer";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
  Config,
  Duration,
  Effect,
  Option,
  pipe,
  Redacted,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import skillGuide from "../../../skills/dumbridge/SKILL.md" with {
  type: "text",
};
import packageJson from "../package.json" with { type: "json" };
import { pullRemote, runRemote } from "./bridge/client";
import {
  detachServe,
  hostServeProcessControl,
  stopDetachedServe,
} from "./bridge/detached-serve";
import { openBridge } from "./bridge/server";
import { resolveBridgeKey } from "./key-source";

export class CliError extends Schema.TaggedErrorClass<CliError>()("CliError", {
  message: Schema.String,
}) {}

const keyFileFlag = Flag.string("key-file").pipe(
  Flag.optional,
  Flag.withDescription(
    "Read the bridge key from this file instead of DUMBRIDGE_KEY; pass '-' to read it from stdin."
  )
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

const parseServeTtl = (value: string) => {
  const duration = Duration.fromInput(value as Duration.Input);
  return Option.isSome(duration) &&
    Duration.isFinite(duration.value) &&
    Duration.isPositive(duration.value)
    ? Effect.succeed(duration.value)
    : Effect.fail(
        new CliError({
          message:
            "The --ttl value is invalid. Use a duration like '90 minutes' or '8 hours'.",
        })
      );
};

const stateDirectory = Config.string("DUMBRIDGE_STATE_DIR").pipe(
  Config.withDefault(join(homedir(), ".dumbridge"))
);

const keyExpiryNotice = (expiresAtIso: string) =>
  `The key expires at ${expiresAtIso}. Run serve again for a fresh key.\n`;

const serveForeground = (root: string, ttl: Duration.Duration | undefined) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* openBridge({
        root,
        transport: makeIrohTransport(),
        ...(ttl === undefined ? {} : { ttl }),
      });
      yield* write(
        process.stdout,
        `Serving the selected directory read-only until Ctrl-C.\n${keyExpiryNotice(new Date(server.expiresAt).toISOString())}DUMBRIDGE_KEY=${server.link}\n`
      );
      yield* server.serve;
    })
  );

const serveDetached = (root: string, rawTtl: string | undefined) =>
  Effect.gen(function* () {
    const startup = yield* detachServe({
      control: hostServeProcessControl,
      root,
      stateDirectory: yield* stateDirectory,
      ...(rawTtl === undefined ? {} : { ttl: rawTtl }),
    });
    yield* write(
      process.stdout,
      `Serving the selected directory read-only until dumbridge serve --stop.\n${
        startup.expiresAtIso === undefined
          ? ""
          : keyExpiryNotice(startup.expiresAtIso)
      }DUMBRIDGE_KEY=${startup.key}\n`
    );
  });

const serveStop = Effect.gen(function* () {
  const result = yield* stopDetachedServe({
    control: hostServeProcessControl,
    stateDirectory: yield* stateDirectory,
  });
  yield* write(
    process.stdout,
    result.type === "stopped"
      ? "Stopped the detached serve.\n"
      : "Removed a stale detached serve record; nothing was running.\n"
  );
});

const serve = Command.make(
  "serve",
  {
    detach: Flag.boolean("detach").pipe(
      Flag.withDescription("Start the server detached from this terminal.")
    ),
    root: Argument.string("root").pipe(Argument.optional),
    stop: Flag.boolean("stop").pipe(
      Flag.withDescription("Stop the detached server, revoking its key.")
    ),
    ttl: Flag.string("ttl").pipe(
      Flag.optional,
      Flag.withDescription(
        "How long the minted key stays valid, like '90 minutes' or '8 hours'. Defaults to 8 hours."
      )
    ),
  },
  ({ detach, root, stop, ttl }) =>
    Effect.gen(function* () {
      if (detach && stop) {
        return yield* new CliError({
          message: "Use either --detach or --stop, not both.",
        });
      }
      if (stop) {
        if (Option.isSome(root)) {
          return yield* new CliError({
            message: "serve --stop does not take a root.",
          });
        }
        if (Option.isSome(ttl)) {
          return yield* new CliError({
            message: "serve --stop does not take a --ttl.",
          });
        }
        return yield* serveStop;
      }
      if (Option.isNone(root)) {
        return yield* new CliError({
          message: "serve requires a <root> directory to share.",
        });
      }
      const keyTtl = Option.isSome(ttl)
        ? yield* parseServeTtl(ttl.value)
        : undefined;
      return yield* detach
        ? serveDetached(root.value, Option.isSome(ttl) ? ttl.value : undefined)
        : serveForeground(root.value, keyTtl);
    })
).pipe(
  Command.withDescription(
    "Run locally and copy the printed DUMBRIDGE_KEY into the cloud agent."
  )
);

const run = Command.make(
  "run",
  { keyFile: keyFileFlag, script: Argument.string("script") },
  ({ keyFile, script }) =>
    Effect.gen(function* () {
      const key = yield* resolveBridgeKey(keyFile);
      const result = yield* runRemote({
        link: Redacted.value(key),
        script,
        transport: clientTransport(),
      });
      if (result.served !== undefined) {
        yield* write(
          process.stderr,
          `dumbridge: serving '${result.served}' as /workspace (read-only)\n`
        );
      }
      yield* write(process.stdout, result.stdout);
      yield* write(process.stderr, result.stderr);
      process.exitCode = result.exitCode;
    })
).pipe(
  Command.withDescription(
    "Run in the cloud agent to query the local served root. The bridge key comes from --key-file when given ('-' reads stdin), otherwise from DUMBRIDGE_KEY."
  )
);

const pull = Command.make(
  "pull",
  // biome-ignore assist/source/useSortedKeys: Effect CLI reads positional arguments in declaration order.
  {
    keyFile: keyFileFlag,
    remotePath: Argument.string("remote-path"),
    destination: Argument.string("destination").pipe(Argument.optional),
  },
  ({ destination, keyFile, remotePath }) =>
    Effect.gen(function* () {
      const key = yield* resolveBridgeKey(keyFile);
      const request = {
        link: Redacted.value(key),
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
    "Run in the cloud agent to pull one local path. The bridge key comes from --key-file when given ('-' reads stdin), otherwise from DUMBRIDGE_KEY."
  )
);

const skill = Command.make("skill", {}, () =>
  write(process.stdout, skillGuide)
).pipe(
  Command.withDescription(
    "Print the agent usage guide without contacting a bridge."
  )
);

const command = Command.make("dumbridge").pipe(
  Command.withDescription(
    "Run serve locally, set DUMBRIDGE_KEY in the cloud, then use run or pull."
  ),
  Command.withSubcommands([serve, run, pull, skill])
);

const runCli = Command.runWith(command, {
  version: packageJson.version,
});

const pullErrorMessages = {
  PullDestinationExistsError: "The pull destination already exists.",
  PullIntegrityError: "The pulled data failed integrity verification.",
  PullIOError: "The pull could not be completed.",
  PullLimitError: "The pull exceeded a safety limit.",
  PullNotFoundError: "The remote path does not exist.",
  PullPathError: "The pull path is invalid.",
  PullRemoteLimitError: "The remote pull exceeded a safety limit.",
  PullSourceChangedError: "The remote source changed during the pull.",
  PullSymlinkError: "Symlinks cannot be pulled.",
  ServedRootChangedError: "The served root changed during the pull.",
} satisfies Record<PullErrorTag, string>;

export const publicErrorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String(error._tag);
    if (Object.hasOwn(pullErrorMessages, tag)) {
      return pullErrorMessages[tag as PullErrorTag];
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
      return redactBridgeKey(message);
    }
  }
  return "dumbridge failed.";
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
