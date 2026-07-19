import Link from "next/link";

interface FooterColumn {
  href?: string;
  items: { href: string; title: string }[];
  title: string;
}

const navigationItems: FooterColumn[] = [
  {
    href: "/",
    items: [],
    title: "Home",
  },
  {
    items: [
      { href: "https://github.com/faw01/dumbridge", title: "GitHub" },
      { href: "https://www.npmjs.com/package/dumbridge", title: "npm" },
    ],
    title: "Project",
  },
  {
    items: [
      { href: "https://www.iroh.computer", title: "iroh" },
      {
        href: "https://github.com/faw01/dumbridge/blob/main/LICENSE",
        title: "MIT License",
      },
    ],
    title: "Built on",
  },
];

export const Footer = () => (
  <section className="dark border-foreground/10 border-t">
    <div className="w-full bg-background py-20 text-foreground lg:py-40">
      <div className="container mx-auto">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div className="flex flex-col items-start gap-8">
            <div className="flex flex-col gap-2">
              <h2 className="max-w-xl text-left font-regular text-3xl tracking-tighter md:text-5xl">
                dumbridge
              </h2>
              <p className="max-w-lg text-left text-foreground/75 text-lg leading-relaxed tracking-tight">
                A dumb bridge, on purpose. Stop serve and it is gone.
              </p>
            </div>
          </div>
          <div className="grid items-start gap-10 lg:grid-cols-3">
            {navigationItems.map((item) => (
              <div
                className="flex flex-col items-start gap-1 text-base"
                key={item.title}
              >
                <div className="flex flex-col gap-2">
                  {item.href ? (
                    <Link
                      className="flex items-center justify-between"
                      href={item.href}
                    >
                      <span className="text-xl">{item.title}</span>
                    </Link>
                  ) : (
                    <p className="text-xl">{item.title}</p>
                  )}
                  {item.items.map((subItem) => (
                    <Link
                      className="flex items-center justify-between"
                      href={subItem.href}
                      key={subItem.title}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <span className="text-foreground/75">
                        {subItem.title}
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </section>
);
