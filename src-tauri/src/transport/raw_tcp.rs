use crate::transport::{PrinterInfo, PrinterTransport, RenderedJob};
use async_trait::async_trait;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

pub struct RawTcpPrinter {
    pub name: String,
    pub address: String,
    pub port: u16,
}

impl RawTcpPrinter {
    pub fn new(name: String, address: String) -> Self {
        // The address column may carry `host:port` (bracketed IPv6:
        // `[::1]:9292`); a bare host keeps the JetDirect default.
        let (host, port) = split_host_port(&address, 9100);
        Self {
            name,
            address: host,
            port,
        }
    }

    pub async fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        // `connect` takes `SocketAddr`-style formatting; IPv6 hosts need
        // brackets so the port is not mistaken for part of the address.
        let addr = if self.address.contains(':') {
            format!("[{}]:{}", self.address, self.port)
        } else {
            format!("{}:{}", self.address, self.port)
        };
        let mut stream = TcpStream::connect(&addr)
            .await
            .map_err(|e| format!("TCP connect failed: {}", e))?;

        stream
            .write_all(data)
            .await
            .map_err(|e| format!("TCP write failed: {}", e))?;

        stream
            .flush()
            .await
            .map_err(|e| format!("TCP flush failed: {}", e))?;

        Ok(())
    }
}

#[async_trait]
impl PrinterTransport for RawTcpPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        vec![]
    }

    async fn test(&self) -> Result<(), String> {
        self.send_raw(&[0x1B, 0x40]).await // ESC/POS init
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.send_raw(&job.data).await
    }
}

/// Split `host:port` from a stored address, defaulting the port.
///
/// A bare host (`192.168.1.5`) or a bare IPv6 literal (`::1`) keeps
/// `default_port`; `host:9292` and `[::1]:9292` override it.
fn split_host_port(address: &str, default_port: u16) -> (String, u16) {
    // Bracketed IPv6: `[::1]:9292`.
    if let Some(rest) = address.strip_prefix('[') {
        if let Some((host, port)) = rest.split_once(']') {
            let port = port
                .strip_prefix(':')
                .and_then(|p| p.parse::<u16>().ok())
                .unwrap_or(default_port);
            return (host.to_string(), port);
        }
    }
    // Exactly one colon means `host:port`; more than one is a bare IPv6
    // literal like `::1`, whose trailing `1` must not parse as a port.
    if address.matches(':').count() == 1 {
        if let Some((host, port)) = address.rsplit_once(':') {
            if let Ok(parsed) = port.parse::<u16>() {
                return (host.to_string(), parsed);
            }
        }
    }
    (address.to_string(), default_port)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// P4 loopback tests bind a random port, so the address column must be
    /// able to carry it.
    #[test]
    fn address_may_carry_a_port() {
        assert_eq!(
            split_host_port("127.0.0.1:9292", 9100),
            ("127.0.0.1".into(), 9292)
        );
        assert_eq!(split_host_port("[::1]:9292", 9100), ("::1".into(), 9292));
    }

    #[test]
    fn a_bare_host_keeps_the_default_port() {
        assert_eq!(
            split_host_port("192.168.1.5", 9100),
            ("192.168.1.5".into(), 9100)
        );
        // Bare IPv6: the trailing component is not a port.
        assert_eq!(split_host_port("::1", 9100), ("::1".into(), 9100));
        assert_eq!(
            split_host_port("fe80::1%wlan0", 9100),
            ("fe80::1%wlan0".into(), 9100)
        );
        // A non-numeric suffix is part of the host, not a port.
        assert_eq!(
            split_host_port("labelprinter:local", 9100),
            ("labelprinter:local".into(), 9100)
        );
    }

    #[test]
    fn new_reads_the_port_from_the_address() {
        let t = RawTcpPrinter::new("T".into(), "127.0.0.1:9292".into());
        assert_eq!(t.port, 9292);
        assert_eq!(t.address, "127.0.0.1");
        let t = RawTcpPrinter::new("T".into(), "10.0.0.4".into());
        assert_eq!(t.port, 9100);
    }
}
