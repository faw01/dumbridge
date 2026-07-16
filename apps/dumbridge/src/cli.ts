#!/usr/bin/env bun

import { homedir } from "node:os";
import { join } from "node:path";
import { redactBridgeKey } from "@dumbridge/bridge-key";
import type { ConnectionPath } from "@dumbridge/bridge-transport";
import {
  type IrohTransportOptions,
  irohBindingSupportsProxy,
  makeIrohTransport,
} from "@dumbridge/bridge-transport/iroh";
import { type PullErrorTag, PullLimitError } from "@dumbridge/pull-transfer";
import {
  maximumFileBytes,
  maximumManifestEntries,
  maximumTransferBytes,
} from "@dumbridge/wire";
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
  listDetachedServes,
  type ServeReachability,
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

export interface ClientTransportResolution {
  readonly options: IrohTransportOptions;
  readonly proxyFallback: boolean;
}

// Cloud sandboxes such as Claude Code "Full Network" set a proxy variable the
// published iroh binding cannot route through. Committing to that proxy would
// fail before any network attempt, so the client degrades to the ordinary
// direct-capable dial: no proxy is requested and no reachability is forced,
// leaving the relay policy to the locator inside the bridge key — a
// direct-only key stays a direct-only attempt, a relay-carrying key keeps its
// fallback. A proxy-capable binding still commits to the proxy, because UDP
// holepunching cannot traverse an HTTP proxy.
export const resolveClientTransportOptions = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
  bindingSupportsProxy: () => boolean = irohBindingSupportsProxy
): ClientTransportResolution => {
  const usesProxy = proxyEnvironmentNames.some((name) => environment[name]);
  if (!usesProxy) {
    return { options: { proxy: { _tag: "Disabled" } }, proxyFallback: false };
  }
  return bindingSupportsProxy()
    ? {
        options: {
          proxy: { _tag: "FromEnvironment" },
          reachability: "relay-only",
        },
        proxyFallback: false,
      }
    : { options: { proxy: { _tag: "Disabled" } }, proxyFallback: true };
};

const write = (stream: NodeJS.WriteStream, value: string) =>
  Effect.sync(() => {
    stream.write(value);
  });

// Stderr only and never the proxy URL itself, which may carry credentials.
export const proxyFallbackNotice =
  "dumbridge: this environment sets a proxy, but the installed iroh binding cannot route through it; attempting a direct connection instead\n";

const clientTransport = Effect.gen(function* () {
  const resolution = resolveClientTransportOptions();
  if (resolution.proxyFallback) {
    yield* write(process.stderr, proxyFallbackNotice);
  }
  return makeIrohTransport(resolution.options);
});

// One line per invocation, stderr only: piped stdout stays exactly the
// script's or pull's own output. The line names the path selected at connect
// time; iroh may upgrade a relayed session to direct afterwards. It prints as
// soon as the session opens, so it survives requests that fail later.
const connectionPathNotices: Record<ConnectionPath, string> = {
  direct: "dumbridge: connected directly\n",
  relay: "dumbridge: connected via relay\n",
  unknown: "dumbridge: connected (path unknown)\n",
};

export const connectionPathNotice = (path: ConnectionPath) =>
  connectionPathNotices[path];

const reportConnectionPath = (path: ConnectionPath) =>
  write(process.stderr, connectionPathNotice(path));

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

const serveForeground = (
  root: string,
  ttl: Duration.Duration | undefined,
  reachability: ServeReachability | undefined
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* openBridge({
        root,
        transport: makeIrohTransport(
          reachability === undefined ? {} : { reachability }
        ),
        ...(ttl === undefined ? {} : { ttl }),
      });
      yield* write(
        process.stdout,
        `Serving the selected directory read-only until Ctrl-C.\n${keyExpiryNotice(new Date(server.expiresAt).toISOString())}DUMBRIDGE_KEY=${server.link}\n`
      );
      yield* server.serve;
    })
  );

