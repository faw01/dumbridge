import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";
import { maximumRemotePathCharacters, parseRemotePath } from "../src/index";

describe("remote path", () => {
  it("accepts canonical relative paths and returns their segments", () => {
    const accepted: readonly (readonly [string, readonly string[]])[] = [
      ["a", ["a"]],
      [".agents", [".agents"]],
      ["folder/file.txt", ["folder", "file.txt"]],
      ["deep/nested/path", ["deep", "nested", "path"]],
      ["photos/IMG2123.jpg", ["photos", "IMG2123.jpg"]],
      ["console", ["console"]],
      ["com0.txt", ["com0.txt"]],
      ["$dollar", ["$dollar"]],
      ["caf\u00e9", ["caf\u00e9"]],
      ["a".repeat(maximumRemotePathCharacters), ["a".repeat(4096)]],
    ];

    for (const [path, segments] of accepted) {
      const parsed = parseRemotePath(path);
      expect(Result.isSuccess(parsed)).toBe(true);
      if (Result.isSuccess(parsed)) {
        expect(String(parsed.success.path)).toBe(path);
        expect(parsed.success.segments).toEqual(segments);
      }
    }
  });

  it("rejects traversal, absolute, separator-trick, and Windows-unsafe paths", () => {
    const rejected: readonly string[] = [
      "",
      "/absolute",
      "../escape",
      "folder/../escape",
      "folder/./file",
      "./file",
      "folder//file",
      "folder/",
      "folder\\file",
      "C:relative",
      "c:/absolute",
      "folder/secret\0.txt",
      "folder/file.txt:stream",
      "folder/CON",
      "folder/CON .txt",
      "con.d",
      "CONIN$",
      "conout$.log",
      "AUX .log",
      "com1.txt",
      "lpt\u00b9",
      "folder/name.",
      "folder/name ",
      "folder/has<angle",
      "pipe|name",
      "question?mark",
      "star*name",
      'quote"name',
      "tab\tname",
      "a".repeat(maximumRemotePathCharacters + 1),
    ];

    for (const path of rejected) {
      const parsed = parseRemotePath(path);
      expect(Result.isFailure(parsed)).toBe(true);
      if (Result.isFailure(parsed)) {
        expect(parsed.failure).toMatchObject({
          _tag: "InvalidRemotePathError",
          path,
        });
      }
    }
  });
});
