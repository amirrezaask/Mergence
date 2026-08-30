use std::{collections::HashMap, net::TcpStream, thread, time::Duration};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use crossbeam_channel::{Receiver, Sender, unbounded};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use tungstenite::{Message, WebSocket, connect, stream::MaybeTlsStream};

use crate::model::{
    AppSession, MuxTerminal, RpcRequest, RpcResponse, RuntimeSnapshot, SessionSnapshot, SessionTab,
    TerminalAttach,
};

const BASE_URL: &str = "http://127.0.0.1:7774";
const WS_URL: &str = "ws://127.0.0.1:7774/ws?since=0&clientId=desktop-gpui&protocol=2";
const CLIENT_ID: &str = "desktop-gpui";

#[derive(Clone, Debug)]
pub enum HostAction {
    Hydrate,
    CreateSession,
    CreateTab {
        session_id: String,
        title: String,
    },
    CreateTerminal {
        session_id: String,
        tab_id: String,
    },
    SelectSession {
        session_id: String,
    },
    SelectTab {
        session_id: String,
        tab_id: String,
    },
    SelectTerminal {
        session_id: String,
        terminal_id: String,
    },
    CloseTerminal {
        terminal_id: String,
    },
    CloseTab {
        tab_id: String,
    },
}

#[derive(Clone, Debug)]
pub enum SocketAction {
    Attach {
        pty_id: String,
    },
    Input {
        pty_id: String,
        bytes: Vec<u8>,
    },
    Resize {
        pty_id: String,
        cols: u16,
        rows: u16,
    },
}

#[derive(Clone, Debug)]
pub enum HostEvent {
    Connecting,
    Connected,
    Offline(String),
    Snapshots(Vec<SessionSnapshot>),
    RefreshRequested,
    TerminalReplay {
        pty_id: String,
        chunks: Vec<Vec<u8>>,
        cols: u16,
        rows: u16,
    },
    TerminalOutput {
        pty_id: String,
        bytes: Vec<u8>,
    },
    ActionFailed(String),
}

#[derive(Clone)]
pub struct HostClient {
    action_tx: Sender<HostAction>,
    socket_tx: Sender<SocketAction>,
    event_rx: Receiver<HostEvent>,
}

impl HostClient {
    pub fn start() -> Self {
        let (event_tx, event_rx) = unbounded();
        let (action_tx, action_rx) = unbounded();
        let (socket_tx, socket_rx) = unbounded();

        spawn_rpc_worker(action_rx, event_tx.clone());
        spawn_socket_worker(socket_rx, event_tx);

        let client = Self {
            action_tx,
            socket_tx,
            event_rx,
        };
        client.hydrate();
        client
    }

    pub fn events(&self) -> &Receiver<HostEvent> {
        &self.event_rx
    }

    pub fn hydrate(&self) {
        let _ = self.action_tx.send(HostAction::Hydrate);
    }

    pub fn action(&self, action: HostAction) {
        let _ = self.action_tx.send(action);
    }

    pub fn attach(&self, pty_id: impl Into<String>) {
        let _ = self.socket_tx.send(SocketAction::Attach {
            pty_id: pty_id.into(),
        });
    }

    pub fn input(&self, pty_id: impl Into<String>, bytes: &[u8]) {
        let _ = self.socket_tx.send(SocketAction::Input {
            pty_id: pty_id.into(),
            bytes: bytes.to_vec(),
        });
    }

    pub fn resize(&self, pty_id: impl Into<String>, cols: u16, rows: u16) {
        let _ = self.socket_tx.send(SocketAction::Resize {
            pty_id: pty_id.into(),
            cols,
            rows,
        });
    }
}

fn spawn_rpc_worker(actions: Receiver<HostAction>, events: Sender<HostEvent>) {
    thread::Builder::new()
        .name("yaade-gpui-rpc".to_owned())
        .spawn(move || {
            let http = reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(10))
                .build()
                .expect("build HTTP client");
            while let Ok(action) = actions.recv() {
                let result = run_action(&http, action);
                match result {
                    Ok(snapshots) => {
                        if let Some(snapshots) = snapshots {
                            let _ = events.send(HostEvent::Snapshots(snapshots));
                        }
                    }
                    Err(error) => {
                        let _ = events.send(HostEvent::ActionFailed(error.to_string()));
                    }
                }
            }
        })
        .expect("start YAADE RPC worker");
}

