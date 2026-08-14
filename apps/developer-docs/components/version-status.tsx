import type { DocsVersion } from "@/lib/versions";

export function VersionStatus({ version }: Readonly<{ version: DocsVersion }>) {
  const status =
    version.status === "unpublished"
      ? "local and unpublished"
      : version.status === "deprecated"
        ? "deprecated"
        : "active";

  return (
    <aside
      aria-label="Documentation version status"
      className="mb-4 rounded-lg border border-fd-border bg-fd-secondary/50 px-4 py-3 text-sm text-fd-muted-foreground"
    >
      <strong className="text-fd-foreground">{version.label}</strong> is {status}.
      Content is tied to SDK{" "}
      {version.compatibility.sdk.version} and chain manifest{" "}
      {version.compatibility.chain.manifestVersion}.
    </aside>
  );
}
