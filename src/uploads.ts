import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const dir = join(dirname(process.env.DB_PATH ?? "data/chat.db"), "uploads");
mkdirSync(dir, { recursive: true });

const TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
} as const;
type Ext = keyof typeof TYPES;

/** 按文件头判断真实格式，不信客户端声明的类型 */
function sniff(b: Buffer): Ext | null {
  if (b.length > 12) {
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") return "webp";
    if (b.subarray(0, 4).toString() === "GIF8") return "gif";
  }
  return null;
}

export const isImageName = (n: string) => /^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/.test(n);

export function saveImage(data: Buffer): string | null {
  const ext = sniff(data);
  if (!ext) return null;
  const name = `${randomUUID()}.${ext}`;
  writeFileSync(join(dir, name), data);
  return name;
}

export function readImage(name: string): { data: Buffer; mediaType: string } | null {
  if (!isImageName(name)) return null;
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  return { data: readFileSync(path), mediaType: TYPES[name.split(".")[1] as Ext] };
}
