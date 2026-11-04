// Packages the extension as a zip that Chrome and Edge accept.
//
// An unpacked extension is a folder with a manifest. A store build is the same
// folder zipped from the inside, with manifest.json at the root rather than inside
// a directory. Getting that wrong produces "Manifest file is missing or
// unreadable", which is a confusing error for a zip layout problem.
//
// Run: npm run ext

import { mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, rmSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "extension");
const OUT = join(ROOT, "dist", "hasp-extension.zip");

/** Every file under a directory, recursively, as sorted relative paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * A minimal zip writer.
 *
 * Only what a browser extension needs: deflate, no zip64, no encryption, no
 * comments. A dependency for this would be more code than the format itself.
 */
function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of files) {
    const raw = Buffer.from(data);
    const deflated = deflateRawSync(raw, { level: 9 });
    // Store uncompressed when compressing made it bigger, which happens with
    // small PNGs that are already deflated.
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(name, "utf8");
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date, 1980-01-01, so builds are reproducible
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory header
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0x21, 14);
    dir.writeUInt32LE(sum, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);

    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

const manifestPath = join(SRC, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

// Refuse to package something the review would reject. A missing file is a 404 at
// runtime in a context that is hard to debug, so it fails here instead.
const named = [
  manifest.action.default_popup,
  manifest.options_ui.page,
  manifest.background.service_worker,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
];
const present = new Set(walk(SRC).map((f) => relative(SRC, f).split("\\").join("/")));
const missing = named.filter((f) => !present.has(f));
if (missing.length) {
  console.error(`manifest names files that do not exist: ${missing.join(", ")}`);
  process.exit(1);
}

const files = [...present].sort().map((name) => ({ name, data: readFileSync(join(SRC, name)) }));
rmSync(dirname(OUT), { recursive: true, force: true });
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, zip(files));

const size = statSync(OUT).size;
console.log(`extension: ${files.length} files, ${(size / 1024).toFixed(1)} KB`);
console.log(`  ${relative(ROOT, OUT)}`);
console.log(`  version ${manifest.version}`);
