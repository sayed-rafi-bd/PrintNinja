use crate::transport::{PrinterInfo, PrinterTransport, RenderedJob};
use async_trait::async_trait;
use std::time::Duration;

/// How long one IPP request may take end to end: connect, upload of the
/// document and the reply. A printer which accepts the connection and then
/// answers nothing used to be reported as an opaque `IPP request failed`,
/// which tells an operator nothing about which of the two happened.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

/// The follow-up query that asks a failed job why it failed. Short: it runs
/// *after* the printer already misbehaved once, and a printer that will not
/// answer it still gets an error built from the job group alone.
const DIAGNOSE_TIMEOUT: Duration = Duration::from_secs(10);

/// IPP (Internet Printing Protocol) sender for Wi-Fi/LAN printers
pub struct IppPrinter {
    pub name: String,
    /// The address exactly as stored in `printers.address`; [`IppPrinter::new`]
    /// parses it into `endpoint`.
    pub address: String,
    endpoint: IppEndpoint,
}

/// Where a job is POSTed and which `printer-uri` to declare, parsed from the
/// stored address. The path used to be hard-coded to port 631 and
/// `/ipp/print` (P7); anything omitted here takes the IPP default.
///
/// Accepted forms:
/// - `192.168.1.10`                  → `http://192.168.1.10:631/ipp/print`
/// - `printer.local:8080/ipp/files` → `http://printer.local:8080/ipp/files`
/// - `ipp://host/ipp/print`          → `http://host:631/ipp/print`
/// - `https://host/printers/1`       → `https://host:443/printers/1`
#[derive(Debug, Clone)]
struct IppEndpoint {
    /// Absolute HTTP(S) URL the document is POSTed to.
    url: String,
    /// `printer-uri` attribute for the request body (an `ipp(s)://` URI).
    printer_uri: String,
}

