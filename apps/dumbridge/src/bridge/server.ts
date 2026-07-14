import {
  type BridgeKey,
  type Capability,
  checkBridgeKeyExpiry,
  encodeBridgeKey,
  mintCapability,
} from "@dumbridge/bridge-key";
import {
  type BridgeListener,
  BridgeListenerClosedError,
  type BridgeSession,
  type BridgeTransport,
} from "@dumbridge/bridge-transport";
import { SafeShell } from "@dumbridge/safe-shell";
import { ServedRoot } from "@dumbridge/served-root";
import { type BridgeRequest, makeRequestSession } from "@dumbridge/wire";
import { Cause, Clock, Duration, Effect, Option } from "effect";
import { WireEventReader } from "./channel";
import {
  type BridgeSessionError,
  handlePull,
  handleRun,
  sessionError,
} from "./session-handlers";

const initialAcceptBackoff: Duration.Input = "10 millis";
const maximumAcceptBackoffMillis = 1000;
const defaultConcurrentSessions = 4;
const maximumConcurrentSessions = 8;

// Bounds the credential to one "human at the machine" working day; the served
// root stays private even when a long-lived bridge process outlives the key.
const defaultKeyTtl: Duration.Input = "8 hours";

// The serve process is the expiry authority: it enforces the deadline it
// recorded at mint time and never trusts a deadline presented by a client.
interface MintedKey {
  readonly capability: Capability;
  readonly expiresAt: number;
}

interface BridgeServerDeadlines {
  readonly pull: Duration.Input;
  readonly request: Duration.Input;
  readonly run: Duration.Input;
}

const defaultDeadlines: BridgeServerDeadlines = {
  pull: "2 hours",
  request: "30 seconds",
  run: "1 minute",
};

interface BridgeServer {
  readonly expiresAt: number;
  readonly link: BridgeKey;
  readonly serve: Effect.Effect<never, BridgeListenerClosedError>;
}

const readRequest = (session: BridgeSession, capability: Capability) =>
  Effect.gen(function* () {
    const decoder = yield* Effect.fromResult(makeRequestSession(capability));
    const reader = new WireEventReader(session, decoder);
    let request: BridgeRequest | undefined;
    let next = yield* reader.next();
    while (Option.isSome(next)) {
      if (request !== undefined) {
        return yield* sessionError("Bridge request contained extra frames.");
      }
      request = next.value;
      next = yield* reader.next();
    }
    if (request === undefined) {
      return yield* sessionError("Bridge request was incomplete.");
    }
    return request;
  });

const withSessionDeadline = <A, E, R>(
  operation: "pull" | "request" | "run",
  duration: Duration.Input,
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => sessionError(`Bridge ${operation} deadline exceeded.`),
    })
  );

type RequestHandlerError =
  | Effect.Error<ReturnType<typeof handlePull>>
  | Effect.Error<ReturnType<typeof handleRun>>
  | BridgeSessionError;

const ensureKeyNotExpired = (key: MintedKey) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      Effect.fromResult(checkBridgeKeyExpiry(key.expiresAt, now))
    )
  );

const handleSession = (
  session: BridgeSession,
  key: MintedKey,
  root: ServedRoot,
  shell: SafeShell,
  deadlines: BridgeServerDeadlines
) =>
  ensureKeyNotExpired(key).pipe(
    Effect.flatMap(() =>
      withSessionDeadline(
        "request",
        deadlines.request,
        readRequest(session, key.capability)
      )
    ),
    Effect.flatMap(
      (request): Effect.Effect<void, RequestHandlerError> =>
        request.type === "run"
          ? withSessionDeadline(
              "run",
              deadlines.run,
              handleRun(session, shell, request.script)
            )
          : withSessionDeadline(
              "pull",
              deadlines.pull,
              handlePull(session, root, request.remotePath)
            )
    )
  );

