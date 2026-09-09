import { unzipSync } from "fflate";

// fflate is already shipped with the reviewed public kernel. Bound allocation
// before decompression; the generated host never depends on retired yauzl.
export function unzipArchive(buffer) {
  if (buffer.length > 16 * 1024 * 1024) throw new Error("archive too large");
  let count = 0;
  let total = 0;
  const entries = unzipSync(buffer, {
    filter(entry) {
      if (++count > 2000) throw new Error("archive has too many entries");
      total += entry.originalSize;
      if (total > 200 * 1024 * 1024) throw new Error("archive too large");
      return true;
    },
  });
  const files = Object.entries(entries).filter(([name]) => !name.endsWith("/"))
    .map(([name, data]) => ({ name, data: Buffer.from(data) }));
  if (!files.length) throw new Error("archive contains no files");
  if (files.reduce((size, file) => size + file.data.length, 0) > 200 * 1024 * 1024) {
    throw new Error("archive too large");
  }
  return files;
}
