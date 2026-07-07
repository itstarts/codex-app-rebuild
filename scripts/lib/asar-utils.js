const crypto = require("node:crypto");
const fs = require("node:fs");
const asar = require("@electron/asar");

function computeAsarHeaderHash(asarPath) {
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = buf.subarray(16, 16 + headerSize);
  return crypto.createHash("sha256").update(header).digest("hex");
}

async function extractAsar(asarPath, dest) {
  await asar.extractAll(asarPath, dest);
}

async function packAsar(src, dest) {
  await asar.createPackage(src, dest);
}

module.exports = {
  computeAsarHeaderHash,
  extractAsar,
  packAsar,
};
