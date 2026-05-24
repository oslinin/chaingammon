import { NextResponse } from "next/server";
import { writeFile } from "fs/promises";
import path from "path";

const CALIBRATION_FILES: Record<string, string> = {
  board_steampunk: "board_steampunk",
  board_celtic:    "board_celtic",
  board_medieval:  "board_medieval",
  board_darkwood:  "board_darkwood",
  board_tokyo:     "board_tokyo",
  board_cyber2:    "board_cyber2",
};

export async function POST(req: Request) {
  const { themeKey, spots } = await req.json() as { themeKey: string; spots: unknown };
  const filename = CALIBRATION_FILES[themeKey];
  if (!filename) {
    return NextResponse.json({ error: `No calibration file mapped for theme "${themeKey}"` }, { status: 400 });
  }
  const filePath = path.join(process.cwd(), "lib", "calibration", `${filename}.json`);
  await writeFile(filePath, JSON.stringify(spots, null, 2) + "\n");
  return NextResponse.json({ ok: true, path: filePath });
}
