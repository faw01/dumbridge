import { Result, Schema } from "effect";

export const maximumRemotePathCharacters = 4096;

const RemotePathSchema = Schema.String.pipe(
  Schema.brand("@Dumbridge/RemotePath")
);

export type RemotePath = typeof RemotePathSchema.Type;

export interface ParsedRemotePath {
  readonly path: RemotePath;
  readonly segments: readonly string[];
}

export class InvalidRemotePathError extends Schema.TaggedErrorClass<InvalidRemotePathError>()(
  "InvalidRemotePathError",
  { path: Schema.String }
) {}

// The canonical form is the strict union of every rule the wire, the served
// root, and the pull receiver enforced before consolidation. Loosening any
// rule here widens the security boundary on all of them at once.
const windowsDrivePattern = /^[a-z]:/i;
const windowsForbiddenCharacterPattern = /[<>:"|?*]/;
const windowsReservedBasePattern =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

const hasControlCharacter = (segment: string) =>
  Array.from(segment).some((character) => character.charCodeAt(0) < 32);

const isCanonicalSegment = (segment: string) => {
  if (segment.length === 0 || segment === "." || segment === "..") {
    return false;
  }
  if (segment.endsWith(".") || segment.endsWith(" ")) {
    return false;
  }
  if (
    hasControlCharacter(segment) ||
    windowsForbiddenCharacterPattern.test(segment)
  ) {
    return false;
  }
  const windowsBase = segment.split(".", 1)[0]?.trimEnd() ?? "";
  return !windowsReservedBasePattern.test(windowsBase);
};

const isCanonicalRemotePath = (path: string, segments: readonly string[]) =>
  path.length > 0 &&
  path.length <= maximumRemotePathCharacters &&
  !path.includes("\0") &&
  !path.includes("\\") &&
  !path.startsWith("/") &&
  !windowsDrivePattern.test(path) &&
  segments.every(isCanonicalSegment);

// The schema stays private so the brand can only be minted here, after the
// canonical checks above have passed.
const brandRemotePath = Schema.decodeUnknownSync(RemotePathSchema);

export const parseRemotePath = (
  path: string
): Result.Result<ParsedRemotePath, InvalidRemotePathError> => {
  const segments = path.split("/");
  if (!isCanonicalRemotePath(path, segments)) {
    return Result.fail(new InvalidRemotePathError({ path }));
  }
  return Result.succeed({ path: brandRemotePath(path), segments });
};
