import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";

const cloudNotes = [
  {
    name: "Claude Code on the web",
    note: "Set Network access to Full.",
  },
  {
    name: "Codex Cloud",
    note: "Set the Domain allowlist to All (unrestricted).",
  },
  {
    name: "Cursor",
    note: "Works with no setup.",
  },
];

export const Setup = () => (
  <section className="border-t">
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-20 md:py-28">
      <div className="flex flex-col gap-3">
        <h2 className="max-w-2xl font-semibold text-3xl tracking-tighter md:text-5xl">
          There is no install
        </h2>
        <p className="max-w-xl text-lg text-muted-foreground leading-relaxed tracking-tight">
          Run it straight from npm or Bun. The only requirement is Bun 1.3.14 or
          newer on PATH.
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <code className="rounded-lg border bg-muted/40 px-5 py-2.5 font-mono text-sm">
          npx dumbridge
        </code>
        <code className="rounded-lg border bg-muted/40 px-5 py-2.5 font-mono text-sm">
          bunx dumbridge
        </code>
      </div>
      <div className="flex flex-col gap-4">
        <p className="font-mono text-muted-foreground text-sm">
          running in a cloud sandbox
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {cloudNotes.map((cloud) => (
            <Card className="gap-0 py-5" key={cloud.name}>
              <CardHeader className="gap-1.5 px-5">
                <CardTitle className="text-base">{cloud.name}</CardTitle>
                <CardDescription className="leading-relaxed">
                  {cloud.note}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </div>
    </div>
  </section>
);
