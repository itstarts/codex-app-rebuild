const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const workflowPath = path.join(root, ".github", "workflows", "release-candidate.yml");
const runbookPath = path.join(root, "doc", "release-runbook.md");

function readRequired(file) {
  assert.equal(fs.existsSync(file), true, `${path.relative(root, file)} must exist`);
  return fs.readFileSync(file, "utf8");
}

test("release workflow automatically publishes signed macOS arm64 Sparkle updates", () => {
  const workflow = readRequired(workflowPath);

  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /^\s+schedule:/m);
  assert.match(workflow, /cron: "0 23 \* \* \*"/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /release_mode:[\s\S]*default: latest-release/);
  assert.match(workflow, /- latest-release/);
  assert.match(workflow, /force_build:[\s\S]*default: false/);
  assert.match(workflow, /check-official-update:/);
  assert.match(workflow, /check-official-update:[\s\S]*permissions:[\s\S]*contents: read/);
  assert.match(workflow, /node scripts\/check-official-update\.js/);
  assert.match(workflow, /REBUILD_UPSTREAM_BUILD=\$upstream_build/);
  assert.match(
    workflow,
    /if: \$\{\{ needs\.check-official-update\.outputs\.should_build == 'true' \}\}/,
  );
  assert.match(
    workflow,
    /promote-release:/,
  );
  assert.match(
    workflow,
    /if: \$\{\{ needs\.check-official-update\.outputs\.should_promote == 'true'/,
  );
  const promoteJob = workflow.match(/  promote-release:[\s\S]*?\n  build:/)?.[0] ?? "";
  assert.notEqual(promoteJob, "");
  assert.match(
    promoteJob,
    /github_api -X PATCH --data "\$publish_payload" "https:\/\/api\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}"/,
  );
  assert.match(promoteJob, /PROMOTE_TAG="\$PROMOTE_TAG"/);
  assert.doesNotMatch(promoteJob, /gh release/);
  assert.match(
    workflow,
    /if: \$\{\{ needs\.build\.result == 'success' && \(github\.event_name == 'schedule' \|\| \(github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.release_mode != 'artifact-only'\)\) \}\}/,
  );
  assert.match(workflow, /INPUT_REBUILD_BUILD_NUMBER: \$\{\{ github\.event\.inputs\.rebuild_build_number \|\| '' \}\}/);
  assert.match(workflow, /KNOWN_UPDATE_COUNT: \$\{\{ needs\.check-official-update\.outputs\.known_update_count \}\}/);
  assert.match(
    workflow,
    /\[ "\$GITHUB_EVENT_NAME" = "schedule" \] && \[ "\$\{KNOWN_UPDATE_COUNT:-0\}" = "0" \]/,
  );
  assert.match(workflow, /REBUILD_ALLOW_NO_PREVIOUS_RELEASE=1/);
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /actions\/checkout@v6/);
  assert.match(workflow, /actions\/setup-node@v6/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /actions\/download-artifact@v8/);
  assert.match(workflow, /SPARKLE_VERSION: "2\.9\.4"/);
  assert.match(workflow, /ce89daf967db1e1893ed3ebd67575ed82d3902563e3191ca92aaec9164fbdef9/);
  assert.match(workflow, /\$\{\{\s*secrets\.SPARKLE_PRIVATE_KEY\s*\}\}/);
  assert.match(workflow, /private_key_file="\$RUNNER_TEMP\/sparkle-private-ed-key\.txt"/);
  assert.match(workflow, /SPARKLE_PRIVATE_KEY_FILE=\$private_key_file/);
  assert.match(workflow, /npm run sync:mac/);
  assert.match(workflow, /npm run patch:check/);
  assert.match(workflow, /npm run patch/);
  assert.match(workflow, /npm run build:mac-arm64/);
  assert.match(workflow, /npm run appcast/);
  assert.match(workflow, /RELEASE_MODE: \$\{\{ github\.event_name == 'schedule' && 'latest-release' \|\| github\.event\.inputs\.release_mode \}\}/);
  assert.doesNotMatch(workflow, /\bgh release\b/);
  assert.doesNotMatch(workflow, /gh release create/);
  assert.doesNotMatch(workflow, /gh release upload/);
  assert.match(workflow, /curl --fail-with-body -sS -L/);
  assert.match(workflow, /https:\/\/api\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}\/releases/);
  assert.match(workflow, /https:\/\/uploads\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}\/assets\?name=\$\{encoded_name\}/);
  assert.match(workflow, /tag_name: process\.env\.RELEASE_TAG/);
  assert.match(workflow, /target_commitish: process\.env\.GITHUB_SHA/);
  assert.match(workflow, /draft: true/);
  assert.match(workflow, /make_latest: "true"/);
  const createCommand = workflow.match(/create_payload="\$\([\s\S]*?\)"\s+release_json="\$\(github_api -X POST --data "\$create_payload" "https:\/\/api\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}\/releases"\)"/)?.[0] ?? "";
  assert.notEqual(createCommand, "");
  assert.match(createCommand, /target_commitish: process\.env\.GITHUB_SHA/);
  assert.match(createCommand, /make_latest: "false"/);
  assert.doesNotMatch(createCommand, /"\$zip_path"/);
  assert.doesNotMatch(createCommand, /"\$appcast_path"/);
  assert.match(workflow, /JSON\.stringify\(\{ draft: false, prerelease: false, make_latest: "true" \}\)/);
  assert.match(
    workflow,
    /delete_existing_asset "\$\(basename "\$zip_path"\)"\s+upload_asset "\$zip_path"\s+delete_existing_asset "\$\(basename "\$appcast_path"\)"\s+upload_asset "\$appcast_path"/,
  );
  assert.doesNotMatch(workflow, /release_flags\+=\(--latest\)/);
  assert.match(
    workflow,
    /release_json="\$\(github_api -X POST --data "\$create_payload" "https:\/\/api\.github\.com\/repos\/\$\{GITHUB_REPOSITORY\}\/releases"\)"[\s\S]*upload_asset "\$zip_path"[\s\S]*upload_asset "\$appcast_path"[\s\S]*if \[ "\$release_mode" = "latest-release" \]; then\s+publish_payload=/,
  );
  assert.match(workflow, /\[ "\$existing_draft" != "true" \]/);
  assert.match(workflow, /refusing to overwrite published assets/);
  assert.doesNotMatch(workflow, /SPARKLE_PRIVATE_KEY[^\n]*upload-artifact/);
});

test("release runbook documents GitHub Actions automatic update boundaries", () => {
  const runbook = readRequired(runbookPath);

  assert.match(runbook, /SPARKLE_PRIVATE_KEY/);
  assert.match(runbook, /release-candidate\.yml/);
  assert.match(runbook, /latest-release/);
  assert.match(runbook, /官方 appcast/);
  assert.match(runbook, /北京时间每天 7:00/);
  assert.match(runbook, /自动发布 latest/);
  assert.match(runbook, /本地旧版 app/);
  assert.match(runbook, /检测到更新/);
});