fn parse_endpoint(address: &str) -> IppEndpoint {
    let address = address.trim();
    let (scheme, rest) = match address.find("://") {
        Some(i) => (&address[..i], &address[i + 3..]),
        None => ("http", address),
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let path = if path.is_empty() { "/ipp/print" } else { path };
    let tls = matches!(scheme, "https" | "ipps");

    // A trailing `:<number>` is a port. This also tells a bare `[::1]` apart
    // from `[::1]:631`; an unbracketed IPv6 address is not supported.
    let has_port = authority
        .rsplit_once(':')
        .is_some_and(|(_, port)| port.parse::<u16>().is_ok());
    let authority = if has_port {
        authority.to_string()
    } else {
        // 631 is the IPP port, not the HTTP one — a bare host means the
        // printer's standard IPP endpoint.
        format!("{authority}:{}", if tls { 443 } else { 631 })
    };

    IppEndpoint {
        url: format!("{}://{authority}{path}", if tls { "https" } else { "http" }),
        printer_uri: format!("{}://{authority}{path}", if tls { "ipps" } else { "ipp" }),
    }
}

impl IppPrinter {
    pub fn new(name: String, address: String) -> Self {
        let endpoint = parse_endpoint(&address);
        Self {
            name,
            address,
            endpoint,
        }
    }

    /// Send an IPP Print-Job request with PDF data
    pub async fn send_pdf(&self, pdf_data: &[u8], copies: u32) -> Result<(), String> {
        use reqwest::Client;

        // Build IPP request body
        let ipp_body = self.build_ipp_request(pdf_data, copies);

        let at = format!("the printer at {}", self.endpoint.url);
        let client = Client::builder()
            .timeout(RESPONSE_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;

        let response = client
            .post(&self.endpoint.url)
            .header("Content-Type", "application/ipp")
            .body(ipp_body)
            .send()
            .await
            .map_err(|e| {
                // reqwest reports a refused connection, a deadline and a
                // server that closes mid-request under similar wording, and
                // the operator needs to tell them apart: the fixes for
                // "wrong address" and "went quiet after accepting" differ.
                if e.is_timeout() {
                    format!(
                        "{at} stopped responding after {}s — check for a paper jam or out-of-paper, or that it is still connected",
                        RESPONSE_TIMEOUT.as_secs()
                    )
                } else if e.is_connect() {
                    format!("Could not reach {at}: {e}")
                } else {
                    // The connection was made and then lost before the reply
                    // came back — a wedged device or one unplugged mid-job.
                    // Calling this "could not reach" sent people to check
                    // the address instead of the printer.
                    format!("{at} stopped responding before the job was accepted")
                }
            })?;

        let http = response.status();
        if !http.is_success() {
            return Err(format!("IPP server returned HTTP {http}"));
        }

        // HTTP 200 is not a printed label. RFC 8010 puts the outcome in the
        // response body — version (2), status code (2), request-id (4) — and
        // this used to be skipped, so a printer that rejected the job counted
        // as printed (P7).
        let body = response
            .bytes()
            .await
            .map_err(|e| format!("IPP response unreadable: {e}"))?;
        let status = parse_status_code(&body)?;
        if status >> 8 != 0 {
            return Err(format!(
                "printer rejected the job: {}",
                describe_status(status)
            ));
        }

        // A *successful* operation status still is not a printed label: RFC
        // 8011 separates the two. A real device reports "paper out", "jam"
        // and "stopped" in the job attributes while the operation itself
        // succeeded, so reading only the status counted every one of those
        // as a good print. The job group is checked now.
        let outcome = parse_job_outcome(&body);
        if !outcome.is_ok() {
            // The job group says the job did not print but almost never says
            // why: the Print-Job reply commonly reports `printer-stopped` for
            // a jam, a paper-out and a pause alike. The actual device
            // condition lives in `printer-state-reasons`, which only
            // Get-Printer-Attributes carries — so ask, on failure only, and
            // fall back to what the job itself said if the printer will not.
            let causes = self.printer_state_reasons().await;
            return Err(match describe_reasons(&causes) {
                Some(sentence) => {
                    format!(
                        "{at} did not print the job: {sentence} [{}]",
                        causes.join(", ")
                    )
                }
                None => format!("{at} did not print the job: {}", outcome.sentence()),
            });
        }
        Ok(())
    }

    /// `printer-state-reasons` from Get-Printer-Attributes: why the printer
    /// itself thinks jobs are not printing.
    ///
    /// A diagnosis, not a prerequisite — it runs only after a job came back
    /// bad, on its own short deadline, and `None` on anything that goes
    /// wrong. A printer that refuses this query still gets a correct (if less
    /// specific) error from the job group.
    async fn printer_state_reasons(&self) -> Vec<String> {
        let body = Self::build_get_printer_attributes(&self.endpoint.printer_uri);
        let mut reasons = Vec::new();
        let Ok(client) = reqwest::Client::builder().timeout(DIAGNOSE_TIMEOUT).build() else {
            return reasons;
        };
        let Ok(response) = client
            .post(&self.endpoint.url)
            .header("Content-Type", "application/ipp")
            .body(body)
            .send()
            .await
        else {
            return reasons;
        };
        if !response.status().is_success() {
            return reasons;
        }
        let Ok(body) = response.bytes().await else {
            return reasons;
        };
        let Ok(status) = parse_status_code(&body) else {
            return reasons;
        };
        if status >> 8 != 0 {
            return reasons;
        }
        for (name, tag, value) in parse_attributes(&body) {
            if name == "printer-state-reasons" && tag == 0x44 {
                reasons.push(String::from_utf8_lossy(&value).into_owned());
            }
        }
        reasons
    }

    fn build_ipp_request(&self, pdf_data: &[u8], copies: u32) -> Vec<u8> {
        // RFC 8011 §3.2.1 Print-Job — minimal but valid attribute set.
        // Previously this only wrote version+operation+request-id+group tag,
        // so every IPP server rejected it (no charset, printer-uri, copies).
        let mut body = Vec::new();

        // IPP version 1.1
        body.extend_from_slice(&[0x01, 0x01]);
        // Operation ID: Print-Job = 0x0002
        body.extend_from_slice(&[0x00, 0x02]);
        // Request ID
        body.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]);

        // Operation attributes group
        body.push(0x01);

        // RFC 8011 requires these three first in order
        Self::push_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
        Self::push_attr(&mut body, 0x48, "attributes-natural-language", b"en");
        Self::push_attr(
            &mut body,
            0x45,
            "printer-uri",
            self.endpoint.printer_uri.as_bytes(),
        );

        // Optional but expected by most servers
        Self::push_attr(&mut body, 0x42, "requesting-user-name", b"PrintNinja");
        Self::push_attr(&mut body, 0x42, "job-name", b"PrintNinja Job");
        Self::push_attr(&mut body, 0x44, "document-format", b"application/pdf");
        if copies > 1 {
            Self::push_integer(&mut body, "copies", copies as i32);
        }
        // ipp-attribute-fidelity = false (boolean 0x22)
        Self::push_attr(&mut body, 0x22, "ipp-attribute-fidelity", &[0x00]);

        // End-of-attributes
        body.push(0x03);

        // Document content follows directly
        body.extend_from_slice(pdf_data);
        body
    }

    fn push_attr(body: &mut Vec<u8>, tag: u8, name: &str, value: &[u8]) {
        body.push(tag);
        body.extend_from_slice(&(name.len() as u16).to_be_bytes());
        body.extend_from_slice(name.as_bytes());
        body.extend_from_slice(&(value.len() as u16).to_be_bytes());
        body.extend_from_slice(value);
    }

    fn push_integer(body: &mut Vec<u8>, name: &str, value: i32) {
        body.push(0x21); // integer
        body.extend_from_slice(&(name.len() as u16).to_be_bytes());
        body.extend_from_slice(name.as_bytes());
        body.extend_from_slice(&4u16.to_be_bytes());
        body.extend_from_slice(&value.to_be_bytes());
    }

    /// RFC 8011 §5.1 Get-Printer-Attributes: how a failed job finds out what
    /// is actually wrong with the device.
    ///
    /// Written for the diagnosis path rather than polled on every print —
    /// printing must not gain a second round trip per job, and nothing here
    /// is needed when the first request already succeeded.
    fn build_get_printer_attributes(printer_uri: &str) -> Vec<u8> {
        let mut body = Vec::new();
        body.extend_from_slice(&[0x01, 0x01]); // IPP 1.1
        body.extend_from_slice(&[0x00, 0x0B]); // Get-Printer-Attributes
        body.extend_from_slice(&[0x00, 0x00, 0x00, 0x01]); // request id
        body.push(0x01); // operation attributes group
        Self::push_attr(&mut body, 0x47, "attributes-charset", b"utf-8");
        Self::push_attr(&mut body, 0x48, "attributes-natural-language", b"en");
        Self::push_attr(&mut body, 0x45, "printer-uri", printer_uri.as_bytes());
        body.push(0x03); // end of attributes
        body
    }
}

