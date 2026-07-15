import { Effect } from "effect";
import {
  BridgeProxyConfigurationError,
  BridgeProxyUnsupportedError,
} from "../index";

export type IrohProxyConfiguration =
  | { readonly _tag: "Disabled" }
  | { readonly _tag: "FromEnvironment" }
  | { readonly _tag: "Url"; readonly url: string };

interface ProxyAwareEndpointBuilder {
  readonly proxyUrl?: (url: string) => void;
}

export type ProxyEnvironment = Readonly<Record<string, string | undefined>>;

const proxyEnvironmentKeys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

const proxyUrlFromEnvironment = (
  environment: ProxyEnvironment
): Effect.Effect<string, BridgeProxyConfigurationError> => {
  const isCgi = environment.REQUEST_METHOD !== undefined;

  for (const key of proxyEnvironmentKeys) {
    if (key === "HTTP_PROXY" && isCgi) {
      continue;
    }

    const candidate = environment[key];
    if (candidate === undefined) {
      continue;
    }

    try {
      const url = new URL(candidate);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.hostname.length > 0
      ) {
        return Effect.succeed(url.toString());
      }
    } catch {
      // Try the next conventional proxy environment variable.
    }
  }

  return new BridgeProxyConfigurationError({
    message:
      "No valid HTTP(S) proxy was found in the proxy environment variables.",
    requested: "environment",
  });
};

export const configureIrohProxy = (
  builder: object,
  proxy: IrohProxyConfiguration,
  environment: ProxyEnvironment = process.env
): Effect.Effect<
  void,
  BridgeProxyConfigurationError | BridgeProxyUnsupportedError
> => {
  if (proxy._tag === "Disabled") {
    return Effect.void;
  }

  const proxyAwareBuilder = builder as ProxyAwareEndpointBuilder;
  const requested = proxy._tag === "FromEnvironment" ? "environment" : "url";
  if (proxyAwareBuilder.proxyUrl === undefined) {
    return new BridgeProxyUnsupportedError({
      message:
        "The installed @number0/iroh binding does not expose proxy configuration.",
      requested,
    });
  }

  const proxyUrl =
    proxy._tag === "FromEnvironment"
      ? proxyUrlFromEnvironment(environment)
      : Effect.succeed(proxy.url);

  return proxyUrl.pipe(
    Effect.flatMap((url) =>
      Effect.try({
        catch: () =>
          new BridgeProxyConfigurationError({
            message: "Could not configure the Iroh proxy.",
            requested,
          }),
        try: () => proxyAwareBuilder.proxyUrl?.(url),
      })
    )
  );
};
