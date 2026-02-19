use std::collections::HashMap;
use std::sync::{
  atomic::{AtomicBool, Ordering},
  Arc, Mutex,
};

use audiopus::coder::Encoder;
use base64::Engine;
use futures::StreamExt;
use napi::bindgen_prelude::{Buffer, Error, Status};
use napi::threadsafe_function::{
  ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{Env, JsFunction};
use napi_derive::napi;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{self, Duration, MissedTickBehavior};
use tsclientlib::audio::AudioHandler;
use tsclientlib::sync::{SyncConnection, SyncStreamItem};
use tsclientlib::{ClientId, Connection, DisconnectOptions, Identity};
use tsproto_packets::packets::{AudioData, CodecType, Direction, InAudioBuf, OutAudio};

const SAMPLE_RATE: usize = 48_000;
const FRAME_SAMPLES: usize = SAMPLE_RATE / 50;
const INTERNAL_CHANNELS: usize = 2;
const MAX_OPUS_FRAME_SIZE: usize = 1275;

type EventTsfn = ThreadsafeFunction<NativeEvent, ErrorStrategy::CalleeHandled>;

#[derive(Debug)]
struct NativeEvent {
  name: String,
  payload: String,
}

enum ControlMessage {
  PushFrame(Vec<i16>),
  Disconnect {
    message: Option<String>,
    done: oneshot::Sender<Result<(), String>>,
  },
}

#[napi(object)]
pub struct ConnectOptions {
  pub address: String,
  pub password: Option<String>,
  pub nickname: Option<String>,
  pub channel: Option<String>,
  pub channel_password: Option<String>,
  pub identity: Option<String>,
  pub log_level: Option<String>,
}

#[napi(object)]
pub struct DisconnectParams {
  pub message: Option<String>,
  pub reason_code: Option<u32>,
}

#[napi]
pub struct TeamSpeakClient {
  event_tsfn: Arc<Mutex<Option<EventTsfn>>>,
  control_tx: Arc<Mutex<Option<mpsc::Sender<ControlMessage>>>>,
  join: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
  connected: Arc<AtomicBool>,
  identity: Arc<Mutex<Option<String>>>,
}

#[napi]
impl TeamSpeakClient {
  #[napi(constructor)]
  pub fn new() -> Self {
    Self {
      event_tsfn: Arc::new(Mutex::new(None)),
      control_tx: Arc::new(Mutex::new(None)),
      join: Arc::new(Mutex::new(None)),
      connected: Arc::new(AtomicBool::new(false)),
      identity: Arc::new(Mutex::new(None)),
    }
  }

  #[napi(js_name = "onEvent")]
  pub fn on_event(&self, env: Env, callback: JsFunction) -> napi::Result<()> {
    let tsfn: EventTsfn = callback.create_threadsafe_function(
      0,
      |ctx: ThreadSafeCallContext<NativeEvent>| {
        let packed = serde_json::json!({
          "name": ctx.value.name,
          "payload": ctx.value.payload,
        });
        let packed = ctx.env.create_string(&packed.to_string())?.into_unknown();
        Ok(vec![packed])
      },
    )?;
    let _ = env;
    *self.event_tsfn.lock().expect("event mutex poisoned") = Some(tsfn);
    Ok(())
  }

  #[napi]
  pub async fn connect(&self, opts: ConnectOptions) -> napi::Result<()> {
    self.refresh_worker_state();
    if self.control_tx.lock().expect("control mutex poisoned").is_some() {
      return Err(Error::new(Status::InvalidArg, "Already connected or connecting".to_string()));
    }

    let identity = parse_or_create_identity(opts.identity.as_deref())
      .map_err(|e| Error::new(Status::InvalidArg, e))?;
    *self.identity.lock().expect("identity mutex poisoned") = Some(identity_to_string(&identity));

    let (control_tx, control_rx) = mpsc::channel(256);
    let (ready_tx, ready_rx) = oneshot::channel();

    self.connected.store(false, Ordering::SeqCst);

    let event_tsfn = self.event_tsfn.clone();
    let connected = self.connected.clone();

    let join = tokio::spawn(async move {
      run_client(opts, identity, control_rx, event_tsfn, connected, ready_tx).await;
    });

    *self.control_tx.lock().expect("control mutex poisoned") = Some(control_tx);
    *self.join.lock().expect("join mutex poisoned") = Some(join);

    match ready_rx.await {
      Ok(Ok(())) => Ok(()),
      Ok(Err(e)) => {
        self.connected.store(false, Ordering::SeqCst);
        *self.control_tx.lock().expect("control mutex poisoned") = None;
        if let Some(handle) = self.join.lock().expect("join mutex poisoned").take() {
          handle.abort();
        }
        Err(Error::new(Status::GenericFailure, e))
      }
      Err(_) => {
        self.connected.store(false, Ordering::SeqCst);
        *self.control_tx.lock().expect("control mutex poisoned") = None;
        Err(Error::new(
          Status::GenericFailure,
          "Connection worker exited before reporting status".to_string(),
        ))
      }
    }
  }

  #[napi]
  pub async fn disconnect(&self, params: Option<DisconnectParams>) -> napi::Result<()> {
    self.refresh_worker_state();

    let tx = {
      let guard = self.control_tx.lock().expect("control mutex poisoned");
      guard.clone()
    };

    let Some(tx) = tx else {
      return Ok(());
    };

    if let Some(p) = params.as_ref() {
      let _ = p.reason_code;
    }

    let (done_tx, done_rx) = oneshot::channel();
    tx.send(ControlMessage::Disconnect {
      message: params.and_then(|p| p.message),
      done: done_tx,
    })
    .await
    .map_err(|_| Error::new(Status::GenericFailure, "Connection worker is not running".to_string()))?;

    let result = done_rx
      .await
      .map_err(|_| Error::new(Status::GenericFailure, "Disconnect interrupted".to_string()))?;

    self.connected.store(false, Ordering::SeqCst);
    *self.control_tx.lock().expect("control mutex poisoned") = None;
    let handle = self.join.lock().expect("join mutex poisoned").take();
    if let Some(handle) = handle {
      let _ = handle.await;
    }

    match result {
      Ok(()) => Ok(()),
      Err(e) => Err(Error::new(Status::GenericFailure, e)),
    }
  }

  #[napi(js_name = "pushFrame")]
  pub fn push_frame(&self, pcm_le: Buffer) -> napi::Result<()> {
    self.refresh_worker_state();

    let tx = {
      let guard = self.control_tx.lock().expect("control mutex poisoned");
      guard.clone()
    };

    let Some(tx) = tx else {
      return Err(Error::new(Status::InvalidArg, "Not connected".to_string()));
    };

    if pcm_le.len() % 2 != 0 {
      return Err(Error::new(
        Status::InvalidArg,
        "PCM buffer size must be divisible by 2".to_string(),
      ));
    }

    let mut samples = Vec::with_capacity(pcm_le.len() / 2);
    for chunk in pcm_le.chunks_exact(2) {
      samples.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }

    tx.try_send(ControlMessage::PushFrame(samples)).map_err(|_| {
      Error::new(
        Status::GenericFailure,
        "Audio queue is full or closed; keep push cadence near 20ms".to_string(),
      )
    })
  }

  #[napi(js_name = "isConnected")]
  pub fn is_connected(&self) -> bool {
    self.connected.load(Ordering::SeqCst)
  }

  #[napi(js_name = "exportIdentity")]
  pub fn export_identity(&self) -> Option<String> {
    self.identity.lock().expect("identity mutex poisoned").clone()
  }

  #[napi(js_name = "getIdentity")]
  pub fn get_identity(&self) -> Option<String> {
    self.identity.lock().expect("identity mutex poisoned").clone()
  }
}

impl TeamSpeakClient {
  fn refresh_worker_state(&self) {
    let finished = self
      .join
      .lock()
      .expect("join mutex poisoned")
      .as_ref()
      .map(|h| h.is_finished())
      .unwrap_or(false);

    if finished {
      self.connected.store(false, Ordering::SeqCst);
      *self.control_tx.lock().expect("control mutex poisoned") = None;
      let _ = self.join.lock().expect("join mutex poisoned").take();
    }
  }
}

async fn run_client(
  opts: ConnectOptions,
  identity: Identity,
  mut control_rx: mpsc::Receiver<ControlMessage>,
  event_tsfn: Arc<Mutex<Option<EventTsfn>>>,
  connected: Arc<AtomicBool>,
  ready_tx: oneshot::Sender<Result<(), String>>,
) {
  let mut ready_tx = Some(ready_tx);

  let mut builder = Connection::build(opts.address.clone()).identity(identity);
  if let Some(password) = opts.password {
    builder = builder.password(password);
  }
  if let Some(nick) = opts.nickname {
    builder = builder.name(nick);
  }
  if let Some(channel) = opts.channel {
    builder = builder.channel(channel);
  }
  if let Some(channel_password) = opts.channel_password {
    builder = builder.channel_password(channel_password);
  }
  match opts.log_level.as_deref() {
    Some("commands") => {
      builder = builder.log_commands(true);
    }
    Some("packets") => {
      builder = builder.log_commands(true).log_packets(true);
    }
    Some("udp") => {
      builder = builder.log_commands(true).log_packets(true).log_udp_packets(true);
    }
    _ => {}
  }

  let con = match builder.connect() {
    Ok(c) => c,
    Err(e) => {
      let msg = format!("Failed to connect: {e}");
      if let Some(tx) = ready_tx.take() {
        let _ = tx.send(Err(msg.clone()));
      }
      emit_error(&event_tsfn, "E_CONNECT", &msg);
      return;
    }
  };
  let mut sync_con: SyncConnection = con.into();

  let encoder = match Encoder::new(
    audiopus::SampleRate::Hz48000,
    audiopus::Channels::Mono,
    audiopus::Application::Voip,
  ) {
    Ok(e) => e,
    Err(e) => {
      let msg = format!("Failed to create Opus encoder: {e}");
      if let Some(tx) = ready_tx.take() {
        let _ = tx.send(Err(msg.clone()));
      }
      emit_error(&event_tsfn, "E_AUDIO_ENCODE", &msg);
      return;
    }
  };
  let mut opus_out = [0u8; MAX_OPUS_FRAME_SIZE];

  let mut speaker_handlers: HashMap<ClientId, AudioHandler<ClientId>> = HashMap::new();

  let mut ticker = time::interval(Duration::from_millis(20));
  ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

  loop {
    tokio::select! {
      Some(ctrl) = control_rx.recv() => {
        match ctrl {
          ControlMessage::PushFrame(samples) => {
            for frame in to_frames(&samples) {
              let mut input = [0.0f32; FRAME_SAMPLES];
              for (dst, src) in input.iter_mut().zip(frame.iter()) {
                *dst = *src as f32 / i16::MAX as f32;
              }

              match encoder.encode_float(&input, &mut opus_out) {
                Ok(len) => {
                  let packet = OutAudio::new(&AudioData::C2S {
                    id: 0,
                    codec: CodecType::OpusVoice,
                    data: &opus_out[..len],
                  });
                  if let Err(e) = sync_con.send_audio(packet) {
                    emit_error(&event_tsfn, "E_SEND_AUDIO", &format!("{e}"));
                  }
                }
                Err(e) => emit_error(&event_tsfn, "E_AUDIO_ENCODE", &format!("{e}")),
              }
            }
          }
          ControlMessage::Disconnect { message, done } => {
            let mut options = DisconnectOptions::new();
            if let Some(message) = message {
              options = options.message(message);
            }
            if let Err(e) = sync_con.disconnect(options) {
              let _ = done.send(Err(format!("{e}")));
              connected.store(false, Ordering::SeqCst);
              emit_error(&event_tsfn, "E_DISCONNECT", &format!("{e}"));
              emit(
                &event_tsfn,
                "disconnected",
                serde_json::json!({ "temporary": false, "reason": "disconnect_error" }),
              );
              return;
            }

            // Keep polling until the stream closes so the server can process the
            // graceful clientdisconnect packet.
            let shutdown_res = time::timeout(Duration::from_secs(8), async {
              while let Some(evt) = sync_con.next().await {
                match evt {
                  Ok(SyncStreamItem::DisconnectedTemporarily(reason)) => {
                    emit(
                      &event_tsfn,
                      "reconnecting",
                      serde_json::json!({ "reason": format!("{reason:?}") }),
                    );
                  }
                  Ok(_) => {}
                  Err(e) => return Err(format!("{e}")),
                }
              }
              Ok::<(), String>(())
            })
            .await;

            match shutdown_res {
              Ok(Ok(())) => {
                let _ = done.send(Ok(()));
              }
              Ok(Err(e)) => {
                let _ = done.send(Err(e.clone()));
                emit_error(&event_tsfn, "E_DISCONNECT", &e);
              }
              Err(_) => {
                let msg = "Timed out while waiting for graceful disconnect".to_string();
                let _ = done.send(Err(msg.clone()));
                emit_error(&event_tsfn, "E_DISCONNECT_TIMEOUT", &msg);
              }
            }

            connected.store(false, Ordering::SeqCst);
            emit(
              &event_tsfn,
              "disconnected",
              serde_json::json!({ "temporary": false, "reason": "client_disconnect" }),
            );
            return;
          }
        }
      }
      _ = ticker.tick() => {
        emit_audio_frames(&event_tsfn, &mut speaker_handlers);
      }
      event = sync_con.next() => {
        match event {
          Some(Ok(item)) => {
            handle_stream_item(
              item,
              &mut sync_con,
              &event_tsfn,
              &connected,
              &mut ready_tx,
              &mut speaker_handlers,
            ).await;
          }
          Some(Err(e)) => {
            if let Some(tx) = ready_tx.take() {
              let _ = tx.send(Err(format!("Connection failed: {e}")));
            }
            connected.store(false, Ordering::SeqCst);
            emit_error(&event_tsfn, "E_STREAM", &format!("{e}"));
            emit(
              &event_tsfn,
              "disconnected",
              serde_json::json!({ "temporary": false, "reason": "stream_error" }),
            );
            return;
          }
          None => {
            if let Some(tx) = ready_tx.take() {
              let _ = tx.send(Err("Disconnected before connected".to_string()));
            }
            connected.store(false, Ordering::SeqCst);
            emit(
              &event_tsfn,
              "disconnected",
              serde_json::json!({ "temporary": false, "reason": "eof" }),
            );
            return;
          }
        }
      }
      else => break,
    }
  }

  if let Some(tx) = ready_tx.take() {
    let _ = tx.send(Err("Connection task exited unexpectedly".to_string()));
  }
}

async fn handle_stream_item(
  item: SyncStreamItem,
  sync_con: &mut SyncConnection,
  event_tsfn: &Arc<Mutex<Option<EventTsfn>>>,
  connected: &Arc<AtomicBool>,
  ready_tx: &mut Option<oneshot::Sender<Result<(), String>>>,
  speaker_handlers: &mut HashMap<ClientId, AudioHandler<ClientId>>,
) {
  match item {
    SyncStreamItem::BookEvents(_) => {
      if !connected.swap(true, Ordering::SeqCst) {
        if let Some(tx) = ready_tx.take() {
          let _ = tx.send(Ok(()));
        }
        let server_name = sync_con
          .get_state()
          .ok()
          .map(|s| s.server.name.clone())
          .unwrap_or_default();
        emit(
          event_tsfn,
          "connected",
          serde_json::json!({ "serverName": server_name }),
        );
      }
    }
    SyncStreamItem::Audio(packet) => {
      handle_incoming_audio(packet, speaker_handlers, event_tsfn);
    }
    SyncStreamItem::DisconnectedTemporarily(reason) => {
      connected.store(false, Ordering::SeqCst);
      emit(
        event_tsfn,
        "reconnecting",
        serde_json::json!({ "reason": format!("{reason:?}") }),
      );
    }
    _ => {}
  }
}

fn parse_or_create_identity(input: Option<&str>) -> Result<Identity, String> {
  match input {
    Some(raw) => Identity::new_from_str(raw).map_err(|e| format!("Failed to parse identity: {e}")),
    None => Ok(Identity::create()),
  }
}

fn identity_to_string(identity: &Identity) -> String {
  let key_b64 = base64::engine::general_purpose::STANDARD.encode(identity.key().to_short());
  format!("{}V{}", identity.counter(), key_b64)
}

fn to_frames(samples: &[i16]) -> Vec<[i16; FRAME_SAMPLES]> {
  if samples.is_empty() {
    return Vec::new();
  }

  let mut frames = Vec::with_capacity((samples.len() + FRAME_SAMPLES - 1) / FRAME_SAMPLES);
  let mut index = 0usize;
  while index < samples.len() {
    let mut frame = [0i16; FRAME_SAMPLES];
    let end = (index + FRAME_SAMPLES).min(samples.len());
    let count = end - index;
    frame[..count].copy_from_slice(&samples[index..end]);
    frames.push(frame);
    index = end;
  }
  frames
}

fn handle_incoming_audio(
  packet: InAudioBuf,
  speaker_handlers: &mut HashMap<ClientId, AudioHandler<ClientId>>,
  event_tsfn: &Arc<Mutex<Option<EventTsfn>>>,
) {
  let from = match packet.data().data() {
    AudioData::S2C { from, .. } | AudioData::S2CWhisper { from, .. } => ClientId(*from),
    _ => return,
  };

  match InAudioBuf::try_new(Direction::S2C, packet.raw_data().to_vec()) {
    Ok(packet_copy) => {
      let handler = speaker_handlers.entry(from).or_default();
      if let Err(e) = handler.handle_packet(from, packet_copy) {
        let msg = format!("{e}");
        if should_report_decode_error(&msg) {
          emit_error(event_tsfn, "E_AUDIO_DECODE", &msg);
        }
      }
    }
    Err(e) => {
      let msg = format!("{e}");
      if should_report_decode_error(&msg) {
        emit_error(event_tsfn, "E_AUDIO_DECODE", &msg);
      }
    }
  }
}

fn emit_audio_frames(
  event_tsfn: &Arc<Mutex<Option<EventTsfn>>>,
  speaker_handlers: &mut HashMap<ClientId, AudioHandler<ClientId>>,
) {
  let mut to_remove = Vec::new();
  let mut mixed = vec![0.0f32; FRAME_SAMPLES];

  for (client_id, handler) in speaker_handlers.iter_mut() {
    // AudioHandler internally yields interleaved stereo samples.
    let mut frame_stereo = vec![0.0f32; FRAME_SAMPLES * INTERNAL_CHANNELS];
    handler.fill_buffer(&mut frame_stereo);

    if handler.get_queues().is_empty() {
      to_remove.push(*client_id);
    }

    let frame = downmix_stereo_to_mono(&frame_stereo);
    if !has_audio(&frame) {
      continue;
    }

    for (m, s) in mixed.iter_mut().zip(frame.iter()) {
      *m += *s;
    }

    emit_audio_payload(event_tsfn, "audioSpeaker", Some(client_id.0), &frame);
  }

  // Emit a fixed-rate mixed frame every tick to preserve a stable timeline.
  emit_audio_payload(event_tsfn, "audioMixed", None, &mixed);

  for id in to_remove {
    speaker_handlers.remove(&id);
  }
}

fn downmix_stereo_to_mono(input: &[f32]) -> Vec<f32> {
  if input.is_empty() {
    return vec![0.0; FRAME_SAMPLES];
  }
  if input.len() < 2 {
    return vec![input[0]; FRAME_SAMPLES];
  }

  let mut out = vec![0.0f32; FRAME_SAMPLES];
  for (i, pair) in input.chunks_exact(2).take(FRAME_SAMPLES).enumerate() {
    out[i] = (pair[0] + pair[1]) * 0.5;
  }
  out
}

fn emit_audio_payload(
  event_tsfn: &Arc<Mutex<Option<EventTsfn>>>,
  event_name: &str,
  client_id: Option<u16>,
  frame: &[f32],
) {
  let pcm = f32_to_pcm_le(frame);
  let mut payload = serde_json::json!({
    "sampleRate": SAMPLE_RATE,
    "channels": 1,
    "samples": FRAME_SAMPLES,
    "pcm": base64::engine::general_purpose::STANDARD.encode(pcm),
  });

  if let Some(client_id) = client_id {
    payload["clientId"] = serde_json::json!(client_id);
  }

  emit(event_tsfn, event_name, payload);
}

fn has_audio(frame: &[f32]) -> bool {
  frame.iter().any(|sample| sample.abs() > 0.0001)
}

fn f32_to_pcm_le(frame: &[f32]) -> Vec<u8> {
  let mut out = Vec::with_capacity(frame.len() * 2);
  for sample in frame {
    let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
    out.extend_from_slice(&value.to_le_bytes());
  }
  out
}

fn emit(event_tsfn: &Arc<Mutex<Option<EventTsfn>>>, name: &str, payload: serde_json::Value) {
  let tsfn = event_tsfn
    .lock()
    .expect("event mutex poisoned")
    .as_ref()
    .cloned();
  let Some(tsfn) = tsfn else {
    return;
  };

  let _ = tsfn.call(
    Ok(NativeEvent {
      name: name.to_string(),
      payload: payload.to_string(),
    }),
    ThreadsafeFunctionCallMode::NonBlocking,
  );
}

fn emit_error(event_tsfn: &Arc<Mutex<Option<EventTsfn>>>, code: &str, message: &str) {
  emit(
    event_tsfn,
    "error",
    serde_json::json!({ "code": code, "message": message }),
  );
}

fn should_report_decode_error(msg: &str) -> bool {
  !(msg.contains("too late") || msg.contains("queue is full"))
}

#[napi(js_name = "decodeBase64PcmToBuffer")]
pub fn decode_base64_pcm_to_buffer(b64: String) -> napi::Result<Buffer> {
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(b64.as_bytes())
    .map_err(|e| Error::new(Status::InvalidArg, format!("Invalid base64: {e}")))?;
  Ok(Buffer::from(bytes))
}

#[napi(js_name = "encodeBufferToBase64Pcm")]
pub fn encode_buffer_to_base64_pcm(buf: Buffer) -> String {
  base64::engine::general_purpose::STANDARD.encode(buf)
}
