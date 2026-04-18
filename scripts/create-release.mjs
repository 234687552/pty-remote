import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const version = process.argv[2]?.trim();

if (!version) {
  console.error('Usage: node scripts/create-release.mjs <version>');
  process.exit(1);
}

const releaseTag = `v${version}`;

async function run(command, args, options = {}) {
  const { stdout = 'inherit', stderr = 'inherit', ...rest } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      cwd: process.cwd(),
      env: process.env,
      ...rest
    }, (error, childStdout, childStderr) => {
      if (stdout === 'pipe' || stderr === 'pipe') {
        if (error) {
          error.stdout = childStdout;
          error.stderr = childStderr;
          reject(error);
          return;
        }
        resolve({ stdout: childStdout, stderr: childStderr });
        return;
      }

      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: childStdout, stderr: childStderr });
    });

    if (stdout === 'inherit' && child.stdout) {
      child.stdout.pipe(process.stdout);
    }
    if (stderr === 'inherit' && child.stderr) {
      child.stderr.pipe(process.stderr);
    }
  });
}

async function ensureCleanWorktree() {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
    cwd: process.cwd(),
    env: process.env
  });
  if (stdout.trim()) {
    throw new Error('Working tree is not clean');
  }
}

async function ensureOnMainBranch() {
  const { stdout } = await execFileAsync('git', ['branch', '--show-current'], {
    cwd: process.cwd(),
    env: process.env
  });
  if (stdout.trim() !== 'main') {
    throw new Error('Release must be created from main');
  }
}

async function ensureTagDoesNotExist() {
  try {
    await execFileAsync('git', ['rev-parse', releaseTag], {
      cwd: process.cwd(),
      env: process.env
    });
    throw new Error(`Tag ${releaseTag} already exists`);
  } catch (error) {
    if (error instanceof Error && /already exists/.test(error.message)) {
      throw error;
    }
  }
}

async function main() {
  await ensureCleanWorktree();
  await ensureOnMainBranch();
  await run('git', ['fetch', 'origin', 'main', '--tags']);
  await ensureTagDoesNotExist();
  await run('git', ['pull', '--ff-only', 'origin', 'main']);
  await run('node', ['scripts/prepare-release.mjs', version]);
  await run('npm', ['install', '--package-lock-only']);
  await run('git', ['add', 'package-lock.json', 'packages/cli/package.json', 'packages/relay/package.json', 'packages/protocol/package.json']);
  await run('git', ['commit', '-m', `Release ${releaseTag}`]);
  await run('git', ['tag', '-a', releaseTag, '-m', `Release ${releaseTag}`]);
  await run('git', ['push', '--atomic', 'origin', 'HEAD:main', `refs/tags/${releaseTag}`]);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
