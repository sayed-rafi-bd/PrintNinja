//! CUPS system printers, spoken to over IPP: no libcups, no `lpstat`.
//!
//! cupsd serves IPP on localhost:631. CUPS-Get-Printers (`0x4002`)
//! lists the queues; Print-Job against a queue URI prints to them
//! through the same raw IPP framing as [`IppPrinter`]. A missing cupsd
//! is normal (no daemon, no queues) and yields an empty list, not an
//! error — discovery must never fail the Setup page.

use async_trait::async_trait;
use std::time::Duration;

use super::{
    ipp::{parse_attributes, parse_status_code, IppPrinter},
    PrinterInfo, PrinterLanguage, PrinterTransport, PrinterType, RenderedJob,
};

/// How long discovery and the test probe wait for cupsd. Short: a
/// missing daemon refuses fast, and Setup must not hang on a wedged one.
const CUPS_TIMEOUT: Duration = Duration::from_secs(3);

fn cups_base_url() -> String {
    std::env::var("PRINTNINJA_CUPS_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:631".to_string())
}

fn queue_uri(name: &str) -> String {
    format!("{}/printers/{name}", cups_base_url())
}

/// One CUPS queue as IPP knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CupsQueue {
    pub name: String,
    pub uri: String,
    /// CUPS `printer-state`: 3 idle, 4 processing, 5 stopped.
    pub state: Option<u8>,
}

pub fn printer_state_word(state: Option<u8>) -> &'static str {
    match state {
        Some(3) => "idle",
        Some(4) => "processing",
        Some(5) => "stopped",
        _ => "unknown",
    }
}

/// CUPS-Get-Printers request (`0x4002`): charset + language only.
/// Queue selection attributes are optional; stock cupsd answers the
/// bare form with every destination.
fn build_cups_get_printers() -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(&[0x01, 0x01]); // IPP 1.1
    body.extend_from_slice(&[0x40, 0x02]); // CUPS-Get-Printers
    body.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]); // request id
    body.push(0x01); // operation attributes group
    IppPrinter::push_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
    IppPrinter::push_attr(&mut body, 0x48, "attributes-natural-language", b"en");
    body.push(0x03); // end of attributes
    body
}

/// Split a CUPS-Get-Printers body into one record per queue.
///
/// The response carries a printer group (`0x04`) per queue, but groups
/// flatten out in [`parse_attributes`] — so records restart at each
/// `printer-name`, which every CUPS printer group carries first.
pub fn parse_cups_printers(body: &[u8]) -> Result<Vec<CupsQueue>, String> {
    let status = parse_status_code(body)?;
    if status != 0 {
        return Err(format!("CUPS refused the request: status 0x{status:04x}"));
    }
    let mut queues = Vec::new();
    let mut name: Option<String> = None;
    let mut uri: Option<String> = None;
    let mut state: Option<u8> = None;
    let flush = |name: &mut Option<String>,
                 uri: &mut Option<String>,
                 state: &mut Option<u8>,
                 queues: &mut Vec<CupsQueue>| {
        if let (Some(n), Some(u)) = (name.take(), uri.take()) {
            queues.push(CupsQueue {
                name: n,
                uri: u,
                state: state.take(),
            });
        } else {
            name.take();
            uri.take();
            state.take();
        }
    };
    for (attr, tag, value) in parse_attributes(body) {
        match attr.as_str() {
            "printer-name" if tag == 0x42 || tag == 0x45 => {
                if name.is_some() {
                    flush(&mut name, &mut uri, &mut state, &mut queues);
                }
                name = Some(String::from_utf8_lossy(&value).into_owned());
            }
            "printer-uri" if tag == 0x45 => {
                uri = Some(String::from_utf8_lossy(&value).into_owned());
            }
            "printer-state" if (tag == 0x21 || tag == 0x23) && value.len() == 4 => {
                let raw = u32::from_be_bytes(value[..4].try_into().unwrap());
                state = u8::try_from(raw).ok();
            }
            _ => {}
        }
    }
    flush(&mut name, &mut uri, &mut state, &mut queues);
    Ok(queues)
}

async fn post_ipp(path: &str, body: Vec<u8>) -> Result<Vec<u8>, String> {
    let url = format!("{}{path}", cups_base_url());
    let client = reqwest::Client::builder()
        .timeout(CUPS_TIMEOUT)
        .build()
        .map_err(|e| format!("CUPS client failed: {e}"))?;
    let response = client
        .post(&url)
        .header("Content-Type", "application/ipp")
        .body(body)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                format!("no CUPS daemon at {url}: {e}")
            } else {
                format!("CUPS request failed: {e}")
            }
        })?;
    if !response.status().is_success() {
        return Err(format!("CUPS returned HTTP {}", response.status()));
    }
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("CUPS response unreadable: {e}"))
}

/// Every CUPS queue as Setup rows. Never fails: no daemon means no
/// queues, and a malformed reply is logged and skipped, not fatal.
pub async fn list_cups_printers() -> Vec<PrinterInfo> {
    let body = match post_ipp("/", build_cups_get_printers()).await {
        Ok(body) => body,
        Err(e) => {
            tracing::debug!("{e}");
            return Vec::new();
        }
    };
    match parse_cups_printers(&body) {
        Ok(queues) => queues
            .into_iter()
            .map(|q| PrinterInfo {
                id: q.name.clone(),
                name: q.name,
                address: q.uri,
                printer_type: PrinterType::System,
                language: PrinterLanguage::Pdf,
                status: printer_state_word(q.state).to_string(),
            })
            .collect(),
        Err(e) => {
            tracing::debug!("CUPS reply unusable: {e}");
            Vec::new()
        }
    }
}

