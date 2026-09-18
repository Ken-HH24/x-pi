import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const chapters = defineCollection({
  loader: glob({ pattern: "*.md", base: "./src/content/chapters" }),
  schema: z.object({
    order: z.number().int().nonnegative(),
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    status: z.enum(["completed", "current", "upcoming"]),
    lab: z.string().optional(),
    diffFrom: z.string().optional(),
    delta: z.object({
      concepts: z.array(z.string()),
      behaviors: z.array(z.string()),
      files: z.array(z.string()),
    }),
    diffFiles: z.array(z.string()).default([]),
  }),
});

export const collections = { chapters };
