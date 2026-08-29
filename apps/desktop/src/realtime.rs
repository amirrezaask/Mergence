use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

use anyhow::{Context as _, Result, anyhow, bail};
use async_channel::{Receiver as EventReceiver, Sender as EventSender};
use futures_util::{Sink, SinkExt as _, StreamExt as _};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, Message};
use url::Url;

use crate::{
    host::HostConfig,
    model::{
        SessionSnapshot, TerminalAttachResult, TerminalPatchMessage, TerminalResyncRequiredMessage,
        TerminalSnapshotMessage, TerminalStreamMessage,
    },
};

const PROTOCOL_VERSION: u8 = 2;
const STREAM_V3_VERSION: u8 = 3;
const STREAM_V3_MAX_BYTES: usize = 8 * 1024 * 1024;
const DATA_FRAME_V1: u8 = 0x01;
const DATA_FRAME_V2: u8 = 0x02;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(45);
const COMMAND_CAPACITY: usize = 512;
const EVENT_CAPACITY: usize = 256;

#[derive(Clone, Debug)]
pub enum RealtimeEvent {
    Connected(Vec<SessionSnapshot>),
    Disconnected,
    Semantic(Box<TerminalStreamMessage>),
    AttachResult {
        terminal_id: String,
        result: Option<Box<TerminalAttachResult>>,
    },
    WorkspaceInvalidated,
    TerminalExited {
        terminal_id: String,
        exit_code: i32,
        signal: Option<i32>,
    },
    Error(String),
}

#[derive(Clone)]
pub struct RealtimeClient {
    commands: mpsc::Sender<RealtimeCommand>,
    events: EventReceiver<RealtimeEvent>,
    connected: Arc<AtomicBool>,
}

impl RealtimeClient {
    pub fn spawn(config: HostConfig) -> Self {
        let (commands, command_rx) = mpsc::channel(COMMAND_CAPACITY);
        let (event_tx, events) = async_channel::bounded(EVENT_CAPACITY);
        let connected = Arc::new(AtomicBool::new(false));
        let thread_connected = Arc::clone(&connected);
        thread::Builder::new()
            .name("yaade-desktop-realtime".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                match runtime {
                    Ok(runtime) => runtime.block_on(realtime_loop(
                        config,
                        command_rx,
                        event_tx,
                        thread_connected,
                    )),
                    Err(error) => {
                        // The UI receiver may already be gone during process shutdown.
                        let _ = event_tx.send_blocking(RealtimeEvent::Error(format!(
                            "could not start realtime runtime: {error}"
                        )));
                    }
                }
            })
            .expect("could not spawn realtime client thread");
        Self {
            commands,
            events,
            connected,
        }
    }

    pub fn event_receiver(&self) -> EventReceiver<RealtimeEvent> {
        self.events.clone()
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    pub fn attach(&self, terminal_id: impl Into<String>, after_sequence: u64) -> bool {
        self.commands
            .try_send(RealtimeCommand::Attach {
                terminal_id: terminal_id.into(),
                after_sequence,
                force: false,
            })
            .is_ok()
    }

    pub fn resync(&self, terminal_id: impl Into<String>, after_sequence: u64) -> bool {
        self.commands
            .try_send(RealtimeCommand::Attach {
                terminal_id: terminal_id.into(),
                after_sequence,
                force: true,
            })
            .is_ok()
    }

    pub fn detach(&self, terminal_id: impl Into<String>) -> bool {
        self.commands
            .try_send(RealtimeCommand::Detach {
                terminal_id: terminal_id.into(),
            })
            .is_ok()
    }

    pub fn write(&self, terminal_id: impl Into<String>, data: impl Into<String>) -> bool {
        self.commands
            .try_send(RealtimeCommand::Write {
                terminal_id: terminal_id.into(),
                data: data.into(),
            })
            .is_ok()
    }

    pub fn resize(&self, terminal_id: impl Into<String>, cols: usize, rows: usize) -> bool {
        self.commands
            .try_send(RealtimeCommand::Resize {
                terminal_id: terminal_id.into(),
                cols,
                rows,
            })
            .is_ok()
    }

    pub fn shutdown(&self) {
        let _ = self.commands.try_send(RealtimeCommand::Shutdown);
    }
}

