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
  void client;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
