use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{
        DefaultBodyLimit, Path as AxumPath, Query, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, Method, Request, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, delete, get, post},
};
use futures_util::{
    SinkExt as _, StreamExt as _,
    stream::{SplitSink, SplitStream},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use subtle::ConstantTimeEq as _;
use tokio::{
    net::TcpListener,
    sync::{Semaphore, broadcast},
};
use uuid::Uuid;

use crate::{
    config::{HostConfig, is_loopback_hostname},
    device_auth::{AuthenticateDevice, DeviceAuthError, PairDevice},
    model::now_iso,
    runtime::{HostRuntime, Principal, RuntimeError},
    terminal::capture_process_identity,
    wire::{
        HostEvent, HostRpcRequest, MAX_WS_PAYLOAD_BYTES, TerminalWsAck, TerminalWsCommand,
        encode_terminal_data_frame,
    },
};

const MAX_JSON_BODY_BYTES: usize = 2 * 1024 * 1024;
const MAX_WS_COMMAND_QUEUE: usize = 64;
const MAX_INFLIGHT_RPC: usize = 32;
const MAX_PENDING_AUTH: usize = 64;

#[derive(Clone)]
struct AppState {
    runtime: Arc<HostRuntime>,
    rpc_limit: Arc<Semaphore>,
    auth_limit: Arc<Semaphore>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsQuery {
    protocol: Option<u8>,
    client_id: Option<String>,
    token: Option<String>,
    since: Option<u64>,
}

pub struct RunningServer {
    pub runtime: Arc<HostRuntime>,
    pub address: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    pub async fn wait(self) {
        let _ = self.task.await;
        let manifest = self.runtime.config.data_dir.join("runtime.json");
        if let Ok(value) = std::fs::read(&manifest)
            && serde_json::from_slice::<Value>(&value)
                .ok()
                .and_then(|value| {
                    value
                        .get("serverEpoch")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .as_deref()
                == Some(self.runtime.identity.server_epoch.as_str())
        {
            let _ = std::fs::remove_file(manifest);
        }
    }
}

pub async fn serve(mut config: HostConfig) -> Result<RunningServer, Box<dyn std::error::Error>> {
    let listener = bind_preferred(&config.host, config.port).await?;
    let address = listener.local_addr()?;
    config.port = address.port();
    let runtime = HostRuntime::start(config)?;
    write_runtime_manifest(&runtime, address.port())?;
    let state = AppState {
        runtime: Arc::clone(&runtime),
        rpc_limit: Arc::new(Semaphore::new(MAX_INFLIGHT_RPC)),
        auth_limit: Arc::new(Semaphore::new(MAX_PENDING_AUTH)),
    };
    let router = Router::new()
        .route("/health", get(health))
        .route("/api/v1/system", get(system))
        .route("/api/v1/diagnostics", get(diagnostics))
        .route("/api/v1/security/pair", post(pair_device))
        .route("/api/v1/security/challenge", post(device_challenge))
        .route("/api/v1/security/session", post(device_session))
        .route(
            "/api/v1/security/session/rotate",
            post(rotate_device_session),
        )
        .route("/api/v1/security/pairing-code", post(pairing_code))
        .route("/api/v1/security/devices", get(list_devices))
        .route(
            "/api/v1/security/devices/{device_id}",
            delete(revoke_device),
        )
        .route("/api/v1/rpc", post(rpc))
        .route("/ws", get(websocket))
        .fallback(any(fallback))
        .layer(DefaultBodyLimit::max(MAX_JSON_BODY_BYTES))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            request_policy,
        ))
        .with_state(state);
    println!(
        "[host-server] listening on http://{}:{}",
        runtime.config.host,
        address.port()
    );
    let shutdown_runtime = Arc::clone(&runtime);
    let shutdown = async move {
        shutdown_signal().await;
        shutdown_runtime.shutdown();
    };
    let task = tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await
        {
            eprintln!("[host-server] {error}");
        }
    });
    Ok(RunningServer {
        runtime,
        address,
        task,
    })
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let terminate = signal(SignalKind::terminate());
        if let Ok(mut terminate) = terminate {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}

async fn bind_preferred(host: &str, preferred: u16) -> std::io::Result<TcpListener> {
    if preferred == 0 {
        return TcpListener::bind((host, 0)).await;
    }
    let mut last_error = None;
    for offset in 0..50_u16 {
        match TcpListener::bind((host, preferred.saturating_add(offset))).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => last_error = Some(error),
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| std::io::Error::other("no available port")))
}

