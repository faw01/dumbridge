import Link from "next/link";
import { ClaudeAiIcon } from "@/components/ui/svgs/claudeAiIcon";
import { CodexDark } from "@/components/ui/svgs/codexDark";
import { CursorDark } from "@/components/ui/svgs/cursorDark";
import { GithubDark } from "@/components/ui/svgs/githubDark";
import { CopyCommand } from "./copy-command";
import { DashedLine } from "./dashed-line";

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
  <section className="flex min-h-svh w-full items-center justify-center overflow-hidden">
    <div className="relative mx-auto w-full max-w-[1216px] p-6 md:p-12">
      <DashedLine direction="top" />
      <DashedLine direction="bottom" />
      <DashedLine direction="left" />
      <DashedLine direction="right" />
      <div className="flex flex-col items-center gap-8">
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
        </div>
        <div className="flex flex-col items-center gap-3">
          <div className="flex flex-col items-center gap-3 sm:flex-row">
            <CopyCommand command="npx dumbridge" />
            <CopyCommand command="bunx dumbridge" />
          </div>
          <p className="text-muted-foreground text-xs">
            Requires Bun 1.3.14 or newer on PATH.
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
    </div>
  </section>
);
