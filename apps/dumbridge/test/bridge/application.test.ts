import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { makeIrohTransport } from "../../src/bridge/adapters/iroh";
import { pullRemote, runRemote } from "../../src/bridge/client";
import {
  encodeBridgeLink,
  mintCapability,
  parseBridgeLink,
} from "../../src/bridge/link";
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

describe("Dumbridge application", () => {
  test("discovers live files and pulls selected text, secrets, and binary data", async () => {
    const imageDestination = join(destinationRoot, "cat.jpg");
    const envDestination = join(destinationRoot, ".env.local");
    const skillDestination = join(destinationRoot, "wayfinder");

    const result = await Effect.runPromise(
      Effect.scoped(
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
      )
    );

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
    expect(await Bun.file(envDestination).text()).toBe("TOKEN=local-only\n");
    expect(await Bun.file(join(skillDestination, "SKILL.md")).text()).toBe(
      "# Wayfinder\n"
    );
    expect(
      new Uint8Array(await Bun.file(imageDestination).arrayBuffer())
    ).toEqual(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9));
  }, 15_000);

  test("rejects a link with the right locator and the wrong capability", async () => {
    const error = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const transport = makeLoopbackTransport();
          const server = yield* openBridge({ root: servedRoot, transport });
          yield* server.serve.pipe(Effect.forkScoped);
          const decoded = success(parseBridgeLink(server.link));
          const wrongLink = success(
            encodeBridgeLink({
              capability: mintCapability(),
              locator: decoded.locator,
              transport: "iroh",
            })
          );

          return yield* runRemote({
            link: wrongLink,
            script: "cat .env",
            transport,
          }).pipe(Effect.flip);
        })
      )
    );

    expect(error).toMatchObject({
      _tag: "BridgeClientError",
    });
    expect(["request", "run-response"]).toContain(error.operation);
    expect(JSON.stringify(error)).not.toContain("TOKEN=local-only");
  }, 10_000);
});