async fn request_policy(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let is_api = request.uri().path().starts_with("/api");
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let cors_allowed = origin
        .as_deref()
        .is_some_and(|origin| allowed_cors_origin(origin, &state.runtime.config.cors_origins));
    if is_api && request.method() == Method::OPTIONS {
        if origin.is_some() && !cors_allowed {
            return StatusCode::FORBIDDEN.into_response();
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        add_cors_headers(&mut response, origin.as_deref(), cors_allowed);
        return response;
    }
    if is_api
        && origin.as_deref().is_some_and(|origin| {
            !allowed_http_origin(
                origin,
                &state.runtime.config.host,
                &state.runtime.config.cors_origins,
            )
        })
    {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": { "code": "ORIGIN_DENIED", "message": "origin is not allowed", "details": {} } }),
        );
    }
    let mut response = next.run(request).await;
    if is_api {
        add_cors_headers(&mut response, origin.as_deref(), cors_allowed);
    }
    response
}

fn add_cors_headers(response: &mut Response, origin: Option<&str>, allowed: bool) {
    if !allowed {
        return;
    }
    if let Some(origin) = origin.and_then(|origin| HeaderValue::from_str(origin).ok()) {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, authorization, x-yaade-token"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET, POST, PUT, OPTIONS"),
        );
    }
}

async fn health(State(state): State<AppState>) -> Response {
    let database = state.runtime.store.health();
    json_response(
        StatusCode::OK,
        json!({
            "status": "ok",
            "version": env!("CARGO_PKG_VERSION"),
            "identity": state.runtime.identity,
            "health": {
                "status": if database { "healthy" } else { "unhealthy" },
                "database": {
                    "status": if database { "healthy" } else { "degraded" },
                    "message": if database { "SQLite WAL is available" } else { "SQLite probe failed" },
                },
                "eventLoop": { "status": "healthy", "message": "health request served on the HTTP event loop" },
                "storage": { "status": "healthy", "message": "runtime storage is available" },
                "connectedClients": state.runtime.events.subscriber_count().saturating_sub(1),
                "runningTerminals": state.runtime.running_terminal_count(),
            }
        }),
    )
}

async fn system(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(_) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    json_response(
        StatusCode::OK,
        json!({
            "name": "YAADE",
            "version": env!("CARGO_PKG_VERSION"),
            "protocolVersion": 2,
            "identity": state.runtime.identity,
            "capabilities": state.runtime.capabilities,
            "serverId": state.runtime.identity.server_id,
            "serverEpoch": state.runtime.identity.server_epoch,
            "launchConfig": state.runtime.config.launch_config,
            "homeDir": state.runtime.home_dir,
            "machineHostname": state.runtime.machine_hostname,
        }),
    )
}

