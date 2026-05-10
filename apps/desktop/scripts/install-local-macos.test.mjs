import assert from "node:assert/strict";
import test from "node:test";

async function loadInstallHelper() {
  try {
    return await import("./install-local-macos.mjs");
  } catch {
    return {};
  }
}

test("install plan only replaces the local app bundle in dry run mode", async () => {
  const { getInstallPlan } = await loadInstallHelper();

  assert.equal(typeof getInstallPlan, "function");

  const plan = getInstallPlan("/build/Voquill (local).app", { dryRun: true });

  assert.equal(plan.sourceAppPath, "/build/Voquill (local).app");
  assert.equal(plan.targetAppPath, "/Applications/Voquill (local).app");
  assert.notEqual(plan.targetAppPath, "/Applications/Voquill.app");
  assert.equal(plan.dryRun, true);
});

test("install plan rejects the official app bundle path", async () => {
  const { getInstallPlan } = await loadInstallHelper();

  assert.equal(typeof getInstallPlan, "function");
  assert.throws(() => getInstallPlan("/build/Voquill.app", { dryRun: true }), {
    message: /Voquill \(local\)\.app/,
  });
});
