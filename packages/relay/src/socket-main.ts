import { startSocketServer } from './socket/server.ts';

void startSocketServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
