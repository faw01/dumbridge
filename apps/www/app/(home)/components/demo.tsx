const localSession = `$ echo "TODO: rotate the staging keys" >> notes.md

$ bunx dumbridge serve ~/projects/my-app
DUMBRIDGE_KEY=...  put this in the agent's env
serving my-app read-only. Ctrl-C stops and revokes.`;

const cloudSession = `$ npx --yes dumbridge run 'ls'
bridge: my-app (read-only)
notes.md
package.json
src

$ npx --yes dumbridge pull notes.md
pulled notes.md

$ cat notes.md
TODO: rotate the staging keys`;

export const Demo = () => (
  <div className="w-full py-20 lg:py-40" id="demo">
    <div className="container mx-auto">
      <div className="flex flex-col gap-10">
        <div className="flex flex-col items-start gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="max-w-xl text-left font-regular text-3xl tracking-tighter md:text-5xl">
              Read a file that was never committed
            </h2>
            <p className="max-w-xl text-left text-lg text-muted-foreground leading-relaxed tracking-tight lg:max-w-lg">
              No snapshot, no upload, no sync. The agent reads the file as it is
              on your disk right now.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div className="flex flex-col gap-3">
            <p className="font-mono text-muted-foreground text-sm">
              your laptop
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-6 font-mono text-sm leading-relaxed">
              {localSession}
            </pre>
          </div>
          <div className="flex flex-col gap-3">
            <p className="font-mono text-muted-foreground text-sm">
              the cloud agent
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-6 font-mono text-sm leading-relaxed">
              {cloudSession}
            </pre>
          </div>
        </div>
        <p className="max-w-xl text-left text-lg text-muted-foreground leading-relaxed tracking-tight">
          notes.md was never committed and never uploaded anywhere. It moved
          only when the agent asked for it. Stop serve and the key is dead.
        </p>
      </div>
    </div>
  </div>
);
