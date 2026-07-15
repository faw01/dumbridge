import {
  type BridgeKey,
  BridgeKeyExpiredError,
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
import {
  AuthenticationError,
  type BridgeRequest,
  makeRequestSession,
  type RejectCode,
} from "@dumbridge/wire";
import { Cause, Clock, Duration, Effect, Option } from "effect";
import { sendFrame, WireEventReader } from "./channel";
import {
  type BannerSender,
  type BridgeSessionError,
  handlePull,
  handleRun,
  sendReject,
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

interface SessionContext {
  readonly deadlines: BridgeServerDeadlines;
  readonly key: MintedKey;
  readonly root: ServedRoot;
  /** Sends the sanitized root display once per bridge process. */
  readonly sendBanner: BannerSender;
  readonly shell: SafeShell;
}

// Only pre-response failures may carry a reject code, so a reject frame can
// never trail a partially written response. Both codes are disclosed solely
// to callers the bridge has already tried to authenticate.
const rejectCodeFor = (error: unknown): RejectCode | undefined => {
  if (error instanceof AuthenticationError) {
    return "invalid-key";
  }
  if (error instanceof BridgeKeyExpiredError) {
    return "expired-key";
  }
};

const handleSession = (session: BridgeSession, context: SessionContext) =>
  withSessionDeadline(
    "request",
    context.deadlines.request,
    readRequest(session, context.key.capability)
  ).pipe(
    // Expiry is checked after authentication so an expired key never reaches
    // the shell or a pull, while unauthenticated callers learn nothing.
    Effect.tap(() => ensureKeyNotExpired(context.key)),
    Effect.flatMap(
      (request): Effect.Effect<void, RequestHandlerError> =>
        request.type === "run"
          ? withSessionDeadline(
              "run",
              context.deadlines.run,
              handleRun(
                session,
                context.shell,
                request.script,
                context.sendBanner
              )
            )
          : withSessionDeadline(
              "pull",
              context.deadlines.pull,
              handlePull(session, context.root, request.remotePath)
            )
    ),
    Effect.catch((error) => {
      const code = rejectCodeFor(error);
      return code === undefined
        ? Effect.fail(error)
        : sendReject(session, code).pipe(
            Effect.flatMap(() => Effect.fail(error))
          );
    })
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
  context: SessionContext
): Effect.Effect<never, BridgeListenerClosedError> => {
  const nextBackoffMillis = (failures: number) =>
    Math.min(maximumAcceptBackoffMillis, 10 * 2 ** Math.min(failures, 7));

  const loop = (
    consecutiveFailures: number
  ): Effect.Effect<never, BridgeListenerClosedError> =>
    Effect.scoped(
      listener.accept.pipe(
        Effect.flatMap((session) =>
          handleSession(session, context).pipe(
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
  context: SessionContext,
  concurrency: number
): Effect.Effect<never, BridgeListenerClosedError> =>
  Effect.forEach(
    Array.from({ length: concurrency }),
    () => serveLoop(listener, context),
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

      // The first run response against this bridge process carries the
      // sanitized root display so the agent learns which root it is
      // exploring. A failed send restores the slot for a later run, so a
      // session whose response never reached a client cannot spend it.
      let pendingBanner: string | undefined = root.displayName;
      const sendBanner: BannerSender = (session) =>
        Effect.suspend(() => {
          const served = pendingBanner;
          if (served === undefined) {
            return Effect.void;
          }
          pendingBanner = undefined;
          return sendFrame(session, { served, type: "banner" }).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                pendingBanner ??= served;
              })
            )
          );
        });

      return {
        expiresAt: key.expiresAt,
        link,
        serve: serveConcurrently(
          listener,
          {
            deadlines: {
              ...defaultDeadlines,
              ...options.deadlines,
            },
            key,
            root,
            sendBanner,
            shell,
          },
          normalizeConcurrentSessions(options.maxConcurrentSessions)
        ),
      } satisfies BridgeServer;
    })
);
