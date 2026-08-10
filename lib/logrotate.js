"use strict";

// launchd holds streamcount.log open in append mode for the life of the
// process, so renaming the file would just leave launchd writing to an
// invisible inode. The only safe rotation is: copy the tail aside, then
// truncate in place. Append-mode writes resume at the new EOF.

const fs = require("fs");

function rotateIfLarge(filePath, maxBytes, keepTailBytes) {
  if (!filePath) return { rotated: false };
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { rotated: false };
  }
  if (stat.size <= maxBytes) return { rotated: false, size: stat.size };

  const keep = Math.min(keepTailBytes ?? Math.floor(maxBytes / 4), stat.size);
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(keep);
    fs.readSync(fd, buf, 0, keep, stat.size - keep);
    fs.closeSync(fd);
    fd = null;
    fs.writeFileSync(
      `${filePath}.1`,
      `--- rotated at ${new Date().toISOString()}, tail of a ${stat.size}-byte log ---\n${buf.toString("utf8")}`
    );
    fs.truncateSync(filePath, 0);
    return { rotated: true, was: stat.size, kept: keep };
  } catch (err) {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    return { rotated: false, error: err.message };
  }
}

module.exports = { rotateIfLarge };