#[async_trait]
impl PrinterTransport for IppPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        // mDNS discovery handled by Android NsdManager or system tools
        vec![]
    }

    async fn test(&self) -> Result<(), String> {
        // Send test page
        let test_pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 210 297] >>\nendobj\ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n140\n%%EOF";
        self.send_pdf(test_pdf, 1).await
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_pdf(&job.data, job.copies).await
    }
}

/// The status code from an IPP response body: version (2 bytes), status code
/// (2), request-id (4), then the attribute groups.
fn parse_status_code(body: &[u8]) -> Result<u16, String> {
    if body.len() < 4 {
        return Err(format!(
            "malformed IPP response: {} bytes, need at least 4",
            body.len()
        ));
    }
    // Versions in the wild are 1.0, 1.1, 2.0, 2.1, 2.2. Anything else means
    // this is not an IPP body at all — e.g. a proxy's HTML error page behind
    // a 200.
    if body[0] != 0x01 && body[0] != 0x02 {
        return Err(format!(
            "not an IPP response (starts 0x{:02x}{:02x})",
            body[0], body[1]
        ));
    }
    Ok(u16::from_be_bytes([body[2], body[3]]))
}

/// Human-readable form of an IPP status code, for the error the job records.
/// The common codes are named; the rest fall back to their class (RFC 8011
/// §14.1: 0x04xx client errors, 0x05xx server errors) and the hex value.
fn describe_status(status: u16) -> String {
    let name = match status {
        0x0000 => "successful-ok",
        0x0001 => "successful-ok-ignored-or-substituted-attributes",
        0x0002 => "successful-ok-conflicting-attributes",
        0x0400 => "client-error-bad-request",
        0x0500 => "server-error-internal-error",
        0x0501 => "server-error-operation-not-supported",
        0x0502 => "server-error-service-unavailable",
        0x0503 => "server-error-version-not-supported",
        0x0504 => "server-error-device-error",
        0x0505 => "server-error-temporary-error",
        0x0506 => "server-error-not-accepting-jobs",
        0x0507 => "server-error-busy",
        0x0508 => "server-error-job-canceled",
        _ if status >> 8 == 0x04 => "client-error",
        _ if status >> 8 == 0x05 => "server-error",
        _ => "unexpected status",
    };
    format!("IPP status 0x{status:04x} ({name})")
}

