import { type Capability, CapabilityTextSchema } from "@dumbridge/bridge-key";
import { Schema } from "effect";
import {
  Digest,
  NonNegativeInt,
  PathText,
  type PullManifest,
  PullManifestSchema,
} from "./pull-manifest";

export const protocol = "dumbridge/1" as const;
export const lengthPrefixBytes = 4;
export const maximumFrameBytes = 1024 * 1024;
export const maximumHeaderBytes = maximumFrameBytes - lengthPrefixBytes;
const maximumScriptCharacters = 64 * 1024;
const maximumServedDisplayCharacters = 64;

const ServedDisplaySchema = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumServedDisplayCharacters),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point of this check
  Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f]+$/)
);

const frameTypeNames = [
  "auth",
  "banner",
  "complete",
  "exit",
  "file-chunk",
  "file-end",
  "file-start",
  "manifest",
  "pull",
  "pull-error",
  "reject",
  "run",
  "stderr",
  "stdout",
] as const;
export const knownHeaderTypes = new Set<string>(frameTypeNames);

export const AuthHeaderSchema = Schema.Struct({
  capability: CapabilityTextSchema,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("auth"),
});
const RunHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  script: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(maximumScriptCharacters)
  ),
  type: Schema.Literal("run"),
});
const PullHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  remotePath: PathText,
  type: Schema.Literal("pull"),
});
const StdoutHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("stdout"),
});
const StderrHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("stderr"),
});
const ExitHeaderSchema = Schema.Struct({
  code: Schema.Int.check(Schema.isBetween({ maximum: 255, minimum: 0 })),
  protocol: Schema.Literal(protocol),
  truncated: Schema.Boolean,
  type: Schema.Literal("exit"),
});
const ManifestHeaderSchema = Schema.Struct({
  manifest: PullManifestSchema,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("manifest"),
});
const FileStartHeaderSchema = Schema.Struct({
  path: PathText,
  protocol: Schema.Literal(protocol),
  size: NonNegativeInt,
  type: Schema.Literal("file-start"),
});
const FileChunkHeaderSchema = Schema.Struct({
  offset: NonNegativeInt,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("file-chunk"),
});
const FileEndHeaderSchema = Schema.Struct({
  digest: Digest,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("file-end"),
});
const CompleteHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("complete"),
});
const PullFailureCodeSchema = Schema.Literals([
  "invalid-path",
  "io",
  "limit",
  "not-found",
  "source-changed",
  "symlink",
]);
const PullErrorHeaderSchema = Schema.Struct({
  code: PullFailureCodeSchema,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("pull-error"),
});
const BannerHeaderSchema = Schema.Struct({
  protocol: Schema.Literal(protocol),
  served: ServedDisplaySchema,
  type: Schema.Literal("banner"),
});
const RejectCodeSchema = Schema.Literals(["expired-key", "invalid-key"]);
const RejectHeaderSchema = Schema.Struct({
  code: RejectCodeSchema,
  protocol: Schema.Literal(protocol),
  type: Schema.Literal("reject"),
});
export const RequestHeaderSchema = Schema.Union([
  RunHeaderSchema,
  PullHeaderSchema,
]);

export const WireHeaderSchema = Schema.Union([
  AuthHeaderSchema,
  RunHeaderSchema,
  PullHeaderSchema,
  BannerHeaderSchema,
  StdoutHeaderSchema,
  StderrHeaderSchema,
  ExitHeaderSchema,
  ManifestHeaderSchema,
  FileStartHeaderSchema,
  FileChunkHeaderSchema,
  FileEndHeaderSchema,
  CompleteHeaderSchema,
  PullErrorHeaderSchema,
  RejectHeaderSchema,
]);
export const WireHeaderJson = Schema.fromJsonString(WireHeaderSchema);
export const HeaderEnvelopeSchema = Schema.Struct({
  protocol: Schema.String.check(Schema.isMaxLength(128)),
  type: Schema.String.check(Schema.isMaxLength(128)),
});

export type WireHeader = typeof WireHeaderSchema.Type;
export type PullFailureCode = typeof PullFailureCodeSchema.Type;
export type RejectCode = typeof RejectCodeSchema.Type;

export type BridgeRequest =
  | { readonly script: string; readonly type: "run" }
  | { readonly remotePath: string; readonly type: "pull" };

export interface RejectEvent {
  readonly code: RejectCode;
  readonly type: "reject";
}

export type RunResponseEvent =
  | { readonly served: string; readonly type: "banner" }
  | { readonly payload: Uint8Array; readonly type: "stdout" | "stderr" }
  | {
      readonly code: number;
      readonly truncated: boolean;
      readonly type: "exit";
    }
  | RejectEvent;

export type PullResponseEvent =
  | { readonly manifest: PullManifest; readonly type: "manifest" }
  | {
      readonly path: string;
      readonly size: number;
      readonly type: "file-start";
    }
  | {
      readonly offset: number;
      readonly payload: Uint8Array;
      readonly type: "file-chunk";
    }
  | { readonly digest: string; readonly type: "file-end" }
  | { readonly code: PullFailureCode; readonly type: "pull-error" }
  | { readonly type: "complete" }
  | RejectEvent;

export type WireFrame =
  | { readonly capability: Capability; readonly type: "auth" }
  | BridgeRequest
  | RunResponseEvent
  | PullResponseEvent;

export interface RawFrame {
  readonly header: WireHeader;
  readonly payload: Uint8Array;
}
