import { describe, expect, test } from "bun:test";
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
    const transport = makeIrohTransport({
      proxy: { _tag: "FromEnvironment" },
      reachability: "direct-only",
    });
    const error = await Effect.runPromise(
      Effect.scoped(transport.listen.pipe(Effect.flip))
    );

    expect(error).toBeInstanceOf(BridgeProxyUnsupportedError);
    if (error instanceof BridgeProxyUnsupportedError) {
      expect(error.requested).toBe("environment");
    }
  });

  test("uses proxy methods when a patched binding exposes them", async () => {
    const configured: string[] = [];

    await Effect.runPromise(
      configureIrohProxy(
        {
          proxyFromEnv: () => configured.push("environment"),
          proxyUrl: (url: string) => configured.push(url),
        },
        { _tag: "FromEnvironment" }
      )
    );
    await Effect.runPromise(
      configureIrohProxy(
        {
          proxyFromEnv: () => configured.push("environment"),
          proxyUrl: (url: string) => configured.push(url),
        },
        { _tag: "Url", url: "https://proxy.example" }
      )
    );

    expect(configured).toEqual(["environment", "https://proxy.example"]);
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
    const relayUrl = "https://relay.example";
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