const serveDetached = (
  root: string,
  rawTtl: string | undefined,
  reachability: ServeReachability | undefined
) =>
  Effect.gen(function* () {
    const startup = yield* detachServe({
      control: hostServeProcessControl,
      root,
      stateDirectory: yield* stateDirectory,
      ...(reachability === undefined ? {} : { reachability }),
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

// One serve per line, tab-separated so a root containing spaces still parses.
const serveStatus = Effect.gen(function* () {
  const records = yield* listDetachedServes({
    control: hostServeProcessControl,
    stateDirectory: yield* stateDirectory,
  });
  if (records.length === 0) {
    return yield* write(process.stdout, "No detached serves are running.\n");
  }
  const lines = records.map(
    (record) =>
      `${record.root}\tpid ${record.pid}\tstarted ${new Date(record.startedAtEpochMs).toISOString()}\t${
        record.expiresAtEpochMs === undefined
          ? "key expiry unknown"
          : `key expires ${new Date(record.expiresAtEpochMs).toISOString()}`
      }\n`
  );
  yield* write(process.stdout, lines.join(""));
});

const serveStop = (root: Option.Option<string>) =>
  Effect.gen(function* () {
    const result = yield* stopDetachedServe({
      control: hostServeProcessControl,
      stateDirectory: yield* stateDirectory,
      ...(Option.isSome(root) ? { root: root.value } : {}),
    });
    yield* write(
      process.stdout,
      result.type === "stopped"
        ? "Stopped the detached serve.\n"
        : "Removed a stale detached serve record; nothing was running.\n"
    );
  });

interface ServeInvocation {
  readonly detach: boolean;
  readonly directOnly: boolean;
  readonly relayOnly: boolean;
  readonly root: Option.Option<string>;
  readonly status: boolean;
  readonly stop: boolean;
  readonly ttl: Option.Option<string>;
}

const serveInvocationError = (flags: ServeInvocation): CliError | undefined => {
  if (flags.detach && flags.stop) {
    return new CliError({
      message: "Use either --detach or --stop, not both.",
    });
  }
  if (flags.status && flags.detach) {
    return new CliError({
      message: "Use either --status or --detach, not both.",
    });
  }
  if (flags.status && flags.stop) {
    return new CliError({
      message: "Use either --status or --stop, not both.",
    });
  }
  if (flags.directOnly && flags.relayOnly) {
    return new CliError({
      message: "Use either --direct-only or --relay-only, not both.",
    });
  }
  if (flags.status && Option.isSome(flags.root)) {
    return new CliError({ message: "serve --status does not take a root." });
  }
  if (!(flags.stop || flags.status)) {
    return;
  }
  const selector = flags.stop ? "--stop" : "--status";
  if (Option.isSome(flags.ttl)) {
    return new CliError({
      message: `serve ${selector} does not take a --ttl.`,
    });
  }
  if (flags.directOnly || flags.relayOnly) {
    return new CliError({
      message: `serve ${selector} does not take --direct-only or --relay-only.`,
    });
  }
};

const forcedReachability = (
  flags: ServeInvocation
): ServeReachability | undefined => {
  if (flags.directOnly) {
    return "direct-only";
  }
  if (flags.relayOnly) {
    return "relay-only";
  }
};

const serve = Command.make(
  "serve",
  {
    detach: Flag.boolean("detach").pipe(
      Flag.withDescription("Start the server detached from this terminal.")
    ),
    directOnly: Flag.boolean("direct-only").pipe(
      Flag.withDescription(
        "Mint a key with no relay fallback: sessions connect peer-to-peer or fail fast."
      )
    ),
    relayOnly: Flag.boolean("relay-only").pipe(
      Flag.withDescription(
        "Mint a key whose initial dial goes through the relay. Best effort only: an established session may still upgrade to a direct path."
      )
    ),
    root: Argument.string("root").pipe(Argument.optional),
    status: Flag.boolean("status").pipe(
      Flag.withDescription(
        "List each active detached serve with its root, pid, start time, and key expiry."
      )
    ),
    stop: Flag.boolean("stop").pipe(
      Flag.withDescription(
        "Stop a detached server, revoking its key. Pass its root when several are running."
      )
    ),
    ttl: Flag.string("ttl").pipe(
      Flag.optional,
      Flag.withDescription(
        "How long the minted key stays valid, like '90 minutes' or '8 hours'. Defaults to 8 hours."
      )
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const invalid = serveInvocationError(flags);
      if (invalid !== undefined) {
        return yield* invalid;
      }
      if (flags.status) {
        return yield* serveStatus;
      }
      if (flags.stop) {
        return yield* serveStop(flags.root);
      }
      const { root, ttl } = flags;
      if (Option.isNone(root)) {
        return yield* new CliError({
          message: "serve requires a <root> directory to share.",
        });
      }
      const keyTtl = Option.isSome(ttl)
        ? yield* parseServeTtl(ttl.value)
        : undefined;
      const reachability = forcedReachability(flags);
      return yield* flags.detach
        ? serveDetached(
            root.value,
            Option.isSome(ttl) ? ttl.value : undefined,
            reachability
          )
        : serveForeground(root.value, keyTtl, reachability);
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
      const transport = yield* clientTransport;
      const result = yield* runRemote({
        link: Redacted.value(key),
        onConnected: reportConnectionPath,
        script,
        transport,
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
    "Run in the cloud agent to query the local served root. The bridge key comes from --key-file when given ('-' reads stdin), otherwise from DUMBRIDGE_KEY. One stderr line names the connection path selected at connect time (directly or via relay); a relayed session may still upgrade to direct afterwards."
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
      const transport = yield* clientTransport;
      const request = {
        link: Redacted.value(key),
        onConnected: reportConnectionPath,
        remotePath,
        transport,
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
    "Run in the cloud agent to pull one local path. The bridge key comes from --key-file when given ('-' reads stdin), otherwise from DUMBRIDGE_KEY. One stderr line names the connection path selected at connect time (directly or via relay); a relayed session may still upgrade to direct afterwards."
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

const formatPullBytes = (bytes: number) => {
  const gibibyte = 1024 * 1024 * 1024;
  const mebibyte = 1024 * 1024;
  if (bytes >= gibibyte && bytes % gibibyte === 0) {
    return `${bytes / gibibyte} GiB`;
  }
  if (bytes >= mebibyte && bytes % mebibyte === 0) {
    return `${bytes / mebibyte} MiB`;
  }
  if (bytes >= 1024 && bytes % 1024 === 0) {
    return `${bytes / 1024} KiB`;
  }
  return `${bytes} bytes`;
};

const pullRecovery = "pull a smaller file or subdirectory";

// The bridge reports only that a limit fired, never which one or what it
// measured, so the remote message states every ceiling the protocol fixes
// for both sides instead of fabricating a measurement.
const remotePullLimitMessage = `The remote pull exceeded a safety limit: one pull may copy at most ${maximumManifestEntries} entries, ${formatPullBytes(maximumFileBytes)} per file, and ${formatPullBytes(maximumTransferBytes)} in total; ${pullRecovery}.`;

const pullLimitMessage = (error: PullLimitError) => {
  const measure = error.limit.endsWith("bytes") ? formatPullBytes : String;
  return `The pull exceeded the ${error.limit} limit: at most ${measure(error.maximum)} allowed and ${measure(error.observed)} observed; ${pullRecovery}.`;
};

const pullErrorMessages = {
  PullDestinationExistsError: "The pull destination already exists.",
  PullIntegrityError: "The pulled data failed integrity verification.",
  PullIOError: "The pull could not be completed.",
  PullLimitError: "The pull exceeded a safety limit.",
  PullNotFoundError: "The remote path does not exist.",
  PullPathError: "The pull path is invalid.",
  PullRemoteLimitError: remotePullLimitMessage,
  PullSourceChangedError: "The remote source changed during the pull.",
  PullSymlinkError: "Symlinks cannot be pulled.",
  ServedRootChangedError: "The served root changed during the pull.",
} satisfies Record<PullErrorTag, string>;

export const publicErrorMessage = (error: unknown): string => {
  if (error instanceof PullLimitError) {
    return pullLimitMessage(error);
  }
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
