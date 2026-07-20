import { Badge } from "@repo/design-system/components/ui/badge";

interface SessionEntry {
  readonly cmd: string;
  readonly out: readonly string[];
}

const localSession: readonly SessionEntry[] = [
  {
    cmd: 'echo "TODO: rotate the staging keys" >> notes.md',
    out: [],
  },
  {
    cmd: "npx dumbridge serve ~/project",
    out: [
      "DUMBRIDGE_KEY=...   put this in the agent's env",
      "serving project read-only. Ctrl-C stops and revokes.",
    ],
  },
];

const cloudSession: readonly SessionEntry[] = [
  {
    cmd: "npx dumbridge run 'ls'",
    out: ["bridge: project (read-only)", "notes.md", "package.json", "src"],
  },
  {
    cmd: "npx dumbridge pull notes.md",
    out: ["pulled notes.md"],
  },
  {
    cmd: "cat notes.md",
    out: ["TODO: rotate the staging keys"],
  },
];

interface TerminalPaneProperties {
  readonly entries: readonly SessionEntry[];
  readonly label: string;
  readonly step: string;
}

const TerminalPane = ({ entries, label, step }: TerminalPaneProperties) => (
  <div className="flex flex-col gap-3">
    <div className="flex items-center gap-2.5">
      <Badge
        className="size-6 justify-center rounded-full p-0 font-mono"
        variant="outline"
      >
        {step}
      </Badge>
      <p className="font-mono text-muted-foreground text-sm">{label}</p>
    </div>
    <div className="overflow-hidden rounded-lg border bg-card">
      <div
        aria-hidden="true"
        className="flex items-center gap-1.5 border-b px-4 py-3"
      >
        <span className="size-2.5 rounded-full bg-muted" />
        <span className="size-2.5 rounded-full bg-muted" />
        <span className="size-2.5 rounded-full bg-muted" />
      </div>
      <pre className="space-y-4 overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
        {entries.map((entry) => (
          <span className="block" key={entry.cmd}>
            <span className="block">
              <span
                aria-hidden="true"
                className="select-none text-muted-foreground"
              >
                ${" "}
              </span>
              {entry.cmd}
            </span>
            {entry.out.length > 0 && (
              <span className="block text-muted-foreground">
                {entry.out.join("\n")}
              </span>
            )}
          </span>
        ))}
      </pre>
    </div>
  </div>
);

export const Demo = () => (
  <section className="border-t">
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-20 md:py-28">
      <div className="flex flex-col gap-3">
        <h2 className="max-w-2xl font-semibold text-3xl tracking-tighter md:text-5xl">
          Access doesn't need to be complicated
        </h2>
        <p className="max-w-xl text-lg text-muted-foreground leading-relaxed tracking-tight">
          Write a note, serve the directory, and the agent reads it seconds
          later. No commit, no push, no upload.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <TerminalPane entries={localSession} label="on your machine" step="1" />
        <TerminalPane
          entries={cloudSession}
          label="in the cloud agent, with DUMBRIDGE_KEY set"
          step="2"
        />
      </div>
      <p className="max-w-2xl text-lg text-muted-foreground leading-relaxed tracking-tight">
        notes.md was never committed and never uploaded anywhere. There is no
        snapshot and no sync. The agent reads the file as it sits on your disk
        right now, and it moves only when the agent asks for it.
      </p>
    </div>
  </section>
);
