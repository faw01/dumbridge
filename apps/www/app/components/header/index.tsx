import { Button } from "@repo/design-system/components/ui/button";
import Link from "next/link";

const navigationItems = [
  { href: "#demo", title: "Demo" },
  { href: "#install", title: "Install" },
  { href: "#security", title: "Security" },
];

export const Header = () => (
  <header className="sticky top-0 left-0 z-40 w-full border-b bg-background">
    <div className="container relative mx-auto flex min-h-20 flex-row items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <p className="whitespace-nowrap font-semibold">dumbridge</p>
      </div>
      <nav className="hidden flex-row items-center gap-4 md:flex">
        {navigationItems.map((item) => (
          <Button asChild key={item.title} variant="ghost">
            <Link href={item.href}>{item.title}</Link>
          </Button>
        ))}
      </nav>
      <div className="flex justify-end gap-4">
        <Button asChild className="hidden md:inline-flex" variant="outline">
          <Link href="https://www.npmjs.com/package/dumbridge">npm</Link>
        </Button>
        <Button asChild>
          <Link href="https://github.com/faw01/dumbridge">GitHub</Link>
        </Button>
      </div>
    </div>
  </header>
);