// Failure payloads may carry request or path details; the serve log keeps only
// the error tags so it can never leak the key or served root content.
const describeSessionFailure = (cause: Cause.Cause<unknown>): string =>
  cause.reasons
    .map((reason) => {
      if (!Cause.isFailReason(reason)) {
        return Cause.isDieReason(reason) ? "Defect" : "Interrupted";
      }
      const error: unknown = reason.error;
      return typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        typeof error._tag === "string"
        ? error._tag
        : "UnknownFailure";
    })
    .join(", ");

const serveLoop = (
  listener: BridgeListener,
  key: MintedKey,
  root: ServedRoot,
  shell: SafeShell,
  deadlines: BridgeServerDeadlines
): Effect.Effect<never, BridgeListenerClosedError> => {
  const nextBackoffMillis = (failures: number) =>
    Math.min(maximumAcceptBackoffMillis, 10 * 2 ** Math.min(failures, 7));

  const loop = (
    consecutiveFailures: number
  ): Effect.Effect<never, BridgeListenerClosedError> =>
    Effect.scoped(
      listener.accept.pipe(
        Effect.flatMap((session) =>
          handleSession(session, key, root, shell, deadlines).pipe(
            Effect.ensuring(session.close),
            Effect.tapCause((cause) =>
              Effect.logWarning(
                "bridge session failed",
                describeSessionFailure(cause)
              )
            ),
            Effect.catch(() => Effect.void)
          )
        )
      )
    ).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          error instanceof BridgeListenerClosedError
            ? Effect.fail(error)
            : Effect.sleep(
                consecutiveFailures === 0
                  ? initialAcceptBackoff
                  : `${nextBackoffMillis(consecutiveFailures)} millis`
              ).pipe(
                Effect.flatMap(() =>
                  Effect.suspend(() => loop(consecutiveFailures + 1))
                )
              ),
        onSuccess: () => Effect.suspend(() => loop(0)),
      })
    );

  return loop(0);
};

const serveConcurrently = (
  listener: BridgeListener,
  key: MintedKey,
  root: ServedRoot,
  shell: SafeShell,
  deadlines: BridgeServerDeadlines,
  concurrency: number
): Effect.Effect<never, BridgeListenerClosedError> =>
  Effect.forEach(
    Array.from({ length: concurrency }),
    () => serveLoop(listener, key, root, shell, deadlines),
    { concurrency: "unbounded", discard: true }
  ).pipe(Effect.flatMap(() => Effect.never));

const normalizeConcurrentSessions = (value: number | undefined) =>
  value === undefined || !Number.isSafeInteger(value)
    ? defaultConcurrentSessions
    : Math.max(1, Math.min(maximumConcurrentSessions, value));

export const openBridge = Effect.fn("BridgeServer.open")(
  (options: {
    readonly deadlines?: Partial<BridgeServerDeadlines>;
    readonly maxConcurrentSessions?: number;
    readonly root: string;
    readonly transport: BridgeTransport;
    readonly ttl?: Duration.Input;
  }) =>
    Effect.gen(function* () {
      const root = yield* ServedRoot.make(options.root);
      const shell = yield* SafeShell.make(root);
      const listener = yield* options.transport.listen;
      const mintedAt = yield* Clock.currentTimeMillis;
      const key: MintedKey = {
        capability: mintCapability(),
        expiresAt: mintedAt + Duration.toMillis(options.ttl ?? defaultKeyTtl),
      };
      const link = yield* Effect.fromResult(
        encodeBridgeKey({
          capability: key.capability,
          expiresAt: key.expiresAt,
          locator: listener.locator.toString(),
          transport: "iroh",
        })
      );

      return {
        expiresAt: key.expiresAt,
        link,
        serve: serveConcurrently(
          listener,
          key,
          root,
          shell,
          {
            ...defaultDeadlines,
            ...options.deadlines,
          },
          normalizeConcurrentSessions(options.maxConcurrentSessions)
        ),
      } satisfies BridgeServer;
    })
);
