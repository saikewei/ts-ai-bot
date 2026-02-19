//! This example connects to a TeamSpeak server and sends audio from an mp3 file.
//! It does not access any system audio input/output device.
//! The file `examples/sample/music1.mp3` is played for 5 seconds, then the client disconnects.

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use audiopus::coder::Encoder;
use clap::Parser;
use futures::prelude::*;
use minimp3::{Decoder, Error as Mp3Error, Frame};
use tokio::time::{self, Duration, MissedTickBehavior};
use tsclientlib::{Connection, DisconnectOptions, Identity, StreamItem};
use tsproto_packets::packets::{AudioData, CodecType, OutAudio, OutPacket};

const TARGET_SAMPLE_RATE: usize = 48_000;
const FRAME_SAMPLES: usize = TARGET_SAMPLE_RATE / 50;
const PLAY_SECONDS: usize = 5;
const MAX_OPUS_FRAME_SIZE: usize = 1275;

#[derive(Parser, Debug)]
#[command(author, about)]
struct Args {
	/// The address of the server to connect to
	#[arg(short, long, default_value = "localhost")]
	address: String,
	/// The password
	#[arg(short, long, default_value = "")]
	password: String,
	/// Volume multiplier for the mp3 audio
	#[arg(default_value_t = 1.0)]
	volume: f32,
	/// Print the content of all packets
	///
	/// 0. Print nothing
	/// 1. Print command string
	/// 2. Print packets
	/// 3. Print udp packets
	#[arg(short, long, action = clap::ArgAction::Count)]
	verbose: u8,
}

#[tokio::main]
async fn main() -> Result<()> {
	real_main().await
}

async fn real_main() -> Result<()> {
	tracing_subscriber::fmt::init();
	let args = Args::parse();

	let audio_path =
		Path::new(env!("CARGO_MANIFEST_DIR")).join("examples").join("sample").join("music1.mp3");
	let pcm = decode_mp3_to_target_pcm(&audio_path, PLAY_SECONDS)
		.with_context(|| format!("Failed to decode {}", audio_path.display()))?;
	let packets = encode_packets(&pcm, args.volume)?;

	let con_config = Connection::build(args.address)
		.log_commands(args.verbose >= 1)
		.log_packets(args.verbose >= 2)
		.log_udp_packets(args.verbose >= 3)
		.password(args.password);

	let id = Identity::new_from_str(
		"MG0DAgeAAgEgAiAIXJBlj1hQbaH0Eq0DuLlCmH8bl+veTAO2+\
		k9EQjEYSgIgNnImcmKo7ls5mExb6skfK2Tw+u54aeDr0OP1ITs\
		C/50CIA8M5nmDBnmDM/gZ//4AAAAAAAAAAAAAAAAAAAAZRzOI",
	)
	.unwrap();
	let con_config = con_config.identity(id);

	let mut con = con_config.connect()?;
	let r = con
		.events()
		.try_filter(|e| future::ready(matches!(e, StreamItem::BookEvents(_))))
		.next()
		.await;
	if let Some(r) = r {
		r?;
	}

	let mut ticker = time::interval(Duration::from_millis(20));
	ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
	let mut packets = packets.into_iter();

	loop {
		tokio::select! {
			_ = ticker.tick() => {
				if let Some(packet) = packets.next() {
					con.send_audio(packet)?;
				} else {
					break;
				}
			}
			_ = tokio::signal::ctrl_c() => {
				break;
			}
		}
	}

	con.disconnect(DisconnectOptions::new())?;
	con.events().for_each(|_| future::ready(())).await;
	Ok(())
}

fn decode_mp3_to_target_pcm(path: &Path, play_seconds: usize) -> Result<Vec<f32>> {
	let file = File::open(path)?;
	let mut decoder = Decoder::new(BufReader::new(file));
	let target_samples = TARGET_SAMPLE_RATE * play_seconds;
	let mut out = Vec::with_capacity(target_samples);

	while out.len() < target_samples {
		let frame = match decoder.next_frame() {
			Ok(frame) => frame,
			Err(Mp3Error::Eof) => break,
			Err(error) => return Err(anyhow!("mp3 decode error: {error}")),
		};
		let mono = frame_to_mono_f32(&frame);
		let resampled = resample_linear(&mono, frame.sample_rate as usize, TARGET_SAMPLE_RATE);
		let remain = target_samples - out.len();
		if resampled.len() > remain {
			out.extend_from_slice(&resampled[..remain]);
		} else {
			out.extend_from_slice(&resampled);
		}
	}

	if out.is_empty() {
		bail!("No audio samples decoded from {}", path.display());
	}
	if out.len() < target_samples {
		out.resize(target_samples, 0.0);
	}
	Ok(out)
}

fn frame_to_mono_f32(frame: &Frame) -> Vec<f32> {
	let channels = frame.channels as usize;
	if channels <= 1 {
		return frame.data.iter().map(|s| *s as f32 / 32768.0).collect();
	}

	frame
		.data
		.chunks(channels)
		.map(|chunk| {
			let sum: i32 = chunk.iter().map(|s| *s as i32).sum();
			(sum as f32 / channels as f32) / 32768.0
		})
		.collect()
}

fn resample_linear(input: &[f32], src_rate: usize, dst_rate: usize) -> Vec<f32> {
	if input.is_empty() {
		return Vec::new();
	}
	if src_rate == dst_rate {
		return input.to_vec();
	}
	if input.len() == 1 {
		return vec![input[0]];
	}

	let out_len = (((input.len() as u64) * (dst_rate as u64) + (src_rate as u64) - 1)
		/ (src_rate as u64)) as usize;
	let mut out = Vec::with_capacity(out_len);

	for i in 0..out_len {
		let pos = (i as f64) * (src_rate as f64) / (dst_rate as f64);
		let idx = pos.floor() as usize;
		let frac = (pos - idx as f64) as f32;
		if idx + 1 < input.len() {
			out.push(input[idx] * (1.0 - frac) + input[idx + 1] * frac);
		} else {
			out.push(*input.last().unwrap());
		}
	}

	out
}

fn encode_packets(samples: &[f32], volume: f32) -> Result<Vec<OutPacket>> {
	let encoder = Encoder::new(
		audiopus::SampleRate::Hz48000,
		audiopus::Channels::Mono,
		audiopus::Application::Audio,
	)
	.context("Failed to create opus encoder")?;
	let mut opus_output = [0; MAX_OPUS_FRAME_SIZE];
	let mut packets = Vec::new();

	for chunk in samples.chunks(FRAME_SAMPLES) {
		let mut frame = [0.0f32; FRAME_SAMPLES];
		for (dst, src) in frame.iter_mut().zip(chunk.iter()) {
			*dst = *src * volume;
		}
		let len = encoder
			.encode_float(&frame, &mut opus_output)
			.context("Failed to encode opus frame")?;
		let packet = OutAudio::new(&AudioData::C2S {
			id: 0,
			codec: CodecType::OpusVoice,
			data: &opus_output[..len],
		});
		packets.push(packet);
	}
	Ok(packets)
}
