import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";

interface TerminalLine {
  readonly cmd: string;
  readonly out: readonly string[];
}

const Terminal = ({ lines }: { readonly lines: readonly TerminalLine[] }) => (
  <div className="overflow-hidden rounded-lg border bg-background/60">
    <div
      aria-hidden="true"
      className="flex items-center gap-1.5 border-b px-4 py-2.5"
    >
      <span className="size-2.5 rounded-full bg-muted" />
      <span className="size-2.5 rounded-full bg-muted" />
      <span className="size-2.5 rounded-full bg-muted" />
    </div>
    <pre className="space-y-3 overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
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

const StepTitle = ({
  number,
  title,
}: {
  readonly number: string;
  readonly title: string;
}) => (
  <CardTitle className="text-lg tracking-tight">
    <span className="mr-2.5 text-muted-foreground">{number}.</span>
    {title}
  </CardTitle>
);

const cloudNotes = [
  { name: "Claude Code on the web", note: "Set Network access to Full." },
  { name: "Codex Cloud", note: "Set the Domain allowlist to All." },
  { name: "Cursor", note: "No setup needed." },
];

export const Walkthrough = () => (
  <section className="border-t">
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-20 md:py-28">
      <h2 className="font-semibold text-3xl tracking-tighter md:text-5xl">
        Using dumbridge
      </h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <StepTitle number="1" title="Serve" />
            <CardDescription className="leading-relaxed">
              Run serve on your machine. Pass the one directory the agent may
              read. serve prints the key and keeps serving. Press Ctrl-C to stop
              serve and revoke the key.
            </CardDescription>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <StepTitle number="2" title="Share the key" />
            <CardDescription className="leading-relaxed">
              Paste <code className="font-mono">DUMBRIDGE_KEY</code> into the
              agent's environment. The key tells the agent how to reach your
              machine.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            {cloudNotes.map((cloud) => (
              <div
                className="rounded-lg border bg-background/60 px-4 py-3"
                key={cloud.name}
              >
                <p className="font-medium text-sm tracking-tight">
                  {cloud.name}
                </p>
                <p className="text-muted-foreground text-sm">{cloud.note}</p>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="md:col-span-3">
          <CardContent className="grid grid-cols-1 items-center gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <StepTitle number="3" title="Read" />
              <CardDescription className="leading-relaxed">
                In the agent, run and pull read your files over the bridge. Each
                read fetches the file from your disk at that moment. Nothing is
                uploaded in advance.
              </CardDescription>
            </div>
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
          </CardContent>
        </Card>
      </div>
    </div>
  </section>
);
