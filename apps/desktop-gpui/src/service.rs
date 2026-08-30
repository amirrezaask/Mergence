use std::{
    io::{Read as _, Write as _},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
    process::{Command, Stdio},
    time::Duration,
};

const DEFAULT_SERVER_ADDRESS: SocketAddr =
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 7774));

pub fn ensure_default_host() {
    std::thread::spawn(|| {
        if default_server_is_running() {
            return;
        }
        let server = std::env::var_os("YAADE_SERVER_BIN")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("yaade"));
        let result = Command::new(server)
            .args(["install", "--host", "127.0.0.1", "--port", "7774"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .status();
        if let Err(error) = result {
            eprintln!("[desktop-gpui] could not start YAADE host service: {error}");
        }
    });
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
    stream.read_to_string(&mut response).is_ok()
        && response.starts_with("HTTP/1.1 200")
        && response.contains("\"status\":\"ok\"")
}

#[cfg(test)]
mod tests {
    use super::default_server_is_running;

    #[test]
    fn health_probe_is_bounded_when_host_is_absent() {
        let _ = default_server_is_running();
    }
}
