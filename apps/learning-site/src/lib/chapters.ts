import type { CollectionEntry } from "astro:content";

export type Chapter = CollectionEntry<"chapters">;

export function chapterHref(chapter: Chapter): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/chapters/${chapter.data.slug}/`;
}

export function sortedChapters(chapters: Chapter[]): Chapter[] {
  return chapters.toSorted((a, b) => a.data.order - b.data.order);
}

export function chapterNumber(order: number): string {
  return String(order).padStart(2, "0");
}
