import type { MetadataRoute } from "next";

import { docsOrigin } from "@/lib/canonical";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/docs/",
    },
    sitemap: `${docsOrigin}/docs/sitemap.xml`,
  };
}