/// What the job group of a Print-Job response said about the submitted job.
///
/// Parsed separately from the operation status, which is what makes the two
/// independently wrong: the operation is about the *request*, the job state
/// about the *print*.
#[derive(Debug, Default)]
struct JobOutcome {
    /// `None` when the response carried no job group at all.
    state: Option<u8>,
    /// `job-state-reasons` keywords, in the order the printer listed them.
    reasons: Vec<String>,
}

impl JobOutcome {
    /// Whether the job was taken. 3 pending, 4 pending-held, 5 processing and
    /// 9 completed all mean yes. 6 processing-stopped, 7 canceled and 8
    /// aborted did not print — however successful the operation status was.
    fn is_ok(&self) -> bool {
        matches!(self.state, None | Some(3) | Some(4) | Some(5) | Some(9))
    }

    /// The sentence to use when the printer gave nothing more specific, i.e.
    /// when Get-Printer-Attributes had no `printer-state-reasons` to offer.
    fn sentence(&self) -> String {
        // The printer's own words beat the state enum: "paused" is the fix,
        // "processing-stopped" is not.
        if let Some(reason) = self
            .reasons
            .iter()
            .find_map(|r| describe_reason(r).map(|detail| (r, detail)))
        {
            // Keep the raw keyword next to the sentence so a support
            // exchange has the actual IPP value, not a paraphrase.
            return format!("{} [{}]", reason.1, self.reasons.join(", "));
        }
        match self.state {
            Some(state) => format!(
                "the printer reported job-state {} ({})",
                state,
                describe_job_state(state)
            ),
            None => "the printer reported no job status".to_string(),
        }
    }
}

/// The job group of a Print-Job response.
fn parse_job_outcome(body: &[u8]) -> JobOutcome {
    let mut outcome = JobOutcome::default();
    for (name, tag, value) in parse_attributes(body) {
        match (name.as_str(), tag) {
            // 0x23 = enum, 0x21 = integer: real devices use both for
            // job-state (RFC 8011 §4.3.8 says enum). Its value is a 4-byte
            // big-endian i32, so reading byte 0 alone yields 0 for every
            // state a printer actually reports.
            ("job-state", 0x21 | 0x23) if value.len() == 4 => {
                let raw = u32::from_be_bytes(value[..4].try_into().unwrap());
                // job-state runs 3..=9 today; anything larger is a vendor
                // extension and must not be mistaken for "completed".
                outcome.state = u8::try_from(raw).ok();
            }
            ("job-state-reasons", 0x44) => {
                outcome
                    .reasons
                    .push(String::from_utf8_lossy(&value).into_owned());
            }
            _ => {}
        }
    }
    outcome
}

/// Every attribute in an IPP response body, as `(name, tag, value)`.
///
/// Walks the groups after the 8-byte header. A repeated value repeats the
/// name as empty (RFC 8010 §3.1.6), so the last name is carried forward and
/// `printer-state-reasons`-style lists collect under one name. Every bound
/// is checked: a truncated or hostile body must not panic the print path.
fn parse_attributes(body: &[u8]) -> Vec<(String, u8, Vec<u8>)> {
    let mut out: Vec<(String, u8, Vec<u8>)> = Vec::new();
    let mut last_name = String::new();
    let mut i = 8; // version (2), status code (2), request-id (4)
    while i < body.len() {
        let tag = body[i];
        // Bytes below 0x10 are delimiters, not value tags: group starts
        // (0x01 operation, 0x02 job, ...) and end-of-attributes (0x03).
        if tag < 0x10 {
            if tag == 0x03 {
                break;
            }
            i += 1;
            continue;
        }
        if i + 3 > body.len() {
            break;
        }
        let name_len = u16::from_be_bytes([body[i + 1], body[i + 2]]) as usize;
        let name_at = i + 3;
        if name_at + name_len + 2 > body.len() {
            break;
        }
        if name_len > 0 {
            last_name = String::from_utf8_lossy(&body[name_at..name_at + name_len]).into_owned();
        }
        let len_at = name_at + name_len;
        let value_len = u16::from_be_bytes([body[len_at], body[len_at + 1]]) as usize;
        let value_at = len_at + 2;
        if value_at + value_len > body.len() {
            break;
        }
        out.push((
            last_name.clone(),
            tag,
            body[value_at..value_at + value_len].to_vec(),
        ));
        i = value_at + value_len;
    }
    out
}

