import { fileURLToPath } from "node:url";
import {
  BridgeDeadlineExceededError,
  BridgeLocator,
  BridgeLocatorInvalidError,
  BridgeProxyConfigurationError,
  BridgeProxyUnsupportedError,
  type BridgeReadError,
  type BridgeSession,
} from "@dumbridge/bridge-transport";
import {
  configureIrohProxy,
  makeIrohTransport,
  normalizeIrohAddress,
} from "@dumbridge/bridge-transport/iroh";
import { describe, expect, it } from "@effect/vitest";
import { EndpointAddr, EndpointId } from "@number0/iroh";
import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

const concatenate = (chunks: readonly Uint8Array[]) => {
  const bytes = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0)
  );
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
};

const readChunks = (
  session: BridgeSession,
  chunks: readonly Uint8Array[] = []
): Effect.Effect<
  readonly Uint8Array[],
  BridgeReadError | BridgeDeadlineExceededError
> =>
  session.read.pipe(
    Effect.flatMap((chunk) =>
      Option.isNone(chunk)
        ? Effect.succeed(chunks)
        : readChunks(session, [...chunks, chunk.value])
    )
  );

const readAll = (session: BridgeSession) =>
  readChunks(session).pipe(Effect.map(concatenate));

const makeLoopbackTransport = () =>
  makeIrohTransport({
    deadlines: {
      accept: "5 seconds",
      connect: "5 seconds",
      io: "5 seconds",
      listen: "5 seconds",
    },
    reachability: "direct-only",
  });

const probePath = fileURLToPath(
  new URL("./fixtures/iroh-transport-probe.ts", import.meta.url)
);

const runProbe = async <A>(scenario: string): Promise<A> => {
  const child = Bun.spawn([process.execPath, probePath, scenario], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`Iroh transport probe failed: ${stderr}`);
  }
  return JSON.parse(stdout) as A;
};

interface BindProbe {
  readonly closeCalls: number;
  readonly errorTag: string;
  readonly operation: string | null;
}

interface BindInterruptProbe {
  readonly closeCalls: number;
  readonly endpointUseCalls: number;
}

interface RelayProbe {
  readonly closeCalls: number;
  readonly directAddresses: readonly string[];
  readonly onlineCalls: number;
  readonly relayUrl: string | null;
}

interface SessionFailureProbe {
  readonly finish: { readonly closeCalls: number; readonly errorTag: string };
  readonly read: { readonly closeCalls: number; readonly errorTag: string };
  readonly write: { readonly closeCalls: number; readonly errorTag: string };
}

interface FinishLifecycleProbe {
  readonly errorTag: string | null;
  readonly events: readonly string[];
  readonly message: string | null;
  readonly operation: string | null;
}

interface ConnectionPathProbe {
  readonly noSelection: string;
  readonly relaySelected: string;
  readonly snapshotFailure: string;
}

