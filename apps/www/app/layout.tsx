import "./styles.css";
import { DesignSystemProvider } from "@repo/design-system";
import { fonts } from "@repo/design-system/lib/fonts";
import { cn } from "@repo/design-system/lib/utils";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Footer } from "./components/footer";
import { Header } from "./components/header";

export const metadata: Metadata = {
  description:
    "dumbridge gives a disposable cloud coding agent temporary, live, read-only access to one local directory. Free. Open source. No account required.",
  metadataBase: new URL("https://dumbridge.dev"),
  title: "dumbridge | a dumb bridge to one local directory",
};

interface RootLayoutProperties {
  readonly children: ReactNode;
}

const RootLayout = ({ children }: RootLayoutProperties) => (
  <html
    className={cn(fonts, "scroll-smooth")}
    lang="en"
    suppressHydrationWarning
  >
    <body>
      <DesignSystemProvider defaultTheme="dark" enableSystem={false}>
        <Header />
        {children}
        <Footer />
      </DesignSystemProvider>
    </body>
  </html>
);

export default RootLayout;
