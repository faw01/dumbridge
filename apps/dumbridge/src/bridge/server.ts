import {
  type BridgeLink,
  type Capability,
  encodeBridgeLink,
  mintCapability,
} from "@dumbridge/bridge-link";
import {
  type BridgeListener,
  BridgeListenerClosedError,
  type BridgeSession,
  type BridgeTransport,
} from "@dumbridge/bridge-transport";
import { SafeShell } from "@dumbridge/safe-shell";
import { ServedRoot } from "@dumbridge/served-root";
import { type BridgeRequest, makeRequestSession } from "@dumbridge/wire";
import { type Duration, Effect, Option } from "effect";
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
  readonly link: BridgeLink;
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

const handleSession = (
  session: BridgeSession,
  capability: Capability,
  root: ServedRoot,
  shell: SafeShell,
  deadlines: BridgeServerDeadlines
) =>
  withSessionDeadline(
    "request",
    deadlines.request,
    readRequest(session, capability)
  ).pipe(
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

const serveLoop = (
  listener: BridgeListener,
  capability: Capability,
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
          handleSession(session, capability, root, shell, deadlines).pipe(
            Effect.ensuring(session.close),
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
  capability: Capability,
  root: ServedRoot,
  shell: SafeShell,
  deadlines: BridgeServerDeadlines,
  concurrency: number
): Effect.Effect<never, BridgeListenerClosedError> =>
  Effect.forEach(
    Array.from({ length: concurrency }),
    () => serveLoop(listener, capability, root, shell, deadlines),
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
  }) =>
    Effect.gen(function* () {
      const root = yield* ServedRoot.make(options.root);
      const shell = yield* SafeShell.make(root);
      const listener = yield* options.transport.listen;
      const capability = mintCapability();
      const link = yield* Effect.fromResult(
        encodeBridgeLink({
          capability,
          locator: listener.locator.toString(),
          transport: "iroh",
        })
      );

      return {
        link,
        serve: serveConcurrently(
          listener,
          capability,
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
