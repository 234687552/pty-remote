import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();
const version = process.argv[2]?.trim();

if (!version) {
  console.error('Usage: node scripts/prepare-release.mjs <version>');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version: ${version}`);
  process.exit(1);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function listWorkspacePackageDirs() {
  const rootPackage = await readJson(path.join(rootDir, 'package.json'));
  const patterns = Array.isArray(rootPackage.workspaces) ? rootPackage.workspaces : [];
  const dirs = [];

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || !pattern.endsWith('/*')) {
      continue;
    }
    const baseDir = path.join(rootDir, pattern.slice(0, -2));
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        dirs.push(path.join(baseDir, entry.name));
      }
    }
  }

  return dirs;
}

async function main() {
  const packageDirs = await listWorkspacePackageDirs();
  const packages = [];

  for (const dir of packageDirs) {
    const manifestPath = path.join(dir, 'package.json');
    const manifest = await readJson(manifestPath);
    if (!manifest.name || !manifest.version) {
      continue;
    }
    packages.push({
      dir,
      manifest,
      manifestPath,
      name: manifest.name
    });
  }

  const workspaceNames = new Set(packages.map((pkg) => pkg.name));
  let changedCount = 0;

  for (const pkg of packages) {
    const nextManifest = structuredClone(pkg.manifest);

    if (nextManifest.version !== version) {
      nextManifest.version = version;
    }

    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      const record = nextManifest[field];
      if (!record || typeof record !== 'object') {
        continue;
      }
      for (const dependencyName of Object.keys(record)) {
        if (workspaceNames.has(dependencyName)) {
          record[dependencyName] = version;
        }
      }
    }

    const before = JSON.stringify(pkg.manifest);
    const after = JSON.stringify(nextManifest);
    if (before === after) {
      continue;
    }

    await writeJson(pkg.manifestPath, nextManifest);
    changedCount += 1;
    console.log(`updated ${path.relative(rootDir, pkg.manifestPath)} -> ${version}`);
  }

  if (changedCount === 0) {
    console.error(`No workspace versions changed for ${version}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
