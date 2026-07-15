import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeBridgeKey,
  mintCapability,
  parseBridgeKey,
} from "@dumbridge/bridge-key";
import {
  BridgeAcceptError,
  BridgeConnectError,
  BridgeDeadlineExceededError,
  BridgeFinishError,
  type BridgeListener,
  BridgeListenerClosedError,
  BridgeLocator,
  BridgeLocatorInvalidError,
  BridgeProxyConfigurationError,
  type BridgeSession,
  type BridgeTransport,
} from "@dumbridge/bridge-transport";
import {
  encodeFrame,
  makePullResponseSession,
  makeRunResponseSession,
  type PullResponseEvent,
  type RunResponseEvent,
  type WireFrame,
} from "@dumbridge/wire";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "@effect/vitest";
import {
  Duration,
  Effect,
  Fiber,
  Logger,
  type LogLevel,
  Option,
  Result,
} from "effect";
import { TestClock } from "effect/testing";
import { Bash } from "just-bash";
import { pullRemote, runRemote } from "../../src/bridge/client";
import { openBridge } from "../../src/bridge/server";

let fixture = "";

const farFutureExpiry = Number.MAX_SAFE_INTEGER;

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "dumbridge-supervision-"));
  await writeFile(join(fixture, "note.txt"), "live\n");
});

afterEach(async () => {
  await rm(fixture, { force: true, recursive: true });
});

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};

const encoded = (frame: WireFrame) => success(encodeFrame(frame));

