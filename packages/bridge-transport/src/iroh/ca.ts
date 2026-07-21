import { Endpoint } from "@number0/iroh";
import { Effect } from "effect";
import {
  BridgeCaTrustConfigurationError,
  BridgeCaTrustUnsupportedError,
} from "../index";

export type IrohCaTrustConfiguration =
  | { readonly _tag: "Disabled" }
  | { readonly _tag: "ExtraRootsPem"; readonly pem: string };

interface CaTrustAwareEndpointBuilder {
  readonly caExtraRootsPem?: (pem: string) => void;
}

export const caTrustUnsupportedMessage =
  "The installed @number0/iroh binding does not expose extra CA root configuration.";

export const irohBindingSupportsCaTrust = (builder?: object): boolean => {
  try {
    const probe = builder ?? Endpoint.builder();
    return (probe as CaTrustAwareEndpointBuilder).caExtraRootsPem !== undefined;
  } catch {
    return false;
  }
};

export interface CaTrustSource {
  readonly name: "DUMBRIDGE_CA_FILE" | "CODEX_PROXY_CERT" | "SSL_CERT_FILE";
  readonly path: string;
}

const caTrustSourceNames = [
  "DUMBRIDGE_CA_FILE",
  "CODEX_PROXY_CERT",
  "SSL_CERT_FILE",
] as const;

export const caTrustSourceFromEnvironment = (
  environment: Readonly<Record<string, string | undefined>>
): CaTrustSource | undefined => {
  for (const name of caTrustSourceNames) {
    const path = environment[name];
    if (path) {
      return { name, path };
    }
  }
};

export const configureIrohCaTrust = (
  builder: object,
  caTrust: IrohCaTrustConfiguration
): Effect.Effect<
  void,
  BridgeCaTrustConfigurationError | BridgeCaTrustUnsupportedError
> => {
  if (caTrust._tag === "Disabled") {
    return Effect.void;
  }

  const caTrustAwareBuilder = builder as CaTrustAwareEndpointBuilder;
  if (caTrustAwareBuilder.caExtraRootsPem === undefined) {
    return new BridgeCaTrustUnsupportedError({
      message: caTrustUnsupportedMessage,
    });
  }

  return Effect.try({
    catch: () =>
      new BridgeCaTrustConfigurationError({
        message: "Could not configure the extra Iroh CA roots.",
      }),
    try: () => caTrustAwareBuilder.caExtraRootsPem?.(caTrust.pem),
  });
};
