import { getCollection } from "astro:content";
import { chapterHref, chapterNumber, sortedChapters } from "@/lib/chapters";

export const prerender = true;

export async function GET() {
  const chapters = sortedChapters(await getCollection("chapters"));
  return new Response(JSON.stringify(chapters.map((chapter) => ({
    title: chapter.data.title,
    number: chapterNumber(chapter.data.order),
    summary: chapter.data.summary,
    href: chapterHref(chapter),
    text: (chapter.body ?? "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[#>*`|\[\]()_-]/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 12000),
  }))), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
