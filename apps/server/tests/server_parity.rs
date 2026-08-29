use std::{path::PathBuf, time::Duration};

use futures_util::{SinkExt as _, StreamExt as _};
use reqwest::StatusCode;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use yaade_server::{
    config::{HostConfig, HostFeatures, LaunchConfig, LaunchSource},
    server::{RunningServer, serve},
};

struct Harness {
    server: RunningServer,
    _temp: TempDir,
}

impl Harness {
    async fn start(token: Option<&str>) -> Self {
        let temp = tempfile::tempdir().expect("temp dir");
        let server = serve(config(&temp, 0, token)).await.expect("server");
        Self { server, _temp: temp }
    }

    fn http(&self, path: &str) -> String {
        format!("http://{}{}", self.server.address, path)
    }

    fn ws(&self, query: &str) -> String {
        format!("ws://{}/ws{query}", self.server.address)
    }
}

fn config(temp: &TempDir, port: u16, token: Option<&str>) -> HostConfig {
    let workspace = std::env::current_dir().expect("cwd");
    HostConfig {
        host: "127.0.0.1".to_owned(),
        port,
        data_dir: temp.path().to_owned(),
        allowed_roots: vec![workspace.clone()],
        open_browser: false,
        launch_path: workspace.clone(),
        launch_config: LaunchConfig {
            workspace_path: workspace,
            file_path: None,
            source: Some(LaunchSource::Default),
        },
        static_dir: None,
        auth_token: token.map(str::to_owned),
        cors_origins: Vec::new(),
        features: HostFeatures { terminal_checkpoints: true },
    }
}

async fn json_message<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    loop {
        let message = tokio::time::timeout(Duration::from_secs(5), socket.next())
            .await
            .expect("message timeout")
            .expect("socket open")
            .expect("valid message");
        if let Message::Text(text) = message {
            return serde_json::from_str(text.as_str()).expect("json message");
        }
    }
}

async fn modern_socket(
    harness: &Harness,
    token: Option<&str>,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let (mut socket, _) = connect_async(harness.ws("?protocol=2&clientId=test"))
        .await
        .expect("connect");
    if let Some(token) = token {
        assert_eq!(json_message(&mut socket).await["type"], "protocol:auth-required");
        socket
            .send(Message::Text(
                json!({ "type": "protocol:auth", "token": token })
                    .to_string()
                    .into(),
            ))
            .await
            .expect("authenticate");
    }
    socket
}

#[tokio::test]
async fn host_token_gate_keeps_health_public_and_requires_token_for_api_and_websocket() {
    let harness = Harness::start(Some("secret-token")).await;
    let client = reqwest::Client::new();
    assert_eq!(client.get(harness.http("/health")).send().await.expect("health").status(), StatusCode::OK);
    assert_eq!(client.get(harness.http("/api/v1/system")).send().await.expect("system").status(), StatusCode::UNAUTHORIZED);
    assert_eq!(client.get(harness.http("/api/v1/system")).bearer_auth("secret-token").send().await.expect("system").status(), StatusCode::OK);

    let denied = connect_async(harness.ws("?protocol=1&token=wrong")).await;
    assert!(matches!(denied, Err(tokio_tungstenite::tungstenite::Error::Http(response)) if response.status() == 401));
    let allowed = connect_async(harness.ws("?protocol=1&token=secret-token")).await;
    assert!(allowed.is_ok());
    harness.server.shutdown().await;
}

#[tokio::test]
async fn modern_realtime_connections_receive_identity_snapshot_and_post_snapshot_events() {
    let harness = Harness::start(None).await;
    let mut socket = modern_socket(&harness, None).await;
    let hello = json_message(&mut socket).await;
    assert_eq!(hello["type"], "protocol:hello");
    let snapshot = json_message(&mut socket).await;
    assert_eq!(snapshot["type"], "runtime:snapshot");
    assert!(snapshot["sessions"].as_array().is_some_and(|sessions| !sessions.is_empty()));

    let response = reqwest::Client::new()
        .post(harness.http("/api/v1/rpc"))
        .json(&json!({ "channel": "mux:createSession", "args": ["Realtime"] }))
        .send().await.expect("rpc");
    assert_eq!(response.status(), StatusCode::OK);
    let event = loop {
        let value = json_message(&mut socket).await;
        if value["channel"] == "mux:event" { break value; }
    };
    assert_eq!(event["protocolVersion"], 2);
    assert_eq!(event["serverId"], hello["identity"]["serverId"]);
    harness.server.shutdown().await;
}

