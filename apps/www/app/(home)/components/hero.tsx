import { Button } from "@repo/design-system/components/ui/button";
import { MoveRight } from "lucide-react";
import Link from "next/link";

export const Hero = () => (
  <div className="w-full">
    <div className="container mx-auto">
      <div className="flex flex-col items-center justify-center gap-8 py-20 lg:py-40">
        <div>
          <Button asChild className="gap-4" size="sm" variant="secondary">
            <Link href="https://www.npmjs.com/package/dumbridge">
              dumbridge 1.0 is on npm <MoveRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
        <div className="flex flex-col gap-4">
          <h1 className="max-w-2xl text-center font-regular text-5xl tracking-tighter md:text-7xl">
            Need to show a cloud agent your code? Try a dumb bridge.
          </h1>
          <p className="max-w-2xl text-center text-lg text-muted-foreground leading-relaxed tracking-tight md:text-xl">
            dumbridge gives a disposable cloud coding agent temporary, live,
            read-only access to one local directory. Free. Open source. No
            account required.
          </p>
        </div>
        {/* HERO ILLUSTRATION SLOT: replace this placeholder block with a
            hand-drawn illustration (SVG or image) when one is ready. */}
        <div
          aria-hidden="true"
          className="flex aspect-video w-full max-w-3xl items-center justify-center rounded-md bg-muted"
        >
          <span className="font-mono text-muted-foreground text-sm">
            laptop ── dumb bridge ── cloud agent
          </span>
        </div>
        <div className="flex flex-row gap-3">
          <Button asChild className="gap-4" size="lg" variant="outline">
            <Link href="https://github.com/faw01/dumbridge">GitHub</Link>
          </Button>
          <Button asChild className="gap-4" size="lg">
            <Link href="#install">
              Install <MoveRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </div>
  </div>
);
