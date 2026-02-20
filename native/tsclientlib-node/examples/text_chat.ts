/* eslint-disable no-console */
const { TeamSpeakClient } = require('../index') as typeof import('../index');

const address = process.env.TS_ADDRESS ?? 'localhost';
const password = process.env.TS_PASSWORD;
const channel = process.env.TS_CHANNEL;
const nickname = process.env.TS_NICKNAME ?? 'tsclientlib-node-text-demo';
const textTarget = (process.env.TS_TEXT_TARGET ?? 'channel') as 'server' | 'channel' | 'client';
const textTargetClientId = process.env.TS_TEXT_CLIENT_ID ? Number(process.env.TS_TEXT_CLIENT_ID) : undefined;
const runSeconds = 10;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const client = new TeamSpeakClient();

  client.on('connected', (e) => {
    console.log('[connected]', e);
  });

  client.on('reconnecting', (e) => {
    console.log('[reconnecting]', e);
  });

  client.on('disconnected', (e) => {
    console.log('[disconnected]', e);
  });

  client.on('textMessage', (e) => {
    console.log('[textMessage]', {
      target: e.target,
      targetClientId: e.targetClientId,
      from: `${e.invoker.name}(${e.invoker.id})`,
      message: e.message,
    });
  });

  client.on('error', (e) => {
    console.error('[error]', e);
  });

  await client.connect({
    address,
    password,
    channel,
    nickname,
    logLevel: 'off',
  });

  const textList = [
    'hello from tsclientlib-node demo',
    `current time: ${new Date().toISOString()}`,
    'this bot will disconnect in 10 seconds',
  ];

  for (const text of textList) {
    try {
      const params =
        textTarget === 'client'
          ? { target: textTarget, message: text, clientId: textTargetClientId }
          : { target: textTarget, message: text };
      await client.sendTextMessage(params);
      console.log('[sent]', { target: textTarget, text });
    } catch (err) {
      console.error('[send failed]', { target: textTarget, text, err: String(err) });
    }
    await wait(800);
  }

  setTimeout(async () => {
    try {
      if (client.isConnected()) {
        await client.disconnect({ message: 'text chat demo done' });
      }
    } catch (err) {
      console.error('[disconnect error]', err);
    } finally {
      process.exit(0);
    }
  }, runSeconds * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
