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

/// Parse a stored printer language, e.g. from `printers.language`.
///
/// Unknown values fall back to `Pdf` — the language every job used before
/// dispatch existed — rather than failing a print on bad DB data.
pub fn parse_printer_language(raw: &str) -> PrinterLanguage {
    match raw.trim().to_ascii_lowercase().as_str() {
        "escpos" | "esc/pos" | "esc-pos" => PrinterLanguage::Escpos,
        "tspl" | "tspl2" => PrinterLanguage::Tspl,
        "zpl" | "zpl2" => PrinterLanguage::Zpl,
        "cpcl" => PrinterLanguage::Cpcl,
        "raster" => PrinterLanguage::Raster,
        // "" or unknown → pdf, the pre-dispatch behaviour.
        _ => PrinterLanguage::Pdf,
    }
}

/// Encode a raster into a printer's own command language (P4).
///
/// Returns the bytes to send and their MIME type. `Pdf` is not a command
/// language: the pipeline renders PDFs directly and never routes them
/// through here.
pub fn encode_for_language(
    language: &PrinterLanguage,
    image: &crate::render::raster::RasterImage,
    label_w_mm: f64,
    label_h_mm: f64,
    dpi: u32,
) -> Result<(Vec<u8>, &'static str), String> {
    // Default media gap for TSPL when the printer row carries none — the
    // printers table has no gap column (2 mm is the common label gap).
    const DEFAULT_GAP_MM: f64 = 2.0;

    match language {
        PrinterLanguage::Pdf => Err(
            "PDF is not a command language: the document is rendered and sent as PDF bytes"
                .to_string(),
        ),
        PrinterLanguage::Escpos => {
            let mut data = escpos::EscPosEncoder::init();
            data.extend_from_slice(&escpos::EscPosEncoder::print_raster(image));
            Ok((data, "application/octet-stream"))
        }
        PrinterLanguage::Tspl => Ok((
            label_langs::tspl::print_bitmap(image, label_w_mm, label_h_mm, DEFAULT_GAP_MM, dpi),
            "application/octet-stream",
        )),
        PrinterLanguage::Zpl => Ok((
            label_langs::zpl::print_bitmap(image, label_w_mm, label_h_mm, dpi).into_bytes(),
            "application/octet-stream",
        )),
        PrinterLanguage::Cpcl => Ok((
            label_langs::cpcl::print_bitmap(image, label_w_mm, dpi).into_bytes(),
            "application/octet-stream",
        )),
        // The bare packed dots, for spoolers and bridges that take a bitmap
        // and speak no label language of their own.
        PrinterLanguage::Raster => Ok((image.to_bytes(), "application/octet-stream")),
    }
}

