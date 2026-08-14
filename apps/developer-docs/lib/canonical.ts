export const docsOrigin = "https://torium.network";
export const docsBasePath = "/docs";

export function canonicalDocsUrl(slugs: readonly string[]): string {
  const pathname = [docsBasePath, ...slugs.map(encodeURIComponent)].join("/");
  return new URL(pathname, docsOrigin).toString();
}
