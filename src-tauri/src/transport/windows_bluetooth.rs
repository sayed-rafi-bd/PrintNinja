use crate::transport::{PrinterInfo, PrinterLanguage, PrinterTransport, PrinterType, RenderedJob};
use async_trait::async_trait;

/// Windows Bluetooth transport via COM port (paired Bluetooth printer)
pub struct WindowsBluetoothPrinter {
    pub name: String,
    pub com_port: String,
}

impl WindowsBluetoothPrinter {
    pub fn new(name: String, com_port: String) -> Self {
        Self { name, com_port }
    }

    pub async fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        #[cfg(feature = "serialport")]
        {
            use std::time::Duration;
            let port = serialport::new(&self.com_port, 9600)
                .timeout(Duration::from_secs(10))
                .open()
                .map_err(|e| format!("Failed to open COM port {}: {}", self.com_port, e))?;

            let mut port = port;
            port.write_all(data)
                .map_err(|e| format!("BT write failed: {}", e))?;
            port.flush()
                .map_err(|e| format!("BT flush failed: {}", e))?;
            Ok(())
        }

        #[cfg(not(feature = "serialport"))]
        {
            // Fallback: use Windows spooler (paired Bluetooth printer appears as system printer)
            crate::transport::windows_spooler::WindowsSpooler::new(self.name.clone()).send_raw(data)
        }
    }

    /// List paired Bluetooth COM ports
    pub fn discover_paired_bluetooth() -> Vec<PrinterInfo> {
        let mut printers = Vec::new();

        // Scan for COM ports that might be Bluetooth printers
        for i in 1..=256 {
            let port_name = format!("COM{}", i);
            #[cfg(feature = "serialport")]
            {
                // Try to open and identify
                if let Ok(_) = serialport::new(&port_name, 9600).open() {
                    printers.push(PrinterInfo {
                        id: port_name.clone(),
                        name: format!("Bluetooth Printer ({})", port_name),
                        address: port_name,
                        printer_type: PrinterType::Bluetooth,
                        language: PrinterLanguage::Escpos,
                        status: "online".to_string(),
                    });
                }
            }
            let _ = port_name;
        }

        printers
    }
}

#[async_trait]
impl PrinterTransport for WindowsBluetoothPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        Self::discover_paired_bluetooth()
    }

    async fn test(&self) -> Result<(), String> {
        self.send_raw(&crate::transport::escpos::EscPosEncoder::init())
            .await
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_raw(&job.data).await
    }
}