async fn diagnostics(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(_) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    json_response(
        StatusCode::OK,
        json!({
            "generatedAt": now_iso(),
            "identity": state.runtime.identity,
            "config": {
                "host": state.runtime.config.host,
                "port": state.runtime.config.port,
                "features": { "terminalCheckpoints": state.runtime.config.features.terminal_checkpoints },
            },
            "health": {
                "status": if state.runtime.store.health() { "healthy" } else { "unhealthy" },
                "database": { "status": if state.runtime.store.health() { "healthy" } else { "degraded" } },
                "connectedClients": state.runtime.events.subscriber_count().saturating_sub(1),
                "runningTerminals": state.runtime.running_terminal_count(),
            },
            "devices": state.runtime.devices.list().unwrap_or_default().into_iter().map(|device| json!({
                "id": device.id,
                "name": device.name,
                "scopes": device.scopes,
                "revokedAt": device.revoked_at,
            })).collect::<Vec<_>>(),
            "capabilities": state.runtime.capabilities,
        }),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceChallengeRequest {
    device_id: String,
}

async fn pair_device(State(state): State<AppState>, Json(input): Json<PairDevice>) -> Response {
    match state.runtime.devices.pair(input) {
        Ok(device) => json_response(StatusCode::CREATED, json!(device)),
        Err(error) => device_error(error, StatusCode::BAD_REQUEST, "PAIRING_FAILED"),
    }
}

async fn device_challenge(
    State(state): State<AppState>,
    Json(input): Json<DeviceChallengeRequest>,
) -> Response {
    match state.runtime.devices.challenge(&input.device_id) {
        Ok(challenge) => json_response(StatusCode::OK, json!(challenge)),
        Err(error) => device_error(error, StatusCode::UNAUTHORIZED, "DEVICE_AUTH_FAILED"),
    }
}

async fn device_session(
    State(state): State<AppState>,
    Json(input): Json<AuthenticateDevice>,
) -> Response {
    match state.runtime.devices.authenticate(input) {
        Ok(session) => json_response(StatusCode::OK, json!(session)),
        Err(error) => device_error(error, StatusCode::UNAUTHORIZED, "DEVICE_AUTH_FAILED"),
    }
}

async fn pairing_code(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(principal) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    if !principal.local_admin {
        return scope_denied("admin pairing requires a local administrator");
    }
    match state.runtime.devices.create_pairing_code() {
        Ok(code) => json_response(StatusCode::CREATED, json!(code)),
        Err(error) => device_error(error, StatusCode::BAD_REQUEST, "PAIRING_FAILED"),
    }
}

async fn list_devices(State(state): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let Some(principal) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    if !principal.can_admin {
        return scope_denied("admin scope required");
    }
    match state.runtime.devices.list() {
        Ok(devices) => json_response(StatusCode::OK, json!(devices)),
        Err(error) => device_error(error, StatusCode::INTERNAL_SERVER_ERROR, "OPERATION_FAILED"),
    }
}

async fn revoke_device(
    State(state): State<AppState>,
    AxumPath(device_id): AxumPath<String>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let Some(principal) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    if !principal.can_admin {
        return scope_denied("admin scope required");
    }
    match state.runtime.devices.revoke(&device_id) {
        Ok(_) => {
            state
                .runtime
                .events
                .emit("security:device-revoked", vec![json!(device_id)]);
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => device_error(error, StatusCode::INTERNAL_SERVER_ERROR, "OPERATION_FAILED"),
    }
}

async fn rotate_device_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let Some(principal) = request_principal(&state.runtime, &headers, &uri, None) else {
        return unauthorized();
    };
    if !principal.can_control {
        return scope_denied("route requires control capability");
    }
    let Some(token) = bearer_token(&headers).or_else(|| query_token(&uri)) else {
        return device_error(
            DeviceAuthError::Unauthorized("unknown session".to_owned()),
            StatusCode::UNAUTHORIZED,
            "DEVICE_AUTH_FAILED",
        );
    };
    match state.runtime.devices.rotate(&token) {
        Ok(session) => json_response(StatusCode::OK, json!(session)),
        Err(error) => device_error(error, StatusCode::UNAUTHORIZED, "DEVICE_AUTH_FAILED"),
    }
}

async fn rpc(State(state): State<AppState>, headers: HeaderMap, uri: Uri, body: Bytes) -> Response {
    let Ok(_permit) = Arc::clone(&state.rpc_limit).try_acquire_owned() else {
        return json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "error": {
                    "code": "HOST_BUSY",
                    "message": format!("too many in-flight RPCs (max {MAX_INFLIGHT_RPC})"),
                    "details": { "inflight": MAX_INFLIGHT_RPC },
                }
            }),
        );
    };
    let request = match serde_json::from_slice::<HostRpcRequest>(&body) {
        Ok(request) => request,
        Err(error) => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({
                    "error": {
                        "code": "INVALID_RPC_PAYLOAD",
                        "message": format!("invalid rpc body: {error}"),
                        "details": {},
                    }
                }),
            );
        }
    };
    let Some(principal) = request_principal(
        &state.runtime,
        &headers,
        &uri,
        Some(request.client_id.as_str()),
    ) else {
        return unauthorized();
    };
    match state
        .runtime
        .dispatch(&principal, &request.channel, &request.args)
    {
        Ok(value) => json_response(StatusCode::OK, json!({ "value": value })),
        Err(error) => runtime_error(error),
    }
}

