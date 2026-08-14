import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/page";

import { getMDXComponents } from "@/components/mdx";
import { canonicalDocsUrl } from "@/lib/canonical";
import { source } from "@/lib/source";
import { currentDocsVersion, getDocsVersion } from "@/lib/versions";

interface PageParameters {
  readonly version: string;
  readonly slug?: string[];
}

function getPage({ version, slug = [] }: PageParameters) {
  if (!getDocsVersion(version)) return undefined;
  return source.getPage([version, ...slug]);
}

export default async function DocumentationPage({
  params,
}: Readonly<{ params: Promise<PageParameters> }>) {
  const route = await params;
  const page = getPage(route);

  if (!page) notFound();

  const MDX = page.data.body;

  return (
    <DocsPage
      toc={page.data.toc}
      full={page.data.full}
      editOnGithub={{
        owner: "Torium-Network",
        repo: "torium",
        sha: "main",
        path: `apps/developer-docs/content/docs/${page.path}`,
      }}
    >
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateMetadata({
  params,
}: Readonly<{ params: Promise<PageParameters> }>): Promise<Metadata> {
  const route = await params;
  const page = getPage(route);

  if (!page) return {};

  return {
    title:
      route.slug && route.slug.length > 0
        ? page.data.title
        : {
            absolute: page.data.title,
          },
    description: page.data.description,
    alternates: {
      canonical: canonicalDocsUrl([route.version, ...(route.slug ?? [])]),
    },
    robots: {
      index: false,
      follow: false,
    },
  };
}

export function generateStaticParams(): PageParameters[] {
  return source.getPages().map((page) => ({
    version: page.slugs[0] ?? currentDocsVersion,
    slug: page.slugs.slice(1),
  }));
}
