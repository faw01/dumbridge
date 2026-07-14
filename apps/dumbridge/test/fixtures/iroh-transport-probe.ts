import {
  type BiStream,
  type Connection,
  type Endpoint,
  EndpointAddr,
  EndpointBuilder,
  EndpointId,
  EndpointTicket,
} from "@number0/iroh";
import { Effect, Fiber } from "effect";
import { makeIrohTransport } from "../../src/bridge/adapters/iroh";
import {
  BridgeDeadlineExceededError,
  BridgeLocator,
} from "../../src/bridge/transport";

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

const makeDirectLocator = () => {
  const id = EndpointId.fromBytes(new Array<number>(32).fill(1));
  const address = new EndpointAddr(id, null, ["127.0.0.1:4242"]);
  return BridgeLocator.fromString(EndpointTicket.fromAddr(address).toString());
};

const lateBind = async (operation: "connect" | "listen") => {
  const originalBind = EndpointBuilder.prototype.bind;
  let closeCalls = 0;
  let resolveBind: ((endpoint: Endpoint) => void) | undefined;
  const pendingBind = new Promise<Endpoint>((resolve) => {
    resolveBind = resolve;
  });
  const lateEndpoint = {
    close: () => {
      closeCalls += 1;
      return Promise.resolve();
    },
  } as Endpoint;
  EndpointBuilder.prototype.bind = () => pendingBind;

  try {
    const transport = makeIrohTransport({
      deadlines: {
        accept: "1 second",
        connect: "20 millis",
        io: "1 second",
        listen: "20 millis",
      },
      reachability: "direct-only",
    });
    const error =
      operation === "listen"
        ? await Effect.runPromise(
            Effect.scoped(transport.listen).pipe(Effect.flip)
          )
        : await Effect.runPromise(
            Effect.scoped(transport.connect(makeDirectLocator())).pipe(
              Effect.flip
            )
          );

    resolveBind?.(lateEndpoint);
    await Bun.sleep(10);

    return {
      closeCalls,
      errorTag: error._tag,
      operation:
        error instanceof BridgeDeadlineExceededError ? error.operation : null,
    };
  } finally {
    EndpointBuilder.prototype.bind = originalBind;
    resolveBind?.(lateEndpoint);
  }
};

const interruptedBindHandoff = async () => {
  const originalBind = EndpointBuilder.prototype.bind;
  let closeCalls = 0;
  let endpointUseCalls = 0;
  let resolveBind: ((endpoint: Endpoint) => void) | undefined;
  let resolveBindStarted: (() => void) | undefined;
  const bindStarted = new Promise<void>((resolve) => {
    resolveBindStarted = resolve;
  });
  const pendingBind = new Promise<Endpoint>((resolve) => {
    resolveBind = resolve;
  });
  const id = EndpointId.fromBytes(new Array<number>(32).fill(3));
  const endpoint = {
    addr: () => {
      endpointUseCalls += 1;
      return new EndpointAddr(id, null, ["127.0.0.1:4242"]);
    },
    close: () => {
      closeCalls += 1;
      return Promise.resolve();
    },
  } as Endpoint;
  EndpointBuilder.prototype.bind = () => {
    resolveBindStarted?.();
    return pendingBind;
  };

  try {
    const fiber = Effect.runFork(
      Effect.scoped(
        makeIrohTransport({
          deadlines: {
            accept: "5 seconds",
            connect: "5 seconds",
            io: "5 seconds",
            listen: "5 seconds",
          },
          reachability: "direct-only",
        }).listen
      )
    );
    await bindStarted;

    resolveBind?.(endpoint);
    const interrupted = new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        Effect.runPromise(Fiber.interrupt(fiber)).then(resolve, reject);
      });
    });
    await interrupted;
    await Bun.sleep(10);

    return { closeCalls, endpointUseCalls };
  } finally {
    EndpointBuilder.prototype.bind = originalBind;
    resolveBind?.(endpoint);
  }
};

const relayReadiness = async (relayReady: boolean) => {
  const originalBind = EndpointBuilder.prototype.bind;
  const id = EndpointId.fromBytes(new Array<number>(32).fill(3));
  const relayUrl = relayReady ? "https://relay.example/" : null;
  let closeCalls = 0;
  let onlineCalls = 0;
  const endpoint = {
    addr: () => new EndpointAddr(id, relayUrl, ["127.0.0.1:4242"]),
    close: () => {
      closeCalls += 1;
      return Promise.resolve();
    },
    online: () => {
      onlineCalls += 1;
      return relayReady
        ? Promise.resolve()
        : new Promise<void>(() => undefined);
    },
  } as Endpoint;
  EndpointBuilder.prototype.bind = () => Promise.resolve(endpoint);

  try {
    const locator = await Effect.runPromise(
      Effect.scoped(
        makeIrohTransport({
          deadlines: { listen: "20 millis" },
          reachability: "direct-or-relay",
        }).listen.pipe(Effect.map((listener) => listener.locator))
      )
    );
    const address = EndpointTicket.fromString(
      locator.toString()
    ).endpointAddr();

    return {
      closeCalls,
      directAddresses: address.directAddresses(),
      onlineCalls,
      relayUrl: address.relayUrl(),
    };
  } finally {
    EndpointBuilder.prototype.bind = originalBind;
  }
};