#[tokio::test]
async fn modern_websocket_authentication_does_not_put_token_in_url() {
    let harness = Harness::start(Some("modern-secret")).await;
    let mut socket = modern_socket(&harness, Some("modern-secret")).await;
    assert_eq!(json_message(&mut socket).await["type"], "protocol:hello");
    assert_eq!(json_message(&mut socket).await["type"], "runtime:snapshot");
    harness.server.shutdown().await;
}

#[tokio::test]
async fn server_identity_survives_api_restart_while_epoch_changes() {
    let temp = tempfile::tempdir().expect("temp dir");
    let first = serve(config(&temp, 0, None)).await.expect("first server");
    let first_id = first.runtime.identity.server_id.clone();
    let first_epoch = first.runtime.identity.server_epoch.clone();
    first.shutdown().await;

    let second = serve(config(&temp, 0, None)).await.expect("second server");
    assert_eq!(second.runtime.identity.server_id, first_id);
    assert_ne!(second.runtime.identity.server_epoch, first_epoch);
    second.shutdown().await;
}

#[tokio::test]
async fn start_host_server_binds_an_os_assigned_high_port_when_preferred_is_zero() {
    let harness = Harness::start(None).await;
    assert_ne!(harness.server.address.port(), 0);
    harness.server.shutdown().await;
}

#[tokio::test]
async fn start_host_server_binds_next_port_when_preferred_is_taken() {
    let (_occupied, preferred) = (30_000_u16..40_000)
        .find_map(|port| std::net::TcpListener::bind(("127.0.0.1", port)).ok().map(|listener| (listener, port)))
        .expect("reserve port");
    let temp = tempfile::tempdir().expect("temp dir");
    let server = serve(config(&temp, preferred, None)).await.expect("server");
    assert_eq!(server.address.port(), preferred + 1);
    server.shutdown().await;
}

#[tokio::test]
async fn two_websocket_clients_receive_same_live_pty_and_survive_one_disconnect() {
    let harness = Harness::start(None).await;
    let client = reqwest::Client::new();
    let create: Value = client.post(harness.http("/api/v1/rpc"))
        .json(&json!({
            "channel": "terminal:create",
            "args": [PathBuf::from(std::env::current_dir().expect("cwd")).display().to_string(), {
                "command": "/bin/sh",
                "args": ["-c", "printf READY; sleep 2"]
            }]
        }))
        .send().await.expect("create").json().await.expect("create json");
    let terminal_id = create["value"]["id"].as_str().expect("terminal id");

    let mut first = modern_socket(&harness, None).await;
    for _ in 0..2 { let _ = json_message(&mut first).await; }
    let mut second = modern_socket(&harness, None).await;
    for _ in 0..2 { let _ = json_message(&mut second).await; }
    for (request, socket) in [("one", &mut first), ("two", &mut second)] {
        socket.send(Message::Text(json!({
            "requestId": request,
            "op": "terminal:attach",
            "args": [terminal_id, 0, "raw"]
        }).to_string().into())).await.expect("attach");
        let result = json_message(socket).await;
        assert_eq!(result["ok"], true);
        assert!(result["value"]["outputChunks"].as_array().is_some());
    }
    first.close(None).await.expect("close first");
    second.send(Message::Text("ping".into())).await.expect("ping");
    let pong = tokio::time::timeout(Duration::from_secs(2), second.next())
        .await.expect("pong timeout").expect("socket open").expect("pong");
    assert_eq!(pong, Message::Text("pong".into()));
    harness.server.shutdown().await;
}