#[derive(Debug, Clone)]
pub struct RenderedJob {
    pub job_id: String,
    pub printer_id: String,
    pub data: Vec<u8>,
    pub mime_type: String,
    pub copies: u32,
    /// The printer's own command language, which a raw transport needs to
    /// know *before* the job: it decides which status query, if any, the
    /// printer is asked whether it can actually print. `Pdf` — the language
    /// of a printer row that carries none — asks nothing.
    pub language: PrinterLanguage,
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
pub mod cups;
pub mod escpos;
pub mod ipp;
pub mod label_langs;
pub mod raw_tcp;
pub mod status;
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
        #[cfg(target_os = "linux")]
        PrinterType::System => Some(Box::new(cups::CupsPrinter::new(
            name.to_string(),
            address.to_string(),
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
        // Off Windows there is no spooler and no USB/Bluetooth
        // transport (Linux serves system printers through CUPS, matched
        // above), so every other variant is unsupported here.
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
        #[cfg(target_os = "linux")]
        {
            // CUPS queues are the system printers.
            match create_transport(&PrinterType::System, "", "") {
                Some(t) => t.discover().await,
                None => Vec::new(),
            }
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            // No system enumeration here; IPP discovery runs through
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

    /// P4: the language column decides the encoder, and anything the schema
    /// would not allow (hand-edited row, empty string) behaves like the
    /// pre-dispatch world: PDF.
    #[test]
    fn language_parsing_falls_back_to_pdf() {
        use PrinterLanguage::*;
        assert!(matches!(parse_printer_language("zpl"), Zpl));
        assert!(matches!(parse_printer_language(" ZPL "), Zpl));
        assert!(matches!(parse_printer_language("esc/pos"), Escpos));
        assert!(matches!(parse_printer_language("tspl2"), Tspl));
        assert!(matches!(parse_printer_language("cpcl"), Cpcl));
        assert!(matches!(parse_printer_language("raster"), Raster));
        assert!(matches!(parse_printer_language("pdf"), Pdf));
        assert!(matches!(parse_printer_language("telepathy"), Pdf));
        assert!(matches!(parse_printer_language(""), Pdf));
    }

    /// P4: `pdf` is not routed through the raster encoders — the pipeline
    /// renders PDFs directly and this function refuses them.
    #[test]
    fn encoding_a_pdf_from_a_raster_is_an_error() {
        let image = crate::render::raster::RasterImage::new(8, 1);
        let err = encode_for_language(&PrinterLanguage::Pdf, &image, 40.0, 30.0, 203)
            .expect_err("pdf must not be encoded from a raster");
        assert!(err.contains("PDF"), "{err}");
    }

    /// P4: every command language carries its own framing around the same
    /// raster — this is what "each takes its own path" means on the wire.
    #[test]
    fn every_command_language_frames_its_raster() {
        let mut image = crate::render::raster::RasterImage::new(8, 2);
        image.set_bit(0, 0, true);
        image.set_bit(7, 1, true);

        let (zpl, _) = encode_for_language(&PrinterLanguage::Zpl, &image, 40.0, 30.0, 203).unwrap();
        let zpl = String::from_utf8_lossy(&zpl);
        assert!(zpl.starts_with("^XA"), "{zpl}");
        assert!(zpl.contains("80"), "hex of the first row (0x80): {zpl}");

        let (tspl, _) =
            encode_for_language(&PrinterLanguage::Tspl, &image, 40.0, 30.0, 203).unwrap();
        let tspl = String::from_utf8_lossy(&tspl);
        assert!(tspl.starts_with("SIZE 40 mm"), "{tspl}");
        assert!(tspl.contains("BITMAP 0,0,1,2,0"), "{tspl}");

        let (cpcl, _) =
            encode_for_language(&PrinterLanguage::Cpcl, &image, 40.0, 30.0, 203).unwrap();
        let cpcl = String::from_utf8_lossy(&cpcl);
        assert!(cpcl.starts_with("! 0 200 200"), "{cpcl}");
        assert!(cpcl.contains("PRINT"), "{cpcl}");

        let (escpos, _) =
            encode_for_language(&PrinterLanguage::Escpos, &image, 40.0, 30.0, 203).unwrap();
        assert!(escpos.starts_with(&[0x1B, 0x40]));
        assert!(escpos.windows(4).any(|w| w == [0x1D, 0x76, 0x30, 0x00]));

        let (raster, _) =
            encode_for_language(&PrinterLanguage::Raster, &image, 40.0, 30.0, 203).unwrap();
        assert_eq!(raster, image.to_bytes(), "raster is the bare dots");
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
            language: PrinterLanguage::Pdf,
        };
        // No IPP server on the loopback test port: must be Err, not Ok.
        assert!(t.send(job).await.is_err());
    }

    #[cfg(all(not(windows), not(target_os = "linux")))]
    #[tokio::test]
    async fn unsupported_platform_names_the_type_that_failed() {
        // Off Windows (and off Linux, which serves system printers
        // through CUPS) there is no spooler, so `system` must say so
        // rather than reporting a successful print.
        let err = TransportRegistry::test_printer(&PrinterType::System, "p", "")
            .await
            .unwrap_err();
        assert!(err.contains("system"), "{err}");
        assert!(err.contains("not supported"), "{err}");
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn system_transport_probes_cups_without_printing() {
        // Read-only probe: absent daemon and unknown queue both fail
        // without submitting anything.
        let err = TransportRegistry::test_printer(
            &PrinterType::System,
            "no-such-queue-printninja",
            "",
        )
        .await
        .unwrap_err();
        assert!(err.contains("CUPS"), "{err}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn system_transport_exists_on_windows() {
        assert!(create_transport(&PrinterType::System, "Printer", "").is_some());
        assert!(create_transport(&PrinterType::Usb, "Thermal", "").is_some());
    }
}
