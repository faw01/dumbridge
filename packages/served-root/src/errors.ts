import { Schema } from "effect";

export type ServedRootLimit = "file-read" | "overlay" | "overlay-entries";

export class InvalidServedRootError extends Schema.TaggedErrorClass<InvalidServedRootError>()(
  "InvalidServedRootError",
  { message: Schema.String }
) {}

export class ServedRootChangedError extends Schema.TaggedErrorClass<ServedRootChangedError>()(
  "ServedRootChangedError",
  { message: Schema.String }
) {}

export class ServedRootPathError extends Schema.TaggedErrorClass<ServedRootPathError>()(
  "ServedRootPathError",
  {
    path: Schema.String,
    reason: Schema.String,
  }
) {}

export class ServedRootNotFoundError extends Schema.TaggedErrorClass<ServedRootNotFoundError>()(
  "ServedRootNotFoundError",
  { path: Schema.String }
) {}

export class ServedRootSymlinkError extends Schema.TaggedErrorClass<ServedRootSymlinkError>()(
  "ServedRootSymlinkError",
  { path: Schema.String }
) {}

export class ServedRootEntryTypeError extends Schema.TaggedErrorClass<ServedRootEntryTypeError>()(
  "ServedRootEntryTypeError",
  {
    actual: Schema.String,
    expected: Schema.String,
    path: Schema.String,
  }
) {}

export class ServedRootSourceChangedError extends Schema.TaggedErrorClass<ServedRootSourceChangedError>()(
  "ServedRootSourceChangedError",
  { path: Schema.String }
) {}

export class ServedRootFileLimitError extends Schema.TaggedErrorClass<ServedRootFileLimitError>()(
  "ServedRootFileLimitError",
  {
    maximum: Schema.Number,
    observed: Schema.Number,
    path: Schema.String,
  }
) {}

export class ServedRootIOError extends Schema.TaggedErrorClass<ServedRootIOError>()(
  "ServedRootIOError",
  {
    operation: Schema.String,
    path: Schema.String,
  }
) {}

export class ServedRootLimitSignal extends Error {
  readonly limit: ServedRootLimit;

  constructor(limit: ServedRootLimit) {
    super(`served root ${limit} limit exceeded`);
    this.limit = limit;
  }
}

export const servedRootChanged = () =>
  new ServedRootChangedError({
    message: "served root changed after bridge start",
  });

export const sourceChanged = (path: string) =>
  new ServedRootSourceChangedError({ path });
