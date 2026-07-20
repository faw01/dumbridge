import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { ClaudeAiIcon } from "@/components/ui/svgs/claudeAiIcon";
import { CodexDark } from "@/components/ui/svgs/codexDark";
import { CursorDark } from "@/components/ui/svgs/cursorDark";
import { GithubDark } from "@/components/ui/svgs/githubDark";

const agentMarks = [
  {
    icon: CodexDark,
    name: "Codex",
    position: "top-[10%] right-[4%]",
  },
  {
    icon: ClaudeAiIcon,
    name: "Claude Code",
    position: "top-[38%] right-[-5%]",
  },
  {
    icon: CursorDark,
    name: "Cursor",
    position: "top-[74%] right-[10%]",
  },
];

export const Hero = () => (
  <section className="flex min-h-svh flex-col items-center gap-10 px-6 pt-8 pb-16">
    <Link
      className="flex items-center gap-1.5 rounded-full border bg-card px-3.5 py-1.5 text-muted-foreground text-xs transition-colors hover:text-foreground"
      href="https://github.com/faw01/dumbridge/releases"
    >
      version 1.0 is here
      <ArrowRight aria-hidden="true" className="size-3" />
    </Link>
    <div className="flex flex-1 flex-col items-center justify-center gap-8">
      <div className="relative w-full max-w-md">
        <img
          alt="A laptop bridged to a cloud agent"
          className="h-auto w-full"
          height={1024}
          src="/hero.png"
          width={1536}
        />
        {agentMarks.map((mark) => (
          <span
            className={`absolute flex items-center gap-1.5 rounded-full border bg-card/90 px-2.5 py-1 backdrop-blur-sm ${mark.position}`}
            key={mark.name}
          >
            <mark.icon
              aria-hidden="true"
              className="size-3.5 text-foreground [&_path]:fill-current"
            />
            <span className="text-foreground/90 text-xs tracking-tight">
              {mark.name}
            </span>
          </span>
        ))}
      </div>
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="font-semibold text-6xl tracking-tighter md:text-8xl">
          dumbridge
        </h1>
        <p className="text-lg text-muted-foreground tracking-tight md:text-xl">
          Free. Open source. No account required.
        </p>
        <Link
          className="flex items-center gap-2 text-muted-foreground text-sm underline-offset-4 transition-colors hover:text-foreground hover:underline"
          href="https://github.com/faw01/dumbridge"
        >
          <GithubDark
            aria-hidden="true"
            className="size-4 text-foreground [&_path]:fill-current"
          />
          GitHub
        </Link>
      </div>
    </div>
  </section>
);
