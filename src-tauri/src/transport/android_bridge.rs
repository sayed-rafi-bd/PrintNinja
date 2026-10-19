use crate::transport::PrinterInfo;

pub struct AndroidBridge;

impl AndroidBridge {
    pub fn new() -> Self {
        Self
    }

    /// IPP printers visible on the local network.
    ///
    /// On Android this is NsdManager (`_ipp._tcp`); the stub build returns
    /// an empty list rather than an error so the Discovery screen still
    /// renders and simply shows "no printers found".
    pub async fn discover(&self) -> Vec<PrinterInfo> {
        Vec::new()
    }
}

impl Default for AndroidBridge {
    fn default() -> Self {
        Self::new()
    }
}
