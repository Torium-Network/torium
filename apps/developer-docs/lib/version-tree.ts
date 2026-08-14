import type { Folder, Node, Root } from "fumadocs-core/page-tree";

function isVersionUrl(url: string, prefix: string): boolean {
  return url === prefix || url.startsWith(`${prefix}/`);
}

function filterNode(node: Node, prefix: string): Node | undefined {
  if (node.type === "page") return isVersionUrl(node.url, prefix) ? node : undefined;
  if (node.type === "separator") return node;

  const children = node.children
    .map((child) => filterNode(child, prefix))
    .filter((child): child is Node => child !== undefined);
  const index = node.index && isVersionUrl(node.index.url, prefix) ? node.index : undefined;

  if (!index && children.every((child) => child.type === "separator")) return undefined;

  return {
    ...node,
    index,
    children,
  } satisfies Folder;
}

export function pageTreeForVersion(tree: Root, version: string): Root {
  const prefix = `/${version}`;
  const children = tree.children
    .map((node) => filterNode(node, prefix))
    .filter((node): node is Node => node !== undefined);

  return {
    ...tree,
    children,
    fallback: tree.fallback
      ? pageTreeForVersion(tree.fallback, version)
      : undefined,
  };
}
