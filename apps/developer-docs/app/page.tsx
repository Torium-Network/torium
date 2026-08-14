import { redirect } from "next/navigation";

import { currentDocsVersion } from "@/lib/versions";

export default function DocsIndexPage(): never {
  redirect(`/${currentDocsVersion}`);
}
