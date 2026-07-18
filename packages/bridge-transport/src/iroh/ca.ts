import { Endpoint } from "@number0/iroh";
import { Effect } from "effect";
import {
  BridgeCaTrustConfigurationError,
  BridgeCaTrustUnsupportedError,
} from "../index";

// Extra CA roots exist for TLS-intercepting proxies (Codex Cloud's Envoy
// MITM): the same rustls configuration verifies the proxy's TLS and the
// relay TLS inside the CONNECT tunnel, so one extra root covers both. Trust
// is additive only — the binding layers the given certificates on top of the
// embedded WebPKI roots and exposes no replace or verify-off form. The PEM
// contents (never a file path) cross this seam so all file I/O stays at the
// CLI edge.
export type IrohCaTrustConfiguration =
  | { readonly _tag: "Disabled" }
  | { readonly _tag: "ExtraRootsPem"; readonly pem: string };

interface CaTrustAwareEndpointBuilder {
  readonly caExtraRootsPem?: (pem: string) => void;
}

// One string for the dial's branded failure and the doctor's check detail,
// so the two surfaces can never drift apart.
export const caTrustUnsupportedMessage =
  "The installed @number0/iroh binding does not expose extra CA root configuration.";

// The published @number0/iroh binding omits the CA trust builder method
// (iroh's Rust core has carried it since CaTlsConfig::with_extra_roots, but
// the Node-API binding does not surface it); only the patched dumbridge-iroh
// binding exposes caExtraRootsPem. Callers probe this before committing to
// extra roots the adapter would otherwise have to reject as a configuration
// dead-end. The probe mirrors irohBindingSupportsProxy: a binding too broken
// to construct a builder cannot trust roots either, so the probe stays total
// instead of throwing.
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

// Precedence: the dumbridge-specific override wins, then the Codex Cloud
// sandbox variable, then the generic OpenSSL convention. Truthiness, not
// presence: an empty variable never counts, mirroring hasProxyEnvironment so
// the CLI's transport selection and the doctor diagnosis can never disagree.
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

  // The native error string may echo the PEM it failed to parse, so it never
  // reaches the branded failure.
  return Effect.try({
    catch: () =>
      new BridgeCaTrustConfigurationError({
        message: "Could not configure the extra Iroh CA roots.",
      }),
    try: () => caTrustAwareBuilder.caExtraRootsPem?.(caTrust.pem),
  });
};
