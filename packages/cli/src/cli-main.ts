import { startCliClient } from './cli/client.ts';
import { runThreadsCli } from './threads-cli.ts';

async function main(): Promise<void> {
  const [command, ...restArgs] = process.argv.slice(2);

  if (command === 'threads') {
    process.exitCode = await runThreadsCli(restArgs);
    return;
  }

  await startCliClient();
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