#[derive(Debug)]
enum RealtimeCommand {
    Attach {
        terminal_id: String,
        after_sequence: u64,
        force: bool,
    },
    Detach {
        terminal_id: String,
    },
    Write {
        terminal_id: String,
        data: String,
    },
    Resize {
        terminal_id: String,
        cols: usize,
        rows: usize,
    },
    Shutdown,
}

#[derive(Clone, Debug)]
enum PendingCommand {
    Attach { terminal_id: String },
    Control { operation: &'static str },
}

#[derive(Debug)]
enum ConnectionEnd {
    Reconnect(anyhow::Error),
    Fatal(anyhow::Error),
    Shutdown,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeSnapshotWire {
    #[serde(rename = "type")]
    message_type: String,
    identity: ServerIdentityWire,
    cursor: EventCursorWire,
    sessions: Vec<SessionSnapshot>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerIdentityWire {
    server_id: String,
    server_epoch: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventCursorWire {
    sequence: u64,
    server_epoch: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostEventWire {
    protocol_version: u8,
    server_id: Option<String>,
    server_epoch: Option<String>,
    sequence: u64,
    channel: String,
    args: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalResultWire {
    #[serde(rename = "type")]
    message_type: String,
    request_id: String,
    ok: bool,
    value: Option<Value>,
    error: Option<TerminalResultErrorWire>,
}

#[derive(Debug, Deserialize)]
struct TerminalResultErrorWire {
    message: String,
    code: Option<String>,
}

async fn realtime_loop(
    config: HostConfig,
    mut command_rx: mpsc::Receiver<RealtimeCommand>,
    events: EventSender<RealtimeEvent>,
    connected: Arc<AtomicBool>,
) {
    let mut last_sequence = 0_u64;
    let mut identity: Option<ServerIdentityWire> = None;
    let mut desired_attachments = HashMap::<String, u64>::new();
    let mut reconnect_attempt = 0_u32;

    loop {
        while let Ok(command) = command_rx.try_recv() {
            if apply_offline_command(command, &mut desired_attachments, &events).await {
                connected.store(false, Ordering::Release);
                return;
            }
        }

        let result = run_connection(
            &config,
            &mut command_rx,
            &events,
            &connected,
            &mut last_sequence,
            &mut identity,
            &mut desired_attachments,
        )
        .await;
        connected.store(false, Ordering::Release);
        if events.send(RealtimeEvent::Disconnected).await.is_err() {
            return;
        }
        match result {
            ConnectionEnd::Shutdown => return,
            ConnectionEnd::Fatal(error) => {
                let _ = events.send(RealtimeEvent::Error(error.to_string())).await;
                return;
            }
            ConnectionEnd::Reconnect(error) => {
                if reconnect_attempt == 0 {
                    let _ = events.send(RealtimeEvent::Error(error.to_string())).await;
                }
            }
        }

        let exponent = reconnect_attempt.min(6);
        let delay = Duration::from_millis((250_u64 << exponent).min(10_000));
        reconnect_attempt = reconnect_attempt.saturating_add(1);
        let sleep = tokio::time::sleep(delay);
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                () = &mut sleep => break,
                command = command_rx.recv() => {
                    let Some(command) = command else { return };
                    if apply_offline_command(command, &mut desired_attachments, &events).await {
                        return;
                    }
                }
            }
        }
    }
}

async fn apply_offline_command(
    command: RealtimeCommand,
    desired: &mut HashMap<String, u64>,
    events: &EventSender<RealtimeEvent>,
) -> bool {
    match command {
        RealtimeCommand::Attach {
            terminal_id,
            after_sequence,
            ..
        } => {
            desired.insert(terminal_id, after_sequence);
        }
        RealtimeCommand::Detach { terminal_id } => {
            desired.remove(&terminal_id);
        }
        RealtimeCommand::Write { .. } => {
            let _ = events
                .send(RealtimeEvent::Error(
                    "Terminal input was not sent because the realtime connection is offline."
                        .to_string(),
                ))
                .await;
        }
        RealtimeCommand::Resize { .. } => {}
        RealtimeCommand::Shutdown => return true,
    }
    false
}

#[allow(clippy::too_many_arguments)]
async fn run_connection(
    config: &HostConfig,
    command_rx: &mut mpsc::Receiver<RealtimeCommand>,
    events: &EventSender<RealtimeEvent>,
    connected: &Arc<AtomicBool>,
    last_sequence: &mut u64,
    identity: &mut Option<ServerIdentityWire>,
    desired: &mut HashMap<String, u64>,
) -> ConnectionEnd {
    let url = match websocket_url(config, *last_sequence) {
        Ok(url) => url,
        Err(error) => return ConnectionEnd::Fatal(error),
    };
    let (socket, _) = match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok(socket) => socket,
        Err(error) => {
            return ConnectionEnd::Reconnect(
                anyhow!(error).context(format!("could not connect realtime socket at {url}")),
            );
        }
    };
    let (mut writer, mut reader) = socket.split();
    if let Some(token) = &config.token {
        let auth = json!({ "type": "protocol:auth", "token": token }).to_string();
        if let Err(error) = writer.send(Message::Text(auth.into())).await {
            return ConnectionEnd::Reconnect(anyhow!(error));
        }
    }

    let mut synchronized = false;
    let mut pending = HashMap::<String, PendingCommand>::new();
    let mut request_sequence = 0_u64;
    let mut heartbeat = tokio::time::interval(HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_pong = tokio::time::Instant::now();

    loop {
        tokio::select! {
            command = command_rx.recv() => {
                let Some(command) = command else { return ConnectionEnd::Shutdown };
                match command {
                    RealtimeCommand::Shutdown => {
                        let _ = writer.send(Message::Close(None)).await;
                        return ConnectionEnd::Shutdown;
                    }
                    RealtimeCommand::Attach { terminal_id, after_sequence, force } => {
                        let previous = desired.insert(terminal_id.clone(), after_sequence);
                        if synchronized
                            && (force || previous != Some(after_sequence))
                            && let Err(error) = send_command(
                                &mut writer,
                                config,
                                &mut request_sequence,
                                &mut pending,
                                "terminal:attach",
                                json!([terminal_id, after_sequence, "semantic"]),
                                PendingCommand::Attach { terminal_id },
                            ).await
                        {
                            return ConnectionEnd::Reconnect(error);
                        }
                    }
                    RealtimeCommand::Detach { terminal_id } => {
                        desired.remove(&terminal_id);
                        if synchronized && let Err(error) = send_command(
                            &mut writer,
                            config,
                            &mut request_sequence,
                            &mut pending,
                            "terminal:detach",
                            json!([terminal_id]),
                            PendingCommand::Control { operation: "terminal detach" },
                        ).await {
                            return ConnectionEnd::Reconnect(error);
                        }
                    }
                    RealtimeCommand::Write { terminal_id, data } => {
                        if !synchronized {
                            let _ = events.send(RealtimeEvent::Error(
                                "Terminal input was not sent because the realtime connection is synchronizing.".to_string(),
                            )).await;
                            continue;
                        }
                        if let Err(error) = send_command(
                            &mut writer,
                            config,
                            &mut request_sequence,
                            &mut pending,
                            "terminal:write",
                            json!([terminal_id, data]),
                            PendingCommand::Control { operation: "terminal input" },
                        ).await {
                            return ConnectionEnd::Reconnect(error);
                        }
                    }
                    RealtimeCommand::Resize { terminal_id, cols, rows } => {
                        if !synchronized { continue; }
                        if let Err(error) = send_command(
                            &mut writer,
                            config,
                            &mut request_sequence,
                            &mut pending,
                            "terminal:resize",
                            json!([terminal_id, cols, rows]),
                            PendingCommand::Control { operation: "terminal resize" },
                        ).await {
                            return ConnectionEnd::Reconnect(error);
                        }
                    }
                }
            }
            message = reader.next() => {
                let Some(message) = message else {
                    return ConnectionEnd::Reconnect(anyhow!("realtime socket closed"));
                };
                let message = match message {
                    Ok(message) => message,
                    Err(error) => return ConnectionEnd::Reconnect(anyhow!(error)),
                };
                match message {
                    Message::Text(text) => {
                        if text.as_str() == "pong" {
                            last_pong = tokio::time::Instant::now();
                            continue;
                        }
                        let raw: Value = match serde_json::from_str(text.as_str()) {
                            Ok(raw) => raw,
                            Err(_) => {
                                let _ = events.send(RealtimeEvent::Error("Host sent an invalid realtime message.".to_string())).await;
                                continue;
                            }
                        };
                        let message_type = raw.get("type").and_then(Value::as_str);
                        match message_type {
                            Some("protocol:auth-required") => {
                                if config.token.is_none() {
                                    return ConnectionEnd::Fatal(anyhow!("Host authentication is required. Set YAADE_HOST_TOKEN."));
                                }
                            }
                            Some("protocol:hello") => {
                                let Some(next_identity) = raw.get("identity")
                                    .cloned()
                                    .and_then(|value| serde_json::from_value::<ServerIdentityWire>(value).ok())
                                else {
                                    return ConnectionEnd::Reconnect(anyhow!("host sent an invalid protocol hello"));
                                };
                                if identity.as_ref().is_some_and(|current|
                                    current.server_id != next_identity.server_id
                                        || current.server_epoch != next_identity.server_epoch
                                ) {
                                    *last_sequence = 0;
                                }
                                *identity = Some(next_identity);
                            }
                            Some("runtime:snapshot") => {
                                let snapshot: RuntimeSnapshotWire = match serde_json::from_value(raw) {
                                    Ok(snapshot) => snapshot,
                                    Err(error) => return ConnectionEnd::Reconnect(anyhow!(error).context("invalid runtime snapshot")),
                                };
                                let Some(current_identity) = identity.as_ref() else {
                                    return ConnectionEnd::Reconnect(anyhow!("runtime snapshot arrived before protocol hello"));
                                };
                                if snapshot.message_type != "runtime:snapshot"
                                    || snapshot.identity.server_id != current_identity.server_id
                                    || snapshot.identity.server_epoch != current_identity.server_epoch
                                    || snapshot.cursor.server_epoch != current_identity.server_epoch
                                {
                                    return ConnectionEnd::Reconnect(anyhow!("runtime snapshot identity mismatch"));
                                }
                                *last_sequence = snapshot.cursor.sequence;
                                synchronized = true;
                                connected.store(true, Ordering::Release);
                                if events.send(RealtimeEvent::Connected(snapshot.sessions)).await.is_err() {
                                    return ConnectionEnd::Shutdown;
                                }
                                let attachments = desired.clone();
                                for (terminal_id, after_sequence) in attachments {
                                    if let Err(error) = send_command(
                                        &mut writer,
                                        config,
                                        &mut request_sequence,
                                        &mut pending,
                                        "terminal:attach",
                                        json!([terminal_id, after_sequence, "semantic"]),
                                        PendingCommand::Attach { terminal_id },
                                    ).await {
                                        return ConnectionEnd::Reconnect(error);
                                    }
                                }
                            }
                            Some("terminal:result") => {
                                let result: TerminalResultWire = match serde_json::from_value(raw) {
                                    Ok(result) => result,
                                    Err(_) => continue,
                                };
                                if result.message_type != "terminal:result" { continue; }
                                let Some(command) = pending.remove(&result.request_id) else { continue; };
                                if !result.ok {
                                    let detail = result.error.map_or_else(
                                        || "unknown host error".to_string(),
                                        |error| error.code.map_or(error.message.clone(), |code| format!("{code}: {}", error.message)),
                                    );
                                    let operation = match command {
                                        PendingCommand::Attach { .. } => "terminal attach",
                                        PendingCommand::Control { operation } => operation,
                                    };
                                    let _ = events.send(RealtimeEvent::Error(format!("{operation} failed: {detail}"))).await;
                                    continue;
                                }
                                if let PendingCommand::Attach { terminal_id } = command {
                                    let attached = match result.value {
                                        None | Some(Value::Null) => None,
                                        Some(value) => match serde_json::from_value::<TerminalAttachResult>(value) {
                                            Ok(value) => Some(value),
                                            Err(error) => {
                                                let _ = events.send(RealtimeEvent::Error(format!("Host returned an invalid terminal replay: {error}"))).await;
                                                continue;
                                            }
                                        },
                                    };
                                    if let Some(attached) = &attached {
                                        desired.insert(terminal_id.clone(), attached.last_sequence);
                                    }
                                    if events.send(RealtimeEvent::AttachResult {
                                        terminal_id: terminal_id.clone(),
                                        result: attached.map(Box::new),
                                    }).await.is_err() {
                                        return ConnectionEnd::Shutdown;
                                    }
                                    if let Err(error) = send_command(
                                        &mut writer,
                                        config,
                                        &mut request_sequence,
                                        &mut pending,
                                        "terminal:ready",
                                        json!([terminal_id]),
                                        PendingCommand::Control { operation: "replay readiness" },
                                    ).await {
                                        return ConnectionEnd::Reconnect(error);
                                    }
                                }
                            }
                            Some("terminal:replay-required") => {
                                let Some(terminal_id) = raw.get("terminalId").and_then(Value::as_str).map(str::to_string) else { continue; };
                                let sequence = raw.get("sequence").and_then(Value::as_u64).unwrap_or(0);
                                let floor = desired.get(&terminal_id).copied().unwrap_or(0).max(sequence);
                                desired.insert(terminal_id.clone(), floor);
                                if let Err(error) = send_command(
                                    &mut writer,
                                    config,
                                    &mut request_sequence,
                                    &mut pending,
                                    "terminal:attach",
                                    json!([terminal_id, floor, "semantic"]),
                                    PendingCommand::Attach { terminal_id },
                                ).await {
                                    return ConnectionEnd::Reconnect(error);
                                }
                            }
                            _ => {
                                let event: HostEventWire = match serde_json::from_value(raw) {
                                    Ok(event) => event,
                                    Err(_) => continue,
                                };
                                if !synchronized || event.sequence <= *last_sequence { continue; }
                                let identity_matches = event.protocol_version == 1 || identity.as_ref().is_some_and(|current|
                                    event.server_id.as_deref() == Some(current.server_id.as_str())
                                        && event.server_epoch.as_deref() == Some(current.server_epoch.as_str())
                                );
                                if !identity_matches { continue; }
                                *last_sequence = event.sequence;
                                match event.channel.as_str() {
                                    "mux:event" => {
                                        let _ = events.send(RealtimeEvent::WorkspaceInvalidated).await;
                                    }
                                    "terminal:exit" => {
                                        let terminal_id = event.args.first().and_then(Value::as_str).unwrap_or_default().to_string();
                                        let exit_code = event.args.get(1).and_then(Value::as_i64).unwrap_or_default() as i32;
                                        let signal = event.args.get(2).and_then(Value::as_i64).map(|value| value as i32);
                                        if !terminal_id.is_empty() {
                                            let _ = events.send(RealtimeEvent::TerminalExited { terminal_id, exit_code, signal }).await;
                                        }
                                    }
                                    "server:shuttingDown" => return ConnectionEnd::Reconnect(anyhow!("YAADE host is shutting down")),
                                    _ => {}
                                }
                            }
                        }
                    }
                    Message::Binary(bytes) => {
                        if let Some(message) = decode_terminal_stream_v3(bytes.as_ref()) {
                            if events.send(RealtimeEvent::Semantic(Box::new(message))).await.is_err() {
                                return ConnectionEnd::Shutdown;
                            }
                            continue;
                        }
                        if let Some(frame) = decode_terminal_data_frame(bytes.as_ref())
                            && synchronized
                            && frame.event_sequence > *last_sequence
                        {
                            *last_sequence = frame.event_sequence;
                            desired
                                .entry(frame.terminal_id.clone())
                                .and_modify(|floor| *floor = (*floor).max(frame.terminal_sequence));
                            let ack = json!({
                                "type": "terminal:ack",
                                "terminalId": frame.terminal_id,
                                "sequence": frame.terminal_sequence,
                            }).to_string();
                            if let Err(error) = writer.send(Message::Text(ack.into())).await {
                                return ConnectionEnd::Reconnect(anyhow!(error));
                            }
                        }
                    }
                    Message::Close(frame) => {
                        if frame.as_ref().is_some_and(|frame| u16::from(frame.code) == 4003) {
                            return ConnectionEnd::Fatal(anyhow!(frame.map_or_else(
                                || "host authentication failed".to_string(),
                                |frame| frame.reason.to_string(),
                            )));
                        }
                        return ConnectionEnd::Reconnect(anyhow!("realtime socket closed"));
                    }
                    Message::Ping(payload) => {
                        if let Err(error) = writer.send(Message::Pong(payload)).await {
                            return ConnectionEnd::Reconnect(anyhow!(error));
                        }
                    }
                    Message::Pong(_) => last_pong = tokio::time::Instant::now(),
                    Message::Frame(_) => {}
                }
            }
            _ = heartbeat.tick() => {
                if last_pong.elapsed() > HEARTBEAT_TIMEOUT {
                    return ConnectionEnd::Reconnect(anyhow!("realtime heartbeat timed out"));
                }
                if let Err(error) = writer.send(Message::Text("ping".into())).await {
                    return ConnectionEnd::Reconnect(anyhow!(error));
                }
            }
        }
    }
}

async fn send_command<S>(
    writer: &mut S,
    config: &HostConfig,
    request_sequence: &mut u64,
    pending: &mut HashMap<String, PendingCommand>,
    operation: &'static str,
    args: Value,
    pending_command: PendingCommand,
) -> Result<()>
where
    S: Sink<Message, Error = tungstenite::Error> + Unpin,
{
    *request_sequence = request_sequence.wrapping_add(1);
    let request_id = format!("{}:{}", config.client_id, request_sequence);
    let payload = json!({
        "requestId": request_id,
        "op": operation,
        "args": args,
    })
    .to_string();
    writer
        .send(Message::Text(payload.into()))
        .await
        .context("could not send realtime terminal command")?;
    pending.insert(request_id, pending_command);
    Ok(())
}

pub fn websocket_url(config: &HostConfig, since: u64) -> Result<Url> {
    let mut url = Url::parse(&config.base_url).context("invalid YAADE host URL")?;
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        other => bail!("unsupported YAADE host URL scheme {other}"),
    };
    url.set_scheme(scheme)
        .map_err(|()| anyhow!("could not construct realtime URL"))?;
    url.set_path("/ws");
    url.set_query(None);
    url.query_pairs_mut()
        .append_pair("since", &since.to_string())
        .append_pair("clientId", &config.client_id)
        .append_pair("protocol", &PROTOCOL_VERSION.to_string());
    Ok(url)
}

fn decode_terminal_stream_v3(bytes: &[u8]) -> Option<TerminalStreamMessage> {
    if bytes.len() < 6 || bytes[0] != STREAM_V3_VERSION {
        return None;
    }
    let size = u32::from_be_bytes(bytes[2..6].try_into().ok()?) as usize;
    if size > STREAM_V3_MAX_BYTES || bytes.len() != size + 6 {
        return None;
    }
    let payload = &bytes[6..];
    match bytes[1] {
        1 => serde_json::from_slice::<TerminalSnapshotMessage>(payload)
            .ok()
            .map(TerminalStreamMessage::Snapshot),
        2 => serde_json::from_slice::<TerminalPatchMessage>(payload)
            .ok()
            .map(TerminalStreamMessage::Patch),
        3 => serde_json::from_slice::<TerminalResyncRequiredMessage>(payload)
            .ok()
            .map(TerminalStreamMessage::ResyncRequired),
        _ => None,
    }
}

#[derive(Debug, Eq, PartialEq)]
struct TerminalDataFrame {
    event_sequence: u64,
    terminal_sequence: u64,
    terminal_id: String,
}

fn decode_terminal_data_frame(bytes: &[u8]) -> Option<TerminalDataFrame> {
    match bytes.first().copied()? {
        DATA_FRAME_V2 => {
            if bytes.len() < 19 {
                return None;
            }
            let event_sequence = u64::from_be_bytes(bytes[1..9].try_into().ok()?);
            let terminal_sequence = u64::from_be_bytes(bytes[9..17].try_into().ok()?);
            let id_len = u16::from_be_bytes(bytes[17..19].try_into().ok()?) as usize;
            if 19 + id_len > bytes.len() {
                return None;
            }
            Some(TerminalDataFrame {
                event_sequence,
                terminal_sequence,
                terminal_id: std::str::from_utf8(&bytes[19..19 + id_len])
                    .ok()?
                    .to_string(),
            })
        }
        DATA_FRAME_V1 => {
            if bytes.len() < 11 {
                return None;
            }
            let event_sequence = u32::from_be_bytes(bytes[1..5].try_into().ok()?) as u64;
            let terminal_sequence = u32::from_be_bytes(bytes[5..9].try_into().ok()?) as u64;
            let id_len = u16::from_be_bytes(bytes[9..11].try_into().ok()?) as usize;
            if 11 + id_len > bytes.len() {
                return None;
            }
            Some(TerminalDataFrame {
                event_sequence,
                terminal_sequence,
                terminal_id: std::str::from_utf8(&bytes[11..11 + id_len])
                    .ok()?
                    .to_string(),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_modern_websocket_url_without_token() {
        let config = HostConfig {
            base_url: "https://devbox.example.com/ignored".to_string(),
            token: Some("secret".to_string()),
            client_id: "desktop-client".to_string(),
        };
        assert_eq!(
            websocket_url(&config, 42).expect("url").as_str(),
            "wss://devbox.example.com/ws?since=42&clientId=desktop-client&protocol=2"
        );
    }

    #[test]
    fn decodes_v2_terminal_data_header() {
        let mut bytes = vec![DATA_FRAME_V2];
        bytes.extend_from_slice(&9_u64.to_be_bytes());
        bytes.extend_from_slice(&7_u64.to_be_bytes());
        bytes.extend_from_slice(&3_u16.to_be_bytes());
        bytes.extend_from_slice(b"pty");
        bytes.extend_from_slice(b"ignored output");
        assert_eq!(
            decode_terminal_data_frame(&bytes),
            Some(TerminalDataFrame {
                event_sequence: 9,
                terminal_sequence: 7,
                terminal_id: "pty".to_string(),
            })
        );
    }

    #[test]
    fn decodes_semantic_v3_snapshot_frame() {
        let response: crate::model::HostRpcResponse<Option<TerminalAttachResult>> =
            serde_json::from_str(include_str!(
                "../tests/fixtures/terminal-attach-success.json"
            ))
            .expect("fixture");
        let crate::model::HostRpcResponse::Success {
            value: Some(result),
        } = response
        else {
            panic!("fixture");
        };
        let message = json!({
            "type": "terminal.snapshot",
            "terminalId": "pty-shell",
            "ownerEpoch": "owner-1",
            "terminalEpoch": "epoch-1",
            "revision": 7,
            "snapshot": result.semantic_snapshot.expect("snapshot"),
        });
        let payload = serde_json::to_vec(&message).expect("payload");
        let mut frame = vec![STREAM_V3_VERSION, 1];
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&payload);
        let Some(TerminalStreamMessage::Snapshot(decoded)) = decode_terminal_stream_v3(&frame)
        else {
            panic!("snapshot frame");
        };
        assert_eq!(decoded.terminal_id, "pty-shell");
        assert_eq!(decoded.revision, 7);
    }
}
