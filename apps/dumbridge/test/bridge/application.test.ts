import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeBridgeKey,
  mintCapability,
  parseBridgeKey,
} from "@dumbridge/bridge-key";
import { makeIrohTransport } from "@dumbridge/bridge-transport/iroh";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { pullRemote, runRemote } from "../../src/bridge/client";
import { openBridge } from "../../src/bridge/server";

let fixture = "";
let servedRoot = "";
let destinationRoot = "";

beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), "dumbridge-application-"));
  servedRoot = join(fixture, "served");
  destinationRoot = join(fixture, "cloud");
  await Promise.all([
    mkdir(join(servedRoot, ".agents", "skills", "wayfinder"), {
      recursive: true,
    }),
    mkdir(join(servedRoot, "photos"), { recursive: true }),
    mkdir(destinationRoot),
  ]);
  await Promise.all([
    writeFile(
      join(servedRoot, ".agents", "skills", "wayfinder", "SKILL.md"),
      "# Wayfinder\n"
    ),
    writeFile(join(servedRoot, ".env"), "TOKEN=local-only\n"),
    writeFile(
      join(servedRoot, "photos", "IMG2123.jpg"),
      Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9)
    ),
  ]);
});

afterEach(async () => {
  await rm(fixture, { force: true, recursive: true });
});

const makeLoopbackTransport = () =>
  makeIrohTransport({
    deadlines: {
      accept: "3 seconds",
      connect: "3 seconds",
      io: "3 seconds",
      listen: "3 seconds",
    },
    reachability: "direct-only",
  });

const success = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};

describe("dumbridge application", () => {
  it.live(
    "discovers live files and pulls selected text, secrets, and binary data",
    () =>
      Effect.gen(function* () {
        const imageDestination = join(destinationRoot, "cat.jpg");
        const envDestination = join(destinationRoot, ".env.local");
        const skillDestination = join(destinationRoot, "wayfinder");

        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const transport = makeLoopbackTransport();
            const server = yield* openBridge({ root: servedRoot, transport });
            yield* server.serve.pipe(Effect.forkScoped);

            yield* Effect.promise(() =>
              writeFile(join(servedRoot, "uncommitted.txt"), "not in git\n")
            );
            const discovery = yield* runRemote({
              link: server.link,
              script:
                "find . -name SKILL.md -o -name 'IMG*.jpg' -o -name .env -o -name uncommitted.txt | sort",
              transport,
            });
            const preview = yield* runRemote({
              link: server.link,
              script: "sed -n '1,10p' .agents/skills/wayfinder/SKILL.md",
              transport,
            });
            const overlayWrite = yield* runRemote({
              link: server.link,
              script: "echo changed > uncommitted.txt; cat uncommitted.txt",
              transport,
            });
            const unchanged = yield* runRemote({
              link: server.link,
              script: "cat uncommitted.txt",
              transport,
            });

            const image = yield* pullRemote({
              destination: imageDestination,
              link: server.link,
              remotePath: "photos/IMG2123.jpg",
              transport,
            });
            const env = yield* pullRemote({
              destination: envDestination,
              link: server.link,
              remotePath: ".env",
              transport,
            });
            const skill = yield* pullRemote({
              destination: skillDestination,
              link: server.link,
              remotePath: ".agents/skills/wayfinder",
              transport,
            });

            return {
              discovery,
              env,
              image,
              overlayWrite,
              preview,
              skill,
              unchanged,
            };
          })
        );

        expect(result.discovery.served).toBe("served");
        expect(result.preview.served).toBeUndefined();
        expect(result.overlayWrite.served).toBeUndefined();
        expect(result.discovery.stdout).toContain(
          "./.agents/skills/wayfinder/SKILL.md"
        );
        expect(result.discovery.stdout).toContain("./photos/IMG2123.jpg");
        expect(result.discovery.stdout).toContain("./uncommitted.txt");
        expect(result.preview.stdout).toBe("# Wayfinder\n");
        expect(result.overlayWrite.stdout).toBe("changed\n");
        expect(result.unchanged.stdout).toBe("not in git\n");
        expect(result.image.bytes).toBe(9);
        expect(result.env.bytes).toBe(17);
        expect(result.skill.files).toBe(1);
        expect(
          yield* Effect.promise(() => readFile(envDestination, "utf8"))
        ).toBe("TOKEN=local-only\n");
        expect(
          yield* Effect.promise(() =>
            readFile(join(skillDestination, "SKILL.md"), "utf8")
          )
        ).toBe("# Wayfinder\n");
        expect(
          new Uint8Array(
            yield* Effect.promise(() => readFile(imageDestination))
          )
        ).toEqual(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9));
      }),
    15_000
  );

  it.live(
    "rejects a link with the right locator and the wrong capability",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.scoped(
          Effect.gen(function* () {
            const transport = makeLoopbackTransport();
            const server = yield* openBridge({ root: servedRoot, transport });
            yield* server.serve.pipe(Effect.forkScoped);
            const decoded = success(parseBridgeKey(server.link));
            const wrongKey = success(
              encodeBridgeKey({
                capability: mintCapability(),
                expiresAt: Number.MAX_SAFE_INTEGER,
                locator: decoded.locator,
                transport: "iroh",
              })
            );

            return yield* runRemote({
              link: wrongKey,
              script: "cat .env",
              transport,
            }).pipe(Effect.flip);
          })
        );

        expect(error).toMatchObject({
          _tag: "BridgeClientError",
          message:
            "The bridge rejected the bridge key: the key does not match this bridge. Copy the current key printed by dumbridge serve.",
          operation: "bridge-key",
        });
        expect(JSON.stringify(error)).not.toContain("TOKEN=local-only");
      }),
    10_000
  );
});
