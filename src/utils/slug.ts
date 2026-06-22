/**
 * Convert an arbitrary string into a filesystem/URL-safe slug.
 *
 * Lowercases, replaces non-alphanumerics with single hyphens, and trims
 * leading/trailing hyphens. Returns "untitled" for empty input.
 */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "untitled";
}
