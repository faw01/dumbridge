export const Problem = () => (
  <section className="border-t">
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-20 md:py-28">
      <h2 className="max-w-3xl text-4xl tracking-tighter md:text-6xl">
        <span className="block text-muted-foreground">
          Your files are here.
        </span>
        <span className="block font-semibold">The agent is not.</span>
      </h2>
      <p className="max-w-2xl text-lg text-muted-foreground leading-relaxed tracking-tight">
        A cloud coding agent works on a remote machine, so it cannot see what is
        on yours: the uncommitted config, the local data, everything you never
        pushed. dumbridge gives the agent temporary, live, read-only access to
        exactly one local directory. It reads your real files as they are right
        now, with no upload, no commit, and no snapshot.
      </p>
    </div>
  </section>
);
