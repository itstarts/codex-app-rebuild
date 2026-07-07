const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { computeAsarHeaderHash } = require("../scripts/lib/asar-utils");

test("computeAsarHeaderHash hashes bytes from ASAR header range", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asar-hash-"));
  const file = path.join(tmp, "fixture.asar");
  const header = Buffer.from("0123456789abcdef", "utf8");
  const buf = Buffer.alloc(16 + header.length + 8);
  buf.writeUInt32LE(header.length, 12);
  header.copy(buf, 16);
  fs.writeFileSync(file, buf);
  const expected = crypto.createHash("sha256").update(header).digest("hex");
  assert.equal(computeAsarHeaderHash(file), expected);
});
