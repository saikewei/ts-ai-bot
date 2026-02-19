//! This example connects to a TeamSpeak server, records 5 seconds of incoming
//! channel audio, writes it to a wav file and disconnects.
//! It does not access any system audio input/output device.

use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use clap::Parser;
use futures::prelude::*;
use tokio::time::{self, Duration, MissedTickBehavior};
use tracing::debug;
use tsclientlib::audio::AudioHandler;
use tsclientlib::{ClientId, Connection, DisconnectOptions, Identity, StreamItem};
use tsproto_packets::packets::AudioData;

const TARGET_SAMPLE_RATE: usize = 48_000;
const FRAME_SAMPLES: usize = TARGET_SAMPLE_RATE / 50;
const RECORD_SECONDS: usize = 5;
const CHANNELS: usize = 2;

#[derive(Parser, Debug)]
#[command(author, about)]
struct Args {
	/// The address of the server to connect to
	#[arg(short, long, default_value = "localhost")]
	address: String,
	/// Output wav path
	#[arg(short, long, default_value = "recorded_5s.wav")]
	output: PathBuf,
	/// The password
	#[arg(short, long, default_value = "")]
	password: String,
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

	let con_config = Connection::build(args.address.clone())
		.log_commands(args.verbose >= 1)
		.log_packets(args.verbose >= 2)
		.log_udp_packets(args.verbose >= 3)
		.password(args.password.clone());

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

	let target_samples = TARGET_SAMPLE_RATE * RECORD_SECONDS * CHANNELS;
	let mut recorded = Vec::with_capacity(target_samples);
	let mut handler = AudioHandler::<ClientId>::new();
	let mut events = con.events();

	let mut ticker = time::interval(Duration::from_millis(20));
	ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

	while recorded.len() < target_samples {
		tokio::select! {
			_ = ticker.tick() => {
				let mut frame = vec![0.0; FRAME_SAMPLES * CHANNELS];
				handler.fill_buffer(&mut frame);
				recorded.extend_from_slice(&frame);
			}
			item = events.next() => {
				match item {
					Some(Ok(StreamItem::Audio(packet))) => {
						let from = match packet.data().data() {
							AudioData::S2C { from, .. } => ClientId(*from),
							AudioData::S2CWhisper { from, .. } => ClientId(*from),
							_ => continue,
						};
						if let Err(error) = handler.handle_packet(from, packet) {
							debug!(%error, "Ignoring undecodable audio packet");
						}
					}
					Some(Ok(_)) => {}
					Some(Err(error)) => return Err(error.into()),
					None => bail!("Disconnected"),
				}
			}
			_ = tokio::signal::ctrl_c() => {
				break;
			}
		}
	}

	drop(events);
	write_wav(&args.output, &recorded[..recorded.len().min(target_samples)])
		.with_context(|| format!("Failed to write wav to {}", args.output.display()))?;

	con.disconnect(DisconnectOptions::new())?;
	con.events().for_each(|_| future::ready(())).await;
	Ok(())
}

fn write_wav(path: &PathBuf, samples: &[f32]) -> Result<()> {
	let spec = hound::WavSpec {
		channels: CHANNELS as u16,
		sample_rate: TARGET_SAMPLE_RATE as u32,
		bits_per_sample: 16,
		sample_format: hound::SampleFormat::Int,
	};
	let mut writer = hound::WavWriter::create(path, spec)?;
	for sample in samples {
		let s = sample.clamp(-1.0, 1.0);
		let i = (s * i16::MAX as f32) as i16;
		writer.write_sample(i)?;
	}
	writer.finalize()?;
	Ok(())
}
