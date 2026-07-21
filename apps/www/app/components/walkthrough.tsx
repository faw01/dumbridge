import type { ReactNode } from "react";

interface TerminalLine {
  readonly cmd: string;
  readonly out: readonly string[];
}

const Snippet = ({ lines }: { readonly lines: readonly TerminalLine[] }) => (
  <pre className="space-y-3 whitespace-pre-wrap break-words rounded-lg border bg-card p-4 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
    {lines.map((line) => (
      <span className="block" key={line.cmd}>
        <span className="block">
          <span
            aria-hidden="true"
            className="select-none text-muted-foreground"
          >
            ${" "}
          </span>
          {line.cmd}
        </span>
        {line.out.length > 0 && (
          <span className="block text-muted-foreground">
            {line.out.join("\n")}
          </span>
        )}
      </span>
    ))}
  </pre>
);

interface StepProperties {
  readonly caption: string;
  readonly children: ReactNode;
  readonly number: string;
  readonly title: string;
}

const cloudNotes = [
  {
    name: "Claude Code on the web",
    note: "set Network access to Full.",
    shot: {
      alt: "Claude Code on the web settings with Network access set to Full",
      height: 240,
      hoverScale: "hover:scale-125 md:hover:scale-150",
      src: "/setup/claude-network.png",
      width: 580,
    },
  },
  {
    name: "Codex Cloud",
    note: "set the Domain allowlist to All.",
    shot: {
      alt: "Codex Cloud settings with the Domain allowlist set to All",
      height: 340,
      hoverScale: "hover:scale-125 md:hover:scale-[1.8]",
      src: "/setup/codex-allowlist.png",
      width: 720,
    },
  },
  {
    name: "Cursor",
    note: "no setup needed.",
    shot: undefined,
  },
];

const Step = ({ caption, children, number, title }: StepProperties) => (
  <div className="grid grid-rows-[auto_auto_auto] gap-y-2 md:row-span-3 md:grid-rows-subgrid">
    {children}
    <h3 className="mt-2 font-semibold text-lg tracking-tight">
      <span className="mr-2 text-muted-foreground">{number}.</span>
      {title}
    </h3>
    <p className="text-muted-foreground text-sm leading-relaxed">{caption}</p>
  </div>
);

export const Walkthrough = () => (
  <section className="border-t">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-20 md:py-28">
      <h2 className="font-semibold text-3xl tracking-tighter md:text-5xl">
        Using dumbridge
      </h2>
      <div className="grid grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-3 md:grid-rows-[auto_auto_auto]">
        <Step
          caption="Serve one directory from your machine."
          number="1"
          title="Serve"
        >
          <Snippet
            lines={[
              {
                cmd: "dumbridge serve ~/dev/dumbridge",
                out: ["DUMBRIDGE_KEY=dumbridge1_9f3c..."],
              },
            ]}
          />
        </Step>
        <Step
          caption="Give the agent the key and the task."
          number="2"
          title="Ask"
        >
          <div className="rounded-lg rounded-br-none border bg-card p-4 text-left text-sm leading-relaxed">
            Find the SKILL.md I was drafting. I never committed it. Key:{" "}
            <code className="break-words font-mono text-[13px] [overflow-wrap:anywhere]">
              dumbridge1_9f3c...
            </code>
          </div>
        </Step>
        <Step
          caption="The agent reads the file live from your computer."
          number="3"
          title="Read"
        >
          <Snippet
            lines={[
              {
                cmd: "dumbridge run 'find . -name SKILL.md'",
                out: ["./docs/skills/pet/SKILL.md"],
              },
              {
                cmd: "dumbridge pull docs/skills/pet/SKILL.md",
                out: ["pulled docs/skills/pet/SKILL.md"],
              },
            ]}
          />
        </Step>
      </div>
      <ul className="flex flex-col gap-5">
        {cloudNotes.map((cloud) => (
          <li className="flex flex-col gap-2" key={cloud.name}>
            <p className="text-sm">
              <span className="font-medium tracking-tight">{cloud.name}:</span>{" "}
              <span className="text-muted-foreground">{cloud.note}</span>
            </p>
            {cloud.shot && (
              <img
                alt={cloud.shot.alt}
                className={`relative z-0 w-48 max-w-full origin-top-left rounded-md border transition-transform duration-200 hover:z-10 hover:shadow-lg ${cloud.shot.hoverScale}`}
                height={cloud.shot.height}
                loading="lazy"
                src={cloud.shot.src}
                width={cloud.shot.width}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  </section>
);
