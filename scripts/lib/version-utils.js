function pad2(value) {
  return String(value).padStart(2, "0");
}

function generateBuildNumber(date = new Date(), sequence = 0) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 99) {
    throw new Error("sequence must be an integer from 0 to 99");
  }

  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
    pad2(sequence),
  ].join("");
}

function validateBuildNumber(value, label = "build number") {
  if (!/^\d{16}$/.test(String(value))) {
    throw new Error(`${label} must match YYYYMMDDHHMMSSNN`);
  }
}

function compareBuildNumbers(a, b) {
  validateBuildNumber(a, "left build number");
  validateBuildNumber(b, "right build number");
  if (a === b) {
    return 0;
  }
  return a > b ? 1 : -1;
}

function assertBuildNumberGreater(candidate, previousMax) {
  validateBuildNumber(candidate, "candidate build number");
  if (!previousMax) {
    return;
  }
  validateBuildNumber(previousMax, "previous max build number");
  if (compareBuildNumbers(candidate, previousMax) <= 0) {
    throw new Error(
      `candidate build number ${candidate} is not greater than previous max ${previousMax}`,
    );
  }
}

module.exports = {
  generateBuildNumber,
  compareBuildNumbers,
  assertBuildNumberGreater,
  validateBuildNumber,
};
