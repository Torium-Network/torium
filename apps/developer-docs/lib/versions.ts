import versions from "@/content/versions.json";

export type DocsVersion = (typeof versions.versions)[number];

export const currentDocsVersion = versions.current;
export const docsVersions: readonly DocsVersion[] = versions.versions;

export function getDocsVersion(version: string): DocsVersion | undefined {
  return docsVersions.find((candidate) => candidate.id === version);
}
