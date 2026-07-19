import { Eye, Folder, KeyRound, ServerOff, ShieldCheck } from "lucide-react";

const securityPoints = [
  {
    description:
      "The agent can read files under the directory you serve. Writes are discarded before they touch your disk, and run never executes your host shell.",
    icon: Eye,
    title: "Read-only, for real",
    wide: true,
  },
  {
    description:
      "Only the one directory you pass to serve is visible. Reads outside it are refused on both sides of the bridge.",
    icon: Folder,
    title: "One directory",
    wide: false,
  },
  {
    description:
      "serve mints a bridge key that expires on its own deadline. Stop serve and the key is revoked instantly. Ctrl-C is the kill switch.",
    icon: KeyRound,
    title: "The key dies with serve",
    wide: false,
  },
  {
    description:
      "No hosted service, no account, no third party holding your files. Bytes move between your machine and the agent and nowhere else.",
    icon: ServerOff,
    title: "Nothing in the middle",
    wide: false,
  },
  {
    description:
      "Transfers run over iroh QUIC with TLS pinned to your machine's key. Even a corporate proxy that intercepts TLS cannot read the stream.",
    icon: ShieldCheck,
    title: "Encrypted end to end",
    wide: true,
  },
];

export const Features = () => (
  <div className="w-full py-20 lg:py-40" id="security">
    <div className="container mx-auto">
      <div className="flex flex-col gap-10">
        <div className="flex flex-col items-start gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="max-w-xl text-left font-regular text-3xl tracking-tighter md:text-5xl">
              Dumb on purpose
            </h2>
            <p className="max-w-xl text-left text-lg text-muted-foreground leading-relaxed tracking-tight lg:max-w-lg">
              dumbridge cannot do much, and that is the pitch. What it cannot do
              is the security model.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {securityPoints.map((point) => (
            <div
              className={`flex h-full flex-col justify-between gap-10 rounded-md bg-muted p-6 ${
                point.wide ? "lg:col-span-2" : "aspect-square lg:aspect-auto"
              }`}
              key={point.title}
            >
              <point.icon className="h-8 w-8 stroke-1" />
              <div className="flex flex-col">
                <h3 className="text-xl tracking-tight">{point.title}</h3>
                <p className="max-w-md text-base text-muted-foreground">
                  {point.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);
