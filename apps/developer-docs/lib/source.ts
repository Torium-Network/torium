import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";

export const source = loader({
  // Next.js adds the public /docs basePath to app-relative source URLs.
  baseUrl: "/",
  source: docs.toFumadocsSource(),
});