describe("Iroh bridge transport", () => {
  it.live("exchanges bounded binary sessions through a scoped listener", () =>
    Effect.gen(function* () {
      const payload = Uint8Array.from(
        { length: 150_000 },
        (_, index) => index % 256
      );

      const reply = yield* Effect.scoped(
        Effect.gen(function* () {
          const transport = makeLoopbackTransport();
          const listener = yield* transport.listen;
          const serverFiber = yield* listener.accept.pipe(
            Effect.flatMap((session) =>
              Effect.gen(function* () {
                const request = yield* readAll(session);
                yield* session.write(request);
                yield* session.finish;
              })
            ),
            Effect.forkScoped
          );
          const client = yield* transport.connect(listener.locator);

          yield* client.write(payload);
          yield* client.finish;
          const response = yield* readAll(client);
          yield* Fiber.join(serverFiber);

          return response;
        })
      );

      expect(reply).toEqual(payload);
    })
  );

  it.live("serializes complete concurrent logical writes", () =>
    Effect.gen(function* () {
      const first = new Uint8Array(320_000).fill(0xa5);
      const second = new Uint8Array(320_000).fill(0x5a);

      const received = yield* Effect.scoped(
        Effect.gen(function* () {
          const transport = makeLoopbackTransport();
          const listener = yield* transport.listen;
          const serverFiber = yield* listener.accept.pipe(
            Effect.flatMap(readAll),
            Effect.forkScoped
          );
          const client = yield* transport.connect(listener.locator);

          yield* Effect.all([client.write(first), client.write(second)], {
            concurrency: "unbounded",
            discard: true,
          });
          yield* client.finish;

          return yield* Fiber.join(serverFiber);
        })
      );
      let transitions = 0;
      for (let index = 1; index < received.byteLength; index += 1) {
        if (received[index] !== received[index - 1]) {
          transitions += 1;
        }
      }

      expect(received.byteLength).toBe(first.byteLength + second.byteLength);
      expect(transitions).toBe(1);
    })
  );

  it.live("reports the connection path selected at connect time", () =>
    Effect.gen(function* () {
      const paths = yield* Effect.scoped(
        Effect.gen(function* () {
          const transport = makeLoopbackTransport();
          const listener = yield* transport.listen;
          const serverFiber = yield* listener.accept.pipe(Effect.forkScoped);
          const client = yield* transport.connect(listener.locator);
          yield* client.write(Uint8Array.of(1));
          const server = yield* Fiber.join(serverFiber);

          return {
            client: client.connectionPath,
            server: server.connectionPath,
          };
        })
      );

      expect(paths).toEqual({ client: "direct", server: "direct" });
    })
  );

  it("classifies relay and unobservable path snapshots honestly", async () => {
    const result = await runProbe<ConnectionPathProbe>("connection-path");

    expect(result.relaySelected).toBe("relay");
    expect(result.noSelection).toBe("unknown");
    expect(result.snapshotFailure).toBe("unknown");
  });

  it.live("rejects an invalid opaque locator with a typed failure", () =>
    Effect.gen(function* () {
      const transport = makeLoopbackTransport();
      const secretLocator = "not-an-iroh-ticket-private-value";
      const error = yield* Effect.scoped(
        transport
          .connect(BridgeLocator.fromString(secretLocator))
          .pipe(Effect.flip)
      );

      expect(error).toBeInstanceOf(BridgeLocatorInvalidError);
      expect(JSON.stringify(error)).not.toContain(secretLocator);
      expect(String(error)).not.toContain(secretLocator);
    })
  );

  it.effect("reports the current proxy binding gap explicitly", () =>
    Effect.gen(function* () {
      const error = yield* configureIrohProxy(
        {},
        { _tag: "FromEnvironment" },
        {
          HTTPS_PROXY: "https://proxy.example",
        }
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(BridgeProxyUnsupportedError);
      if (error instanceof BridgeProxyUnsupportedError) {
        expect(error.requested).toBe("environment");
      }
    })
  );

  it.effect(
    "resolves Iroh proxy precedence before generic proxy fallbacks",
    () =>
      Effect.gen(function* () {
        const configured: string[] = [];
        const builder = {
          proxyUrl: (url: string) => configured.push(url),
        };

        yield* configureIrohProxy(
          builder,
          { _tag: "FromEnvironment" },
          {
            HTTP_PROXY: "http://first.example",
            HTTPS_PROXY: "https://third.example",
            http_proxy: "http://second.example",
          }
        );
        yield* configureIrohProxy(
          builder,
          { _tag: "FromEnvironment" },
          {
            HTTP_PROXY: "http://ignored.example",
            http_proxy: "http://cgi-safe.example",
            REQUEST_METHOD: "GET",
          }
        );
        yield* configureIrohProxy(
          builder,
          { _tag: "FromEnvironment" },
          {
            ALL_PROXY: "http://fallback.example",
            HTTPS_PROXY: "https://preferred.example",
          }
        );
        yield* configureIrohProxy(
          builder,
          { _tag: "FromEnvironment" },
          {
            ALL_PROXY: "http://all-proxy.example",
            all_proxy: "http://lower-all-proxy.example",
          }
        );
        yield* configureIrohProxy(
          builder,
          { _tag: "FromEnvironment" },
          {
            all_proxy: "http://lower-all-proxy.example",
          }
        );

        expect(configured).toEqual([
          "http://first.example/",
          "http://cgi-safe.example/",
          "https://preferred.example/",
          "http://all-proxy.example/",
          "http://lower-all-proxy.example/",
        ]);
      })
  );

  it.effect(
    "fails closed when proxy environment variables are missing or invalid",
    () =>
      Effect.gen(function* () {
        const secret = "proxy-secret-credential";
        const builder = { proxyUrl: () => undefined };
        const [missing, malformed, invalidAllProxy] = yield* Effect.all([
          configureIrohProxy(builder, { _tag: "FromEnvironment" }, {}).pipe(
            Effect.flip
          ),
          configureIrohProxy(
            builder,
            { _tag: "FromEnvironment" },
            {
              HTTP_PROXY: `not-a-url-${secret}`,
              https_proxy: `socks5://${secret}@proxy.example`,
            }
          ).pipe(Effect.flip),
          configureIrohProxy(
            builder,
            { _tag: "FromEnvironment" },
            {
              ALL_PROXY: `socks5://${secret}@proxy.example`,
            }
          ).pipe(Effect.flip),
        ]);

        expect(missing).toBeInstanceOf(BridgeProxyConfigurationError);
        expect(malformed).toBeInstanceOf(BridgeProxyConfigurationError);
        expect(invalidAllProxy).toBeInstanceOf(BridgeProxyConfigurationError);
        expect(JSON.stringify(malformed)).not.toContain(secret);
        expect(String(malformed)).not.toContain(secret);
        expect(JSON.stringify(invalidAllProxy)).not.toContain(secret);
        expect(String(invalidAllProxy)).not.toContain(secret);
      })
  );

  it.effect("does not expose a proxy URL when native configuration fails", () =>
    Effect.gen(function* () {
      const secret = "proxy-secret-credential";
      const error = yield* configureIrohProxy(
        {
          proxyUrl: () => {
            throw new Error(`https://${secret}@proxy.example`);
          },
        },
        { _tag: "Url", url: `https://${secret}@proxy.example` }
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(BridgeProxyConfigurationError);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(String(error)).not.toContain(secret);
    })
  );

  it.effect("normalizes mixed locators to the selected reachability", () =>
    Effect.gen(function* () {
      const id = EndpointId.fromBytes(new Array<number>(32).fill(1));
      const directAddresses = ["127.0.0.1:4242", "[::1]:4242"];
      const relayUrl = "https://relay.example/";
      const mixed = new EndpointAddr(id, relayUrl, directAddresses);
      const [directOnly, relayOnly, directOrRelay] = yield* Effect.all([
        normalizeIrohAddress(mixed, "direct-only"),
        normalizeIrohAddress(mixed, "relay-only"),
        normalizeIrohAddress(mixed, "direct-or-relay"),
      ]);

      expect(directOnly.relayUrl()).toBeNull();
      expect(directOnly.directAddresses()).toEqual(directAddresses);
      expect(relayOnly.relayUrl()).toBe(relayUrl);
      expect(relayOnly.directAddresses()).toEqual([]);
      expect(directOrRelay.relayUrl()).toBe(relayUrl);
      expect(directOrRelay.directAddresses()).toEqual(directAddresses);

      const noRelayError = yield* normalizeIrohAddress(
        new EndpointAddr(id, null, directAddresses),
        "relay-only"
      ).pipe(Effect.flip);
      const noDirectError = yield* normalizeIrohAddress(
        new EndpointAddr(id, relayUrl, []),
        "direct-only"
      ).pipe(Effect.flip);
      expect(noRelayError).toBeInstanceOf(BridgeLocatorInvalidError);
      expect(noDirectError).toBeInstanceOf(BridgeLocatorInvalidError);
    })
  );

  it("falls back to a direct locator when home relay readiness expires", async () => {
    const result = await runProbe<RelayProbe>("relay-timeout");

    expect(result.onlineCalls).toBe(1);
    expect(result.directAddresses).toEqual(["127.0.0.1:4242"]);
    expect(result.relayUrl).toBeNull();
    expect(result.closeCalls).toBe(1);
  });

  it("keeps relay and direct routes when the home relay is ready", async () => {
    const result = await runProbe<RelayProbe>("relay-ready");

    expect(result.onlineCalls).toBe(1);
    expect(result.directAddresses).toEqual(["127.0.0.1:4242"]);
    expect(result.relayUrl).toBe("https://relay.example/");
    expect(result.closeCalls).toBe(1);
  });

  it("bounds listener binding and closes a late endpoint", async () => {
    const result = await runProbe<BindProbe>("bind-listen");

    expect(result.errorTag).toBe("BridgeDeadlineExceededError");
    expect(result.operation).toBe("listen");
    expect(result.closeCalls).toBe(1);
  });

  it("bounds client binding and closes a late endpoint", async () => {
    const result = await runProbe<BindProbe>("bind-connect");

    expect(result.errorTag).toBe("BridgeDeadlineExceededError");
    expect(result.operation).toBe("connect");
    expect(result.closeCalls).toBe(1);
  });

  it("closes an endpoint interrupted during bind handoff", async () => {
    const result = await runProbe<BindInterruptProbe>("bind-interrupt-handoff");

    expect(result.endpointUseCalls).toBe(0);
    expect(result.closeCalls).toBe(1);
  });

  it("closes sessions after ordinary native I/O failures", async () => {
    const result = await runProbe<SessionFailureProbe>("session-failures");

    expect(result.read.errorTag).toBe("BridgeReadError");
    expect(result.write.errorTag).toBe("BridgeWriteError");
    expect(result.finish.errorTag).toBe("BridgeFinishError");
    expect(result.read.closeCalls).toBe(1);
    expect(result.write.closeCalls).toBe(1);
    expect(result.finish.closeCalls).toBe(1);
  });

  it("waits for peer delivery acknowledgement before closing", async () => {
    const result = await runProbe<FinishLifecycleProbe>("finish-success");

    expect(result.errorTag).toBeNull();
    expect(result.message).toBeNull();
    expect(result.operation).toBeNull();
    expect(result.events).toEqual(["finish", "stopped", "close"]);
  });

  it("sanitizes a peer stream stop and closes the session", async () => {
    const result = await runProbe<FinishLifecycleProbe>("finish-peer-stop");

    expect(result.errorTag).toBe("BridgeFinishError");
    expect(result.message).toBe("Could not finish the bridge session.");
    expect(result.operation).toBeNull();
    expect(result.events).toEqual(["finish", "stopped", "close"]);
    expect(result.message).not.toContain("0");
  });

  it("bounds peer delivery acknowledgement and closes on timeout", async () => {
    const result = await runProbe<FinishLifecycleProbe>("finish-timeout");

    expect(result.errorTag).toBe("BridgeDeadlineExceededError");
    expect(result.message).toBe("finish deadline exceeded");
    expect(result.operation).toBe("finish");
    expect(result.events).toEqual(["finish", "stopped", "close"]);
  });

  it.live("keeps an idle listener open past its accept deadline", () =>
    Effect.gen(function* () {
      const transport = makeIrohTransport({
        deadlines: {
          accept: "20 millis",
          connect: "1 second",
          io: "1 second",
          listen: "1 second",
        },
        reachability: "direct-only",
      });
      const payload = Uint8Array.of(7, 8, 9);
      const received = yield* Effect.scoped(
        Effect.gen(function* () {
          const listener = yield* transport.listen;
          const serverFiber = yield* listener.accept.pipe(
            Effect.flatMap(readAll),
            Effect.forkScoped
          );

          yield* Effect.sleep("80 millis");
          const client = yield* transport.connect(listener.locator);
          yield* client.write(payload);
          yield* client.finish;

          return yield* Fiber.join(serverFiber);
        })
      );

      expect(received).toEqual(payload);
    })
  );

  it.live("keeps a quiet default session open beyond thirty seconds", () =>
    Effect.gen(function* () {
      const payload = Uint8Array.of(7, 8, 9);
      const received = yield* Effect.scoped(
        Effect.gen(function* () {
          const transport = makeIrohTransport({ reachability: "direct-only" });
          const listener = yield* transport.listen;
          const serverFiber = yield* listener.accept.pipe(Effect.forkScoped);
          const client = yield* transport.connect(listener.locator);
          yield* client.write(Uint8Array.of(1));
          const server = yield* Fiber.join(serverFiber);
          expect(Option.isSome(yield* server.read)).toBe(true);
          yield* client.finish;

          return yield* Effect.gen(function* () {
            let readSettled = false;
            const readFiber = yield* readAll(client).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  readSettled = true;
                })
              ),
              Effect.forkChild
            );
            yield* Effect.yieldNow;
            yield* TestClock.adjust("31 seconds");
            expect(readSettled).toBe(false);

            yield* server.write(payload);
            yield* server.finish;
            return yield* Fiber.join(readFiber);
          }).pipe(
            Effect.provide(TestClock.layer({ warningDelay: "10 seconds" }))
          );
        })
      );

      expect(received).toEqual(payload);
    })
  );

  it.live("closes a byte session whose read deadline expires", () =>
    Effect.gen(function* () {
      const transport = makeIrohTransport({
        deadlines: {
          accept: "1 second",
          connect: "1 second",
          io: "50 millis",
          listen: "1 second",
        },
        reachability: "direct-only",
      });
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const listener = yield* transport.listen;
          const serverFiber = yield* listener.accept.pipe(
            Effect.flatMap((server) =>
              Effect.gen(function* () {
                const firstChunk = yield* server.read;
                expect(Option.isSome(firstChunk)).toBe(true);
                return yield* server.read.pipe(Effect.flip);
              })
            ),
            Effect.forkScoped
          );
          const client = yield* transport.connect(listener.locator);

          yield* client.write(Uint8Array.of(7));
          const failure = yield* Fiber.join(serverFiber);

          // Close only after the join. Without a later use of `client`, GC may
          // finalize its native send stream mid-test, which implicitly
          // finishes the QUIC stream; the server would then read EOF instead
          // of reaching its deadline.
          yield* client.close;
          return failure;
        })
      );

      expect(error).toBeInstanceOf(BridgeDeadlineExceededError);
      if (error instanceof BridgeDeadlineExceededError) {
        expect(error.operation).toBe("read");
      }
    })
  );

  it.live("revokes a listener when its scope closes", () =>
    Effect.gen(function* () {
      const transport = makeIrohTransport({
        deadlines: {
          accept: "1 second",
          connect: "200 millis",
          io: "1 second",
          listen: "1 second",
        },
        reachability: "direct-only",
      });
      const locator = yield* Effect.scoped(
        Effect.gen(function* () {
          const listener = yield* transport.listen;
          return listener.locator;
        })
      );
      const error = yield* Effect.scoped(transport.connect(locator)).pipe(
        Effect.flip
      );

      expect(["BridgeConnectError", "BridgeDeadlineExceededError"]).toContain(
        error._tag
      );
    })
  );
});