/// RFC 8011 §4.3.8 job-state keywords, for the message when the printer gave
/// no more specific reason.
fn describe_job_state(state: u8) -> &'static str {
    match state {
        3 => "pending",
        4 => "pending-held",
        5 => "processing",
        6 => "processing-stopped",
        7 => "canceled",
        8 => "aborted",
        9 => "completed",
        _ => "unknown",
    }
}

/// Map an IPP reason keyword to the advice an operator needs.
///
/// Serves both `printer-state-reasons` (the device condition: out of paper,
/// jam, offline) and `job-state-reasons` (why the job stopped), because the
/// vocabulary is shared and the printer picks whichever it likes.
///
/// `None` for reasons that carry no specific fix (informational warnings,
/// vendor extensions, `none`); the caller falls back to the state enum.
fn describe_reason(reason: &str) -> Option<String> {
    let reason = reason.trim().to_ascii_lowercase();
    let text = match reason.as_str() {
        "media-empty" | "media-empty-warning" => "it is out of paper",
        "media-jam" | "media-jam-warning" => "there is a paper jam",
        "paused" | "printer-stopped" | "stopped-partly" => "it is paused",
        "offline-report" => "it is offline",
        "toner-empty" | "toner-life-end" | "marker-supply-empty" => {
            "it has run out of toner or ink"
        }
        "toner-low" | "marker-supply-low-warning" => "it is low on toner or ink",
        "output-area-full" => "its output tray is full",
        _ => return None,
    };
    Some(text.to_string())
}