/// A CUPS queue as a [`PrinterTransport`]: discovery lists it, the test
/// probe reads its attributes without printing, and sending is an IPP
/// Print-Job against the queue URI — the same bytes path as a network
/// IPP printer, which is exactly what CUPS is.
/// Blocking twin for the synchronous `enumerate_system_printers`
/// command: spins a throwaway current-thread runtime, so discovery
/// never needs an async context at the call site.
pub fn list_blocking() -> Vec<PrinterInfo> {
    match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt.block_on(list_cups_printers()),
        Err(e) => {
            tracing::debug!("CUPS runtime failed: {e}");
            Vec::new()
        }
    }
}

pub struct CupsPrinter {
    name: String,
    uri: String,
}

impl CupsPrinter {
    pub fn new(name: String, address: String) -> Self {
        let uri = if address.trim().is_empty() {
            queue_uri(&name)
        } else {
            address
        };
        Self { name, uri }
    }

    fn ipp(&self) -> IppPrinter {
        IppPrinter::new(self.name.clone(), self.uri.clone())
    }
}

#[async_trait]
impl PrinterTransport for CupsPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        list_cups_printers().await
    }

    async fn test(&self) -> Result<(), String> {
        let body = post_ipp(
            "/",
            IppPrinter::build_get_printer_attributes(&ipp_uri(&self.uri)),
        )
        .await?;
        let status = parse_status_code(&body)?;
        if status == 0 {
            Ok(())
        } else {
            Err(format!(
                "CUPS queue refused the probe: status 0x{status:04x}"
            ))
        }
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.ipp().send(job).await
    }
}

/// The `ipp://` form of a queue's HTTP URI, for the printer-uri attribute.
fn ipp_uri(http_uri: &str) -> String {
    if let Some(rest) = http_uri.strip_prefix("http://") {
        return format!("ipp://{rest}");
    }
    if let Some(rest) = http_uri.strip_prefix("https://") {
        return format!("ipps://{rest}");
    }
    http_uri.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attr(tag: u8, name: &str, value: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        out.extend_from_slice(&(name.len() as u16).to_be_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&(value.len() as u16).to_be_bytes());
        out.extend_from_slice(value);
        out
    }

    fn attr_int(name: &str, value: u32) -> Vec<u8> {
        let mut out = vec![0x23]; // enum
        out.extend_from_slice(&(name.len() as u16).to_be_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(&4u16.to_be_bytes());
        out.extend_from_slice(&value.to_be_bytes());
        out
    }

    fn get_printers_response() -> Vec<u8> {
        let mut body = vec![0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01];
        for (name, uri, state) in [
            ("DeskJet", "ipp://localhost:631/printers/DeskJet", 3u32),
            ("Label", "ipp://localhost:631/printers/Label", 5u32),
        ] {
            body.push(0x04); // printer group
            body.extend(attr(0x42, "printer-name", name.as_bytes()));
            body.extend(attr(0x45, "printer-uri", uri.as_bytes()));
            body.extend(attr(0x44, "printer-location", b"office"));
            body.extend(attr_int("printer-state", state));
        }
        body.push(0x03);
        body
    }

    #[test]
    fn request_encodes_cups_get_printers() {
        let body = build_cups_get_printers();
        assert_eq!(&body[..8], &[0x01, 0x01, 0x40, 0x02, 0, 0, 0, 1]);
        assert!(body
            .windows(b"attributes-charset".len())
            .any(|w| w == b"attributes-charset"));
        assert_eq!(*body.last().unwrap(), 0x03);
    }

    #[test]
    fn response_splits_into_one_record_per_queue() {
        let queues = parse_cups_printers(&get_printers_response()).expect("parses");
        assert_eq!(queues.len(), 2);
        assert_eq!(queues[0].name, "DeskJet");
        assert_eq!(queues[0].uri, "ipp://localhost:631/printers/DeskJet");
        assert_eq!(queues[0].state, Some(3));
        assert_eq!(printer_state_word(queues[0].state), "idle");
        assert_eq!(queues[1].name, "Label");
        assert_eq!(queues[1].state, Some(5));
        assert_eq!(printer_state_word(queues[1].state), "stopped");
        assert_eq!(printer_state_word(None), "unknown");
    }

    #[test]
    fn non_ok_status_is_an_error_not_queues() {
        let mut body = vec![0x01, 0x01, 0x05, 0x01, 0, 0, 0, 1, 0x03];
        assert!(parse_cups_printers(&body).is_err());
        body[2] = 0x04;
        body[3] = 0x00;
        assert!(parse_cups_printers(&body).is_err());
    }

    #[test]
    fn ipp_uri_rewrites_the_scheme_only() {
        assert_eq!(
            ipp_uri("http://localhost:631/printers/A"),
            "ipp://localhost:631/printers/A"
        );
        assert_eq!(
            ipp_uri("https://print.local:631/printers/A"),
            "ipps://print.local:631/printers/A"
        );
        assert_eq!(ipp_uri("ipp://x/printers/A"), "ipp://x/printers/A");
    }
}
