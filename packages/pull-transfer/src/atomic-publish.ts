import { dlopen, read } from "bun:ffi";

export type PublishPathResult =
  | { readonly status: "published" }
  | { readonly code: number; readonly status: "destination-exists" }
  | { readonly code?: number; readonly status: "unsupported" }
  | { readonly code: number; readonly status: "io-error" };

type PublishPath = (source: string, destination: string) => PublishPathResult;

type PublisherState =
  | { readonly publish: PublishPath; readonly status: "loaded" }
  | { readonly status: "unsupported" };

let publisherState: PublisherState | undefined;

const cString = (value: string) => Buffer.from(`${value}\0`);

const wideString = (value: string) => Buffer.from(`${value}\0`, "utf16le");

const posixResult = (
  code: number,
  options: {
    readonly destinationExists: readonly number[];
    readonly unsupported: readonly number[];
  }
): PublishPathResult => {
  if (options.destinationExists.includes(code)) {
    return { code, status: "destination-exists" };
  }
  if (options.unsupported.includes(code)) {
    return { code, status: "unsupported" };
  }
  return { code, status: "io-error" };
};

const macOSPublisher = (): PublishPath => {
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    __error: {
      args: [],
      returns: "ptr",
    },
    renameatx_np: {
      args: ["i32", "ptr", "i32", "ptr", "u32"],
      returns: "i32",
    },
  });
  const { __error, renameatx_np } = library.symbols;
  const atCurrentWorkingDirectory = -2;
  const renameExclusive = 4;

  return (source, destination) => {
    const result = renameatx_np(
      atCurrentWorkingDirectory,
      cString(source),
      atCurrentWorkingDirectory,
      cString(destination),
      renameExclusive
    );
    if (result === 0) {
      return { status: "published" };
    }
    const errorPointer = __error();
    if (errorPointer === null) {
      return { status: "unsupported" };
    }
    const code = read.i32(errorPointer, 0);
    return posixResult(code, {
      destinationExists: [17, 66],
      unsupported: [22, 45, 78],
    });
  };
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

export const linuxLibraryCandidates = (architecture = process.arch) => {
  const musl = muslArchitecture(architecture);
  return [
    "libc.so.6",
    ...(musl === undefined
      ? []
      : [`/lib/libc.musl-${musl}.so.1`, `/lib/ld-musl-${musl}.so.1`]),
  ];
};

export const linuxRenameat2SyscallNumber = (architecture = process.arch) => {
  switch (architecture) {
    case "arm64":
      return 276;
    case "x64":
      return 316;
    default:
      return;
  }
};

const directLinuxPublisher = (candidate: string): PublishPath => {
  const library = dlopen(candidate, {
    __errno_location: {
      args: [],
      returns: "ptr",
    },
    renameat2: {
      args: ["i32", "ptr", "i32", "ptr", "u32"],
      returns: "i32",
    },
  });
  const { __errno_location, renameat2 } = library.symbols;
  const atCurrentWorkingDirectory = -100;
  const renameNoReplace = 1;

  return (source, destination) => {
    const result = renameat2(
      atCurrentWorkingDirectory,
      cString(source),
      atCurrentWorkingDirectory,
      cString(destination),
      renameNoReplace
    );
    if (result === 0) {
      return { status: "published" };
    }
    const errorPointer = __errno_location();
    if (errorPointer === null) {
      return { status: "unsupported" };
    }
    const code = read.i32(errorPointer, 0);
    return posixResult(code, {
      destinationExists: [17, 39],
      unsupported: [22, 38, 95],
    });
  };
};

const syscallLinuxPublisher = (
  candidate: string,
  syscallNumber: number
): PublishPath => {
  const library = dlopen(candidate, {
    __errno_location: {
      args: [],
      returns: "ptr",
    },
    syscall: {
      args: ["i64", "i64", "ptr", "i64", "ptr", "u64"],
      returns: "i64",
    },
  });
  const { __errno_location, syscall } = library.symbols;
  const atCurrentWorkingDirectory = -100;
  const renameNoReplace = 1;

  return (source, destination) => {
    const result = syscall(
      syscallNumber,
      atCurrentWorkingDirectory,
      cString(source),
      atCurrentWorkingDirectory,
      cString(destination),
      renameNoReplace
    );
    if (result === 0n) {
      return { status: "published" };
    }
    const errorPointer = __errno_location();
    if (errorPointer === null) {
      return { status: "unsupported" };
    }
    const code = read.i32(errorPointer, 0);
    return posixResult(code, {
      destinationExists: [17, 39],
      unsupported: [22, 38, 95],
    });
  };
};

const tryLinuxPublisher = (
  load: () => PublishPath
): PublishPath | undefined => {
  try {
    return load();
  } catch {
    //
  }
};

const linuxPublisher = (): PublishPath => {
  const syscallNumber = linuxRenameat2SyscallNumber();

  for (const candidate of linuxLibraryCandidates()) {
    const direct = tryLinuxPublisher(() => directLinuxPublisher(candidate));
    if (direct !== undefined) {
      return direct;
    }
    if (syscallNumber !== undefined) {
      const fallback = tryLinuxPublisher(() =>
        syscallLinuxPublisher(candidate, syscallNumber)
      );
      if (fallback !== undefined) {
        return fallback;
      }
    }
  }

  throw new Error(
    `atomic path publication is unavailable for Linux ${process.arch}`
  );
};

const windowsPublisher = (): PublishPath => {
  const library = dlopen("kernel32.dll", {
    GetLastError: {
      args: [],
      returns: "u32",
    },
    MoveFileExW: {
      args: ["ptr", "ptr", "u32"],
      returns: "i32",
    },
  });
  const { GetLastError, MoveFileExW } = library.symbols;

  return (source, destination) => {
    if (MoveFileExW(wideString(source), wideString(destination), 0) !== 0) {
      return { status: "published" };
    }
    const code = GetLastError();
    if (code === 80 || code === 183) {
      return { code, status: "destination-exists" };
    }
    if (code === 1 || code === 50 || code === 120) {
      return { code, status: "unsupported" };
    }
    return { code, status: "io-error" };
  };
};

const loadPublisher = (): PublishPath => {
  const platform: string = process.platform;
  switch (platform) {
    case "darwin":
      return macOSPublisher();
    case "linux":
      return linuxPublisher();
    case "win32":
      return windowsPublisher();
    default:
      throw new Error(`atomic path publication is unsupported on ${platform}`);
  }
};

const publisher = (): PublisherState => {
  if (publisherState) {
    return publisherState;
  }
  try {
    publisherState = { publish: loadPublisher(), status: "loaded" };
  } catch {
    publisherState = { status: "unsupported" };
  }
  return publisherState;
};

export const publishPathNoReplace = (
  source: string,
  destination: string
): PublishPathResult => {
  const state = publisher();
  return state.status === "loaded"
    ? state.publish(source, destination)
    : { status: "unsupported" };
};
