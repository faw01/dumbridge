import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Duration, Effect, Fiber, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { Bash } from "just-bash";
import { pullRemote, runRemote } from "../../src/bridge/client";
import {
  encodeBridgeLink,
  mintCapability,
  parseBridgeLink,
} from "../../src/bridge/link";
import { openBridge } from "../../src/bridge/server";
import {
  BridgeAcceptError,
  BridgeConnectError,
  BridgeDeadlineExceededError,
  BridgeFinishError,
  type BridgeListener,
  BridgeListenerClosedError,
  BridgeLocator,
  type BridgeSession,
  type BridgeTransport,
} from "../../src/bridge/transport";
import {
  encodeFrame,
  makePullResponseSession,
  makeRunResponseSession,
  type PullResponseEvent,
  type RunResponseEvent,
  type WireFrame,
} from "../../src/bridge/wire";

let fixture = "";

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
  const decoded = success(parseBridgeLink(link));
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
  test("accepts another session while one handshake is stalled", async () => {
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
    const server = await Effect.runPromise(
      Effect.scoped(
        openBridge({
          maxConcurrentSessions: 2,
          root: fixture,
          transport: listenerTransport(listener),
        })
      )
    );
    const request = requestFor(server.link, {
      script: "cat note.txt",
      type: "run",
    });
    const healthy = scriptedSession({ reads: [request] });
    acceptedSession = healthy.session;

    const end = await Effect.runPromise(
      Effect.scoped(server.serve.pipe(Effect.flip))
    );

    expect(end).toBeInstanceOf(BridgeListenerClosedError);
    expect(attempts).toBe(3);
    expect(healthy.state.closeCalls).toBe(1);
    expect(decodeRunEvents(healthy.state.writes)).toContainEqual({
      payload: new TextEncoder().encode("live\n"),
      type: "stdout",
    });
  });

  test("backs off persistent accept failures and resets after an accepted session", async () => {
    let attempts = 0;
    const accepted = scriptedSession({});
    const accepts: BridgeListener["accept"][] = [
      Effect.fail(new BridgeAcceptError({ message: "first failure" })),
      Effect.fail(new BridgeAcceptError({ message: "second failure" })),
      Effect.succeed(accepted.session),
      Effect.fail(new BridgeAcceptError({ message: "failure after success" })),
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

    const end = await Effect.runPromise(
      Effect.scoped(
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
      ).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })))
    );

    expect(end).toBeInstanceOf(BridgeListenerClosedError);
    expect(attempts).toBe(5);
    expect(accepted.state.closeCalls).toBe(1);
  });

  test("recovers from transient accepts and a slow-drip request", async () => {
    const accepts: BridgeListener["accept"][] = [];
    const listener = listenerFrom(accepts);
    const server = await Effect.runPromise(
      Effect.scoped(
        openBridge({
          deadlines: { request: "20 millis" },
          maxConcurrentSessions: 1,
          root: fixture,
          transport: listenerTransport(listener),
        })
      )
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
      Effect.fail(new BridgeListenerClosedError({ message: "listener closed" }))
    );

    const end = await Effect.runPromise(
      Effect.scoped(server.serve.pipe(Effect.flip))
    );

    expect(end).toBeInstanceOf(BridgeListenerClosedError);
    expect(slow.state.closeCalls).toBe(1);
    expect(healthy.state.closeCalls).toBe(1);
    const events = decodeRunEvents(healthy.state.writes);
    expect(events).toContainEqual({
      payload: new TextEncoder().encode("live\n"),
      type: "stdout",
    });
    expect(events.at(-1)).toMatchObject({ code: 0, type: "exit" });
  });

  test("terminates without a response when the served root changes", async () => {
    const accepts: BridgeListener["accept"][] = [];
    const listener = listenerFrom(accepts);
    const server = await Effect.runPromise(
      Effect.scoped(
        openBridge({
          maxConcurrentSessions: 1,
          root: fixture,
          transport: listenerTransport(listener),
        })
      )
    );
    const request = requestFor(server.link, {
      script: "cat note.txt",
      type: "run",
    });
    const changedRootSession = scriptedSession({ reads: [request] });
    accepts.push(
      Effect.succeed(changedRootSession.session),
      Effect.fail(new BridgeListenerClosedError({ message: "listener closed" }))
    );
    const originalRoot = `${fixture}-original`;

    try {
      await rename(fixture, originalRoot);
      await mkdir(fixture);
      await writeFile(join(fixture, "note.txt"), "replacement secret\n");

      const end = await Effect.runPromise(
        Effect.scoped(server.serve.pipe(Effect.flip))
      );

      expect(end).toBeInstanceOf(BridgeListenerClosedError);
      expect(changedRootSession.state.writes).toHaveLength(0);
      expect(changedRootSession.state.finishCalls).toBe(0);
      expect(changedRootSession.state.closeCalls).toBe(1);
    } finally {
      await rm(originalRoot, { force: true, recursive: true });
    }
  });

  test("honors configured run deadlines beyond thirty seconds", async () => {
    const executionStarted = Promise.withResolvers<void>();
    let executionWasAborted = false;
    const execute = spyOn(Bash.prototype, "exec");
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

    try {
      const end = await Effect.runPromise(
        Effect.scoped(
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
            expect(stalled.state.writes).toHaveLength(0);
            expect(stalled.state.finishCalls).toBe(0);
            expect(stalled.state.closeCalls).toBe(1);
            expect(executionWasAborted).toBe(true);
            return result;
          })
        ).pipe(Effect.provide(TestClock.layer({ warningDelay: "10 seconds" })))
      );

      expect(end).toBeInstanceOf(BridgeListenerClosedError);
    } finally {
      execute.mockRestore();
    }
  });

  test("interrupts and closes a pull that exceeds its total deadline", async () => {
    const accepts: BridgeListener["accept"][] = [];
    const listener = listenerFrom(accepts);
    const server = await Effect.runPromise(
      Effect.scoped(
        openBridge({
          deadlines: { pull: "25 millis" },
          maxConcurrentSessions: 1,
          root: fixture,
          transport: listenerTransport(listener),
        })
      )
    );
    let writeWasInterrupted = false;
    const request = requestFor(server.link, {
      remotePath: "note.txt",
      type: "pull",
    });
    const stalled = scriptedSession({
      onWrite: (index) =>
        index === 2
          ? Effect.never.pipe(
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
      Effect.fail(new BridgeListenerClosedError({ message: "listener closed" }))
    );

    const end = await Effect.runPromise(
      Effect.scoped(server.serve.pipe(Effect.flip))
    );

    expect(end).toBeInstanceOf(BridgeListenerClosedError);
    expect(stalled.state.writes).toHaveLength(3);
    expect(stalled.state.finishCalls).toBe(0);
    expect(stalled.state.closeCalls).toBe(1);
    expect(writeWasInterrupted).toBe(true);
  });

  test("returns a sanitized typed failure for an unavailable remote path", async () => {
    const accepts: BridgeListener["accept"][] = [];
    const listener = listenerFrom(accepts);
    const server = await Effect.runPromise(
      Effect.scoped(
        openBridge({
          maxConcurrentSessions: 1,
          root: fixture,
          transport: listenerTransport(listener),
        })
      )
    );
    const request = requestFor(server.link, {
      remotePath: "missing.txt",
      type: "pull",
    });
    const serverSession = scriptedSession({ reads: [request] });
    accepts.push(
      Effect.succeed(serverSession.session),
      Effect.fail(new BridgeListenerClosedError({ message: "listener closed" }))
    );

    await Effect.runPromise(Effect.scoped(server.serve.pipe(Effect.flip)));

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
    const error = await Effect.runPromise(
      pullRemote({
        destination: join(fixture, "destination"),
        link: server.link,
        remotePath: "missing.txt",
        transport: clientTransport(clientSession.session),
      }).pipe(Effect.flip)
    );

    expect(error).toMatchObject({
      _tag: "PullNotFoundError",
      path: "missing.txt",
    });
    expect(clientSession.state.closeCalls).toBe(1);
  });

  test("returns a limit before an oversized pull manifest", async () => {
    const wide = join(fixture, "wide");
    await mkdir(wide);
    const fileCount = 4096;
    const batchSize = 128;
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

    const accepts: BridgeListener["accept"][] = [];
    const listener = listenerFrom(accepts);
    const server = await Effect.runPromise(
      Effect.scoped(
        openBridge({
          maxConcurrentSessions: 1,
          root: fixture,
          transport: listenerTransport(listener),
        })
      )
    );
    const request = requestFor(server.link, {
      remotePath: "wide",
      type: "pull",
    });
    const serverSession = scriptedSession({ reads: [request] });
    accepts.push(
      Effect.succeed(serverSession.session),
      Effect.fail(new BridgeListenerClosedError({ message: "listener closed" }))
    );

    await Effect.runPromise(Effect.scoped(server.serve.pipe(Effect.flip)));

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
  }, 30_000);

  test("rejects an invalid remote path before opening a session", async () => {
    let connectCalls = 0;
    const capability = mintCapability();
    const link = success(
      encodeBridgeLink({
        capability,
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

    const error = await Effect.runPromise(
      pullRemote({
        link,
        remotePath: "../secret",
        transport,
      }).pipe(Effect.flip)
    );

    expect(error).toMatchObject({
      _tag: "PullPathError",
      path: "../secret",
    });
    expect(connectCalls).toBe(0);
  });

  test("represents a sanitized remote limit without fabricated measurements", async () => {
    const capability = mintCapability();
    const link = success(
      encodeBridgeLink({
        capability,
        locator: "limited-client",
        transport: "iroh",
      })
    );
    const limited = scriptedSession({
      reads: [encoded({ code: "limit", type: "pull-error" })],
    });

    const error = await Effect.runPromise(
      pullRemote({
        destination: join(fixture, "limited"),
        link,
        remotePath: "large.bin",
        transport: clientTransport(limited.session),
      }).pipe(Effect.flip)
    );

    expect(error).toMatchObject({
      _tag: "PullRemoteLimitError",
      path: "large.bin",
    });
    expect(error).not.toHaveProperty("maximum");
    expect(error).not.toHaveProperty("observed");
    expect(limited.state.closeCalls).toBe(1);
  });

  test("bounds a client response even when every read makes progress", async () => {
    const capability = mintCapability();
    const link = success(
      encodeBridgeLink({
        capability,
        locator: "test-client",
        transport: "iroh",
      })
    );
    const response = joinChunks(
      encoded({ payload: new TextEncoder().encode("live\n"), type: "stdout" }),
      encoded({ code: 0, truncated: false, type: "exit" })
    );
    const slow = scriptedSession({
      readDelay: "5 millis",
      reads: Array.from(response, (byte) => Uint8Array.of(byte)),
    });

    const error = await Effect.runPromise(
      runRemote({
        deadline: "25 millis",
        link,
        script: "cat note.txt",
        transport: clientTransport(slow.session),
      }).pipe(Effect.flip)
    );

    expect(error).toMatchObject({
      _tag: "BridgeClientError",
      message: "The bridge run response deadline was exceeded.",
      operation: "run-response",
    });
    expect(slow.state.readCalls).toBeGreaterThan(1);
    expect(slow.state.closeCalls).toBe(1);
  });

  test("retries one connection failure before sending the request", async () => {
    const capability = mintCapability();
    const link = success(
      encodeBridgeLink({
        capability,
        locator: "retry-client",
        transport: "iroh",
      })
    );
    const response = joinChunks(
      encoded({ payload: new TextEncoder().encode("live\n"), type: "stdout" }),
      encoded({ code: 0, truncated: false, type: "exit" })
    );
    const connected = scriptedSession({ reads: [response] });
    let connectCalls = 0;
    const transport: BridgeTransport = {
      connect: () => {
        connectCalls += 1;
        return connectCalls === 1
          ? Effect.fail(
              new BridgeConnectError({ message: "transient handshake failure" })
            )
          : Effect.succeed(connected.session);
      },
      listen: Effect.die("listener is not used in this test"),
    };

    const result = await Effect.runPromise(
      runRemote({ link, script: "cat note.txt", transport })
    );

    expect(result.stdout).toBe("live\n");
    expect(connectCalls).toBe(2);
    expect(connected.state.finishCalls).toBe(1);
    expect(connected.state.closeCalls).toBe(1);
  });

  test("does not retry after request transmission starts", async () => {
    const capability = mintCapability();
    const link = success(
      encodeBridgeLink({
        capability,
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

    const error = await Effect.runPromise(
      runRemote({ link, script: "cat note.txt", transport }).pipe(Effect.flip)
    );

    expect(error).toMatchObject({
      _tag: "BridgeClientError",
      operation: "request",
    });
    expect(connectCalls).toBe(1);
    expect(started.state.writes).toHaveLength(2);
    expect(started.state.closeCalls).toBe(1);
  });
});