fn run_action(
    http: &reqwest::blocking::Client,
    action: HostAction,
) -> anyhow::Result<Option<Vec<SessionSnapshot>>> {
    match action {
        HostAction::Hydrate => {
            rpc::<Vec<SessionSnapshot>>(http, "mux:listSessions", vec![json!(false)]).map(Some)
        }
        HostAction::CreateSession => {
            let session = rpc::<AppSession>(http, "mux:createSession", vec![json!("New session")])?;
            if let Some(snapshot) =
                rpc::<Option<SessionSnapshot>>(http, "mux:getSession", vec![json!(session.id)])?
                && let Some(tab) = snapshot.tabs.first()
            {
                create_terminal(http, &snapshot.session.id, &tab.id)?;
            }
            hydrate(http).map(Some)
        }
        HostAction::CreateTab { session_id, title } => {
            let tab = rpc::<SessionTab>(
                http,
                "mux:createTab",
                vec![json!({
                    "_tag": "CreateSessionTab",
                    "sessionId": session_id,
                    "title": title,
                })],
            )?;
            create_terminal(http, &tab.session_id, &tab.id)?;
            hydrate(http).map(Some)
        }
        HostAction::CreateTerminal { session_id, tab_id } => {
            create_terminal(http, &session_id, &tab_id)?;
            hydrate(http).map(Some)
        }
        HostAction::SelectSession { session_id } => {
            let snapshot =
                rpc::<Option<SessionSnapshot>>(http, "mux:getSession", vec![json!(session_id)])?;
            if let Some(snapshot) = snapshot {
                let tab_id = snapshot
                    .session
                    .active_tab_id
                    .or_else(|| snapshot.tabs.first().map(|tab| tab.id.clone()));
                rpc::<AppSession>(
                    http,
                    "mux:selectTab",
                    vec![json!({
                        "_tag": "SelectSessionTab",
                        "sessionId": snapshot.session.id,
                        "tabId": tab_id,
                    })],
                )?;
            }
            hydrate(http).map(Some)
        }
        HostAction::SelectTab { session_id, tab_id } => {
            rpc::<AppSession>(
                http,
                "mux:selectTab",
                vec![json!({
                    "_tag": "SelectSessionTab",
                    "sessionId": session_id,
                    "tabId": tab_id,
                })],
            )?;
            hydrate(http).map(Some)
        }
        HostAction::SelectTerminal {
            session_id,
            terminal_id,
        } => {
            rpc::<AppSession>(
                http,
                "mux:selectTerminal",
                vec![json!(session_id), json!(terminal_id)],
            )?;
            hydrate(http).map(Some)
        }
        HostAction::CloseTerminal { terminal_id } => {
            rpc::<MuxTerminal>(
                http,
                "mux:closeTerminal",
                vec![json!({
                    "_tag": "CloseTerminal",
                    "muxTerminalId": terminal_id,
                })],
            )?;
            hydrate(http).map(Some)
        }
        HostAction::CloseTab { tab_id } => {
            rpc::<SessionTab>(
                http,
                "mux:archiveTab",
                vec![json!({
                    "_tag": "ArchiveSessionTab",
                    "tabId": tab_id,
                    "mode": "stop-terminals",
                })],
            )?;
            hydrate(http).map(Some)
        }
    }
}

fn create_terminal(
    http: &reqwest::blocking::Client,
    session_id: &str,
    tab_id: &str,
) -> anyhow::Result<MuxTerminal> {
    rpc::<MuxTerminal>(
        http,
        "mux:createTerminal",
        vec![json!({
            "_tag": "CreateTerminal",
            "sessionId": session_id,
            "tabId": tab_id,
            "kind": "terminal",
            "input": { "_tag": "TerminalInput", "kind": "terminal" },
        })],
    )
}

fn hydrate(http: &reqwest::blocking::Client) -> anyhow::Result<Vec<SessionSnapshot>> {
    rpc(http, "mux:listSessions", vec![json!(false)])
}

fn rpc<T: DeserializeOwned>(
    http: &reqwest::blocking::Client,
    channel: &str,
    args: Vec<Value>,
) -> anyhow::Result<T> {
    let response = http
        .post(format!("{BASE_URL}/api/v1/rpc"))
        .json(&RpcRequest {
            channel,
            args,
            client_id: CLIENT_ID,
        })
        .send()?
        .error_for_status()?
        .json::<RpcResponse>()?;
    if let Some(error) = response.error {
        anyhow::bail!("{}: {}", error.code, error.message);
    }
    serde_json::from_value(response.value.unwrap_or(Value::Null)).map_err(Into::into)
}

