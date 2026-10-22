//! CUPS discovery and printing against a mock cupsd.
//!
//! A fake cupsd speaks just enough HTTP+IPP: CUPS-Get-Printers on `/`
//! returns one queue, Print-Job on `/printers/<name>` accepts the
//! document. `PRINTNINJA_CUPS_URL` points the transport at the mock.
//! Env is process-global while tests share threads, so a static mutex
//! serializes the three tests.

use printninja_lib::transport::{cups, PrinterType, RenderedJob, TransportRegistry};
use std::io::{Read, Write};
use std::sync::{Mutex, OnceLock};

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(())).lock().unwrap()
}

fn attr(tag: u8, name: &str, value: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend_from_slice(&(name.len() as u16).to_be_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&(value.len() as u16).to_be_bytes());
    out.extend_from_slice(value);
    out
}

fn attr_enum(name: &str, value: u32) -> Vec<u8> {
    let mut out = vec![0x23];
    out.extend_from_slice(&(name.len() as u16).to_be_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(&4u16.to_be_bytes());
    out.extend_from_slice(&value.to_be_bytes());
    out
}

fn get_printers_body() -> Vec<u8> {
    let mut body = vec![0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01];
    body.push(0x04); // printer group
    body.extend(attr(0x42, "printer-name", b"MockLaser"));
    body.extend(attr(
        0x45,
        "printer-uri",
        b"ipp://127.0.0.1:631/printers/MockLaser",
    ));
    body.extend(attr_int_state());
    body.push(0x03);
    body
}

fn attr_int_state() -> Vec<u8> {
    attr_enum("printer-state", 3)
}

fn ok_body() -> Vec<u8> {
    vec![0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x03]
}

fn err_body(status: u16) -> Vec<u8> {
    vec![
        0x01,
        0x01,
        (status >> 8) as u8,
        status as u8,
        0x00,
        0x00,
        0x00,
        0x01,
        0x03,
    ]
}

/// Serves canned bodies matched by request path. Returns the base URL
/// for PRINTNINJA_CUPS_URL.
fn mock_cupsd(routes: Vec<(String, Vec<u8>)>) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind mock cupsd");
    let addr = listener.local_addr().expect("mock address");
    std::thread::spawn(move || {
        for stream in listener.incoming().take(routes.len()) {
            let Ok(mut stream) = stream else {
                return;
            };
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(10)))
                .ok();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 8192];
            let (request_path, want) = loop {
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buf[..pos]);
                    let request_path = head
                        .lines()
                        .next()
                        .unwrap_or("")
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let cl = head.to_ascii_lowercase();
                    let cl = cl
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    break (request_path, pos + 4 + cl);
                }
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break ("/".to_string(), buf.len()),
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            };
            while buf.len() < want {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
            let body = routes
                .iter()
                .find(|(path, _)| *path == request_path)
                .map(|(_, body)| body.clone())
                .unwrap_or_else(|| err_body(0x0400));
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/ipp\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&body);
        }
    });
    format!("http://127.0.0.1:{}", addr.port())
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn cups_lists_queues_as_system_printers() {
    let _guard = lock();
    let url = mock_cupsd(vec![("/".to_string(), get_printers_body())]);
    std::env::set_var("PRINTNINJA_CUPS_URL", &url);
    let rows = cups::list_blocking();
    std::env::remove_var("PRINTNINJA_CUPS_URL");
    assert_eq!(rows.len(), 1, "one queue from the mock cupsd");
    let row = &rows[0];
    assert_eq!(row.name, "MockLaser");
    assert_eq!(row.printer_type, PrinterType::System);
    assert_eq!(row.status, "idle");
    assert!(
        row.address.ends_with("/printers/MockLaser"),
        "address carries the queue URI: {}",
        row.address
    );
}

#[test]
#[cfg_attr(
    windows,
    ignore = "System printers go through WinSpool on Windows, not the CUPS mock"
)]
fn cups_queue_prints_pdf_through_print_job() {
    let _guard = lock();
    let url = mock_cupsd(vec![
        ("/".to_string(), get_printers_body()),
        ("/printers/MockLaser".to_string(), ok_body()),
    ]);
    std::env::set_var("PRINTNINJA_CUPS_URL", &url);
    let created = printninja_lib::transport::create_transport(
        &PrinterType::System,
        "MockLaser",
        &format!("{url}/printers/MockLaser"),
    );
    assert!(created.is_some(), "system resolves on Linux");
    let result = rt().block_on(created.unwrap().send(RenderedJob {
        job_id: "1".into(),
        printer_id: "1".into(),
        data: b"%PDF-1.4 test".to_vec(),
        mime_type: "application/pdf".into(),
        copies: 1,
        language: printninja_lib::transport::PrinterLanguage::Pdf,
    }));
    std::env::remove_var("PRINTNINJA_CUPS_URL");
    result.expect("print-job accepted");
}

#[test]
#[cfg_attr(
    windows,
    ignore = "System printers go through WinSpool on Windows, not the CUPS mock"
)]
fn cups_test_probe_needs_no_print() {
    let _guard = lock();
    // Unknown queue: the mock answers Get-Printer-Attributes with a
    // client error, so the probe fails without having printed anything.
    let url = mock_cupsd(vec![("/".to_string(), err_body(0x0400))]);
    std::env::set_var("PRINTNINJA_CUPS_URL", &url);
    let result = rt().block_on(TransportRegistry::test_printer(
        &PrinterType::System,
        "Ghost",
        "",
    ));
    std::env::remove_var("PRINTNINJA_CUPS_URL");
    let err = result.unwrap_err();
    assert!(err.contains("CUPS"), "probe failure names CUPS: {err}");
}
