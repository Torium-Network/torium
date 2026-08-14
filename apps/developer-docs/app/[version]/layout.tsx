import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";

import { VersionStatus } from "@/components/version-status";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { pageTreeForVersion } from "@/lib/version-tree";
import { getDocsVersion } from "@/lib/versions";

export default async function VersionLayout({
  children,
  params,
}: Readonly<{
  children: ReactNode;
  params: Promise<{ version: string }>;
}>) {
  const { version } = await params;
  const release = getDocsVersion(version);

  if (!release) notFound();

  return (
    <RootProvider
      search={{
        options: {
          api: `/docs/api/search?version=${release.id}`,
        },
      }}
    >
      <DocsLayout tree={pageTreeForVersion(source.pageTree, release.id)} {...baseOptions}>
        <VersionStatus version={release} />
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
