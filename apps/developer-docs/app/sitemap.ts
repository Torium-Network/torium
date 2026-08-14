import type { MetadataRoute } from "next";

import { canonicalDocsUrl } from "@/lib/canonical";
import { source } from "@/lib/source";

export default function sitemap(): MetadataRoute.Sitemap {
  return source.getPages().map((page) => ({
    url: canonicalDocsUrl(page.slugs),
    changeFrequency: "weekly",
    priority: page.slugs.length === 1 ? 1 : 0.7,
  }));
}
