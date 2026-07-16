import {
  diagnoseIrohEnvironment,
  type IrohDiagnosticProbes,
} from "@dumbridge/bridge-transport/iroh";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

const relayHosts = ["relay-a.example", "relay-b.example"];

const healthyProbes: IrohDiagnosticProbes = {
  makeEndpointBuilder: () => ({ proxyUrl: () => undefined }),
  openTcp: () => Promise.resolve(),
  resolveHost: () => Promise.resolve(),
  sendUdpProbe: () => Promise.resolve(),
};

const diagnose = (
  probes: Partial<IrohDiagnosticProbes>,
  environment: Readonly<Record<string, string | undefined>> = {}
) =>
  diagnoseIrohEnvironment({
    environment,
    probes: { ...healthyProbes, ...probes },
    relayHosts,
  });

describe("Iroh environment diagnosis", () => {
  it.effect("reports four ok checks in a healthy direct network", () =>
    Effect.gen(function* () {
      const checks = yield* diagnose({});

      expect(checks).toEqual([
        {
          detail:
            "Resolved all 2 iroh relay hosts: relay-a.example, relay-b.example.",
          name: "dns-resolution",
          status: "ok",
        },
        {
          detail:
            "A UDP datagram to a public DNS resolver was answered; UDP egress and a return path are available, so direct peer-to-peer connections may be possible.",
          name: "udp-egress",
          status: "ok",
        },
        {
          detail:
            "All 2 iroh relay hosts accepted a TCP connection on port 443.",
          name: "relay-reachability",
          status: "ok",
        },
        {
          detail: "No HTTP(S) proxy is configured in the environment.",
          name: "proxy-capability",
          status: "ok",
        },
      ]);
    })
  );

  it.effect("fails the host checks when no relay hosts are configured", () =>
    Effect.gen(function* () {
      const checks = yield* diagnoseIrohEnvironment({
        environment: {},
        probes: healthyProbes,
        relayHosts: [],
      });

      expect(checks[0]).toEqual({
        detail:
          "No iroh relay hosts could be read from the installed binding's default relay configuration.",
        name: "dns-resolution",
        status: "fail",
      });
      expect(checks[2]).toEqual({
        detail:
          "No iroh relay hosts could be read from the installed binding's default relay configuration.",
        name: "relay-reachability",
        status: "fail",
      });
    })
  );

  it.effect("degrades dns-resolution to warn and fail by resolved count", () =>
    Effect.gen(function* () {
      const failingHost = (host: string) =>
        host === "relay-b.example"
          ? Promise.reject(new Error("NXDOMAIN"))
          : Promise.resolve();
      const [partial] = yield* diagnose({ resolveHost: failingHost });
      const [total] = yield* diagnose({
        resolveHost: () => Promise.reject(new Error("no resolver reachable")),
      });

      expect(partial).toEqual({
        detail:
          "Resolved 1 of 2 iroh relay hosts; could not resolve: relay-b.example.",
        name: "dns-resolution",
        status: "warn",
      });
      expect(total).toEqual({
        detail:
          "Could not resolve any of the 2 iroh relay hosts: relay-a.example, relay-b.example.",
        name: "dns-resolution",
        status: "fail",
      });
    })
  );

  it.effect("downgrades blocked local DNS only behind a usable proxy", () =>
    Effect.gen(function* () {
      const noResolver = () => Promise.reject(new Error("blocked"));
      const [usable] = yield* diagnose(
        { resolveHost: noResolver },
        { HTTPS_PROXY: "http://proxy.example:8080" }
      );
      const [unusable] = yield* diagnose(
        { makeEndpointBuilder: () => ({}), resolveHost: noResolver },
        { HTTPS_PROXY: "http://proxy.example:8080" }
      );

      expect(usable).toEqual({
        detail:
          "Could not resolve any of the 2 iroh relay hosts locally; with an HTTP(S) proxy configured, the proxy resolves relay hostnames itself, a path this probe does not test.",
        name: "dns-resolution",
        status: "warn",
      });
      expect(unusable).toEqual({
        detail:
          "Could not resolve any of the 2 iroh relay hosts: relay-a.example, relay-b.example.",
        name: "dns-resolution",
        status: "fail",
      });
    })
  );

  it.effect("marks blocked UDP egress as a warn, not a failure", () =>
    Effect.gen(function* () {
      const checks = yield* diagnose({
        sendUdpProbe: () => Promise.reject(new Error("probe timed out")),
      });

      expect(checks[1]).toEqual({
        detail:
          "No reply to a UDP datagram sent to a public DNS resolver; UDP egress looks blocked, so sessions will depend on the relay path.",
        name: "udp-egress",
        status: "warn",
      });
    })
  );

  it.effect("fails relay-reachability only without a proxy escape hatch", () =>
    Effect.gen(function* () {
      const refuse = () => Promise.reject(new Error("connection refused"));
      const refuseOne = (host: string) =>
        host === "relay-a.example"
          ? Promise.reject(new Error("connection refused"))
          : Promise.resolve();
      const [, , partial] = yield* diagnose({ openTcp: refuseOne });
      const [, , blocked] = yield* diagnose({ openTcp: refuse });
      const [, , proxied] = yield* diagnose(
        { openTcp: refuse },
        { HTTPS_PROXY: "http://proxy.example:8080" }
      );

      expect(partial).toEqual({
        detail:
          "1 of 2 iroh relay hosts accepted a TCP connection on port 443; unreachable: relay-a.example.",
        name: "relay-reachability",
        status: "warn",
      });
      expect(blocked).toEqual({
        detail:
          "No iroh relay host accepted a TCP connection on port 443: relay-a.example, relay-b.example.",
        name: "relay-reachability",
        status: "fail",
      });
      expect(proxied).toEqual({
        detail:
          "No iroh relay host accepted a direct TCP connection on port 443; with an HTTP(S) proxy configured, relay traffic must travel through the proxy, a path this probe does not test.",
        name: "relay-reachability",
        status: "warn",
      });
    })
  );

  it.effect("keeps blocked 443 a failure when the proxy is unusable", () =>
    Effect.gen(function* () {
      const [, , relay] = yield* diagnose(
        {
          makeEndpointBuilder: () => ({}),
          openTcp: () => Promise.reject(new Error("connection refused")),
        },
        { HTTPS_PROXY: "http://proxy.example:8080" }
      );

      expect(relay).toEqual({
        detail:
          "No iroh relay host accepted a TCP connection on port 443: relay-a.example, relay-b.example.",
        name: "relay-reachability",
        status: "fail",
      });
    })
  );

  it.effect(
    "reports a usable proxy through the existing capability check",
    () =>
      Effect.gen(function* () {
        const configured: string[] = [];
        const checks = yield* diagnose(
          {
            makeEndpointBuilder: () => ({
              proxyUrl: (url: string) => configured.push(url),
            }),
          },
          { HTTPS_PROXY: "http://proxy.example:8080" }
        );

        expect(checks[3]).toEqual({
          detail:
            "An HTTP(S) proxy is configured and the installed iroh binding can use it.",
          name: "proxy-capability",
          status: "ok",
        });
        expect(configured).toEqual(["http://proxy.example:8080/"]);
      })
  );

  it.effect("warns on proxy-capability when the binding lacks support", () =>
    Effect.gen(function* () {
      const checks = yield* diagnose(
        { makeEndpointBuilder: () => ({}) },
        { HTTPS_PROXY: "http://proxy.example:8080" }
      );

      expect(checks[3]).toEqual({
        detail:
          "The installed @number0/iroh binding does not expose proxy configuration. run and pull fall back to a direct connection.",
        name: "proxy-capability",
        status: "warn",
      });
    })
  );

  it.effect(
    "fails proxy-capability on variables with no usable proxy URL",
    () =>
      Effect.gen(function* () {
        const checks = yield* diagnose(
          {},
          { ALL_PROXY: "socks5://user:secret-credential@proxy.example" }
        );

        expect(checks[3]).toEqual({
          detail:
            "No valid HTTP(S) proxy was found in the proxy environment variables.",
          name: "proxy-capability",
          status: "fail",
        });
      })
  );

  it.effect("ignores empty proxy environment variables", () =>
    Effect.gen(function* () {
      const checks = yield* diagnose({}, { ALL_PROXY: "", HTTPS_PROXY: "" });

      expect(checks[3]).toEqual({
        detail: "No HTTP(S) proxy is configured in the environment.",
        name: "proxy-capability",
        status: "ok",
      });
    })
  );

  it.effect("keeps a builder construction crash as check data", () =>
    Effect.gen(function* () {
      const checks = yield* diagnose(
        {
          makeEndpointBuilder: () => {
            throw new Error("native binding failed to load");
          },
        },
        { HTTPS_PROXY: "http://proxy.example:8080" }
      );

      expect(checks[3]).toEqual({
        detail:
          "The installed @number0/iroh binding could not construct an endpoint builder; run and pull cannot open a connection.",
        name: "proxy-capability",
        status: "fail",
      });
    })
  );

  it.effect("never leaks proxy credentials into any check detail", () =>
    Effect.gen(function* () {
      const secret = "proxy-secret-credential";
      const environment = {
        HTTPS_PROXY: `http://user:${secret}@proxy.example:8080`,
      };
      const [capable, incapable] = yield* Effect.all([
        diagnose({}, environment),
        diagnose({ makeEndpointBuilder: () => ({}) }, environment),
      ]);

      for (const check of [...capable, ...incapable]) {
        expect(check.detail).not.toContain(secret);
        expect(check.detail).not.toContain("proxy.example");
      }
    })
  );
});
