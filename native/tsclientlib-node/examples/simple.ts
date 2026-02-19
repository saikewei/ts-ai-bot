/* eslint-disable no-console */
const { TeamSpeakClient } = require('../index') as typeof import('../index');

const address = process.env.TS_ADDRESS ?? 'localhost';
const password = process.env.TS_PASSWORD;
const channel = process.env.TS_CHANNEL;
const nickname = process.env.TS_NICKNAME ?? 'tsclientlib-node-demo';
const runSeconds = Number(process.env.RUN_SECONDS ?? '5');

const SAMPLE_RATE = 48_000;
const FRAME_SAMPLES = SAMPLE_RATE / 50; // 20ms
const TONE_HZ = 440;

function makeSineFrame(phaseRef: { value: number }, gain = 0.15): Int16Array {
  const out = new Int16Array(FRAME_SAMPLES);
  const step = (2 * Math.PI * TONE_HZ) / SAMPLE_RATE;
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    const sample = Math.sin(phaseRef.value) * gain;
    out[i] = Math.max(-1, Math.min(1, sample)) * 32767;
    phaseRef.value += step;
    if (phaseRef.value > Math.PI * 2) phaseRef.value -= Math.PI * 2;
  }
  return out;
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

  client.on('audioMixed', (e) => {
    // 每 20ms 一帧，打印太频繁；这里只做示意
    if (Math.random() < 0.02) {
      console.log('[audioMixed]', e.samples, 'samples');
    }
  });

  client.on('audioSpeaker', (e) => {
    if (Math.random() < 0.05) {
      console.log('[audioSpeaker]', e.clientId, e.samples, 'samples');
    }
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

  console.log('identity:', client.exportIdentity());

  const phase = { value: 0 };
  const timer = setInterval(() => {
    client.pushFrame(makeSineFrame(phase));
  }, 20);

  // 发音 N 秒后断开
  setTimeout(async () => {
    clearInterval(timer);
    await client.disconnect({ message: 'demo done' });
    process.exit(0);
  }, Math.max(1, runSeconds) * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
