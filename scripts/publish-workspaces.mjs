import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = process.cwd();
const dryRun = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
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
      if (!entry.isDirectory()) {
        continue;
      }
      dirs.push(path.join(baseDir, entry.name));
    }
  }

  return dirs;
}

function collectLocalDeps(pkg, workspaceNames) {
  const fields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
  const deps = new Set();

  for (const field of fields) {
    const record = pkg[field];
    if (!record || typeof record !== 'object') {
      continue;
    }
    for (const name of Object.keys(record)) {
      if (workspaceNames.has(name)) {
        deps.add(name);
      }
    }
  }

  return [...deps];
}

function topoSort(workspaces) {
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const visiting = new Set();
  const visited = new Set();
  const sorted = [];

  function visit(name) {
    if (visited.has(name)) {
      return;
    }
    if (visiting.has(name)) {
      throw new Error(`Circular workspace dependency detected at ${name}`);
    }

    visiting.add(name);
    const workspace = byName.get(name);
    if (!workspace) {
      throw new Error(`Unknown workspace ${name}`);
    }
    for (const dep of workspace.localDeps) {
      visit(dep);
    }
    visiting.delete(name);
    visited.add(name);
    sorted.push(workspace);
  }

  for (const workspace of workspaces) {
    visit(workspace.name);
  }

  return sorted;
}

async function packageVersionExists(name, version) {
  try {
    const { stdout } = await execFileAsync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
      cwd: rootDir,
      env: process.env
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function publishWorkspace(workspace) {
  const alreadyPublished = await packageVersionExists(workspace.name, workspace.version);
  if (alreadyPublished) {
    console.log(`skip ${workspace.name}@${workspace.version} (already published)`);
    return;
  }

  const command = ['publish', '--access', 'public', '--provenance'];
  if (dryRun) {
    console.log(`dry-run publish ${workspace.name}@${workspace.version}: npm ${command.join(' ')}`);
    return;
  }

  console.log(`publish ${workspace.name}@${workspace.version}`);
  await new Promise((resolve, reject) => {
    const child = spawn('npm', command, {
      cwd: workspace.dir,
      env: process.env,
      stdio: 'inherit'
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      reject(new Error(`npm publish failed for ${workspace.name}@${workspace.version} with exit code ${code ?? 'unknown'}`));
    });
  });
}

async function main() {
  const packageDirs = await listWorkspacePackageDirs();
  const packages = [];

  for (const dir of packageDirs) {
    const manifestPath = path.join(dir, 'package.json');
    const pkg = await readJson(manifestPath);
    if (!pkg.name || !pkg.version) {
      continue;
    }
    packages.push({
      dir,
      name: pkg.name,
      private: pkg.private === true,
      version: pkg.version,
      manifest: pkg
    });
  }

  const publicPackages = packages.filter((pkg) => !pkg.private);
  const workspaceNames = new Set(publicPackages.map((pkg) => pkg.name));
  const publishable = publicPackages.map((pkg) => ({
    ...pkg,
    localDeps: collectLocalDeps(pkg.manifest, workspaceNames)
  }));
  const ordered = topoSort(publishable);

  for (const workspace of ordered) {
    await publishWorkspace(workspace);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
