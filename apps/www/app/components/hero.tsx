import Link from "next/link";
import { GithubDark } from "@/components/ui/svgs/githubDark";
import { CopyCommand } from "./copy-command";
import { CloudOrbit, OrbitingImage } from "./ui/cloud-orbit";

const agentMarks = [
  { name: "Codex", startAt: 0, url: "/marks/codex.svg" },
  { name: "Claude Code", startAt: 1 / 3, url: "/marks/claude.svg" },
  { name: "Cursor", startAt: 2 / 3, url: "/marks/cursor.svg" },
];

const ORBIT_RADIUS = 120;
const MARK_SIZE = 44;

const OrbitSet = () => (
  <CloudOrbit className="absolute inset-0" size={0}>
    <div
      aria-hidden="true"
      className="absolute top-1/2 left-1/2 size-[240px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10"
    />
    {agentMarks.map((mark) => (
      <OrbitingImage
        images={[{ name: mark.name, url: mark.url }]}
        key={mark.name}
        radius={ORBIT_RADIUS}
        size={MARK_SIZE}
        speed={24}
        startAt={mark.startAt}
      />
    ))}
  </CloudOrbit>
);

export const Hero = () => (
  <section className="flex min-h-svh w-full items-center justify-center overflow-hidden px-6 py-12">
    <div className="flex flex-col items-center gap-8">
      <div className="relative w-full max-w-2xl">
        <img
          alt="A laptop bridged to a cloud agent"
          className="h-auto w-full"
          height={1024}
          src="/hero.png"
          width={1536}
        />
        <div className="absolute top-[61%] left-[81%] -translate-x-1/2 -translate-y-1/2">
          <div className="scale-[0.55] sm:scale-[0.85] md:scale-100">
            <OrbitSet />
          </div>
        </div>
      </div>
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="font-semibold text-6xl tracking-tighter md:text-8xl">
          dumbridge
        </h1>
        <p className="text-lg text-muted-foreground tracking-tight md:text-xl">
          Local files for your cloud agents.
        </p>
      </div>
      <div className="flex flex-col items-center gap-4">
        <CopyCommand command="npx dumbridge" />
        <Link
          aria-label="dumbridge on GitHub"
          className="text-muted-foreground transition-colors hover:text-foreground"
          href="https://github.com/faw01/dumbridge"
        >
          <GithubDark
            aria-hidden="true"
            className="size-5 fill-current [&_path]:fill-current"
          />
        </Link>
      </div>
    </div>
  </section>
);
