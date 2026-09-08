import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function defaultExportPath(cwd: string, now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return join(cwd, `pi-context-${stamp}.md`);
}

export function resolveExportPath(input: string, cwd: string) {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("A file path is required");
  if (trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("The file path must be one line");
  }
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~")) {
    throw new Error(
      "Paths for another user's home directory are not supported",
    );
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
}

export async function saveSharedContext(
  path: string,
  content: string,
  overwrite = false,
) {
  await writeFile(path, content, {
    encoding: "utf8",
    flag: overwrite ? "w" : "wx",
  });
}
