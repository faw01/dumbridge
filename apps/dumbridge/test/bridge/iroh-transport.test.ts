import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { EndpointAddr, EndpointId } from "@number0/iroh";
import { Effect, Fiber, Option } from "effect";
import {
  configureIrohProxy,
  makeIrohTransport,
  normalizeIrohAddress,
} from "../../src/bridge/adapters/iroh";
import {
  BridgeDeadlineExceededError,
  BridgeLocator,
  BridgeLocatorInvalidError,
  BridgeProxyConfigurationError,
  BridgeProxyUnsupportedError,
  type BridgeReadError,
  type BridgeSession,
} from "../../src/bridge/transport";

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
  new URL("../fixtures/iroh-transport-probe.ts", import.meta.url)
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

describe("Iroh bridge transport", () => {
  test("exchanges bounded binary sessions through a scoped listener", async () => {
    const payload = Uint8Array.from(
      { length: 150_000 },
      (_, index) => index % 256
    );

    const reply = await Effect.runPromise(
      Effect.scoped(
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
      )
    );

    expect(reply).toEqual(payload);
  });

  test("serializes complete concurrent logical writes", async () => {
    const first = new Uint8Array(320_000).fill(0xa5);
    const second = new Uint8Array(320_000).fill(0x5a);

    const received = await Effect.runPromise(
      Effect.scoped(
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
      )
    );
    let transitions = 0;
    for (let index = 1; index < received.byteLength; index += 1) {
      if (received[index] !== received[index - 1]) {
        transitions += 1;
      }
    }

    expect(received.byteLength).toBe(first.byteLength + second.byteLength);
    expect(transitions).toBe(1);
  });

  test("rejects an invalid opaque locator with a typed failure", async () => {
    const transport = makeLoopbackTransport();
    const secretLocator = "not-an-iroh-ticket-private-value";
    const error = await Effect.runPromise(
      Effect.scoped(
        transport
          .connect(BridgeLocator.fromString(secretLocator))
          .pipe(Effect.flip)
      )
    );

    expect(error).toBeInstanceOf(BridgeLocatorInvalidError);
    expect(JSON.stringify(error)).not.toContain(secretLocator);
    expect(String(error)).not.toContain(secretLocator);
  });

  test("reports the current proxy binding gap explicitly", async () => {
    const error = await Effect.runPromise(
      configureIrohProxy(
        {},
        { _tag: "FromEnvironment" },
        {
          HTTPS_PROXY: "https://proxy.example",
        }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(BridgeProxyUnsupportedError);
    if (error instanceof BridgeProxyUnsupportedError) {
      expect(error.requested).toBe("environment");
    }
  });

  test("resolves Iroh proxy precedence before generic proxy fallbacks", async () => {
    const configured: string[] = [];
    const builder = {
      proxyUrl: (url: string) => configured.push(url),
    };

    await Effect.runPromise(
      configureIrohProxy(
        builder,
        { _tag: "FromEnvironment" },
        {
          HTTP_PROXY: "http://first.example",
          HTTPS_PROXY: "https://third.example",
          http_proxy: "http://second.example",
        }
      )
    );
    await Effect.runPromise(
      configureIrohProxy(
        builder,
        { _tag: "FromEnvironment" },
        {
          HTTP_PROXY: "http://ignored.example",
          http_proxy: "http://cgi-safe.example",
          REQUEST_METHOD: "GET",
        }
      )
    );
    await Effect.runPromise(
      configureIrohProxy(
        builder,
        { _tag: "FromEnvironment" },
        {
          ALL_PROXY: "http://fallback.example",
          HTTPS_PROXY: "https://preferred.example",
        }
      )
    );
    await Effect.runPromise(
      configureIrohProxy(
        builder,
        { _tag: "FromEnvironment" },
        {
          ALL_PROXY: "http://all-proxy.example",
          all_proxy: "http://lower-all-proxy.example",
        }
      )
    );
    await Effect.runPromise(
      configureIrohProxy(
        builder,
        { _tag: "FromEnvironment" },
        {
          all_proxy: "http://lower-all-proxy.example",
        }
      )
    );

    expect(configured).toEqual([
      "http://first.example/",
      "http://cgi-safe.example/",
      "https://preferred.example/",
      "http://all-proxy.example/",
      "http://lower-all-proxy.example/",
    ]);
  });

  test("fails closed when proxy environment variables are missing or invalid", async () => {
    const secret = "proxy-secret-credential";
    const builder = { proxyUrl: () => undefined };
    const [missing, malformed, invalidAllProxy] = await Effect.runPromise(
      Effect.all([
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
      ])
    );

    expect(missing).toBeInstanceOf(BridgeProxyConfigurationError);
    expect(malformed).toBeInstanceOf(BridgeProxyConfigurationError);
    expect(invalidAllProxy).toBeInstanceOf(BridgeProxyConfigurationError);
    expect(JSON.stringify(malformed)).not.toContain(secret);
    expect(String(malformed)).not.toContain(secret);
    expect(JSON.stringify(invalidAllProxy)).not.toContain(secret);
    expect(String(invalidAllProxy)).not.toContain(secret);
  });

  test("does not expose a proxy URL when native configuration fails", async () => {
    const secret = "proxy-secret-credential";
    const error = await Effect.runPromise(
      configureIrohProxy(
        {
          proxyUrl: () => {
            throw new Error(`https://${secret}@proxy.example`);
          },
        },
        { _tag: "Url", url: `https://${secret}@proxy.example` }
      ).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(BridgeProxyConfigurationError);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  });

  test("normalizes mixed locators to the selected reachability", async () => {
    const id = EndpointId.fromBytes(new Array<number>(32).fill(1));
    const directAddresses = ["127.0.0.1:4242", "[::1]:4242"];
    const relayUrl = "https://relay.example/";
    const mixed = new EndpointAddr(id, relayUrl, directAddresses);
    const [directOnly, relayOnly, directOrRelay] = await Effect.runPromise(
      Effect.all([
        normalizeIrohAddress(mixed, "direct-only"),
        normalizeIrohAddress(mixed, "relay-only"),
        normalizeIrohAddress(mixed, "direct-or-relay"),
      ])
    );

    expect(directOnly.relayUrl()).toBeNull();
    expect(directOnly.directAddresses()).toEqual(directAddresses);
    expect(relayOnly.relayUrl()).toBe(relayUrl);
    expect(relayOnly.directAddresses()).toEqual([]);
    expect(directOrRelay.relayUrl()).toBe(relayUrl);
    expect(directOrRelay.directAddresses()).toEqual(directAddresses);

    const noRelayError = await Effect.runPromise(
      normalizeIrohAddress(
        new EndpointAddr(id, null, directAddresses),
        "relay-only"
      ).pipe(Effect.flip)
    );
    const noDirectError = await Effect.runPromise(
      normalizeIrohAddress(
        new EndpointAddr(id, relayUrl, []),
        "direct-only"
      ).pipe(Effect.flip)
    );
    expect(noRelayError).toBeInstanceOf(BridgeLocatorInvalidError);
    expect(noDirectError).toBeInstanceOf(BridgeLocatorInvalidError);
  });

  test("falls back to a direct locator when home relay readiness expires", async () => {
    const result = await runProbe<RelayProbe>("relay-timeout");

    expect(result.onlineCalls).toBe(1);
    expect(result.directAddresses).toEqual(["127.0.0.1:4242"]);
    expect(result.relayUrl).toBeNull();
    expect(result.closeCalls).toBe(1);
  });

  test("keeps relay and direct routes when the home relay is ready", async () => {
    const result = await runProbe<RelayProbe>("relay-ready");

    expect(result.onlineCalls).toBe(1);
    expect(result.directAddresses).toEqual(["127.0.0.1:4242"]);
    expect(result.relayUrl).toBe("https://relay.example/");
    expect(result.closeCalls).toBe(1);
  });

  test("bounds listener binding and closes a late endpoint", async () => {
    const result = await runProbe<BindProbe>("bind-listen");

    expect(result.errorTag).toBe("BridgeDeadlineExceededError");
    expect(result.operation).toBe("listen");
    expect(result.closeCalls).toBe(1);
  });

  test("bounds client binding and closes a late endpoint", async () => {
    const result = await runProbe<BindProbe>("bind-connect");

    expect(result.errorTag).toBe("BridgeDeadlineExceededError");
    expect(result.operation).toBe("connect");
    expect(result.closeCalls).toBe(1);
  });

  test("closes an endpoint interrupted during bind handoff", async () => {
    const result = await runProbe<BindInterruptProbe>("bind-interrupt-handoff");

    expect(result.endpointUseCalls).toBe(0);
    expect(result.closeCalls).toBe(1);
  });

  test("closes sessions after ordinary native I/O failures", async () => {
    const result = await runProbe<SessionFailureProbe>("session-failures");

    expect(result.read.errorTag).toBe("BridgeReadError");
    expect(result.write.errorTag).toBe("BridgeWriteError");
    expect(result.finish.errorTag).toBe("BridgeFinishError");
    expect(result.read.closeCalls).toBe(1);
    expect(result.write.closeCalls).toBe(1);
    expect(result.finish.closeCalls).toBe(1);
  });

  test("waits for peer delivery acknowledgement before closing", async () => {
    const result = await runProbe<FinishLifecycleProbe>("finish-success");

    expect(result.errorTag).toBeNull();
    expect(result.message).toBeNull();
    expect(result.operation).toBeNull();
    expect(result.events).toEqual(["finish", "stopped", "close"]);
  });

  test("sanitizes a peer stream stop and closes the session", async () => {
    const result = await runProbe<FinishLifecycleProbe>("finish-peer-stop");

    expect(result.errorTag).toBe("BridgeFinishError");
    expect(result.message).toBe("Could not finish the bridge session.");
    expect(result.operation).toBeNull();
    expect(result.events).toEqual(["finish", "stopped", "close"]);
    expect(result.message).not.toContain("0");
  });

  test("bounds peer delivery acknowledgement and closes on timeout", async () => {
    const result = await runProbe<FinishLifecycleProbe>("finish-timeout");

    expect(result.errorTag).toBe("BridgeDeadlineExceededError");
    expect(result.message).toBe("finish deadline exceeded");
    expect(result.operation).toBe("finish");
    expect(result.events).toEqual(["finish", "stopped", "close"]);
  });

  test("keeps an idle listener open past its accept deadline", async () => {
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
    const received = await Effect.runPromise(
      Effect.scoped(
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
      )
    );

    expect(received).toEqual(payload);
  });

  test("closes a byte session whose read deadline expires", async () => {
    const transport = makeIrohTransport({
      deadlines: {
        accept: "1 second",
        connect: "1 second",
        io: "50 millis",
        listen: "1 second",
      },
      reachability: "direct-only",
    });
    const error = await Effect.runPromise(
      Effect.scoped(
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
          return yield* Fiber.join(serverFiber);
        })
      )
    );

    expect(error).toBeInstanceOf(BridgeDeadlineExceededError);
    if (error instanceof BridgeDeadlineExceededError) {
      expect(error.operation).toBe("read");
    }
  });

  test("revokes a listener when its scope closes", async () => {
    const transport = makeIrohTransport({
      deadlines: {
        accept: "1 second",
        connect: "200 millis",
        io: "1 second",
        listen: "1 second",
      },
      reachability: "direct-only",
    });
    const locator = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const listener = yield* transport.listen;
          return listener.locator;
        })
      )
    );
    const error = await Effect.runPromise(
      Effect.scoped(transport.connect(locator)).pipe(Effect.flip)
    );

    expect(["BridgeConnectError", "BridgeDeadlineExceededError"]).toContain(
      error._tag
    );
  });
});
