import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Option } from "effect";
import { makeIrohTransport } from "../../src/bridge/adapters/iroh";
import {
  BridgeDeadlineExceededError,
  BridgeLocator,
  BridgeLocatorInvalidError,
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

  test("rejects an invalid opaque locator with a typed failure", async () => {
    const transport = makeLoopbackTransport();
    const error = await Effect.runPromise(
      Effect.scoped(
        transport
          .connect(BridgeLocator.fromString("not-an-iroh-ticket"))
          .pipe(Effect.flip)
      )
    );

    expect(error).toBeInstanceOf(BridgeLocatorInvalidError);
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

  test("closes a listener whose accept deadline expires", async () => {
    const transport = makeIrohTransport({
      deadlines: {
        accept: "20 millis",
        connect: "1 second",
        io: "1 second",
        listen: "1 second",
      },
      reachability: "direct-only",
    });
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const listener = yield* transport.listen;
          return yield* listener.accept.pipe(Effect.flip);
        })
      )
    );

    expect(error).toBeInstanceOf(BridgeDeadlineExceededError);
    if (error instanceof BridgeDeadlineExceededError) {
      expect(error.operation).toBe("accept");
    }
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
          const serverFiber = yield* listener.accept.pipe(Effect.forkScoped);
          const client = yield* transport.connect(listener.locator);

          yield* client.write(Uint8Array.of(7));
          const server = yield* Fiber.join(serverFiber);
          const firstChunk = yield* server.read;

          expect(Option.isSome(firstChunk)).toBe(true);
          return yield* server.read.pipe(Effect.flip);
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
