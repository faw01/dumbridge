import type { ReactNode } from "react";
import { DashedLine } from "./dashed-line";

interface TerminalLine {
  readonly cmd: string;
  readonly out: readonly string[];
}

const Terminal = ({ lines }: { readonly lines: readonly TerminalLine[] }) => (
  <div className="overflow-hidden rounded-lg border bg-card">
    <div
      aria-hidden="true"
      className="flex items-center gap-1.5 border-b px-4 py-3"
    >
      <span className="size-2.5 rounded-full bg-muted" />
      <span className="size-2.5 rounded-full bg-muted" />
      <span className="size-2.5 rounded-full bg-muted" />
    </div>
    <pre className="space-y-3 overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
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
  </div>
);

interface StepProperties {
  readonly children: ReactNode;
  readonly description: ReactNode;
  readonly number: string;
  readonly title: string;
}

const Step = ({ children, description, number, title }: StepProperties) => (
  <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2 lg:gap-12">
    <div className="flex flex-col gap-3">
      <h3 className="font-semibold text-xl tracking-tight md:text-2xl">
        <span className="mr-3 text-muted-foreground">{number}.</span>
        {title}
      </h3>
      <div className="text-muted-foreground leading-relaxed tracking-tight">
        {description}
      </div>
    </div>
    {children}
  </div>
);

const cloudNotes = [
  { name: "Claude Code on the web", note: "set Network access to Full" },
  { name: "Codex Cloud", note: "set the Domain allowlist to All" },
  { name: "Cursor", note: "no setup needed" },
];

export const Walkthrough = () => (
  <section className="relative">
    <DashedLine direction="top" />
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-14 px-6 py-20 md:py-28">
      <h2 className="font-semibold text-3xl tracking-tighter md:text-5xl">
        Using dumbridge
      </h2>
      <Step
        description="Run serve on your machine. Pass the one directory the agent may read. serve prints the key and keeps serving. Press Ctrl-C to stop serve and revoke the key."
        number="1"
        title="Serve"
      >
        <Terminal
          lines={[
            {
              cmd: "dumbridge serve ~/project",
              out: [
                "Serving the selected directory read-only until Ctrl-C.",
                "DUMBRIDGE_KEY=dumbridge1_...",
              ],
            },
          ]}
        />
      </Step>
      <Step
        description={
          <div className="flex flex-col gap-3">
            <p>
              Paste <code className="font-mono text-sm">DUMBRIDGE_KEY</code>{" "}
              into the agent's environment. The key tells the agent how to reach
              your machine.
            </p>
            <ul className="flex flex-col gap-1 text-sm">
              {cloudNotes.map((cloud) => (
                <li key={cloud.name}>
                  <span className="text-foreground">{cloud.name}</span> —{" "}
                  {cloud.note}
                </li>
              ))}
            </ul>
          </div>
        }
        number="2"
        title="Share the key"
      >
        <Terminal
          lines={[
            {
              cmd: "export DUMBRIDGE_KEY=dumbridge1_...",
              out: [],
            },
          ]}
        />
      </Step>
      <Step
        description="In the agent, run and pull read your files over the bridge. Each read fetches the file from your disk at that moment. Nothing is uploaded in advance."
        number="3"
        title="Read"
      >
        <Terminal
          lines={[
            {
              cmd: "dumbridge run 'ls'",
              out: ["bridge: project (read-only)", "notes.md", "src"],
            },
            {
              cmd: "dumbridge pull notes.md",
              out: ["pulled notes.md"],
            },
          ]}
        />
      </Step>
    </div>
  </section>
);