const joinChunks = (...chunks: readonly Uint8Array[]) => {
  const joined = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

const scriptedSession = (options: {
  readonly onWrite?: (index: number, bytes: Uint8Array) => Effect.Effect<void>;
  readonly readDelay?: Duration.Input;
  readonly reads?: readonly Uint8Array[];
}) => {
  const state = {
    closeCalls: 0,
    finishCalls: 0,
    readCalls: 0,
    writes: [] as Uint8Array[],
  };
  const reads = options.reads ?? [];
  const session: BridgeSession = {
    close: Effect.sync(() => {
      state.closeCalls += 1;
    }),
    finish: Effect.sync(() => {
      state.finishCalls += 1;
    }),
    read: Effect.suspend(() => {
      const chunk = reads[state.readCalls];
      state.readCalls += 1;
      const result = Effect.succeed(
        chunk === undefined ? Option.none<Uint8Array>() : Option.some(chunk)
      );
      return options.readDelay === undefined
        ? result
        : Effect.sleep(options.readDelay).pipe(Effect.flatMap(() => result));
    }),
    write: (bytes) => {
      const copy = Uint8Array.from(bytes);
      const index = state.writes.length;
      state.writes.push(copy);
      return options.onWrite?.(index, copy) ?? Effect.void;
    },
  };
  return { session, state };
};

const listenerTransport = (listener: BridgeListener): BridgeTransport => ({
  connect: () => Effect.die("client connection is not used in this test"),
  listen: Effect.succeed(listener),
});

const clientTransport = (session: BridgeSession): BridgeTransport => ({
  connect: () => Effect.succeed(session),
  listen: Effect.die("listener is not used in this test"),
});

const listenerFrom = (accepts: BridgeListener["accept"][]): BridgeListener => {
  let index = 0;
  return {
    accept: Effect.suspend(() => {
      const accepted = accepts[index];
      index += 1;
      return (
        accepted ??
        Effect.fail(
          new BridgeListenerClosedError({ message: "listener closed" })
        )
      );
    }),
    locator: BridgeLocator.fromString("test-listener"),
  };
};

const requestFor = (link: string, request: WireFrame) => {
  const decoded = success(parseBridgeKey(link));
  return joinChunks(
    encoded({ capability: decoded.capability, type: "auth" }),
    encoded(request)
  );
};

const decodeRunEvents = (writes: readonly Uint8Array[]) => {
  const decoder = success(makeRunResponseSession());
  const events: RunResponseEvent[] = [];
  for (const write of writes) {
    events.push(...success(decoder.push(write)));
  }
  success(decoder.finish());
  return events;
};

describe("bridge application supervision", () => {
  it.effect("accepts another session while one handshake is stalled", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let acceptedSession: BridgeSession | undefined;
      const listener: BridgeListener = {
        accept: Effect.suspend(() => {
          attempts += 1;
          if (attempts === 1) {
            return Effect.never;
          }
          if (attempts === 2) {
            return acceptedSession === undefined
              ? Effect.die("healthy session was not prepared")
              : Effect.succeed(acceptedSession);
          }
          return Effect.fail(
            new BridgeListenerClosedError({ message: "listener closed" })
          );
        }),
        locator: BridgeLocator.fromString("concurrent-listener"),
      };
      const server = yield* Effect.scoped(
        openBridge({
          maxConcurrentSessions: 2,
          root: fixture,
          transport: listenerTransport(listener),
        })
      );
      const request = requestFor(server.link, {
        script: "cat note.txt",
        type: "run",
      });
      const healthy = scriptedSession({ reads: [request] });
      acceptedSession = healthy.session;

      const end = yield* Effect.scoped(server.serve.pipe(Effect.flip));

      expect(end).toBeInstanceOf(BridgeListenerClosedError);
      expect(attempts).toBe(3);
      expect(healthy.state.closeCalls).toBe(1);
      expect(decodeRunEvents(healthy.state.writes)).toContainEqual({
        payload: new TextEncoder().encode("live\n"),
        type: "stdout",
      });
    })
  );

  it.effect(
    "backs off persistent accept failures and resets after an accepted session",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        const accepted = scriptedSession({});
        const accepts: BridgeListener["accept"][] = [
          Effect.fail(new BridgeAcceptError({ message: "first failure" })),
          Effect.fail(new BridgeAcceptError({ message: "second failure" })),
          Effect.succeed(accepted.session),
          Effect.fail(
            new BridgeAcceptError({ message: "failure after success" })
          ),
          Effect.fail(new BridgeListenerClosedError({ message: "closed" })),
        ];
        const listener: BridgeListener = {
          accept: Effect.suspend(() => {
            const next = accepts[attempts];
            attempts += 1;
            return (
              next ??
              Effect.fail(new BridgeListenerClosedError({ message: "closed" }))
            );
          }),
          locator: BridgeLocator.fromString("backoff-listener"),
        };

        const end = yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* openBridge({
              maxConcurrentSessions: 1,
              root: fixture,
              transport: listenerTransport(listener),
            });
            const fiber = yield* server.serve.pipe(Effect.forkChild);

            yield* Effect.yieldNow;
            expect(attempts).toBe(1);
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            expect(attempts).toBe(1);

            yield* TestClock.adjust("9 millis");
            expect(attempts).toBe(1);
            yield* TestClock.adjust("1 millis");
            expect(attempts).toBe(2);

            yield* TestClock.adjust("19 millis");
            expect(attempts).toBe(2);
            yield* TestClock.adjust("1 millis");
            expect(attempts).toBe(4);
            expect(accepted.state.closeCalls).toBe(1);

            yield* TestClock.adjust("9 millis");
            expect(attempts).toBe(4);
            yield* TestClock.adjust("1 millis");
            return yield* Fiber.join(fiber).pipe(Effect.flip);
          })
        ).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })));

        expect(end).toBeInstanceOf(BridgeListenerClosedError);
        expect(attempts).toBe(5);
        expect(accepted.state.closeCalls).toBe(1);
      })
  );

  it.effect("recovers from transient accepts and a slow-drip request", () =>
    Effect.gen(function* () {
      const accepts: BridgeListener["accept"][] = [];
      const listener = listenerFrom(accepts);
      const server = yield* Effect.scoped(
        openBridge({
          deadlines: { request: "20 millis" },
          maxConcurrentSessions: 1,
          root: fixture,
          transport: listenerTransport(listener),
        })
      );

      const request = requestFor(server.link, {
        script: "cat note.txt",
        type: "run",
      });
      const slow = scriptedSession({
        readDelay: "5 millis",
        reads: Array.from(request, (byte) => Uint8Array.of(byte)),
      });
      const healthy = scriptedSession({ reads: [request] });
      accepts.push(
        Effect.fail(new BridgeAcceptError({ message: "handshake failed" })),
        Effect.fail(
          new BridgeDeadlineExceededError({
            message: "accept deadline exceeded",
            operation: "accept",
          })
        ),
        Effect.succeed(slow.session),
        Effect.succeed(healthy.session),
        Effect.fail(
          new BridgeListenerClosedError({ message: "listener closed" })
        )
      );

      const end = yield* Effect.gen(function* () {
        const fiber = yield* Effect.scoped(server.serve.pipe(Effect.flip)).pipe(
          Effect.forkChild
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("100 millis");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })));

      expect(end).toBeInstanceOf(BridgeListenerClosedError);
      expect(slow.state.closeCalls).toBe(1);
      expect(healthy.state.closeCalls).toBe(1);
      const events = decodeRunEvents(healthy.state.writes);
      expect(events).toContainEqual({
        payload: new TextEncoder().encode("live\n"),
        type: "stdout",
      });
      expect(events.at(-1)).toMatchObject({ code: 0, type: "exit" });
    })
  );

  it.effect("terminates without a response when the served root changes", () =>
    Effect.gen(function* () {
      const accepts: BridgeListener["accept"][] = [];
      const listener = listenerFrom(accepts);
      const server = yield* Effect.scoped(
        openBridge({
          maxConcurrentSessions: 1,
          root: fixture,
          transport: listenerTransport(listener),
        })
      );
      const request = requestFor(server.link, {
        script: "cat note.txt",
        type: "run",
      });
      const changedRootSession = scriptedSession({ reads: [request] });
      accepts.push(
        Effect.succeed(changedRootSession.session),
        Effect.fail(
          new BridgeListenerClosedError({ message: "listener closed" })
        )
      );
      const logEntries: {
        readonly logLevel: LogLevel.LogLevel;
        readonly message: unknown;
      }[] = [];
      const capturingLogger = Logger.make((options) => {
        logEntries.push({
          logLevel: options.logLevel,
          message: options.message,
        });
      });
      const originalRoot = `${fixture}-original`;

      yield* Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await rename(fixture, originalRoot);
          await mkdir(fixture);
          await writeFile(join(fixture, "note.txt"), "replacement secret\n");
        });

        const end = yield* Effect.scoped(server.serve.pipe(Effect.flip)).pipe(
          Effect.provide(Logger.layer([capturingLogger]))
        );

        expect(end).toBeInstanceOf(BridgeListenerClosedError);
        expect(changedRootSession.state.writes).toHaveLength(0);
        expect(changedRootSession.state.finishCalls).toBe(0);
        expect(changedRootSession.state.closeCalls).toBe(1);
        const warnings = logEntries.filter(
          (entry) => entry.logLevel === "Warn"
        );
        expect(warnings).toHaveLength(1);
        const logged = JSON.stringify(logEntries);
        expect(logged).toContain("ServedRootChangedError");
        expect(logged).not.toContain(fixture);
        expect(logged).not.toContain("replacement secret");
        expect(logged).not.toContain(server.link);
      }).pipe(
        Effect.ensuring(
          Effect.promise(() =>
            rm(originalRoot, { force: true, recursive: true })
          )
        )
      );
    })
  );

  it.effect(
    "answers a run exceeding its time budget with a branded failure",
    () =>
      Effect.gen(function* () {
        const executionStarted = Promise.withResolvers<void>();
        let executionWasAborted = false;
        const execute = vi.spyOn(Bash.prototype, "exec");
        execute.mockImplementation((_script, options) => {
          executionStarted.resolve();
          return new Promise<never>((_resolve, reject) => {
            const signal = options?.signal;
            const abort = () => {
              executionWasAborted = true;
              reject(signal?.reason ?? new Error("execution aborted"));
            };
            if (signal?.aborted) {
              abort();
              return;
            }
            signal?.addEventListener("abort", abort, { once: true });
          });
        });

        const end = yield* Effect.scoped(
          Effect.gen(function* () {
            const accepts: BridgeListener["accept"][] = [];
            const listener = listenerFrom(accepts);
            const server = yield* openBridge({
              deadlines: { run: "40 seconds" },
              maxConcurrentSessions: 1,
              root: fixture,
              transport: listenerTransport(listener),
            });
            const request = requestFor(server.link, {
              script: "cat note.txt",
              type: "run",
            });
            const stalled = scriptedSession({ reads: [request] });
            accepts.push(
              Effect.succeed(stalled.session),
              Effect.fail(
                new BridgeListenerClosedError({ message: "listener closed" })
              )
            );
            const fiber = yield* server.serve.pipe(
              Effect.flip,
              Effect.forkChild
            );

            yield* Effect.promise(() => executionStarted.promise);
            yield* TestClock.adjust("31 seconds");
            expect(stalled.state.writes).toHaveLength(0);
            expect(stalled.state.finishCalls).toBe(0);
            expect(stalled.state.closeCalls).toBe(0);
            expect(executionWasAborted).toBe(false);

            yield* TestClock.adjust("9 seconds");
            const result = yield* Fiber.join(fiber);
            expect(executionWasAborted).toBe(true);
            const events = decodeRunEvents(stalled.state.writes);
            const stderrText = new TextDecoder().decode(
              joinChunks(
                ...events.flatMap((event) =>
                  event.type === "stderr" ? [event.payload] : []
                )
              )
            );
            expect(stderrText).toBe(
              "dumbridge: remote read shell time budget of 40s exceeded; narrow the query to fewer files or a subdirectory\n"
            );
            expect(events.at(-1)).toMatchObject({
              code: 1,
              truncated: true,
              type: "exit",
            });
            expect(stalled.state.finishCalls).toBe(1);
            expect(stalled.state.closeCalls).toBe(1);
            return result;
          })
        ).pipe(
          Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })),
          Effect.ensuring(
            Effect.sync(() => {
              execute.mockRestore();
            })
          )
        );

        expect(end).toBeInstanceOf(BridgeListenerClosedError);
      })
  );

  it.effect(
    "interrupts and closes a pull that exceeds its total deadline",
    () =>
      Effect.gen(function* () {
        const accepts: BridgeListener["accept"][] = [];
        const listener = listenerFrom(accepts);
        const server = yield* Effect.scoped(
          openBridge({
            deadlines: { pull: "25 millis" },
            maxConcurrentSessions: 1,
            root: fixture,
            transport: listenerTransport(listener),
          })
        );
        let writeWasInterrupted = false;
        const stalledWriteStarted = Promise.withResolvers<void>();
        const request = requestFor(server.link, {
          remotePath: "note.txt",
          type: "pull",
        });
        const stalled = scriptedSession({
          onWrite: (index) =>
            index === 2
              ? Effect.suspend(() => {
                  stalledWriteStarted.resolve();
                  return Effect.never;
                }).pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      writeWasInterrupted = true;
                    })
                  )
                )
              : Effect.void,
          reads: [request],
        });
        accepts.push(
          Effect.succeed(stalled.session),
          Effect.fail(
            new BridgeListenerClosedError({ message: "listener closed" })
          )
        );

        const end = yield* Effect.gen(function* () {
          const fiber = yield* Effect.scoped(
            server.serve.pipe(Effect.flip)
          ).pipe(Effect.forkChild);
          yield* Effect.promise(() => stalledWriteStarted.promise);
          yield* TestClock.adjust("25 millis");
          return yield* Fiber.join(fiber);
        }).pipe(
          Effect.provide(TestClock.layer({ warningDelay: "10 seconds" }))
        );

        expect(end).toBeInstanceOf(BridgeListenerClosedError);
        expect(stalled.state.writes).toHaveLength(3);
        expect(stalled.state.finishCalls).toBe(0);
        expect(stalled.state.closeCalls).toBe(1);
        expect(writeWasInterrupted).toBe(true);
      })
  );

  it.effect(
    "returns a sanitized typed failure for an unavailable remote path",
    () =>
      Effect.gen(function* () {
        const accepts: BridgeListener["accept"][] = [];
        const listener = listenerFrom(accepts);
        const server = yield* Effect.scoped(
          openBridge({
            maxConcurrentSessions: 1,
            root: fixture,
            transport: listenerTransport(listener),
          })
        );
        const request = requestFor(server.link, {
          remotePath: "missing.txt",
          type: "pull",
        });
        const serverSession = scriptedSession({ reads: [request] });
        accepts.push(
          Effect.succeed(serverSession.session),
          Effect.fail(
            new BridgeListenerClosedError({ message: "listener closed" })
          )
        );

        yield* Effect.scoped(server.serve.pipe(Effect.flip));

        const decoder = success(makePullResponseSession());
        const events: PullResponseEvent[] = [];
        for (const write of serverSession.state.writes) {
          events.push(...success(decoder.push(write)));
        }
        success(decoder.finish());
        expect(events).toEqual([{ code: "not-found", type: "pull-error" }]);
        expect(
          new TextDecoder().decode(joinChunks(...serverSession.state.writes))
        ).not.toContain(fixture);

        const clientSession = scriptedSession({
          reads: serverSession.state.writes,
        });
        const error = yield* pullRemote({
          destination: join(fixture, "destination"),
          link: server.link,
          remotePath: "missing.txt",
          transport: clientTransport(clientSession.session),
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "PullNotFoundError",
          path: "missing.txt",
        });
        expect(clientSession.state.closeCalls).toBe(1);
      })
  );

  it.effect(
    "returns a limit before an oversized pull manifest",
    () =>
      Effect.gen(function* () {
        const wide = join(fixture, "wide");
        yield* Effect.promise(() => mkdir(wide));
        const fileCount = 4096;
        const batchSize = 128;
        yield* Effect.promise(async () => {
          for (let start = 0; start < fileCount; start += batchSize) {
            const end = Math.min(start + batchSize, fileCount);
            // biome-ignore lint/performance/noAwaitInLoops: Batches avoid exhausting file descriptors.
            await Promise.all(
              Array.from({ length: end - start }, (_, offset) => {
                const index = String(start + offset).padStart(4, "0");
                const name = `${index}-${"x".repeat(145)}`;
                return writeFile(join(wide, name), "");
              })
            );
          }
        });

        const accepts: BridgeListener["accept"][] = [];
        const listener = listenerFrom(accepts);
        const server = yield* Effect.scoped(
          openBridge({
            maxConcurrentSessions: 1,
            root: fixture,
            transport: listenerTransport(listener),
          })
        );
        const request = requestFor(server.link, {
          remotePath: "wide",
          type: "pull",
        });
        const serverSession = scriptedSession({ reads: [request] });
        accepts.push(
          Effect.succeed(serverSession.session),
          Effect.fail(
            new BridgeListenerClosedError({ message: "listener closed" })
          )
        );

        yield* Effect.scoped(server.serve.pipe(Effect.flip));

        const decoder = success(makePullResponseSession());
        const events: PullResponseEvent[] = [];
        for (const write of serverSession.state.writes) {
          events.push(...success(decoder.push(write)));
        }
        success(decoder.finish());
        expect(events).toEqual([{ code: "limit", type: "pull-error" }]);
        expect(serverSession.state.writes).toHaveLength(1);
        expect(serverSession.state.finishCalls).toBe(1);
        expect(serverSession.state.closeCalls).toBe(1);
      }),
    30_000
  );

  it.effect("rejects an invalid remote path before opening a session", () =>
    Effect.gen(function* () {
      let connectCalls = 0;
      const capability = mintCapability();
      const link = success(
        encodeBridgeKey({
          capability,
          expiresAt: farFutureExpiry,
          locator: "unused-client",
          transport: "iroh",
        })
      );
      const transport: BridgeTransport = {
        connect: () => {
          connectCalls += 1;
          return Effect.die("invalid paths must not connect");
        },
        listen: Effect.die("listener is not used in this test"),
      };

      const error = yield* pullRemote({
        link,
        remotePath: "../secret",
        transport,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "PullPathError",
        path: "../secret",
      });
      expect(connectCalls).toBe(0);
    })
  );

  it.effect(
    "represents a sanitized remote limit without fabricated measurements",
    () =>
      Effect.gen(function* () {
        const capability = mintCapability();
        const link = success(
          encodeBridgeKey({
            capability,
            expiresAt: farFutureExpiry,
            locator: "limited-client",
            transport: "iroh",
          })
        );
        const limited = scriptedSession({
          reads: [encoded({ code: "limit", type: "pull-error" })],
        });

        const error = yield* pullRemote({
          destination: join(fixture, "limited"),
          link,
          remotePath: "large.bin",
          transport: clientTransport(limited.session),
        }).pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "PullRemoteLimitError",
          path: "large.bin",
        });
        expect(error).not.toHaveProperty("maximum");
        expect(error).not.toHaveProperty("observed");
        expect(limited.state.closeCalls).toBe(1);
      })
  );

  it.effect(
    "bounds a client response even when every read makes progress",
    () =>
      Effect.gen(function* () {
        const capability = mintCapability();
        const link = success(
          encodeBridgeKey({
            capability,
            expiresAt: farFutureExpiry,
            locator: "test-client",
            transport: "iroh",
          })
        );
        const response = joinChunks(
          encoded({
            payload: new TextEncoder().encode("live\n"),
            type: "stdout",
          }),
          encoded({ code: 0, truncated: false, type: "exit" })
        );
        const slow = scriptedSession({
          readDelay: "5 millis",
          reads: Array.from(response, (byte) => Uint8Array.of(byte)),
        });

        const error = yield* Effect.gen(function* () {
          const fiber = yield* runRemote({
            deadline: "25 millis",
            link,
            script: "cat note.txt",
            transport: clientTransport(slow.session),
          }).pipe(Effect.flip, Effect.forkChild);
          yield* Effect.yieldNow;
          yield* TestClock.adjust("25 millis");
          return yield* Fiber.join(fiber);
        }).pipe(
          Effect.provide(TestClock.layer({ warningDelay: "10 seconds" }))
        );

        expect(error).toMatchObject({
          _tag: "BridgeClientError",
          message: "The bridge run response deadline was exceeded.",
          operation: "run-response",
        });
        expect(slow.state.readCalls).toBeGreaterThan(1);
        expect(slow.state.closeCalls).toBe(1);
      })
  );

  it.live("retries one connection failure before sending the request", () =>
    Effect.gen(function* () {
      const capability = mintCapability();
      const link = success(
        encodeBridgeKey({
          capability,
          expiresAt: farFutureExpiry,
          locator: "retry-client",
          transport: "iroh",
        })
      );
      const response = joinChunks(
        encoded({
          payload: new TextEncoder().encode("live\n"),
          type: "stdout",
        }),
        encoded({ code: 0, truncated: false, type: "exit" })
      );
      const connected = scriptedSession({ reads: [response] });
      let connectCalls = 0;
      const transport: BridgeTransport = {
        connect: () => {
          connectCalls += 1;
          return connectCalls === 1
            ? Effect.fail(
                new BridgeConnectError({
                  message: "transient handshake failure",
                })
              )
            : Effect.succeed(connected.session);
        },
        listen: Effect.die("listener is not used in this test"),
      };

      const result = yield* runRemote({
        link,
        script: "cat note.txt",
        transport,
      });

      expect(result.stdout).toBe("live\n");
      expect(connectCalls).toBe(2);
      expect(connected.state.finishCalls).toBe(1);
      expect(connected.state.closeCalls).toBe(1);
    })
  );

  it.effect("does not retry deterministic connect failures", () =>
    Effect.gen(function* () {
      const capability = mintCapability();
      const link = success(
        encodeBridgeKey({
          capability,
          expiresAt: farFutureExpiry,
          locator: "deterministic-client",
          transport: "iroh",
        })
      );
      const deterministicFailures = [
        new BridgeLocatorInvalidError({
          message: "The bridge transport locator is invalid.",
        }),
        new BridgeProxyConfigurationError({
          message: "The bridge proxy configuration is invalid.",
          requested: "environment",
        }),
      ] as const;

      yield* Effect.forEach(deterministicFailures, (failure) => {
        let connectCalls = 0;
        const transport: BridgeTransport = {
          connect: () => {
            connectCalls += 1;
            return Effect.fail(failure);
          },
          listen: Effect.die("listener is not used in this test"),
        };

        return runRemote({ link, script: "cat note.txt", transport }).pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error).toBe(failure);
              expect(connectCalls).toBe(1);
            })
          )
        );
      });
    })
  );

  it.live("surfaces the transient cause after exhausting connect retries", () =>
    Effect.gen(function* () {
      const capability = mintCapability();
      const link = success(
        encodeBridgeKey({
          capability,
          expiresAt: farFutureExpiry,
          locator: "exhausted-client",
          transport: "iroh",
        })
      );
      let connectCalls = 0;
      const transport: BridgeTransport = {
        connect: () => {
          connectCalls += 1;
          return Effect.fail(
            new BridgeConnectError({ message: "persistent handshake failure" })
          );
        },
        listen: Effect.die("listener is not used in this test"),
      };

      const error = yield* runRemote({
        link,
        script: "cat note.txt",
        transport,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "BridgeClientError",
        message:
          "The bridge process is unreachable. Check that dumbridge serve is still running on the local machine.",
        operation: "connect",
      });
      expect(error.cause).toBeInstanceOf(BridgeConnectError);
      expect(connectCalls).toBe(2);
    })
  );

  it.effect("mints keys with the default eight hour expiry deadline", () =>
    Effect.gen(function* () {
      const server = yield* Effect.scoped(
        openBridge({
          root: fixture,
          transport: listenerTransport(listenerFrom([])),
        })
      ).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })));

      expect(server.expiresAt).toBe(Duration.toMillis("8 hours"));
      expect(success(parseBridgeKey(server.link)).expiresAt).toBe(
        server.expiresAt
      );
    })
  );

  it.effect(
    "rejects a valid capability once the key expiry deadline passes",
    () =>
      Effect.gen(function* () {
        const end = yield* Effect.scoped(
          Effect.gen(function* () {
            const accepts: BridgeListener["accept"][] = [];
            const listener = listenerFrom(accepts);
            const server = yield* openBridge({
              maxConcurrentSessions: 1,
              root: fixture,
              transport: listenerTransport(listener),
              ttl: "1 hour",
            });
            expect(server.expiresAt).toBe(Duration.toMillis("1 hour"));

            const request = requestFor(server.link, {
              script: "cat note.txt",
              type: "run",
            });
            const expired = scriptedSession({ reads: [request] });
            accepts.push(
              Effect.succeed(expired.session),
              Effect.fail(
                new BridgeListenerClosedError({ message: "listener closed" })
              )
            );

            yield* TestClock.adjust("1 hour");
            const result = yield* server.serve.pipe(Effect.flip);
            expect(decodeRunEvents(expired.state.writes)).toEqual([
              { code: "expired-key", type: "reject" },
            ]);
            expect(expired.state.finishCalls).toBe(1);
            expect(expired.state.closeCalls).toBe(1);
            return result;
          })
        ).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })));

        expect(end).toBeInstanceOf(BridgeListenerClosedError);
      })
  );

  it.effect(
    "rejects a request that finishes arriving after the key deadline",
    () =>
      Effect.gen(function* () {
        const end = yield* Effect.scoped(
          Effect.gen(function* () {
            const accepts: BridgeListener["accept"][] = [];
            const listener = listenerFrom(accepts);
            const server = yield* openBridge({
              deadlines: { request: "5 hours" },
              maxConcurrentSessions: 1,
              root: fixture,
              transport: listenerTransport(listener),
              ttl: "1 hour",
            });

            const request = requestFor(server.link, {
              script: "cat note.txt",
              type: "run",
            });
            const lateArrival = scriptedSession({
              readDelay: "2 hours",
              reads: [request],
            });
            accepts.push(
              Effect.succeed(lateArrival.session),
              Effect.fail(
                new BridgeListenerClosedError({ message: "listener closed" })
              )
            );

            const fiber = yield* server.serve.pipe(
              Effect.flip,
              Effect.forkChild
            );
            yield* TestClock.adjust("4 hours");
            const result = yield* Fiber.join(fiber);
            expect(decodeRunEvents(lateArrival.state.writes)).toEqual([
              { code: "expired-key", type: "reject" },
            ]);
            expect(lateArrival.state.finishCalls).toBe(1);
            expect(lateArrival.state.closeCalls).toBe(1);
            return result;
          })
        ).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })));

        expect(end).toBeInstanceOf(BridgeListenerClosedError);
      })
  );

  it.effect("does not retry after request transmission starts", () =>
    Effect.gen(function* () {
      const capability = mintCapability();
      const link = success(
        encodeBridgeKey({
          capability,
          expiresAt: farFutureExpiry,
          locator: "request-failure-client",
          transport: "iroh",
        })
      );
      const started = scriptedSession({});
      const session: BridgeSession = {
        ...started.session,
        finish: Effect.fail(
          new BridgeFinishError({ message: "forced request finish failure" })
        ),
      };
      let connectCalls = 0;
      const transport: BridgeTransport = {
        connect: () => {
          connectCalls += 1;
          return Effect.succeed(session);
        },
        listen: Effect.die("listener is not used in this test"),
      };

      const error = yield* runRemote({
        link,
        script: "cat note.txt",
        transport,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "BridgeClientError",
        operation: "request",
      });
      expect(error.cause).toBeInstanceOf(BridgeFinishError);
      expect(connectCalls).toBe(1);
      expect(started.state.writes).toHaveLength(2);
      expect(started.state.closeCalls).toBe(1);
    })
  );

  it.effect("keeps the bridge key out of a remapped invalid-key error", () =>
    Effect.gen(function* () {
      const rejectedPayload = "bm90LXJlYWxseS1hLWJyaWRnZS1rZXk";
      const transport: BridgeTransport = {
        connect: () => Effect.die("invalid keys must not connect"),
        listen: Effect.die("listener is not used in this test"),
      };

      const error = yield* runRemote({
        link: `dumbridge1_${rejectedPayload}`,
        script: "cat note.txt",
        transport,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "BridgeClientError",
        message: "The bridge key is invalid.",
        operation: "bridge-key",
      });
      expect(error.cause).toMatchObject({ _tag: "InvalidBridgeKeyError" });
      expect(JSON.stringify(error)).not.toContain(rejectedPayload);
    })
  );
});
