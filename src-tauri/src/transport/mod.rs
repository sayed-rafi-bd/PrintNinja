use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrinterInfo {
    pub id: String,
    pub name: String,
    pub address: String,
    pub printer_type: PrinterType,
    pub language: PrinterLanguage,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum PrinterType {
    Ipp,
    RawTcp,
    Usb,
    Bluetooth,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PrinterLanguage {
    Pdf,
    Escpos,
    Tspl,
    Zpl,
    Cpcl,
    Raster,
}

#[derive(Debug, Clone)]
pub struct RenderedJob {
    pub job_id: String,
    pub printer_id: String,
    pub data: Vec<u8>,
    pub mime_type: String,
    pub copies: u32,
}

#[async_trait]
pub trait PrinterTransport: Send + Sync {
    /// Find printers this transport can reach.
    ///
    /// Takes `&self` deliberately. Without it the method has no `self`
    /// parameter at all, so it is not dispatchable through `dyn
    /// PrinterTransport` and a registry can only ever call whichever one
    /// implementation it names statically. That made per-printer transports
    /// — a USB thermal head sitting next to an IPP office printer —
    /// impossible to represent.
    async fn discover(&self) -> Vec<PrinterInfo>;

    async fn test(&self) -> Result<(), String>;

    async fn send(&self, job: RenderedJob) -> Result<(), String>;
}

pub mod android_bridge;
pub mod escpos;
pub mod ipp;
pub mod label_langs;
pub mod raw_tcp;
pub mod windows_bluetooth;
pub mod windows_spooler;
pub mod windows_usb;

/// Parse a stored printer type id, e.g. from `printers.printer_type`.
impl std::str::FromStr for PrinterType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "ipp" => Ok(PrinterType::Ipp),
            "raw_tcp" | "rawtcp" | "tcp" | "network" => Ok(PrinterType::RawTcp),
            "usb" => Ok(PrinterType::Usb),
            "bluetooth" | "bt" => Ok(PrinterType::Bluetooth),
            "system" | "spooler" | "windows" => Ok(PrinterType::System),
            other => Err(format!("Unknown printer type `{other}`")),
        }
    }
}

impl std::fmt::Display for PrinterType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            PrinterType::Ipp => "ipp",
            PrinterType::RawTcp => "raw_tcp",
            PrinterType::Usb => "usb",
            PrinterType::Bluetooth => "bluetooth",
            PrinterType::System => "system",
        };
        f.write_str(s)
    }
}

/// Build a transport for a stored printer row.
///
/// One function so every caller (Tauri commands, REST API routes, deep
/// links) resolves transports identically. `None` means the transport has no
/// implementation on this platform — never a silent success.
pub fn create_transport(
    printer_type: &PrinterType,
    name: &str,
    address: &str,
) -> Option<Box<dyn PrinterTransport>> {
    match printer_type {
        PrinterType::Ipp => Some(Box::new(ipp::IppPrinter::new(
            name.to_string(),
            address.to_string(),
        ))),
        PrinterType::RawTcp => Some(Box::new(raw_tcp::RawTcpPrinter::new(
            name.to_string(),
            address.to_string(),
        ))),
        #[cfg(windows)]
        PrinterType::System => Some(Box::new(windows_spooler::WindowsSpooler::new(
            name.to_string(),
        ))),
        #[cfg(windows)]
        PrinterType::Usb => Some(Box::new(windows_usb::WindowsUsbPrinter::new(
            name.to_string(),
            0,
            0,
        ))),
        #[cfg(windows)]
        PrinterType::Bluetooth => Some(Box::new(windows_bluetooth::WindowsBluetoothPrinter::new(
            name.to_string(),
            address.to_string(),
        ))),
        // Off Windows there is no spooler and no USB/Bluetooth transport, so
        // every other variant is unsupported here.
        #[cfg(not(windows))]
        _ => None,
    }
}

/// Parse a stored printer type, falling back to the platform default rather
/// than panicking on bad DB data.
pub fn parse_printer_type(raw: &str) -> PrinterType {
    raw.parse().unwrap_or(PrinterType::System)
}

/// One entry point for discovery and sending, so callers do not each
/// re-implement the platform `cfg` soup.
#[derive(Default)]
pub struct TransportRegistry {
    _private: (),
}

impl TransportRegistry {
    pub fn new() -> Self {
        Self { _private: () }
    }

