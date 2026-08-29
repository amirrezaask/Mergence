#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{Read as _, Write as _},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
    time::Duration,
};

use tauri_plugin_shell::ShellExt as _;

const DEFAULT_SERVER_ADDRESS: SocketAddr =
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 7774));

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if default_server_is_running() {
                    return;
                }
                let command = match handle.shell().sidecar("yaade") {
                    Ok(command) => {
                        command.args(["install", "--host", "127.0.0.1", "--port", "7774"])
                    }
                    Err(error) => {
                        eprintln!("[yaade-desktop] could not locate server sidecar: {error}");
                        return;
                    }
                };
                match command.output().await {
                    Ok(output)
                        if output.status.success()
                            && String::from_utf8_lossy(&output.stdout)
                                .contains("\"running\":true") => {}
                    Ok(output) => eprintln!(
                        "[yaade-desktop] could not start server service: {} {}",
                        String::from_utf8_lossy(&output.stderr).trim(),
                        String::from_utf8_lossy(&output.stdout).trim()
                    ),
                    Err(error) => {
                        eprintln!("[yaade-desktop] could not start server service: {error}");
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not run YAADE desktop");
}

fn default_server_is_running() -> bool {
    let Ok(mut stream) =
        TcpStream::connect_timeout(&DEFAULT_SERVER_ADDRESS, Duration::from_millis(300))
    else {
        return false;
    };
    let timeout = Some(Duration::from_millis(500));
    if stream.set_read_timeout(timeout).is_err() || stream.set_write_timeout(timeout).is_err() {
        return false;
    }
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:7774\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    stream.read_to_string(&mut response).is_ok() && response_is_healthy(&response)
}

fn response_is_healthy(response: &str) -> bool {
    response.starts_with("HTTP/1.1 200") && response.contains("\"status\":\"ok\"")
}

#[cfg(test)]
mod tests {
    use super::response_is_healthy;

    #[test]
    fn recognizes_only_successful_yaade_health_responses() {
        assert!(response_is_healthy(
            "HTTP/1.1 200 OK\r\n\r\n{\"status\":\"ok\"}"
        ));
        assert!(!response_is_healthy("HTTP/1.1 200 OK\r\n\r\nready"));
        assert!(!response_is_healthy(
            "HTTP/1.1 503 Service Unavailable\r\n\r\n{\"status\":\"ok\"}"
        ));
    }
}
