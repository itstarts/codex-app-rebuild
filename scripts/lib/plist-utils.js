const { run } = require("./fs-utils");

function plutilGet(plistPath, key) {
  return run("plutil", ["-extract", key, "raw", plistPath]).trim();
}

function plutilSet(plistPath, key, value) {
  run("plutil", ["-replace", key, "-string", String(value), plistPath]);
}

module.exports = {
  plutilGet,
  plutilSet,
};
