import { readFile } from "node:fs/promises";
import { Config, Effect, Option, Redacted, Schema } from "effect";

class BridgeKeySourceError extends Schema.TaggedErrorClass<BridgeKeySourceError>()(
  "BridgeKeySourceError",
  {
    message: Schema.String,
  }
) {}

const sourceError = (message: string) => new BridgeKeySourceError({ message });

const lineBreakPattern = /[\r\n]/;

const validateKeyText = (
  raw: string,
  emptyMessage: string,
  multiLineMessage: string
): Effect.Effect<Redacted.Redacted<string>, BridgeKeySourceError> => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return Effect.fail(sourceError(emptyMessage));
  }
  if (lineBreakPattern.test(trimmed)) {
    return Effect.fail(sourceError(multiLineMessage));
  }
  return Effect.succeed(Redacted.make(trimmed));
};

const readKeyFile = (path: string) =>
  Effect.tryPromise({
    catch: () => sourceError("The key file could not be read."),
    try: () => readFile(path, "utf8"),
  }).pipe(
    Effect.flatMap((raw) =>
      validateKeyText(
        raw,
        "The key file is empty.",
        "The key file must contain one bridge key on a single line."
      )
    )
  );

const readKeyStdin = Effect.tryPromise({
  catch: () => sourceError("Stdin could not be read."),
  try: () => Bun.stdin.text(),
}).pipe(
  Effect.flatMap((raw) =>
    validateKeyText(
      raw,
      "Stdin provided no bridge key.",
      "Stdin must contain one bridge key on a single line."
    )
  )
);

const environmentKey = Config.redacted("DUMBRIDGE_KEY").pipe(
  Effect.mapError(() =>
    sourceError(
      "No bridge key is set. Set DUMBRIDGE_KEY or pass --key-file <path> ('-' reads stdin)."
    )
  )
);

export const resolveBridgeKey = (
  keyFile: Option.Option<string>
): Effect.Effect<Redacted.Redacted<string>, BridgeKeySourceError> =>
  Option.match(keyFile, {
    onNone: () => environmentKey,
    onSome: (path) => (path === "-" ? readKeyStdin : readKeyFile(path)),
  });
