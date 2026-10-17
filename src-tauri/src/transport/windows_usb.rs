use crate::transport::{PrinterInfo, PrinterLanguage, PrinterTransport, PrinterType, RenderedJob};
use async_trait::async_trait;
use std::collections::HashMap;

/// Windows USB transport using rus1 (libusb) for raw USB thermal printers
pub struct WindowsUsbPrinter {
    pub name: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub interface: u8,
    pub endpoint: u8,
}

impl WindowsUsbPrinter {
    pub fn new(name: String, vendor_id: u16, product_id: u16) -> Self {
        Self {
            name,
            vendor_id,
            product_id,
            interface: 0,
            endpoint: 1,
        }
    }

    pub async fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        // Use rusb for raw USB communication
        // In practice, rusb requires the libusb backend which may not be available
        // without installing the "libusb" feature. For Windows, fallback to spooler.
        #[cfg(feature = "rusb")]
        {
            use rusb::{Device, UsbContext};
            let timeout = std::time::Duration::from_secs(10);

            match rusb::Context::new() {
                Ok(context) => {
                    for device in context.devices().unwrap_or_default() {
                        let desc = match device.device_descriptor() {
                            Ok(d) => d,
                            Err(_) => continue,
                        };
                        if desc.vendor_id() == self.vendor_id
                            && desc.product_id() == self.product_id
                        {
                            match device.open() {
                                Ok(handle) => {
                                    let _ = handle.claim_interface(self.interface);
                                    let written = handle
                                        .write_bulk(self.endpoint, data, timeout)
                                        .map_err(|e| e.to_string())?;
                                    if written > 0 {
                                        let _ = handle.release_interface(self.interface);
                                        return Ok(());
                                    }
                                }
                                Err(_) => continue,
                            }
                        }
                    }
                    Err("USB device not found".to_string())
                }
                Err(e) => Err(format!("rusb init failed: {}", e)),
            }
        }

        #[cfg(not(feature = "rusb"))]
        {
            // Fallback: use the Windows spooler with USB port
            crate::transport::windows_spooler::WindowsSpooler::new(self.name.clone()).send_raw(data)
        }
    }

    /// List USB devices that match known thermal printer vendor IDs
    pub fn discover_thermal_usb() -> Vec<PrinterInfo> {
        let known_vendor_ids: [u16; 10] = [
            0x04B8, // Epson
            0x0483, // STMicroelectronics (various Chinese printers)
            0x1A86, // QinHeng (CH340, various Chinese printers)
            0x0416, // Winbond
            0x067B, // Prolific (PL2303, virtual COM)
            0x0525, // Netchip (generic)
            0x1FC9, // NXP
            0x28E9, // GD32 (various Chinese printers)
            0x0451, // Texas Instruments
            0x0471, // Philips
        ];

        let mut printers = Vec::new();

        #[cfg(feature = "rusb")]
        {
            if let Ok(context) = rusb::Context::new() {
                for device in context.devices().unwrap_or_default() {
                    if let Ok(desc) = device.device_descriptor() {
                        if known_vendor_ids.contains(&desc.vendor_id()) {
                            let name = format!(
                                "USB Printer {:04x}:{:04x}",
                                desc.vendor_id(),
                                desc.product_id()
                            );
                            printers.push(PrinterInfo {
                                id: name.clone(),
                                name,
                                address: format!(
                                    "{:04x}:{:04x}",
                                    desc.vendor_id(),
                                    desc.product_id()
                                ),
                                printer_type: PrinterType::Usb,
                                language: PrinterLanguage::Escpos,
                                status: "online".to_string(),
                            });
                        }
                    }
                }
            }
        }

        printers
    }
}

#[async_trait]
impl PrinterTransport for WindowsUsbPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        Self::discover_thermal_usb()
    }

    async fn test(&self) -> Result<(), String> {
        self.send_raw(&crate::transport::escpos::EscPosEncoder::init())
            .await
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_raw(&job.data).await
    }
}