fn spawn_socket_worker(actions: Receiver<SocketAction>, events: Sender<HostEvent>) {
    thread::Builder::new()
        .name("yaade-gpui-terminal-stream".to_owned())
        .spawn(move || {
            let mut subscriptions = HashMap::<String, u64>::new();
            loop {
                let _ = events.send(HostEvent::Connecting);
                match connect(WS_URL) {
                    Ok((mut socket, _)) => {
                        set_socket_timeout(&mut socket);
                        let _ = events.send(HostEvent::Connected);
                        run_socket(&mut socket, &actions, &events, &mut subscriptions);
                    }
                    Err(error) => {
                        let _ = events.send(HostEvent::Offline(error.to_string()));
                    }
                }
                thread::sleep(Duration::from_millis(750));
            }
        })
        .expect("start YAADE terminal stream worker");
}

fn set_socket_timeout(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) {
    if let MaybeTlsStream::Plain(stream) = socket.get_mut() {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(16)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    }
}

fn run_socket(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    actions: &Receiver<SocketAction>,
    events: &Sender<HostEvent>,
    subscriptions: &mut HashMap<String, u64>,
) {
    let mut sequence = 0_u64;
    let mut pending_attach = HashMap::<String, String>::new();
    for (pty_id, last_sequence) in subscriptions.iter() {
        sequence += 1;
        let request_id = format!("desktop-gpui:{sequence}");
        pending_attach.insert(request_id.clone(), pty_id.clone());
        let attach = json!({
            "requestId": request_id,
            "op": "terminal:attach",
            "args": [pty_id, last_sequence, "raw"],
        });
        if socket
            .send(Message::Text(attach.to_string().into()))
            .is_err()
        {
            return;
        }
    }
    loop {
        while let Ok(action) = actions.try_recv() {
            sequence += 1;
            let request_id = format!("desktop-gpui:{sequence}");
            let (op, args) = match action {
                SocketAction::Attach { pty_id } => {
                    let last_sequence = *subscriptions.entry(pty_id.clone()).or_insert(0);
                    pending_attach.insert(request_id.clone(), pty_id.clone());
                    (
                        "terminal:attach",
                        vec![json!(pty_id), json!(last_sequence), json!("raw")],
                    )
                }
                SocketAction::Input { pty_id, bytes } => (
                    "terminal:writeBinary",
                    vec![json!(pty_id), json!(STANDARD.encode(bytes))],
                ),
                SocketAction::Resize { pty_id, cols, rows } => (
                    "terminal:resize",
                    vec![json!(pty_id), json!(cols), json!(rows)],
                ),
            };
            if socket
                .send(Message::Text(
                    json!({ "requestId": request_id, "op": op, "args": args })
                        .to_string()
                        .into(),
                ))
                .is_err()
            {
                return;
            }
        }

        match socket.read() {
            Ok(Message::Text(text)) => handle_text_message(
                socket,
                text.as_str(),
                &mut pending_attach,
                subscriptions,
                events,
            ),
            Ok(Message::Binary(bytes)) => {
                if let Some(frame) = decode_terminal_frame(bytes.as_ref()) {
                    subscriptions
                        .entry(frame.pty_id.clone())
                        .and_modify(|sequence| *sequence = (*sequence).max(frame.terminal_sequence))
                        .or_insert(frame.terminal_sequence);
                    let _ = events.send(HostEvent::TerminalOutput {
                        pty_id: frame.pty_id.clone(),
                        bytes: frame.payload,
                    });
                    let ack = json!({
                        "type": "terminal:ack",
                        "terminalId": frame.pty_id,
                        "sequence": frame.terminal_sequence,
                    });
                    let _ = socket.send(Message::Text(ack.to_string().into()));
                }
            }
            Ok(Message::Ping(bytes)) => {
                let _ = socket.send(Message::Pong(bytes));
            }
            Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) => return,
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return,
            _ => {}
        }
    }
}

