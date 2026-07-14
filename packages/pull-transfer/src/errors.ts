import {
  ServedRootChangedError,
  ServedRootEntryTypeError,
  ServedRootFileLimitError,
  ServedRootIOError,
  ServedRootNotFoundError,
  ServedRootPathError,
  ServedRootSourceChangedError,
  ServedRootSymlinkError,
} from "@dumbridge/served-root";
import { Schema } from "effect";

export class PullPathError extends Schema.TaggedErrorClass<PullPathError>()(
  "PullPathError",
  {
    path: Schema.String,
    reason: Schema.String,
  }
) {}

export class PullNotFoundError extends Schema.TaggedErrorClass<PullNotFoundError>()(
  "PullNotFoundError",
  { path: Schema.String }
) {}

export class PullSymlinkError extends Schema.TaggedErrorClass<PullSymlinkError>()(
  "PullSymlinkError",
  { path: Schema.String }
) {}

export class PullLimitError extends Schema.TaggedErrorClass<PullLimitError>()(
  "PullLimitError",
  {
    limit: Schema.String,
    maximum: Schema.Number,
    observed: Schema.Number,
  }
) {}

export class PullRemoteLimitError extends Schema.TaggedErrorClass<PullRemoteLimitError>()(
  "PullRemoteLimitError",
  { path: Schema.String }
) {}

export class PullSourceChangedError extends Schema.TaggedErrorClass<PullSourceChangedError>()(
  "PullSourceChangedError",
  { path: Schema.String }
) {}

export class PullDestinationExistsError extends Schema.TaggedErrorClass<PullDestinationExistsError>()(
  "PullDestinationExistsError",
  { path: Schema.String }
) {}

export class PullIntegrityError extends Schema.TaggedErrorClass<PullIntegrityError>()(
  "PullIntegrityError",
  {
    actual: Schema.String,
    expected: Schema.String,
    path: Schema.String,
  }
) {}

export class PullIOError extends Schema.TaggedErrorClass<PullIOError>()(
  "PullIOError",
  {
    operation: Schema.String,
    path: Schema.String,
  }
) {}

export type PullError =
  | PullPathError
  | PullNotFoundError
  | PullSymlinkError
  | PullLimitError
  | PullRemoteLimitError
  | PullSourceChangedError
  | PullDestinationExistsError
  | PullIntegrityError
  | PullIOError
  | ServedRootChangedError;

export const changed = (path: string): PullSourceChangedError =>
  new PullSourceChangedError({ path });

const isPullError = (cause: unknown): cause is PullError =>
  cause instanceof PullPathError ||
  cause instanceof PullNotFoundError ||
  cause instanceof PullSymlinkError ||
  cause instanceof PullLimitError ||
  cause instanceof PullRemoteLimitError ||
  cause instanceof PullSourceChangedError ||
  cause instanceof PullDestinationExistsError ||
  cause instanceof PullIntegrityError ||
  cause instanceof PullIOError ||
  cause instanceof ServedRootChangedError;

export const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

export const mapPullError = (
  cause: unknown,
  operation: string,
  path: string
): PullError => {
  if (isPullError(cause)) {
    return cause;
  }
  if (cause instanceof ServedRootPathError) {
    return new PullPathError({ path: cause.path, reason: cause.reason });
  }
  if (cause instanceof ServedRootNotFoundError) {
    return new PullNotFoundError({ path: cause.path });
  }
  if (cause instanceof ServedRootSymlinkError) {
    return new PullSymlinkError({ path: cause.path });
  }
  if (cause instanceof ServedRootEntryTypeError) {
    return new PullPathError({
      path: cause.path,
      reason:
        cause.expected === "file" ? "not a regular file" : "not a directory",
    });
  }
  if (cause instanceof ServedRootSourceChangedError) {
    return changed(cause.path);
  }
  if (cause instanceof ServedRootFileLimitError) {
    return new PullLimitError({
      limit: "file bytes",
      maximum: cause.maximum,
      observed: cause.observed,
    });
  }
  if (cause instanceof ServedRootIOError) {
    return new PullIOError({
      operation: cause.operation,
      path: cause.path,
    });
  }
  return new PullIOError({ operation, path });
};
