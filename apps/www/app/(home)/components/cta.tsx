import { Button } from "@repo/design-system/components/ui/button";
import { MoveRight } from "lucide-react";
import Link from "next/link";

export const CTA = () => (
  <div className="w-full py-20 lg:py-40" id="install">
    <div className="container mx-auto">
      <div className="flex flex-col items-center gap-8 rounded-md bg-muted p-4 text-center lg:p-14">
        <div className="flex flex-col gap-2">
          <h3 className="max-w-xl font-regular text-3xl tracking-tighter md:text-5xl">
            There is no install
          </h3>
          <p className="max-w-xl text-lg text-muted-foreground leading-relaxed tracking-tight">
            Run it straight from npm. The only requirement is Bun 1.3.14 or
            newer on PATH.
          </p>
        </div>
        <div className="flex flex-col gap-3 font-mono text-sm">
          <code className="rounded-md bg-background px-6 py-3">
            npx --yes dumbridge
          </code>
          <code className="rounded-md bg-background px-6 py-3">
            bunx dumbridge
          </code>
        </div>
        <div className="flex flex-row gap-4">
          <Button asChild className="gap-4" variant="outline">
            <Link href="https://github.com/faw01/dumbridge">GitHub</Link>
          </Button>
          <Button asChild className="gap-4">
            <Link href="https://www.npmjs.com/package/dumbridge">
              dumbridge on npm <MoveRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  </div>
);
