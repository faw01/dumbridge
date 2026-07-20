import { CopyButton } from "./copy-button";

const commands = ["npx dumbridge", "bunx dumbridge"];

export const Install = () => (
  <section className="border-t">
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-20 md:py-28">
      <h2 className="font-semibold text-3xl tracking-tighter md:text-5xl">
        Install
      </h2>
      <p className="max-w-xl text-lg text-muted-foreground leading-relaxed tracking-tight">
        There is nothing to install. Run it straight from the registry on both
        sides of the bridge.
      </p>
      <div className="flex flex-col gap-3 sm:flex-row">
        {commands.map((command) => (
          <div
            className="flex items-center gap-4 rounded-lg border bg-card px-5 py-3"
            key={command}
          >
            <code className="font-mono text-sm">
              <span
                aria-hidden="true"
                className="select-none text-muted-foreground"
              >
                ${" "}
              </span>
              {command}
            </code>
            <CopyButton text={command} />
          </div>
        ))}
      </div>
      <p className="text-muted-foreground text-sm">
        Requires Bun 1.3.14 or newer on PATH.
      </p>
    </div>
  </section>
);