fn handle_text_message(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    text: &str,
    pending_attach: &mut HashMap<String, String>,
    subscriptions: &mut HashMap<String, u64>,
    events: &Sender<HostEvent>,
) {
    if text == "pong" {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("runtime:snapshot") => {
            if let Ok(snapshot) = serde_json::from_value::<RuntimeSnapshot>(value) {
                let _ = events.send(HostEvent::Snapshots(snapshot.sessions));
            }
        }
        Some("terminal:result") => {
            let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
                return;
            };
            let Some(pty_id) = pending_attach.remove(request_id) else {
                return;
            };
            if value.get("ok").and_then(Value::as_bool) != Some(true) {
                let message = value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("terminal attach failed");
                let _ = events.send(HostEvent::ActionFailed(message.to_owned()));
                return;
            }
            if let Ok(attach) = serde_json::from_value::<TerminalAttach>(
                value.get("value").cloned().unwrap_or(Value::Null),
            ) {
                let mut chunks = Vec::new();
                if let Some(checkpoint) = attach.checkpoint
                    && let Ok(bytes) = STANDARD.decode(checkpoint.synthetic_bytes)
                {
                    chunks.push(bytes);
                }
                for encoded in attach.output_chunks {
                    if let Ok(bytes) = STANDARD.decode(encoded) {
                        chunks.push(bytes);
                    }
                }
                if let Ok(bytes) = STANDARD.decode(attach.output)
                    && !bytes.is_empty()
                {
                    chunks.push(bytes);
                }
                subscriptions.insert(pty_id.clone(), attach.last_sequence);
                let _ = events.send(HostEvent::TerminalReplay {
                    pty_id: attach.id,
                    chunks,
                    cols: attach.cols,
                    rows: attach.rows,
                });
                let ready = json!({
                    "requestId": format!("desktop-gpui:ready:{}", attach.last_sequence),
                    "op": "terminal:ready",
                    "args": [pty_id],
                });
                let _ = socket.send(Message::Text(ready.to_string().into()));
            }
        }
        Some("terminal:replay-required") => {
            if let Some(pty_id) = value.get("terminalId").and_then(Value::as_str) {
                let request_id = format!("desktop-gpui:reattach:{}", uuid::Uuid::new_v4());
                pending_attach.insert(request_id.clone(), pty_id.to_owned());
                let last_sequence = subscriptions.get(pty_id).copied().unwrap_or(0);
                let attach = json!({
                    "requestId": request_id,
                    "op": "terminal:attach",
                    "args": [pty_id, last_sequence, "raw"],
                });
                let _ = socket.send(Message::Text(attach.to_string().into()));
            }
        }
        _ => {
            if value.get("channel").and_then(Value::as_str) == Some("mux:event")
                || value.get("channel").and_then(Value::as_str) == Some("terminal:exit")
            {
                let _ = events.send(HostEvent::RefreshRequested);
            }
        }
    }
}

struct TerminalFrame {
    pty_id: String,
    terminal_sequence: u64,
    payload: Vec<u8>,
}

fn decode_terminal_frame(bytes: &[u8]) -> Option<TerminalFrame> {
    match bytes.first().copied()? {
        0x02 if bytes.len() >= 19 => {
            let terminal_sequence = u64::from_be_bytes(bytes.get(9..17)?.try_into().ok()?);
            let id_len = u16::from_be_bytes(bytes.get(17..19)?.try_into().ok()?) as usize;
            let payload_start = 19_usize.checked_add(id_len)?;
            Some(TerminalFrame {
                pty_id: std::str::from_utf8(bytes.get(19..payload_start)?)
                    .ok()?
                    .to_owned(),
                terminal_sequence,
                payload: bytes.get(payload_start..)?.to_vec(),
            })
        }
        0x01 if bytes.len() >= 11 => {
            let terminal_sequence = u32::from_be_bytes(bytes.get(5..9)?.try_into().ok()?) as u64;
            let id_len = u16::from_be_bytes(bytes.get(9..11)?.try_into().ok()?) as usize;
            let payload_start = 11_usize.checked_add(id_len)?;
            Some(TerminalFrame {
                pty_id: std::str::from_utf8(bytes.get(11..payload_start)?)
                    .ok()?
                    .to_owned(),
                terminal_sequence,
                payload: bytes.get(payload_start..)?.to_vec(),
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::decode_terminal_frame;

    #[test]
    fn decodes_terminal_data_v2_without_copying_ids_into_payload() {
        let id = b"pty-test";
        let mut bytes = vec![0x02];
        bytes.extend_from_slice(&7_u64.to_be_bytes());
        bytes.extend_from_slice(&9_u64.to_be_bytes());
        bytes.extend_from_slice(&(id.len() as u16).to_be_bytes());
        bytes.extend_from_slice(id);
        bytes.extend_from_slice(b"hello");
        let frame = decode_terminal_frame(&bytes).expect("frame");
        assert_eq!(frame.pty_id, "pty-test");
        assert_eq!(frame.terminal_sequence, 9);
        assert_eq!(frame.payload, b"hello");
    }
}
