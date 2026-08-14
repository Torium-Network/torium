import { createFromSource } from "fumadocs-core/search/server";

import { source } from "@/lib/source";
import { getDocsVersion } from "@/lib/versions";

const search = createFromSource(source, {
  language: "english",
});

export async function GET(request: Request): Promise<Response> {
  const version = new URL(request.url).searchParams.get("version");

  if (!version || !getDocsVersion(version)) {
    return Response.json(
      { error: "A known documentation version is required." },
      { status: 400 }
    );
  }

  const response = await search.GET(request);
  const results = (await response.json()) as Array<{ url?: string }>;
  const prefix = `/${version}`;

  return Response.json(
    results.filter(
      (result) =>
        result.url === prefix || result.url?.startsWith(`${prefix}/`)
    ),
    { headers: response.headers }
  );
}
