import type { BiStream, Connection, Endpoint } from "@number0/iroh";
import { type Duration, Effect, Option, Semaphore } from "effect";
import {
  BridgeAcceptError,
  type BridgeDeadlineExceededError,
  type BridgeDeadlines,
  BridgeFinishError,
  type BridgeListener,
  BridgeListenerClosedError,
  BridgeReadError,
  type BridgeSession,
  BridgeWriteError,
} from "../index";
import {
  closeConnection,
  closeConnectionImmediately,
  refuseIncoming,
  withDeadline,
} from "./endpoint";

const chunkSize = 64 * 1024;

export const makeSession = (
  connection: Connection,
  stream: BiStream,
  ioDeadline: Duration.Input
): Effect.Effect<BridgeSession> =>
  Effect.gen(function* () {
    const writeLock = yield* Semaphore.make(1);
    const close = closeConnection(connection);
    const read = withDeadline(
      "read",
      ioDeadline,
      Effect.tryPromise({
        catch: () =>
          new BridgeReadError({
            message: "Could not read from the bridge session.",
          }),
        try: () => stream.recv.read(chunkSize),
      }),
      close
    ).pipe(
      Effect.tapError(() => close),
      Effect.map((bytes) =>
        bytes.length === 0
          ? Option.none<Uint8Array>()
          : Option.some(Uint8Array.from(bytes))
      )
    );

    const writeFrom = (
      bytes: Uint8Array,
      offset: number
    ): Effect.Effect<void, BridgeWriteError | BridgeDeadlineExceededError> =>
      Effect.suspend(() => {
        if (offset >= bytes.byteLength) {
          return Effect.void;
        }

        const end = Math.min(offset + chunkSize, bytes.byteLength);
        const chunk = Array.from(bytes.subarray(offset, end));

        return withDeadline(
          "write",
          ioDeadline,
          Effect.tryPromise({
            catch: () =>
              new BridgeWriteError({
                message: "Could not write to the bridge session.",
              }),
            try: () => stream.send.writeAll(chunk),
          }),
          close
        ).pipe(
          Effect.tapError(() => close),
          Effect.flatMap(() => writeFrom(bytes, end))
        );
      });

    return {
      close,
      finish: writeLock.withPermits(1)(
        withDeadline(
          "finish",
          ioDeadline,
          Effect.tryPromise({
            catch: () =>
              new BridgeFinishError({
                message: "Could not finish the bridge session.",
              }),
            try: async () => {
              await stream.send.finish();
              const stopped = await stream.send.stopped();
              if (stopped !== null) {
                throw new Error("The peer stopped the bridge stream.");
              }
            },
          }),
          close
        ).pipe(Effect.tapError(() => close))
      ),
      read,
      write: (bytes) => writeLock.withPermits(1)(writeFrom(bytes, 0)),
    } satisfies BridgeSession;
  });

export const acquireConnection = (connection: Connection) =>
  Effect.acquireRelease(Effect.succeed(connection), (activeConnection) =>
    closeConnection(activeConnection)
  );

export const acceptSession = (
  endpoint: Endpoint,
  deadlines: BridgeDeadlines
): BridgeListener["accept"] =>
  Effect.gen(function* () {
    const incoming = yield* Effect.tryPromise({
      catch: () =>
        new BridgeAcceptError({
          message: "Could not accept an incoming bridge connection.",
        }),
      try: () => endpoint.acceptNext(),
    });

    if (incoming === null) {
      return yield* new BridgeListenerClosedError({
        message: "The bridge listener is closed.",
      });
    }

    let handshakeExpired = false;
    const abandonHandshake = Effect.sync(() => {
      handshakeExpired = true;
    }).pipe(Effect.flatMap(() => refuseIncoming(incoming)));
    const connection = yield* withDeadline(
      "accept",
      deadlines.accept,
      Effect.tryPromise({
        catch: () =>
          new BridgeAcceptError({
            message: "Could not establish an incoming bridge connection.",
          }),
        try: async () => {
          const accepted = await incoming.accept();
          const established = await accepted.connect();
          if (handshakeExpired) {
            closeConnectionImmediately(established);
            throw new Error("The incoming bridge handshake was abandoned.");
          }
          return established;
        },
      }),
      abandonHandshake
    ).pipe(Effect.tapError(() => refuseIncoming(incoming)));
    const activeConnection = yield* acquireConnection(connection);
    const stream = yield* withDeadline(
      "accept",
      deadlines.accept,
      Effect.tryPromise({
        catch: () =>
          new BridgeAcceptError({
            message: "Could not accept a bridge byte session.",
          }),
        try: () => activeConnection.acceptBi(),
      }),
      closeConnection(activeConnection)
    );

    return yield* makeSession(activeConnection, stream, deadlines.io);
  });
