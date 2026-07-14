import { dlopen, FFIType, ptr } from "bun:ffi";

type NativeMove = (source: string, destination: string) => boolean;

const atWorkingDirectory = -100;
const renameExclusive = 4;
const renameNoReplace = 1;

const posixPath = (path: string) => {
  if (path.includes("\0")) {
    throw new Error("filesystem paths cannot contain null bytes");
  }
  return Buffer.from(`${path}\0`);
};

const windowsPath = (path: string) => {
  if (path.includes("\0")) {
    throw new Error("filesystem paths cannot contain null bytes");
  }
  return Buffer.from(`${path}\0`, "utf16le");
};

const muslArchitecture = (architecture: string) => {
  switch (architecture) {
    case "arm64":
      return "aarch64";
    case "x64":
      return "x86_64";
    default:
      return;
  }
};

export const linuxLibcCandidates = (architecture = process.arch) => {
  const musl = muslArchitecture(architecture);
  return [
    "libc.so.6",
    ...(musl === undefined
      ? []
      : [`/lib/libc.musl-${musl}.so.1`, `/lib/ld-musl-${musl}.so.1`]),
  ];
};

const linuxMove = (): NativeMove => {
  let loadFailure: unknown;

  for (const candidate of linuxLibcCandidates()) {
    try {
      const library = dlopen(candidate, {
        renameat2: {
          args: [
            FFIType.i32,
            FFIType.ptr,
            FFIType.i32,
            FFIType.ptr,
            FFIType.u32,
          ],
          returns: FFIType.i32,
        },
      });

      return (source, destination) => {
        const sourcePath = posixPath(source);
        const destinationPath = posixPath(destination);
        return (
          library.symbols.renameat2(
            atWorkingDirectory,
            ptr(sourcePath),
            atWorkingDirectory,
            ptr(destinationPath),
            renameNoReplace
          ) === 0
        );
      };
    } catch (cause) {
      loadFailure = cause;
    }
  }

  throw new Error(
    `atomic directory moves are unavailable for Linux ${process.arch}`,
    { cause: loadFailure }
  );
};

const macosMove = (): NativeMove => {
  const library = dlopen("libc.dylib", {
    renamex_np: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });

  return (source, destination) => {
    const sourcePath = posixPath(source);
    const destinationPath = posixPath(destination);
    return (
      library.symbols.renamex_np(
        ptr(sourcePath),
        ptr(destinationPath),
        renameExclusive
      ) === 0
    );
  };
};

const windowsMove = (): NativeMove => {
  const library = dlopen("kernel32.dll", {
    MoveFileExW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  });

  return (source, destination) => {
    const sourcePath = windowsPath(source);
    const destinationPath = windowsPath(destination);
    return (
      library.symbols.MoveFileExW(ptr(sourcePath), ptr(destinationPath), 0) !==
      0
    );
  };
};

const loadNativeMove = (): NativeMove => {
  const platform: string = process.platform;
  switch (platform) {
    case "darwin":
      return macosMove();
    case "linux":
      return linuxMove();
    case "win32":
      return windowsMove();
    default:
      throw new Error("atomic directory moves are unavailable");
  }
};

let nativeMove: NativeMove | undefined;

export const moveDirectoryNoReplace = (
  source: string,
  destination: string
): boolean => {
  nativeMove ??= loadNativeMove();
  return nativeMove(source, destination);
};