/// Turn a `printer-state-reasons` list into one sentence, if any of it is
/// actionable.
///
/// `none` means the printer reports no fault and explains nothing, so it is
/// dropped; if that leaves nothing the caller falls back to what the job
/// group said, which is always correct even when it is less specific.
fn describe_reasons(reasons: &[String]) -> Option<String> {
    let mut parts: Vec<String> = reasons
        .iter()
        .filter(|r| !r.trim().eq_ignore_ascii_case("none"))
        .filter_map(|r| describe_reason(r))
        .collect();
    parts.dedup();
    (!parts.is_empty()).then(|| parts.join(" and "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(copies: u32) -> Vec<u8> {
        IppPrinter::new("test".into(), "192.168.1.10".into()).build_ipp_request(b"%PDF-1.4", copies)
    }

    #[test]
    fn encodes_version_and_operation() {
        let b = body(1);
        assert_eq!(&b[0..2], &[0x01, 0x01]); // 1.1
        assert_eq!(&b[2..4], &[0x00, 0x02]); // Print-Job
    }

    #[test]
    fn includes_required_attributes() {
        let b = body(1);
        let s = String::from_utf8_lossy(&b);
        assert!(s.contains("attributes-charset"));
        assert!(s.contains("utf-8"));
        assert!(s.contains("attributes-natural-language"));
        assert!(s.contains("printer-uri"));
        assert!(s.contains("ipp://192.168.1.10:631/ipp/print"));
        assert!(s.contains("document-format"));
        assert!(s.contains("application/pdf"));
    }

    #[test]
    fn copies_attribute_only_when_needed() {
        let b1 = body(1);
        let s1 = String::from_utf8_lossy(&b1);
        // copies=1 is the default — omit to avoid surprising servers that treat 1 as explicit
        assert!(!s1.contains("copies"));

        let b2 = body(3);
        let s2 = String::from_utf8_lossy(&b2);
        assert!(s2.contains("copies"));
        // integer value 3 encoded as 4-byte BE
        assert!(b2.windows(4).any(|w| w == 3i32.to_be_bytes()));
    }

    #[test]
    fn ends_with_end_tag_and_document() {
        let pdf = b"%PDF-1.4 fake";
        let b = IppPrinter::new("t".into(), "10.0.0.1".into()).build_ipp_request(pdf, 1);
        // Find end-of-attributes 0x03 before the PDF starts
        let pos = b.iter().position(|&x| x == 0x03).expect("end tag");
        assert_eq!(&b[pos + 1..pos + 1 + pdf.len()], pdf);
    }

    #[test]
    fn operation_attributes_group_present() {
        let b = body(1);
        // After request-id (8 bytes), group tag 0x01
        assert_eq!(b[8], 0x01);
    }

    // ── P7: configurable endpoint ────────────────────────────────

    #[test]
    fn a_bare_host_keeps_the_ipp_defaults() {
        let p = IppPrinter::new("t".into(), "192.168.1.10".into());
        assert_eq!(p.endpoint.url, "http://192.168.1.10:631/ipp/print");
        assert_eq!(p.endpoint.printer_uri, "ipp://192.168.1.10:631/ipp/print");
    }

    #[test]
    fn port_and_path_come_from_the_address() {
        let p = IppPrinter::new("t".into(), "printer.local:8080/ipp/files".into());
        assert_eq!(p.endpoint.url, "http://printer.local:8080/ipp/files");
        assert_eq!(p.endpoint.printer_uri, "ipp://printer.local:8080/ipp/files");
    }

    #[test]
    fn an_ipp_scheme_address_is_posted_over_http() {
        let p = IppPrinter::new("t".into(), "ipp://host/ipp/print".into());
        assert_eq!(p.endpoint.url, "http://host:631/ipp/print");
        assert_eq!(p.endpoint.printer_uri, "ipp://host:631/ipp/print");
    }

    #[test]
    fn an_https_address_keeps_tls_and_uses_the_https_port() {
        let p = IppPrinter::new("t".into(), "https://host/printers/1".into());
        assert_eq!(p.endpoint.url, "https://host:443/printers/1");
        assert_eq!(p.endpoint.printer_uri, "ipps://host:443/printers/1");
    }

    // ── P7: the response status, not the HTTP status, decides ──────

    #[test]
    fn status_code_is_read_from_the_body() {
        // version 1.1, status 0x0502, request-id 1
        let body = [0x01, 0x01, 0x05, 0x02, 0x00, 0x00, 0x00, 0x01];
        assert_eq!(parse_status_code(&body).unwrap(), 0x0502);
    }

    #[test]
    fn a_body_that_is_not_ipp_is_refused() {
        assert!(parse_status_code(b"<html>maintenance page</html>").is_err());
        assert!(parse_status_code(&[0x01, 0x01]).is_err());
    }

    #[test]
    fn statuses_are_described_with_class_and_hex() {
        assert!(describe_status(0x0502).contains("0x0502"));
        assert!(describe_status(0x0502).contains("service-unavailable"));
        // Unknown codes still name their class and value.
        assert!(describe_status(0x040f).contains("0x040f"));
        assert!(describe_status(0x040f).contains("client-error"));
        assert!(describe_status(0x05ff).contains("server-error"));
    }

    // ── job-group parsing ────────────────────────────────────────────

    fn name(body: &mut Vec<u8>, n: &str) {
        body.extend_from_slice(&(n.len() as u16).to_be_bytes());
        body.extend_from_slice(n.as_bytes());
    }

    /// A Print-Job response carrying a job group shaped the way real
    /// devices shape it: `job-state` as an enum in four big-endian bytes,
    /// `job-state-reasons` as a list whose later entries repeat an empty
    /// name (RFC 8010 §3.1.6).
    fn job_group(state: Option<u8>, reasons: &[&str]) -> Vec<u8> {
        let mut b = vec![0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01];
        b.push(0x02); // job attributes group
        if let Some(state) = state {
            b.push(0x23); // enum — not 0x21 integer, which is what we first tried
            name(&mut b, "job-state");
            b.extend_from_slice(&4u16.to_be_bytes());
            b.extend_from_slice(&(i32::from(state)).to_be_bytes());
        }
        for (i, reason) in reasons.iter().enumerate() {
            b.push(0x44); // textWithoutLanguage
            name(&mut b, if i == 0 { "job-state-reasons" } else { "" });
            b.extend_from_slice(&(reason.len() as u16).to_be_bytes());
            b.extend_from_slice(reason.as_bytes());
        }
        b.push(0x03); // end of attributes
        b
    }

    #[test]
    fn a_completed_job_is_a_success() {
        let outcome = parse_job_outcome(&job_group(Some(9), &["job-completed-successfully"]));
        assert!(outcome.is_ok());
    }

    #[test]
    fn a_pending_job_is_a_success() {
        for state in [3, 4, 5] {
            assert!(
                parse_job_outcome(&job_group(Some(state), &[])).is_ok(),
                "{state}"
            );
        }
    }

    #[test]
    fn a_stopped_job_is_a_failure_even_with_a_successful_operation_status() {
        let outcome = parse_job_outcome(&job_group(Some(6), &["printer-stopped"]));
        assert!(!outcome.is_ok());
        let sentence = outcome.sentence();
        assert!(sentence.contains("paused"), "{sentence}");
        // The raw keyword stays attached for a support exchange.
        assert!(sentence.contains("printer-stopped"), "{sentence}");
    }

    #[test]
    fn canceled_and_aborted_jobs_are_failures() {
        for state in [7, 8] {
            assert!(
                !parse_job_outcome(&job_group(Some(state), &[])).is_ok(),
                "{state}"
            );
        }
    }

    #[test]
    fn the_job_state_is_read_as_four_big_endian_bytes() {
        // Regression: reading byte 0 alone yields 0 for every state a
        // printer actually reports, which is neither ok nor explained.
        let outcome = parse_job_outcome(&job_group(Some(9), &[]));
        assert_eq!(outcome.state, Some(9));
        assert!(outcome.is_ok());
    }

    #[test]
    fn a_response_without_a_job_group_is_not_a_failure() {
        // RFC 8011 lets a server omit it; the operation status already said
        // the job was accepted, so refusing here would break real printers.
        let mut b = vec![0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x03];
        b[8] = 0x03;
        assert!(parse_job_outcome(&b).is_ok());
    }

    #[test]
    fn every_prefix_of_a_body_parses_without_panicking() {
        // The bounds checks are load-bearing: this runs on bytes from a
        // device on the network, mid-print.
        let full = job_group(Some(6), &["media-jam", "none"]);
        for cut in 0..=full.len() {
            let _ = parse_job_outcome(&full[..cut]);
            let _ = parse_attributes(&full[..cut]);
        }
        let _ = parse_job_outcome(b"not ipp at all");
        let _ = parse_attributes(b"\x00");
    }

    // ── reason vocabulary ────────────────────────────────────────────

    #[test]
    fn device_conditions_become_advice() {
        let cases = [
            ("media-empty", "out of paper"),
            ("media-jam", "paper jam"),
            ("offline-report", "offline"),
            ("paused", "paused"),
            ("toner-empty", "toner or ink"),
        ];
        for (keyword, expected) in cases {
            let text = describe_reasons(&[keyword.to_string()])
                .unwrap_or_else(|| panic!("{keyword} produced no advice"));
            assert!(text.contains(expected), "{keyword} -> {text}");
        }
    }

    #[test]
    fn a_healthy_printer_gives_no_advice() {
        // `none` means no fault; treating it as an explanation would turn
        // every healthy diagnosis into an error message.
        assert_eq!(describe_reasons(&["none".to_string()]), None);
        assert_eq!(describe_reasons(&[]), None);
        // Vendor extensions we do not know still leave the caller free to
        // fall back to the job group's own wording.
        assert_eq!(describe_reasons(&["vendor-mystery".to_string()]), None);
    }

    #[test]
    fn several_faults_are_reported_together() {
        let text = describe_reasons(&["media-empty".to_string(), "offline-report".to_string()])
            .expect("actionable");
        assert!(text.contains("out of paper"), "{text}");
        assert!(text.contains("offline"), "{text}");
        // Not "out of paper and out of paper".
        assert!(!text.contains("out of paper and out of paper"), "{text}");
    }

    #[test]
    fn a_reason_beside_none_is_still_honoured() {
        let text = describe_reasons(&["none".to_string(), "media-jam".to_string()])
            .expect("the jam is actionable");
        assert!(text.contains("paper jam"), "{text}");
    }
}
