import { Endpoint } from "@number0/iroh";
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

// The published @number0/iroh binding omits the proxy builder methods; only
// the patched binding exposes proxyUrl. Callers probe this before committing
// a dial to a proxy the adapter would otherwise have to reject as a
// configuration dead-end. A binding too broken to construct a builder cannot
// proxy either; the dial's own builder creation then surfaces the branded
// construction failure, so the probe stays total instead of throwing.
export const irohBindingSupportsProxy = (builder?: object): boolean => {
  try {
    const probe = builder ?? Endpoint.builder();
    return (probe as ProxyAwareEndpointBuilder).proxyUrl !== undefined;
  } catch {
    return false;
  }
};

const proxyEnvironmentKeys = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

// Truthiness, not presence: empty proxy variables (common placeholder
// exports) never count as a configured proxy. The CLI's transport selection
// and the doctor diagnosis share this one predicate so the two can never
// disagree about whether an environment is proxied.
export const hasProxyEnvironment = (environment: ProxyEnvironment) =>
  proxyEnvironmentKeys.some((key) => Boolean(environment[key]));

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

// The environment is a required value threaded from the CLI shell: a
// process.env default here would smuggle an ambient effect through the
// BridgeTransport seam and let a dial silently read a different environment
// than the one the client committed to.
export const configureIrohProxy = (
  builder: object,
  proxy: IrohProxyConfiguration,
  environment: ProxyEnvironment
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
