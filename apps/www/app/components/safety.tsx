import { Eye, Folder, KeyRound, ServerOff, ShieldCheck } from "lucide-react";
import Link from "next/link";

const safetyPoints = [
  {
    description:
      "The agent can read files below the served root. Writes are discarded before they touch your disk, and run never executes your host shell.",
    icon: Eye,
    title: "Read-only, for real",
  },
  {
    description:
      "Only the one directory you pass to serve is visible. Reads outside it are refused on both sides of the bridge.",
    icon: Folder,
    title: "One directory",
  },
  {
    description:
      "The bridge key expires on its own deadline, and stopping serve revokes it instantly. Ctrl-C is the kill switch.",
    icon: KeyRound,
    title: "The key dies with serve",
  },
  {
    description:
      "No hosted service, no account, no third party holding your files. Bytes move between your machine and the agent and nowhere else.",
    icon: ServerOff,
    title: "Nothing in the middle",
  },
  {
    description:
      "Transfers run over iroh QUIC with TLS pinned to your machine's key. Even a corporate proxy that intercepts TLS cannot read the stream.",
    icon: ShieldCheck,
    title: "Encrypted end to end",
  },
];

export const Safety = () => (
  <section className="border-t">
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-20 md:py-28">
      <div className="flex flex-col gap-3">
        <h2 className="max-w-2xl font-semibold text-3xl tracking-tighter md:text-5xl">
          Dumb on purpose
        </h2>
        <p className="max-w-xl text-lg text-muted-foreground leading-relaxed tracking-tight">
          dumbridge cannot do much, and that is the pitch. What it cannot do is
          the security model.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {safetyPoints.map((point) => (
          <div
            className="flex flex-col gap-3 rounded-lg border bg-card p-5"
            key={point.title}
          >
            <point.icon className="size-5 stroke-[1.5] text-muted-foreground" />
            <div className="flex flex-col gap-1.5">
              <h3 className="font-medium tracking-tight">{point.title}</h3>
              <p className="text-muted-foreground text-sm leading-relaxed">
                {point.description}
              </p>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-col items-center gap-2 pt-10 text-center">
        <p className="text-lg tracking-tight">
          Built on{" "}
          <Link
            className="underline underline-offset-4 hover:text-muted-foreground"
            href="https://www.iroh.computer"
          >
            iroh
          </Link>
        </p>
        <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
          Every byte crosses the bridge over iroh: peer-to-peer QUIC
          connections, end-to-end encrypted, with relays when a direct path is
          blocked.
        </p>
      </div>
    </div>
  </section>
);
