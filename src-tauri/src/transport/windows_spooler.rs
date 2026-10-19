#[cfg(windows)]
use crate::transport::{PrinterInfo, PrinterLanguage, PrinterTransport, PrinterType, RenderedJob};
#[cfg(windows)]
use async_trait::async_trait;
#[cfg(windows)]
use std::ffi::CString;
#[cfg(windows)]
use std::ptr::null_mut;

// Windows API types for spooler
#[cfg(windows)]
mod winapi {
    use std::os::raw::{c_char, c_void};

    pub type HANDLE = *mut c_void;
    pub type BOOL = i32;
    pub type DWORD = u32;
    pub type LPSTR = *mut c_char;
    pub type LPVOID = *mut c_void;
    pub type LPDWORD = *mut DWORD;
    pub type LPBYTE = *mut u8;

    #[repr(C)]
    #[allow(non_snake_case)]
    pub struct DOC_INFO_1A {
        pub pDocName: LPSTR,
        pub pOutputFile: LPSTR,
        pub pDatatype: LPSTR,
    }

    /// `PRINTER_INFO_2A` as documented in winspool.h.
    ///
    /// This MUST be laid out exactly or we read garbage pointers and crash.
    /// Field order per MSDN, each pointer is 8 bytes on 64-bit.
    #[repr(C)]
    #[allow(non_snake_case)]
    pub struct PRINTER_INFO_2A {
        pub pServerName: LPSTR,
        pub pPrinterName: LPSTR,
        pub pShareName: LPSTR,
        pub pPortName: LPSTR,
        pub pDriverName: LPSTR,
        pub pComment: LPSTR,
        pub pLocation: LPSTR,
        pub pDevMode: LPVOID,
        pub pSepFile: LPSTR,
        pub pPrintProcessor: LPSTR,
        pub pDatatype: LPSTR,
        pub pParameters: LPSTR,
        pub pSecurityDescriptor: LPVOID,
        pub Attributes: DWORD,
        pub Priority: DWORD,
        pub DefaultPriority: DWORD,
        pub StartTime: DWORD,
        pub UntilTime: DWORD,
        pub Status: DWORD,
        pub cJobs: DWORD,
        pub AveragePPM: DWORD,
    }

    extern "system" {
        pub fn OpenPrinterA(
            pPrinterName: LPSTR,
            phPrinter: *mut HANDLE,
            pDefault: *mut c_void,
        ) -> BOOL;
        pub fn ClosePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn StartDocPrinterA(
            hPrinter: HANDLE,
            Level: DWORD,
            pDocInfo: *mut DOC_INFO_1A,
        ) -> DWORD;
        pub fn EndDocPrinter(hPrinter: HANDLE) -> BOOL;
        pub fn StartPagePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn EndPagePrinter(hPrinter: HANDLE) -> BOOL;
        pub fn WritePrinter(
            hPrinter: HANDLE,
            pBuf: LPVOID,
            cbBuf: DWORD,
            pcWritten: LPDWORD,
        ) -> BOOL;
        pub fn EnumPrintersA(
            Flags: DWORD,
            Name: LPSTR,
            Level: DWORD,
            pPrinterEnum: LPBYTE,
            cbBuf: DWORD,
            pcbNeeded: LPDWORD,
            pcReturned: LPDWORD,
        ) -> BOOL;
        pub fn GetLastError() -> DWORD;
    }

    pub const PRINTER_ENUM_LOCAL: DWORD = 0x00000002;
    pub const PRINTER_ENUM_CONNECTIONS: DWORD = 0x00000004;
}

#[cfg(windows)]
pub struct WindowsSpooler {
    printer_name: String,
}

#[cfg(windows)]
impl WindowsSpooler {
    pub fn new(printer_name: String) -> Self {
        Self { printer_name }
    }

