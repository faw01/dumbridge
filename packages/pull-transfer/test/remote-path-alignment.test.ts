import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { encodeFrame, type PullManifest } from "@dumbridge/wire";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { materializePull, resolvePullDestination } from "../src/index";
import { oneChunk, withFixture } from "./support";

const emptySha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const candidates: readonly (readonly [string, boolean])[] = [
  ["file.txt", true],
  [".agents", true],
  ["folder/nested/file.txt", true],
  ["photos/IMG2123.jpg", true],
  ["console/log.txt", true],
  ["", false],
  ["/etc/passwd", false],
  ["../secret", false],
  ["folder/../secret", false],
  ["folder//secret", false],
  ["folder/./secret", false],
  ["folder\\secret", false],
  ["C:secret", false],
  ["folder/secret\0.txt", false],
  ["folder/file.txt:stream", false],
  ["folder/CON", false],
  ["folder/CON .txt", false],
  ["CONIN$", false],
  ["conout$.log", false],
  ["com1.txt", false],
  ["folder/name.", false],
  ["folder/name ", false],
  ["folder/has<angle", false],
  [`folder/${"a".repeat(4096)}`, false],
];

const receiverAcceptsPath = (remotePath: string) =>
  Result.isSuccess(resolvePullDestination(remotePath, "ignored-destination"));

describe("remote path alignment", () => {
  it("wire and receiver accept and reject identical pull paths", () => {
    for (const [remotePath, accepted] of candidates) {
      const wireAccepts = Result.isSuccess(
        encodeFrame({ remotePath, type: "pull" })
      );
      expect(`${remotePath}:${wireAccepts}`).toBe(`${remotePath}:${accepted}`);
      expect(`${remotePath}:${receiverAcceptsPath(remotePath)}`).toBe(
        `${remotePath}:${accepted}`
      );
    }
  });

  it.effect(
    "wire and receiver accept and reject identical manifest entry paths",
    () =>
      withFixture(({ workspace }) =>
        Effect.gen(function* () {
          const singleSegment = candidates.filter(
            ([path]) => path.length > 0 && !path.includes("/")
          );
          const outcomes = yield* Effect.all(
            singleSegment.map(([entryPath, accepted], index) => {
              const manifest: PullManifest = {
                digestAlgorithm: "sha256",
                entries: [
                  {
                    digest: emptySha256,
                    kind: "file",
                    path: entryPath,
                    size: 0,
                  },
                ],
                kind: "file",
                name: entryPath,
                totalBytes: 0,
              };
              const wireAccepts = Result.isSuccess(
                encodeFrame({ manifest, type: "manifest" })
              );
              return materializePull({
                destination: join(workspace, `entry-${index}`),
                manifest,
                read: () => oneChunk(new Uint8Array()),
              }).pipe(
                Effect.map(() => true),
                Effect.catch((error) =>
                  error._tag === "PullPathError"
                    ? Effect.succeed(false)
                    : Effect.fail(error)
                ),
                Effect.map((receiverAccepts) => ({
                  accepted,
                  entryPath,
                  index,
                  receiverAccepts,
                  wireAccepts,
                }))
              );
            }),
            { concurrency: "unbounded" }
          );

          for (const outcome of outcomes) {
            expect(`${outcome.entryPath}:${outcome.wireAccepts}`).toBe(
              `${outcome.entryPath}:${outcome.accepted}`
            );
            expect(`${outcome.entryPath}:${outcome.receiverAccepts}`).toBe(
              `${outcome.entryPath}:${outcome.accepted}`
            );
          }
          const materialized = outcomes
            .filter((outcome) => outcome.accepted)
            .map((outcome) => `entry-${outcome.index}`)
            .sort();
          expect(
            (yield* Effect.promise(() => readdir(workspace))).sort()
          ).toEqual(materialized);
        })
      )
  );
});
