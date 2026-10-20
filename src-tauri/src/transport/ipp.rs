use crate::transport::{PrinterInfo, PrinterTransport, RenderedJob};
use async_trait::async_trait;
use std::time::Duration;

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

        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;

        let response = client
            .post(&self.endpoint.url)
            .header("Content-Type", "application/ipp")
            .body(ipp_body)
            .send()
            .await
            .map_err(|e| format!("IPP request failed: {}", e))?;

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
        if status >> 8 == 0 {
            Ok(())
        } else {
            Err(format!(
                "printer rejected the job: {}",
                describe_status(status)
            ))
        }
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
}
