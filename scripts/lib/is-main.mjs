import { pathToFileURL } from "node:url";

// Robust "run as main" detection across platforms (handles Windows backslash
// paths correctly, unlike a naive endsWith(".mjs") check).
export function isMain(importMetaUrl) {
  if (!process.argv[1]) return false;
  return pathToFileURL(process.argv[1]).href === importMetaUrl;
}
