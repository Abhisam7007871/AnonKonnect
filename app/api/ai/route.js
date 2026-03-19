import { NextResponse } from "next/server";
import { z } from "zod";

import { generatePersonaReply } from "@/lib/gemini-ai";

const schema = z.object({
  personaId: z.string(),
  message: z.string().min(1),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
      }),
    )
    .optional()
    .default([]),
});

export async function POST(request) {
  const parsed = schema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }

  try {
    const result = await generatePersonaReply(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "AI request failed.",
      },
      { status: 500 },
    );
  }
}