type SessionFailureOperation = "finish" | "read" | "write";

const sessionFailure = async (operation: SessionFailureOperation) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const originalBind = EndpointBuilder.prototype.bind;
        let closeCalls = 0;
        const stream = {
          recv: {
            read: () =>
              operation === "read"
                ? Promise.reject(new Error("forced native read failure"))
                : Promise.resolve([]),
          },
          send: {
            finish: () =>
              operation === "finish"
                ? Promise.reject(new Error("forced native finish failure"))
                : Promise.resolve(),
            stopped: () => Promise.resolve(null),
            writeAll: () =>
              operation === "write"
                ? Promise.reject(new Error("forced native write failure"))
                : Promise.resolve(),
          },
        } as unknown as BiStream;
        const connection = {
          close: () => {
            closeCalls += 1;
          },
          openBi: () => Promise.resolve(stream),
        } as unknown as Connection;
        const endpoint = {
          close: () => Promise.resolve(),
          connect: () => Promise.resolve(connection),
        } as unknown as Endpoint;
        EndpointBuilder.prototype.bind = () => Promise.resolve(endpoint);

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            EndpointBuilder.prototype.bind = originalBind;
          })
        );

        const client = yield* makeLoopbackTransport().connect(
          makeDirectLocator()
        );
        let errorTag: string;
        if (operation === "read") {
          const error = yield* client.read.pipe(Effect.flip);
          errorTag = error._tag;
        } else if (operation === "write") {
          const error = yield* client.write(Uint8Array.of(1)).pipe(Effect.flip);
          errorTag = error._tag;
        } else {
          const error = yield* client.finish.pipe(Effect.flip);
          errorTag = error._tag;
        }

        return { closeCalls, errorTag };
      })
    )
  );

type FinishLifecycleScenario = "peer-stop" | "success" | "timeout";

const finishLifecycle = async (scenario: FinishLifecycleScenario) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const originalBind = EndpointBuilder.prototype.bind;
        const events: string[] = [];
        let closed = false;
        const stream = {
          recv: {
            read: () => Promise.resolve([]),
          },
          send: {
            finish: () => {
              events.push("finish");
              return Promise.resolve();
            },
            stopped: () => {
              events.push("stopped");
              if (scenario === "timeout") {
                return new Promise<number | null>(() => undefined);
              }
              return Promise.resolve(scenario === "peer-stop" ? 0 : null);
            },
            writeAll: () => Promise.resolve(),
          },
        } as unknown as BiStream;
        const connection = {
          close: () => {
            if (!closed) {
              closed = true;
              events.push("close");
            }
          },
          openBi: () => Promise.resolve(stream),
        } as unknown as Connection;
        const endpoint = {
          close: () => Promise.resolve(),
          connect: () => Promise.resolve(connection),
        } as unknown as Endpoint;
        EndpointBuilder.prototype.bind = () => Promise.resolve(endpoint);

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            EndpointBuilder.prototype.bind = originalBind;
          })
        );

        const client = yield* makeIrohTransport({
          deadlines: {
            accept: "1 second",
            connect: "1 second",
            io: "20 millis",
            listen: "1 second",
          },
          reachability: "direct-only",
        }).connect(makeDirectLocator());

        if (scenario === "success") {
          yield* client.finish;
          return { errorTag: null, events, message: null, operation: null };
        }

        const error = yield* client.finish.pipe(Effect.flip);
        return {
          errorTag: error._tag,
          events,
          message: error.message,
          operation:
            error instanceof BridgeDeadlineExceededError
              ? error.operation
              : null,
        };
      })
    )
  );

const run = (scenario: string | undefined) => {
  switch (scenario) {
    case "bind-connect":
      return lateBind("connect");
    case "bind-listen":
      return lateBind("listen");
    case "bind-interrupt-handoff":
      return interruptedBindHandoff();
    case "relay-ready":
      return relayReadiness(true);
    case "relay-timeout":
      return relayReadiness(false);
    case "session-failures":
      return sessionFailure("read").then(async (read) => {
        const write = await sessionFailure("write");
        const finish = await sessionFailure("finish");
        return { finish, read, write };
      });
    case "finish-success":
      return finishLifecycle("success");
    case "finish-peer-stop":
      return finishLifecycle("peer-stop");
    case "finish-timeout":
      return finishLifecycle("timeout");
    default:
      throw new Error("Unknown Iroh transport probe scenario.");
  }
};

try {
  console.log(JSON.stringify(await run(Bun.argv[2])));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
