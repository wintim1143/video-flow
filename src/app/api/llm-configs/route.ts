import { NextResponse } from "next/server";
import { listProfilesSafe } from "@/lib/llm-configs";

export const runtime = "nodejs";

/** 给前端的 LLM profile 列表（脱敏，无 apiKey）。每次现读配置文件，改完即生效 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    data: {
      text: listProfilesSafe("text"),
      image: listProfilesSafe("image"),
      video: listProfilesSafe("video"),
    },
  });
}
