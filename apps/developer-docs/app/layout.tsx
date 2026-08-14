import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

import { docsOrigin } from "@/lib/canonical";

export const metadata: Metadata = {
  metadataBase: new URL(docsOrigin),
  title: {
    default: "Torium Developer Docs",
    template: "%s | Torium Developer Docs",
  },
  description:
    "Versioned documentation for the Torium EVM L1 and TypeScript SDK.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {children}
      </body>
    </html>
  );
}
