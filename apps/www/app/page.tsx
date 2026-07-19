import Link from "next/link";

const Home = () => (
  <main className="flex min-h-svh flex-col items-center justify-center gap-8 px-6 py-10 text-center">
    {/* HERO ILLUSTRATION SLOT: replace this placeholder block with a
        hand-drawn illustration (SVG or image) when one is ready. */}
    <div
      aria-hidden="true"
      className="flex aspect-video w-full max-w-lg items-center justify-center rounded-md bg-muted"
    >
      <span className="font-mono text-muted-foreground text-sm">
        laptop ── dumb bridge ── cloud agent
      </span>
    </div>
    <div className="flex flex-col items-center gap-4">
      <p className="font-mono text-muted-foreground text-xs uppercase tracking-widest">
        need to show a cloud agent your code? try
      </p>
      <h1 className="font-semibold text-6xl tracking-tighter md:text-8xl">
        dumbridge
      </h1>
      <p className="max-w-xl text-lg text-muted-foreground leading-relaxed tracking-tight">
        Temporary, live, read-only access to one local directory. Free. Open
        source. No account required.
      </p>
    </div>
    <code className="rounded-md bg-muted px-4 py-2 font-mono text-sm">
      npx --yes dumbridge
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
  </main>
);

export default Home;