    /// Enumerate all local system printers
    pub fn enumerate_printers() -> Vec<PrinterInfo> {
        use std::ffi::CStr;
        use winapi::*;

        let mut printers = Vec::new();
        let mut bytes_needed: DWORD = 0;
        let mut num_printers: DWORD = 0;

        // First call to get buffer size
        unsafe {
            EnumPrintersA(
                PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
                null_mut(),
                2,
                null_mut(),
                0,
                &mut bytes_needed,
                &mut num_printers,
            );
        }

        if bytes_needed == 0 {
            return printers;
        }

        let mut buffer = vec![0u8; bytes_needed as usize];

        unsafe {
            let result = EnumPrintersA(
                PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS,
                null_mut(),
                2,
                buffer.as_mut_ptr(),
                bytes_needed,
                &mut bytes_needed,
                &mut num_printers,
            );

            if result == 0 {
                return printers;
            }

            // Cast the buffer to an array of PRINTER_INFO_2A and read fields
            // by name instead of guessing byte offsets (the old code used
            // `size_of::<usize>() * 10` which read garbage / could fault).
            let stride = std::mem::size_of::<PRINTER_INFO_2A>();
            let capacity = bytes_needed as usize / stride;

            let (_prefix, infos, _suffix) = buffer.as_slice().align_to::<PRINTER_INFO_2A>();
            for info in infos.iter().take(capacity.min(num_printers as usize)) {
                if info.pPrinterName.is_null() {
                    continue;
                }
                let name = CStr::from_ptr(info.pPrinterName as *const i8)
                    .to_string_lossy()
                    .to_string();
                let port = if info.pPortName.is_null() {
                    name.clone()
                } else {
                    CStr::from_ptr(info.pPortName as *const i8)
                        .to_string_lossy()
                        .to_string()
                };

                // PRINTER_STATUS_OFFLINE (0x02) / PRINTER_STATUS_PAPEROUT (0x04)
                let offline = info.Status & 0x06 != 0;

                printers.push(PrinterInfo {
                    id: name.clone(),
                    name,
                    address: port,
                    printer_type: PrinterType::System,
                    language: PrinterLanguage::Pdf,
                    status: if offline { "offline" } else { "online" }.to_string(),
                });
            }
        }

        printers
    }

    /// Send raw bytes to the printer via the spooler
    pub fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        use winapi::*;

        let printer_name = CString::new(self.printer_name.clone()).map_err(|e| e.to_string())?;
        let doc_name = CString::new("PrintNinja Job").map_err(|e| e.to_string())?;
        let datatype = CString::new("RAW").map_err(|e| e.to_string())?;

        unsafe {
            let mut h_printer: HANDLE = null_mut();
            let result = OpenPrinterA(printer_name.as_ptr() as *mut _, &mut h_printer, null_mut());
            if result == 0 {
                return Err(format!("OpenPrinter failed: {}", GetLastError()));
            }

            let doc_info = DOC_INFO_1A {
                pDocName: doc_name.as_ptr() as *mut _,
                pOutputFile: null_mut(),
                pDatatype: datatype.as_ptr() as *mut _,
            };

            let result = StartDocPrinterA(h_printer, 1, &doc_info as *const _ as *mut _);
            if result == 0 {
                ClosePrinter(h_printer);
                return Err(format!("StartDocPrinter failed: {}", GetLastError()));
            }

            let result = StartPagePrinter(h_printer);
            if result == 0 {
                EndDocPrinter(h_printer);
                ClosePrinter(h_printer);
                return Err(format!("StartPagePrinter failed: {}", GetLastError()));
            }

            let mut written: DWORD = 0;
            let result = WritePrinter(
                h_printer,
                data.as_ptr() as *mut _,
                data.len() as DWORD,
                &mut written,
            );

            EndPagePrinter(h_printer);
            EndDocPrinter(h_printer);
            ClosePrinter(h_printer);

            if result == 0 {
                return Err(format!("WritePrinter failed: {}", GetLastError()));
            }
        }

        Ok(())
    }
}

#[cfg(windows)]
#[async_trait]
impl PrinterTransport for WindowsSpooler {
    async fn discover(&self) -> Vec<PrinterInfo> {
        Self::enumerate_printers()
    }

    async fn test(&self) -> Result<(), String> {
        // Test by sending a minimal ESC/POS or PDF
        self.send_raw(b"\x1B@") // ESC/POS init
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_raw(&job.data)
    }
}

#[cfg(not(windows))]
pub struct WindowsSpooler;

#[cfg(not(windows))]
impl WindowsSpooler {
    pub fn new(_printer_name: String) -> Self {
        Self
    }

    pub fn send_raw(&self, _data: &[u8]) -> Result<(), String> {
        Err("Windows spooler not available on this platform".to_string())
    }
}