    /// Every printer reachable on this machine, across all transports.
    ///
    /// Discovery is inherently per-platform: the Windows spooler enumerates
    /// installed printers, Android uses NsdManager, and USB/Bluetooth need
    /// Windows-specific enumeration. Individual transports that fail are
    /// skipped rather than failing the whole scan.
    pub async fn discover_all() -> Vec<PrinterInfo> {
        #[cfg(windows)]
        {
            match create_transport(&PrinterType::System, "", "") {
                Some(t) => t.discover().await,
                None => Vec::new(),
            }
        }
        #[cfg(not(windows))]
        {
            // No system enumeration off Windows; IPP discovery runs through
            // the platform bridge (NsdManager on Android).
            android_bridge::AndroidBridge::new().discover().await
        }
    }

    /// Resolve the transport for a printer row and send `job` to it.
    pub async fn send_to(
        printer_type: &PrinterType,
        name: &str,
        address: &str,
        job: RenderedJob,
    ) -> Result<(), String> {
        let transport = create_transport(printer_type, name, address).ok_or_else(|| {
            format!("`{printer_type}` printers are not supported on this platform")
        })?;
        transport.send(job).await
    }

    /// Connectivity check for a stored printer row.
    pub async fn test_printer(
        printer_type: &PrinterType,
        name: &str,
        address: &str,
    ) -> Result<(), String> {
        let transport = create_transport(printer_type, name, address).ok_or_else(|| {
            format!("`{printer_type}` printers are not supported on this platform")
        })?;
        transport.test().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_stored_type_id_parses() {
        // These are the strings the DB stores in printers.printer_type.
        for id in ["ipp", "raw_tcp", "usb", "bluetooth", "system"] {
            assert!(id.parse::<PrinterType>().is_ok(), "{id} should parse");
        }
    }

    #[test]
    fn type_parsing_is_case_and_space_insensitive() {
        assert!(matches!(
            "  IPP ".parse::<PrinterType>().unwrap(),
            PrinterType::Ipp
        ));
        assert!(matches!(
            "RawTCP".parse::<PrinterType>().unwrap(),
            PrinterType::RawTcp
        ));
    }

    #[test]
    fn unknown_type_is_an_error_not_a_panic() {
        assert!("telepathy".parse::<PrinterType>().is_err());
        assert!(matches!(
            parse_printer_type("telepathy"),
            PrinterType::System
        ));
    }

    #[test]
    fn display_round_trips_through_parse() {
        for id in ["ipp", "raw_tcp", "usb", "bluetooth", "system"] {
            let parsed: PrinterType = id.parse().unwrap();
            assert_eq!(parsed.to_string(), id);
        }
    }

    /// Regression for #19: `discover` used to be a static method with no
    /// `self` parameter, so it could not be reached through a
    /// `dyn PrinterTransport`. Build boxed transports and call every trait
    /// method through the trait object.
    #[tokio::test]
    async fn transports_are_dyn_dispatchable() {
        let transports: Vec<Box<dyn PrinterTransport>> = vec![
            Box::new(ipp::IppPrinter::new("ip".into(), "127.0.0.1".into())),
            Box::new(raw_tcp::RawTcpPrinter::new(
                "tcp".into(),
                "127.0.0.1".into(),
            )),
        ];
        // Empty discovery is fine (mDNS is platform-specific); the point is
        // that the call compiles and dispatches at all.
        for t in &transports {
            let _found: Vec<PrinterInfo> = t.discover().await;
        }
    }

    #[tokio::test]
    async fn send_to_an_unreachable_ipprinter_fails_rather_than_hangs() {
        let t = ipp::IppPrinter::new("ip".into(), "127.0.0.1".into());
        let job = RenderedJob {
            job_id: "j1".into(),
            printer_id: "p1".into(),
            data: vec![0x25, 0x50, 0x44, 0x46],
            mime_type: "application/pdf".into(),
            copies: 1,
        };
        // No IPP server on the loopback test port: must be Err, not Ok.
        assert!(t.send(job).await.is_err());
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn unsupported_platform_names_the_type_that_failed() {
        // Off Windows there is no spooler, so `system` must say so rather
        // than reporting a successful print.
        let err = TransportRegistry::test_printer(&PrinterType::System, "p", "")
            .await
            .unwrap_err();
        assert!(err.contains("system"), "{err}");
        assert!(err.contains("not supported"), "{err}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn system_transport_exists_on_windows() {
        assert!(create_transport(&PrinterType::System, "Printer", "").is_some());
        assert!(create_transport(&PrinterType::Usb, "Thermal", "").is_some());
    }
}
