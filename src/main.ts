import { TeamSpeakClient } from '../index';

async function main() {
  const client = new TeamSpeakClient();

  client.on('connected', (payload) => {
    console.log('connected', payload);
  });
  client.on('disconnected', (payload) => {
    console.log('disconnected', payload);
  });
  client.on('error', (payload) => {
    console.error('error', payload);
  });

  console.log('Node API ready. Fill in connection params before running connect().');
  console.log('Auto-exit in 500ms...');

  await new Promise<void>((resolve) => {
    setTimeout(resolve, 500);
  });

  if (client.isConnected()) {
    await client.disconnect({ message: 'main.ts demo done' });
  }

  const nodeProcess = (
    globalThis as { process?: { exit: (code?: number) => never } }
  ).process;
  nodeProcess?.exit(0);
}

main().catch((err) => {
  console.error(err);
});
