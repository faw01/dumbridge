import type {
  BridgeDeadlineExceededError,
  BridgeReadError,
  BridgeSession,
} from "@dumbridge/bridge-transport";
import {
  encodeFrame,
  type WireDecodeError,
  type WireFrame,
  type WireSession,
} from "@dumbridge/wire";
import { Effect, Option } from "effect";

export const sendFrame = (session: BridgeSession, frame: WireFrame) =>
  Effect.fromResult(encodeFrame(frame)).pipe(Effect.flatMap(session.write));

export const sendFrames = (
  session: BridgeSession,
  frames: readonly WireFrame[]
) =>
  Effect.forEach(frames, (frame) => sendFrame(session, frame), {
    concurrency: 1,
    discard: true,
  });

export class WireEventReader<A> {
  readonly #decoder: WireSession<A>;
  readonly #endState = new Set<"ended">();
  readonly #events: A[] = [];
  readonly #session: BridgeSession;

  constructor(session: BridgeSession, decoder: WireSession<A>) {
    this.#decoder = decoder;
    this.#session = session;
  }

  readonly next = (): Effect.Effect<
    Option.Option<A>,
    WireDecodeError | BridgeDeadlineExceededError | BridgeReadError
  > =>
    Effect.suspend(() => {
      const event = this.#events.shift();
      if (event !== undefined) {
        return Effect.succeed(Option.some(event));
      }
      if (this.#endState.has("ended")) {
        return Effect.succeed(Option.none());
      }

      return this.#readNext();
    });

  #readNext(): Effect.Effect<
    Option.Option<A>,
    WireDecodeError | BridgeDeadlineExceededError | BridgeReadError
  > {
    return this.#session.read.pipe(
      Effect.flatMap((chunk) => {
        if (Option.isNone(chunk)) {
          return Effect.fromResult(this.#decoder.finish()).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                this.#endState.add("ended");
              })
            ),
            Effect.as(Option.none<A>())
          );
        }

        return Effect.fromResult(this.#decoder.push(chunk.value)).pipe(
          Effect.tap((events) =>
            Effect.sync(() => {
              this.#events.push(...events);
            })
          ),
          Effect.flatMap(() => this.next())
        );
      })
    );
  }
}

export const joinBytes = (chunks: readonly Uint8Array[]) => {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};
