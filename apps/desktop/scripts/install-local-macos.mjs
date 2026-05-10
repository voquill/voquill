import { access, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_APP_NAME = "Voquill (local).app";
const LOCAL_INSTALL_PATH = `/Applications/${LOCAL_APP_NAME}`;
const DEFAULT_SOURCE_APP_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src-tauri/target/release/bundle/macos",
  LOCAL_APP_NAME,
);

export function getInstallPlan(sourceAppPath = DEFAULT_SOURCE_APP_PATH, { dryRun = false } = {}) {
  const resolvedSourceAppPath = path.resolve(sourceAppPath);

  if (path.basename(resolvedSourceAppPath) !== LOCAL_APP_NAME) {
    throw new Error(`Source app path must point to ${LOCAL_APP_NAME}.`);
  }

  return {
    sourceAppPath: resolvedSourceAppPath,
    targetAppPath: LOCAL_INSTALL_PATH,
    dryRun,
  };
}

export async function installLocalMacos(options = {}) {
  const plan = getInstallPlan(options.sourceAppPath, { dryRun: options.dryRun });

  if (plan.dryRun) {
    return plan;
  }

  await access(plan.sourceAppPath);
  await rm(plan.targetAppPath, { recursive: true, force: true });
  await cp(plan.sourceAppPath, plan.targetAppPath, { recursive: true });

  return plan;
}

async function runCli() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const sourceAppPath = args.find((arg) => !arg.startsWith("--"));
  const plan = await installLocalMacos({ sourceAppPath, dryRun });

  const action = dryRun ? "Would replace" : "Replaced";
  console.log(`${action} ${plan.targetAppPath} with ${plan.sourceAppPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
