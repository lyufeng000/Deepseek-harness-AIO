import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

export function boundedPath(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath
      || /[\\:\0]/.test(relativePath) || isAbsolute(relativePath)
      || relativePath.split("/").some(part => !part || part === "." || part === ".."
        || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error("unsupported relative file path");
  }
  const base = resolve(root);
  const target = resolve(base, relativePath);
  const within = relative(base, target);
  if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
    throw new Error("file escapes its directory");
  }
  return target;
}

// Refuse links/junctions in every existing component, including the configured
// root. A lexically bounded path alone does not bound filesystem effects.
export async function assertNoLinks(target) {
  const absolute = resolve(target);
  let current = parse(absolute).root;
  for (const component of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error("linked skill paths are not supported");
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
  }
}

export async function removeBounded(root, target) {
  const absolute = boundedPath(root, relative(resolve(root), resolve(target)).split(sep).join("/"));
  await assertNoLinks(absolute);
  await rm(absolute, { recursive: true, force: true });
}

export async function atomicJson(target, value) {
  await assertNoLinks(target);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await assertNoLinks(target);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