async fn websocket(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<WsQuery>,
    headers: HeaderMap,
) -> Response {
    if !allowed_websocket_origin(
        headers
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok()),
        headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok()),
        &state.runtime.config.cors_origins,
    ) {
        return StatusCode::FORBIDDEN.into_response();
    }
    if query.protocol.unwrap_or(1) != 2
        && principal_for_token(
            &state.runtime,
            query.token.as_deref(),
            format!("ws-admission-{}", Uuid::new_v4()),
        )
        .is_none()
    {
        return unauthorized();
    }
    ws.max_message_size(MAX_WS_PAYLOAD_BYTES)
        .max_frame_size(MAX_WS_PAYLOAD_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, state.runtime, state.auth_limit, query))
}

async fn handle_socket(
    socket: WebSocket,
    runtime: Arc<HostRuntime>,
    auth_limit: Arc<Semaphore>,
    query: WsQuery,
) {
    let protocol = query.protocol.unwrap_or(1);
    if protocol != 1 && protocol != 2 {
        let mut socket = socket;
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 4002,
                reason: "incompatible protocol".into(),
            })))
            .await;
        return;
    }
    let (mut sender, mut receiver) = socket.split();
    let connection_id = query
        .client_id
        .as_deref()
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .map_or_else(
            || format!("ws-{}", Uuid::new_v4()),
            |value| format!("ws-{value}-{}", Uuid::new_v4()),
        );
    let principal = if protocol == 2 {
        let auth_permit = if runtime.config.auth_token.is_some() {
            match auth_limit.try_acquire_owned() {
                Ok(permit) => Some(permit),
                Err(_) => {
                    let _ = close_socket(&mut sender, 1013, "too many unauthenticated connections")
                        .await;
                    return;
                }
            }
        } else {
            None
        };
        let authenticated =
            authenticate_modern(&runtime, &mut sender, &mut receiver, &connection_id).await;
        drop(auth_permit);
        match authenticated {
            Some(principal) => principal,
            None => return,
        }
    } else {
        match principal_for_token(&runtime, query.token.as_deref(), connection_id.clone()) {
            Some(principal) => principal,
            None => {
                let _ = close_socket(&mut sender, 4003, "authentication required").await;
                return;
            }
        }
    };
    let mut events = runtime.events.subscribe();
    let mut snapshot_sequence = 0;
    if protocol == 2 {
        if send_json(
            &mut sender,
            &json!({
                "type": "protocol:hello",
                "identity": runtime.identity,
                "capabilities": runtime.capabilities,
            }),
        )
        .await
        .is_err()
        {
            return;
        }
        let snapshot = runtime.snapshot();
        snapshot_sequence = snapshot
            .get("cursor")
            .and_then(|cursor| cursor.get("sequence"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if send_json(&mut sender, &snapshot).await.is_err() {
            return;
        }
    } else {
        let replay = runtime.events.replay_window(query.since.unwrap_or(0));
        if replay.history_evicted {
            let gap = HostEvent {
                protocol_version: 1,
                server_id: None,
                server_epoch: None,
                sequence: replay.replay_floor.saturating_sub(1),
                channel: Arc::from("protocol:replay-gap"),
                args: Arc::from(vec![
                    json!(replay.replay_floor),
                    json!(replay.last_sequence),
                ]),
            };
            if send_json(&mut sender, &gap).await.is_err() {
                return;
            }
        }
        for event in replay.events {
            if send_json(&mut sender, &event.legacy()).await.is_err() {
                return;
            }
        }
    }

    let mut attached = HashSet::<String>::new();
    let mut raw = HashSet::<String>::new();
    let flow_limit = terminal_flow_limit();
    let mut flow = HashMap::<String, TerminalFlow>::new();
    let mut queued_commands = 0_usize;

    loop {
        tokio::select! {
            message = receiver.next() => {
                let Some(Ok(message)) = message else { break; };
                match message {
                    Message::Text(text) if text.as_str() == "ping" => {
                        if sender.send(Message::Text("pong".into())).await.is_err() { break; }
                    }
                    Message::Text(text) => {
                        let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else { continue; };
                        if let Ok(ack) = serde_json::from_value::<TerminalWsAck>(value.clone())
                            && ack.kind == "terminal:ack"
                        {
                            if let Some(state) = flow.get_mut(&ack.terminal_id) {
                                state.acknowledge(ack.sequence);
                            }
                            continue;
                        }
                        let Ok(command) = serde_json::from_value::<TerminalWsCommand>(value) else { continue; };
                        if command.request_id.is_empty() || !is_realtime_op(&command.op) { continue; }
                        if queued_commands >= MAX_WS_COMMAND_QUEUE {
                            if send_json(&mut sender, &json!({
                                "type": "terminal:result",
                                "requestId": command.request_id,
                                "ok": false,
                                "error": { "code": "HOST_BUSY", "message": "too many in-flight terminal commands" },
                            })).await.is_err() { break; }
                            continue;
                        }
                        queued_commands += 1;
                        if command.op == "terminal:attach"
                            && let Some(id) = command.args.first().and_then(Value::as_str)
                        {
                            attached.insert(id.to_owned());
                            let mode = command.args.get(2).and_then(Value::as_str).unwrap_or("both");
                            if mode == "raw" || mode == "both" { raw.insert(id.to_owned()); }
                            flow.insert(id.to_owned(), TerminalFlow::new(command.args.get(1).and_then(Value::as_u64).unwrap_or(0)));
                        } else if command.op == "terminal:detach"
                            && let Some(id) = command.args.first().and_then(Value::as_str)
                        {
                            attached.remove(id);
                            raw.remove(id);
                            flow.remove(id);
                        }
                        let result = runtime.dispatch(&principal, &command.op, &command.args);
                        queued_commands = queued_commands.saturating_sub(1);
                        let response = match result {
                            Ok(value) => json!({
                                "type": "terminal:result",
                                "requestId": command.request_id,
                                "ok": true,
                                "value": value,
                            }),
                            Err(error) => {
                                if command.op == "terminal:attach"
                                    && let Some(id) = command.args.first().and_then(Value::as_str)
                                {
                                    attached.remove(id);
                                    raw.remove(id);
                                    flow.remove(id);
                                }
                                json!({
                                    "type": "terminal:result",
                                    "requestId": command.request_id,
                                    "ok": false,
                                    "error": { "code": error.wire_code(), "message": error.to_string() },
                                })
                            }
                        };
                        if send_json(&mut sender, &response).await.is_err() { break; }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
            event = events.recv() => {
                let event = match event {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        for id in raw.drain() {
                            let sequence = flow.get(&id).map_or(0, |state| state.acknowledged);
                            if send_json(&mut sender, &json!({
                                "type": "terminal:replay-required",
                                "terminalId": id,
                                "sequence": sequence,
                            })).await.is_err() { break; }
                        }
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if protocol == 2 && event.sequence <= snapshot_sequence {
                    continue;
                }
                if event.channel.as_ref() == "security:device-revoked" {
                    let revoked = event.args.first().and_then(Value::as_str);
                    if revoked == principal.device_id.as_deref() {
                        let _ = close_socket(&mut sender, 4003, "access revoked").await;
                        break;
                    }
                    continue;
                }
                if event.channel.as_ref() == "terminal:data" {
                    let Some(id) = event.args.first().and_then(Value::as_str) else { continue; };
                    if !attached.contains(id) || !raw.contains(id) { continue; }
                    let data = event.args.get(1).and_then(Value::as_str).unwrap_or("");
                    let sequence = event.args.get(2).and_then(Value::as_u64).unwrap_or(0);
                    if protocol == 2 {
                        let state = flow.entry(id.to_owned()).or_insert_with(|| TerminalFlow::new(0));
                        if !state.reserve(sequence, data.len(), flow_limit) {
                            raw.remove(id);
                            if send_json(&mut sender, &json!({
                                "type": "terminal:replay-required",
                                "terminalId": id,
                                "sequence": state.acknowledged,
                            })).await.is_err() { break; }
                            continue;
                        }
                    }
                    let Ok(frame) = encode_terminal_data_frame(event.sequence, sequence, id, data.as_bytes()) else { continue; };
                    if sender.send(Message::Binary(frame)).await.is_err() { break; }
                    continue;
                }
                if event.channel.as_ref() == "terminal:semantic" { continue; }
                let outgoing = if protocol == 1 { event.legacy() } else { (*event).clone() };
                if send_json(&mut sender, &outgoing).await.is_err() { break; }
            }
        }
    }
    runtime
        .terminal
        .release_connection(&principal.connection_id);
}

async fn authenticate_modern(
    runtime: &HostRuntime,
    sender: &mut SplitSink<WebSocket, Message>,
    receiver: &mut SplitStream<WebSocket>,
    connection_id: &str,
) -> Option<Principal> {
    if runtime.config.auth_token.is_none() {
        return Some(Principal::local(connection_id.to_owned()));
    }
    send_json(sender, &json!({ "type": "protocol:auth-required" }))
        .await
        .ok()?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let message = match tokio::time::timeout_at(deadline, receiver.next()).await {
            Ok(Some(Ok(message))) => message,
            Ok(Some(Err(_)) | None) => return None,
            Err(_) => {
                let _ = close_socket(sender, 4003, "authentication required").await;
                return None;
            }
        };
        let Message::Text(text) = message else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else {
            continue;
        };
        let Some(token) = value
            .as_object()
            .filter(|object| object.get("type").and_then(Value::as_str) == Some("protocol:auth"))
            .and_then(|object| object.get("token"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let principal = principal_for_token(runtime, Some(token), connection_id.to_owned());
        if principal.is_none() {
            let _ = close_socket(sender, 4003, "authentication failed").await;
        }
        return principal;
    }
}

fn request_principal(
    runtime: &HostRuntime,
    headers: &HeaderMap,
    uri: &Uri,
    correlation: Option<&str>,
) -> Option<Principal> {
    let token = bearer_token(headers).or_else(|| query_token(uri));
    let connection_id = correlation
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map_or_else(
            || format!("http-{}", Uuid::new_v4()),
            |value| format!("http-{value}"),
        );
    principal_for_token(runtime, token.as_deref(), connection_id)
}

fn principal_for_token(
    runtime: &HostRuntime,
    provided: Option<&str>,
    connection_id: String,
) -> Option<Principal> {
    if let (Some(expected), Some(provided)) = (runtime.config.auth_token.as_deref(), provided)
        && tokens_equal(expected, provided)
    {
        return Some(Principal::token(connection_id));
    }
    if let Some(token) = provided
        && let Ok(Some(session)) = runtime.devices.session(token)
    {
        return Some(Principal::paired(
            session.device_id,
            &session.scopes,
            connection_id,
        ));
    }
    if runtime.config.auth_token.is_none() && is_loopback_hostname(&runtime.config.host) {
        return Some(Principal::local(connection_id));
    }
    None
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        && let Some(token) = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
    {
        return Some(token.trim().to_owned());
    }
    headers
        .get("x-yaade-token")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn query_token(uri: &Uri) -> Option<String> {
    uri.query().and_then(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned())
    })
}

fn tokens_equal(expected: &str, provided: &str) -> bool {
    let expected = Sha256::digest(expected.as_bytes());
    let provided = Sha256::digest(provided.as_bytes());
    bool::from(expected.as_slice().ct_eq(provided.as_slice()))
}

fn is_desktop_origin(url: &url::Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

fn is_local_browser_host(host: Option<&str>) -> bool {
    matches!(host, Some("localhost" | "127.0.0.1" | "::1" | "ide.local"))
}

fn allowed_cors_origin(origin: &str, allowed: &[String]) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if is_desktop_origin(&url) {
        return true;
    }
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    is_local_browser_host(url.host_str())
        || allowed
            .iter()
            .any(|candidate| candidate == "*" || candidate == origin)
}

fn allowed_http_origin(origin: &str, bind_host: &str, allowed: &[String]) -> bool {
    if !allowed_cors_origin(origin, allowed) {
        return false;
    }
    if is_loopback_hostname(bind_host) {
        return true;
    }
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    is_desktop_origin(&url)
        || url.scheme() != "http"
        || url.host_str().is_some_and(is_loopback_hostname)
}

fn allowed_websocket_origin(
    origin: Option<&str>,
    request_host: Option<&str>,
    allowed: &[String],
) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if is_desktop_origin(&url) {
        return true;
    }
    if url.scheme() != "http" && url.scheme() != "https" {
        return false;
    }
    if is_local_browser_host(url.host_str()) {
        return true;
    }
    allowed
        .iter()
        .any(|candidate| candidate == "*" || candidate == origin)
        || request_host.is_some_and(|host| url.authority() == host)
}

async fn fallback(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    request: Request<Body>,
) -> Response {
    if uri.path().starts_with("/api/") {
        let Some(principal) = request_principal(&state.runtime, request.headers(), &uri, None)
        else {
            return unauthorized();
        };
        if !principal.can_admin {
            return scope_denied("route requires admin capability");
        }
        return json_response(
            StatusCode::NOT_FOUND,
            json!({ "error": { "code": "NOT_FOUND", "message": format!("no route {}", uri.path()), "details": {} } }),
        );
    }
    if method == Method::GET
        && let Some(root) = state.runtime.config.static_dir.as_deref()
        && let Some(response) = serve_static(root, uri.path(), request.headers()).await
    {
        return response;
    }
    json_response(
        StatusCode::NOT_FOUND,
        json!({ "error": { "code": "NOT_FOUND", "message": format!("no route {}", uri.path()), "details": {} } }),
    )
}

async fn serve_static(root: &Path, pathname: &str, headers: &HeaderMap) -> Option<Response> {
    let relative = if pathname == "/" {
        "index.html"
    } else {
        pathname.trim_start_matches('/')
    };
    let canonical_root = root.canonicalize().ok()?;
    let candidate = canonical_root.join(relative);
    let mut path = candidate
        .canonicalize()
        .ok()
        .filter(|path| path.starts_with(&canonical_root));
    if path.as_ref().is_none_or(|path| !path.is_file()) {
        path = Some(canonical_root.join("index.html"));
    }
    let path = path?.canonicalize().ok()?;
    if !path.starts_with(&canonical_root) || !path.is_file() {
        return None;
    }
    let accept = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let (served, encoding) =
        if accepts_encoding(accept, "br") && compressed_path(&path, "br").is_file() {
            (compressed_path(&path, "br"), Some("br"))
        } else if accepts_encoding(accept, "gzip") && compressed_path(&path, "gz").is_file() {
            (compressed_path(&path, "gz"), Some("gzip"))
        } else {
            (path.clone(), None)
        };
    let bytes = tokio::fs::read(&served).await.ok()?;
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(
            mime_guess::from_path(&path)
                .first_or_octet_stream()
                .as_ref(),
        )
        .ok()?,
    );
    let immutable = path
        .strip_prefix(&canonical_root)
        .ok()
        .and_then(|relative| relative.to_str())
        .is_some_and(|relative| relative.starts_with("assets/") && hashed_asset_name(relative));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    if let Some(encoding) = encoding {
        response
            .headers_mut()
            .insert(header::CONTENT_ENCODING, HeaderValue::from_static(encoding));
    }
    Some(response)
}

fn accepts_encoding(header: &str, encoding: &str) -> bool {
    let mut wildcard = None;
    for entry in header.split(',') {
        let mut parts = entry.trim().split(';');
        let Some(name) = parts.next().map(str::trim) else {
            continue;
        };
        let mut quality = 1.0_f32;
        for parameter in parts {
            if let Some(value) = parameter.trim().strip_prefix("q=")
                && let Ok(parsed) = value.parse::<f32>()
            {
                quality = parsed.clamp(0.0, 1.0);
            }
        }
        if name.eq_ignore_ascii_case(encoding) {
            return quality > 0.0;
        }
        if name == "*" {
            wildcard = Some(quality);
        }
    }
    wildcard.is_some_and(|quality| quality > 0.0)
}

fn hashed_asset_name(relative: &str) -> bool {
    let Some(stem) = Path::new(relative)
        .file_stem()
        .and_then(|value| value.to_str())
    else {
        return false;
    };
    stem.rsplit_once('-').is_some_and(|(_, hash)| {
        hash.len() >= 8
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    })
}

fn compressed_path(path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}.{}", path.display(), suffix))
}

fn runtime_error(error: RuntimeError) -> Response {
    let status = StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::BAD_REQUEST);
    json_response(
        status,
        json!({
            "error": {
                "code": error.wire_code(),
                "message": error.to_string(),
                "details": {},
            }
        }),
    )
}

fn device_error(error: DeviceAuthError, fallback: StatusCode, code: &'static str) -> Response {
    let (status, code) = match error {
        DeviceAuthError::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "RATE_LIMITED"),
        _ => (fallback, code),
    };
    json_response(
        status,
        json!({ "error": { "code": code, "message": error.to_string(), "details": {} } }),
    )
}

