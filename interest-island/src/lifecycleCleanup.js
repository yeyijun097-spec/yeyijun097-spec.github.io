import fs from "node:fs";
import path from "node:path";

export function cleanupDirectory({
  dir,
  retentionMs,
  maxFiles,
  maxBytes,
  protectedPaths = [],
  filter = () => true,
  now = Date.now()
}) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  const protectedSet = new Set(protectedPaths.filter(Boolean).map((file) => path.resolve(file)));
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => {
      const file = path.resolve(root, entry.name);
      const stat = fs.lstatSync(file);
      return { file, name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs };
    })
    .filter((item) => filter(item))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const deleted = [];
  let keptFiles = 0;
  let keptBytes = 0;
  const safeMaxFiles = Math.max(1, Number(maxFiles) || 1);
  const safeMaxBytes = Math.max(1, Number(maxBytes) || 1);
  const cutoff = now - Math.max(0, Number(retentionMs) || 0);
  for (const item of files) {
    if (protectedSet.has(item.file)) continue;
    const overAge = item.mtimeMs < cutoff;
    const overCount = keptFiles >= safeMaxFiles;
    const overBytes = keptBytes + item.size > safeMaxBytes;
    if (overAge || overCount || overBytes) {
      fs.unlinkSync(item.file);
      deleted.push(item.file);
      continue;
    }
    keptFiles += 1;
    keptBytes += item.size;
  }
  return deleted;
}
