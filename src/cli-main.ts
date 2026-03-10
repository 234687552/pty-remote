import { startCliClient } from './cli/client.ts';

void startCliClient().catch((error) => {
  console.error(error);
  process.exit(1);
});
