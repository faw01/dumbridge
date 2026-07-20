import type { ReactNode } from "react";

interface TerminalLine {
  readonly cmd: string;
  readonly out: readonly string[];
}

const Snippet = ({ lines }: { readonly lines: readonly TerminalLine[] }) => (
  <pre className="flex-1 space-y-3 overflow-x-auto rounded-lg border bg-card p-4 font-mono text-xs leading-relaxed">
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

const Step = ({ caption, children, number, title }: StepProperties) => (
  <div className="flex flex-col gap-4">
    {children}
    <div className="flex flex-col gap-1">
      <h3 className="font-semibold text-lg tracking-tight">
        <span className="mr-2 text-muted-foreground">{number}.</span>
        {title}
      </h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{caption}</p>
    </div>
  </div>
);

export const Walkthrough = () => (
  <section className="border-t">
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 py-20 md:py-28">
      <h2 className="font-semibold text-3xl tracking-tighter md:text-5xl">
        Using dumbridge
      </h2>
      <div className="grid grid-cols-1 gap-8 md:grid-cols-3">
        <Step
          caption="Serve one directory from your machine. dumbridge prints the key."
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
          <div className="flex-1 rounded-lg rounded-br-none border bg-card p-4 text-left text-sm leading-relaxed">
            Find the SKILL.md I was drafting. I never committed it. Key:{" "}
            <code className="font-mono text-[13px]">dumbridge1_9f3c...</code>
          </div>
        </Step>
        <Step
          caption="The agent reads the file live from your disk. Nothing was committed or uploaded."
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
      <p className="max-w-3xl text-muted-foreground text-sm leading-relaxed">
        In a cloud sandbox: Claude Code on the web needs Network access set to
        Full. Codex Cloud needs the Domain allowlist set to All. Cursor needs no
        setup.
      </p>
    </div>
  </section>
);
