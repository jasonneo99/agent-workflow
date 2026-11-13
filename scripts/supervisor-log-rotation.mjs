import fs from "node:fs/promises";
import path from "node:path";

export async function rotateSupervisorLogs(logDir, options = {}) {
  const maxBytes = positiveInteger(options.maxBytes, 10 * 1024 * 1024);
  const keep = positiveInteger(options.keep, 5);
  return Promise.all([
    rotateFileIfOversized(path.join(logDir, "stdout.log"), { maxBytes, keep }),
    rotateFileIfOversized(path.join(logDir, "stderr.log"), { maxBytes, keep })
  ]);
}

export async function rotateFileIfOversized(filePath, options = {}) {
  const maxBytes = positiveInteger(options.maxBytes, 10 * 1024 * 1024);
  const keep = positiveInteger(options.keep, 5);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return { filePath, rotated: false, size: 0 };
    throw error;
  }
  if (!stat.isFile() || stat.size <= maxBytes) {
    return { filePath, rotated: false, size: stat.size };
  }

  for (let index = keep; index >= 1; index -= 1) {
    const source = `${filePath}.${index}`;
    const destination = `${filePath}.${index + 1}`;
    if (index === keep) {
      await fs.unlink(source).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    } else {
      await fs.rename(source, destination).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
  }

  const retainedBytes = Math.min(stat.size, maxBytes);
  const retained = Buffer.allocUnsafe(retainedBytes);
  const handle = await fs.open(filePath, "r");
  try {
    await handle.read(retained, 0, retainedBytes, stat.size - retainedBytes);
  } finally {
    await handle.close();
  }
  await fs.writeFile(`${filePath}.1`, retained);
  await fs.truncate(filePath, 0);
  return { filePath, rotated: true, size: stat.size };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
