import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export const DEFAULT_ROADMAP_NAME = "ROADMAP.md";
export const PROGRESS_CONFIG_PATH = join(".pi", "progress.json");
const MAX_ROADMAP_BYTES = 1024 * 1024;

export interface LoadedRoadmapFile {
  readonly status: "loaded";
  readonly projectRoot: string;
  readonly roadmapPath: string;
  readonly markdown: string;
}

export interface MissingRoadmapFile {
  readonly status: "missing";
  readonly projectRoot: string;
  readonly roadmapPath: string;
}

export interface RoadmapFileError {
  readonly status: "error";
  readonly projectRoot: string;
  readonly roadmapPath: string;
  readonly message: string;
}

export type RoadmapFileResult =
  LoadedRoadmapFile | MissingRoadmapFile | RoadmapFileError;

export interface TrackedRoadmapConfig {
  readonly projectRoot: string;
  readonly roadmapPath: string;
  readonly configPath: string;
  readonly configuredPath: string;
}

function isMissing(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isInsideProject(projectRoot: string, candidate: string) {
  const child = relative(projectRoot, candidate);
  return (
    child !== "" &&
    child !== ".." &&
    !child.startsWith(`..${sep}`) &&
    !isAbsolute(child)
  );
}

export function findProjectRoot(cwd: string) {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function resolveConfiguredRoadmapPath(
  projectRoot: string,
  configuredPath: string,
) {
  if (isAbsolute(configuredPath)) {
    throw new Error("The roadmap path must be relative to the project root.");
  }

  const candidate = resolve(projectRoot, configuredPath);
  if (!isInsideProject(projectRoot, candidate)) {
    throw new Error(
      "The roadmap path must point to a file inside the project.",
    );
  }
  return candidate;
}

async function configuredRoadmapPath(
  projectRoot: string,
  allowProjectConfig: boolean,
) {
  if (!allowProjectConfig) return undefined;
  const configPath = join(projectRoot, PROGRESS_CONFIG_PATH);
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(`Could not read ${PROGRESS_CONFIG_PATH}.`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${PROGRESS_CONFIG_PATH} is not valid JSON.`);
  }

  if (
    typeof data !== "object" ||
    data === null ||
    !("path" in data) ||
    typeof data.path !== "string" ||
    !data.path.trim()
  ) {
    throw new Error(
      `${PROGRESS_CONFIG_PATH} must contain a non-empty "path" string.`,
    );
  }

  try {
    return resolveConfiguredRoadmapPath(projectRoot, data.path.trim());
  } catch (error) {
    throw new Error(
      `${PROGRESS_CONFIG_PATH}: ${error instanceof Error ? error.message : "invalid roadmap path"}`,
    );
  }
}

export async function setTrackedRoadmap(
  cwd: string,
  requestedPath: string,
): Promise<TrackedRoadmapConfig> {
  const projectRoot = findProjectRoot(cwd);
  const cleanedPath = requestedPath.trim();
  if (!cleanedPath) throw new Error("Provide a Markdown file to track.");

  const roadmapPath = resolveConfiguredRoadmapPath(projectRoot, cleanedPath);
  const configPath = join(projectRoot, PROGRESS_CONFIG_PATH);
  if (roadmapPath === configPath) {
    throw new Error(`${PROGRESS_CONFIG_PATH} cannot track itself.`);
  }

  let roadmapFile;
  try {
    roadmapFile = await stat(roadmapPath);
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(`${cleanedPath} does not exist.`);
    }
    throw new Error(`Could not inspect ${cleanedPath}.`);
  }
  if (!roadmapFile.isFile()) throw new Error(`${cleanedPath} is not a file.`);
  if (roadmapFile.size > MAX_ROADMAP_BYTES) {
    throw new Error(`${cleanedPath} is larger than 1 MiB.`);
  }

  const configDirectory = dirname(configPath);
  await mkdir(configDirectory, { recursive: true });
  const [realProjectRoot, realRoadmapPath, realConfigDirectory] =
    await Promise.all([
      realpath(projectRoot),
      realpath(roadmapPath),
      realpath(configDirectory),
    ]);
  if (!isInsideProject(realProjectRoot, realRoadmapPath)) {
    throw new Error("The roadmap file resolves outside the project.");
  }
  if (!isInsideProject(realProjectRoot, realConfigDirectory)) {
    throw new Error(
      `${dirname(PROGRESS_CONFIG_PATH)} resolves outside the project.`,
    );
  }

  const configuredPath = relative(projectRoot, roadmapPath)
    .split(sep)
    .join("/");
  const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ path: configuredPath }, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return { projectRoot, roadmapPath, configPath, configuredPath };
}

export async function loadRoadmapFile(
  cwd: string,
  options: { readonly allowProjectConfig?: boolean } = {},
): Promise<RoadmapFileResult> {
  const projectRoot = findProjectRoot(cwd);
  let roadmapPath = join(projectRoot, DEFAULT_ROADMAP_NAME);
  let usesProjectConfig = false;

  try {
    const configured = await configuredRoadmapPath(
      projectRoot,
      options.allowProjectConfig ?? true,
    );
    if (configured) {
      roadmapPath = configured;
      usesProjectConfig = true;
    }
  } catch (error) {
    return {
      status: "error",
      projectRoot,
      roadmapPath,
      message:
        error instanceof Error
          ? error.message
          : "Could not resolve the roadmap path.",
    };
  }

  try {
    const file = await stat(roadmapPath);
    if (!file.isFile()) {
      return {
        status: "error",
        projectRoot,
        roadmapPath,
        message: `${relative(projectRoot, roadmapPath)} is not a file.`,
      };
    }
    if (file.size > MAX_ROADMAP_BYTES) {
      return {
        status: "error",
        projectRoot,
        roadmapPath,
        message: `${relative(projectRoot, roadmapPath)} is larger than 1 MiB.`,
      };
    }
    if (usesProjectConfig) {
      const [realProjectRoot, realRoadmapPath] = await Promise.all([
        realpath(projectRoot),
        realpath(roadmapPath),
      ]);
      if (!isInsideProject(realProjectRoot, realRoadmapPath)) {
        return {
          status: "error",
          projectRoot,
          roadmapPath,
          message: `${PROGRESS_CONFIG_PATH} must point to a file inside the project.`,
        };
      }
    }
    return {
      status: "loaded",
      projectRoot,
      roadmapPath,
      markdown: await readFile(roadmapPath, "utf8"),
    };
  } catch (error) {
    if (isMissing(error)) {
      return { status: "missing", projectRoot, roadmapPath };
    }
    return {
      status: "error",
      projectRoot,
      roadmapPath,
      message: `Could not read ${basename(roadmapPath)}.`,
    };
  }
}