fn scope_denied(message: &str) -> Response {
    json_response(
        StatusCode::FORBIDDEN,
        json!({ "error": { "code": "SCOPE_DENIED", "message": message, "details": {} } }),
    )
}

fn unauthorized() -> Response {
    json_response(
        StatusCode::UNAUTHORIZED,
        json!({ "error": { "code": "UNAUTHORIZED", "message": "host token required", "details": {} } }),
    )
}

fn json_response(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

async fn send_json<T: serde::Serialize>(
    sender: &mut SplitSink<WebSocket, Message>,
    value: &T,
) -> Result<(), axum::Error> {
    let encoded = serde_json::to_string(value).map_err(axum::Error::new)?;
    sender.send(Message::Text(encoded.into())).await
}

async fn close_socket(
    sender: &mut SplitSink<WebSocket, Message>,
    code: u16,
    reason: &'static str,
) -> Result<(), axum::Error> {
    sender
        .send(Message::Close(Some(axum::extract::ws::CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await
}

fn is_realtime_op(operation: &str) -> bool {
    matches!(
        operation,
        "terminal:write"
            | "terminal:writeBinary"
            | "terminal:resize"
            | "terminal:ready"
            | "terminal:detach"
            | "terminal:attach"
    )
}

fn terminal_flow_limit() -> usize {
    std::env::var("YAADE_TERMINAL_UNACKNOWLEDGED_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value >= 64 * 1024)
        .unwrap_or(8 * 1024 * 1024)
}

struct TerminalFlow {
    acknowledged: u64,
    outstanding: usize,
    frames: VecDeque<(u64, usize)>,
}

impl TerminalFlow {
    fn new(acknowledged: u64) -> Self {
        Self {
            acknowledged,
            outstanding: 0,
            frames: VecDeque::new(),
        }
    }

    fn reserve(&mut self, sequence: u64, bytes: usize, limit: usize) -> bool {
        if self.outstanding.saturating_add(bytes) > limit {
            return false;
        }
        self.outstanding += bytes;
        self.frames.push_back((sequence, bytes));
        true
    }

    fn acknowledge(&mut self, sequence: u64) {
        self.acknowledged = self.acknowledged.max(sequence);
        while self
            .frames
            .front()
            .is_some_and(|(frame, _)| *frame <= self.acknowledged)
        {
            if let Some((_, bytes)) = self.frames.pop_front() {
                self.outstanding = self.outstanding.saturating_sub(bytes);
            }
        }
    }
}

fn write_runtime_manifest(runtime: &HostRuntime, port: u16) -> std::io::Result<()> {
    let target = runtime.config.data_dir.join("runtime.json");
    let temporary = runtime
        .config
        .data_dir
        .join(format!("runtime.json.{}.tmp", std::process::id()));
    let body = serde_json::to_vec(&json!({
        "schemaVersion": 1,
        "serverId": runtime.identity.server_id,
        "serverEpoch": runtime.identity.server_epoch,
        "pid": std::process::id(),
        "processIdentity": capture_process_identity(std::process::id()),
        "host": "127.0.0.1",
        "port": port,
        "startedAt": runtime.identity.started_at,
    }))?;
    std::fs::write(&temporary, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(temporary, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_comparison_requires_an_exact_value() {
        assert!(tokens_equal("secret", "secret"));
        assert!(!tokens_equal("secret", "secreT"));
        assert!(!tokens_equal("secret", "short"));
    }

    #[test]
    fn encoding_quality_zero_is_rejected() {
        assert!(!accepts_encoding("br;q=0, gzip;q=0.5", "br"));
        assert!(accepts_encoding("br;q=0, gzip;q=0.5", "gzip"));
        assert!(accepts_encoding("*;q=1", "br"));
    }

    #[test]
    fn desktop_and_loopback_origins_are_allowed() {
        assert!(allowed_cors_origin("tauri://localhost", &[]));
        assert!(allowed_cors_origin("http://127.0.0.1:4747", &[]));
        assert!(!allowed_cors_origin("file:///tmp/index.html", &[]));
    }
}
