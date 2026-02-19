'use strict';

const fs = require('fs');
const path = require('path');
const { TeamSpeakClient } = require('../index');

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const FRAME_SAMPLES = SAMPLE_RATE / 50; // 20ms
const FRAME_BYTES = FRAME_SAMPLES * 2;
const DURATION_SECONDS = Number(process.env.RECORD_SECONDS || '10');
const TARGET_FRAMES = Math.max(1, DURATION_SECONDS) * 50;
const OUTPUT = process.env.OUT_WAV || path.resolve(process.cwd(), 'mixed_10s.wav');

function writeWavHeader(fd, pcmBytes) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const dataSize = pcmBytes;
  const riffSize = 36 + dataSize;

  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(riffSize, 4);
  header.write('WAVE', 8, 4, 'ascii');
  header.write('fmt ', 12, 4, 'ascii');
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 4, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  fs.writeSync(fd, header, 0, header.length, 0);
}

async function main() {
  const address = process.env.TS_ADDRESS;
  const password = process.env.TS_PASSWORD;
  const nickname = process.env.TS_NICKNAME || 'mixed-recorder';

  if (!address) {
    throw new Error('TS_ADDRESS is required');
  }

  const fd = fs.openSync(OUTPUT, 'w');
  // Reserve WAV header, will be rewritten at end with final sizes.
  fs.writeSync(fd, Buffer.alloc(44));

  const client = new TeamSpeakClient();
  let totalPcmBytes = 0; // bytes actually written to wav data section
  let mixedFramesIn = 0; // incoming audioMixed events
  let speakerFrames = 0;
  let done = false;

  client.on('connected', (e) => console.log('connected', e));
  client.on('disconnected', (e) => console.log('disconnected', e));
  client.on('error', (e) => console.log('error', e));
  client.on('audioSpeaker', () => {
    speakerFrames += 1;
  });
  client.on('audioMixed', (e) => {
    if (done) return;
    if (!Buffer.isBuffer(e.pcm)) return;
    mixedFramesIn += 1;
    if (e.pcm.length >= FRAME_BYTES) {
      fs.writeSync(fd, e.pcm.subarray(0, FRAME_BYTES));
      totalPcmBytes += FRAME_BYTES;
    } else {
      const frame = Buffer.alloc(FRAME_BYTES, 0);
      e.pcm.copy(frame, 0, 0, e.pcm.length);
      fs.writeSync(fd, frame);
      totalPcmBytes += FRAME_BYTES;
    }

    if (mixedFramesIn >= TARGET_FRAMES) {
      done = true;
    }
  });

  await client.connect({
    address,
    password,
    nickname,
  });

  // Wait until exact frame count is collected.
  while (!done) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  await client.disconnect({ message: 'record done' });
  await new Promise((resolve) => setTimeout(resolve, 300));

  writeWavHeader(fd, totalPcmBytes);
  fs.closeSync(fd);

  console.log('saved', {
    output: OUTPUT,
    seconds: DURATION_SECONDS,
    mixedFramesIn,
    targetFrames: TARGET_FRAMES,
    speakerFrames,
    pcmBytes: totalPcmBytes,
  });

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
