import Link from "next/link";

export const Hero = () => (
  <section className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 py-10 text-center">
    <img
      alt="A laptop bridged to a cloud agent"
      className="h-auto w-full max-w-md"
      height={1024}
      src="/hero.png"
      width={1536}
    />
    <div className="flex flex-col items-center gap-4">
      <h1 className="font-semibold text-6xl tracking-tighter md:text-8xl">
        dumbridge
      </h1>
      <p className="max-w-xl text-balance text-lg leading-relaxed tracking-tight md:text-xl">
        Temporary, live, read-only access to one local directory.
      </p>
      <p className="text-muted-foreground text-sm">
        Free. Open source. No account required.
      </p>
    </div>
    <code className="rounded-lg border bg-muted/40 px-5 py-2.5 font-mono text-sm">
      <span aria-hidden="true" className="select-none text-muted-foreground">
        ${" "}
      </span>
      npx dumbridge
    </code>
    <div className="flex flex-row items-center gap-3 text-muted-foreground text-sm">
      <Link
        className="underline-offset-4 hover:text-foreground hover:underline"
        href="https://github.com/faw01/dumbridge"
      >
        GitHub
      </Link>
      <span aria-hidden="true">·</span>
      <Link
        className="underline-offset-4 hover:text-foreground hover:underline"
        href="https://www.npmjs.com/package/dumbridge"
      >
        npm
      </Link>
    </div>
  </section>
);
