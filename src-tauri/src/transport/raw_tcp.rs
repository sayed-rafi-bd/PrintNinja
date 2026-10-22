use crate::transport::status;
use crate::transport::{PrinterInfo, PrinterLanguage, PrinterTransport, RenderedJob};
use async_trait::async_trait;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// How long to wait for a raw (JetDirect) printer to accept a connection.
///
/// Kept short so an unreachable printer fails in seconds rather than after
/// the whole send budget: the OS default for an unanswered SYN is minutes.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the bytes of one job may take to be accepted.
///
/// This covers only the write and flush, not the time this process spends
/// waiting for the printer's turn (that is the per-printer permit's
/// business). A raw printer sends nothing back, so this deadline is the
/// *only* thing that can end a job against a printer which accepts the
/// connection and then goes quiet.
const SEND_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for a status query's answer.
///
/// Status replies are immediate by specification — `DLE EOT` is answered
/// even while offline or with a full buffer, TSPL says "at any time" — so
/// this is generous rather than tight. It is still bounded, because a
/// printer that never answers pays it: on the first job, and after that once
/// an hour instead of once per job (see `status::should_probe`).
const STATUS_REPLY_TIMEOUT: Duration = Duration::from_secs(3);

pub struct RawTcpPrinter {
    pub name: String,
    pub address: String,
    pub port: u16,
}

/// Test-only send-buffer cap, honoured when PRINTNINJA_TEST_SNDBUF holds
/// a byte count. Integration tests stall a sender against a wedged peer
/// by capping the buffer: whatever the OS autotuning would otherwise
/// grow it to, a small fixed buffer fills after a few kilobytes and the
/// write blocks until the deadline instead of completing vacuously.
/// Never set in production; without the variable the socket is untouched
/// (a failed parse or setsockopt also leaves it untouched).
fn cap_test_send_buffer(stream: TcpStream) -> TcpStream {
    let size: usize = match std::env::var("PRINTNINJA_TEST_SNDBUF") {
        Ok(v) => match v.parse() {
            Ok(n) => n,
            Err(_) => return stream,
        },
        Err(_) => return stream,
    };
    let Ok(std_stream) = stream.into_std() else {
        panic!("PRINTNINJA_TEST_SNDBUF is set but the socket cannot leave async mode");
    };
    let sock = socket2::SockRef::from(&std_stream);
    let set_result = sock.set_send_buffer_size(size);
    // Read back: the test verdict depends on this cap actually holding.
    // stdout is only shown for failed tests, so this is free diagnosis.
    let actual = sock.send_buffer_size().map(|n| n.to_string());
    eprintln!("[cap_test_send_buffer] requested={size} set={set_result:?} actual={actual:?}");
    TcpStream::from_std(std_stream)
        .expect("PRINTNINJA_TEST_SNDBUF is set but the socket cannot re-enter async mode")
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

    /// The address this printer is dialled at, formatted for `connect`.
    ///
    /// IPv6 hosts need brackets so the port is not mistaken for part of the
    /// address.
    fn socket_addr(&self) -> String {
        if self.address.contains(':') {
            format!("[{}]:{}", self.address, self.port)
        } else {
            format!("{}:{}", self.address, self.port)
        }
    }

    /// How every message about this printer names it.
    fn at(&self) -> String {
        format!("the printer at {}", self.socket_addr())
    }

    /// Open the connection, or explain why not.
    ///
    /// Shared by the status probe and by the job, so a printer that cannot be
    /// reached produces exactly one message, whichever of the two got there
    /// first — the probe simply gets there sooner. Test-only socket tuning
    /// lives here too (see below).
    async fn connect(&self) -> Result<TcpStream, String> {
        let addr = self.socket_addr();
        let at = self.at();
        match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr)).await {
            Err(_) => Err(format!(
                "{at} never accepted a connection (waited {}s) — check the address and that the printer is powered on",
                CONNECT_TIMEOUT.as_secs()
            )),
            Ok(Err(e)) => Err(format!("Could not reach {at}: {e}")),
            Ok(Ok(stream)) => Ok(cap_test_send_buffer(stream)),
        }
    }

    /// Write `data` and stop — no status question, no interpretation.
    ///
    /// [`Self::precheck`] sits in front of this in [`PrinterTransport::send`];
    /// reaching the bytes directly is for callers that only want them, such
    /// as the connectivity check.
    pub async fn send_raw(&self, data: &[u8]) -> Result<(), String> {
        // A raw printer gives no application-level reply: the job is done
        // when the bytes are written. That means a printer which accepts the
        // connection and then stops reading — a full buffer, a wedged
        // spooler, or a server answering `hang` — blocks `write_all`
        // forever. The job then sits `printing`, the UI spins and nothing
        // ever reaches history, so both phases carry a deadline.
        let at = self.at();
        let mut stream = self.connect().await?;

        let send = async {
            stream.write_all(data).await.map_err(|e| {
                format!("{at} closed the connection while the job was sending: {e}")
            })?;
            stream
                .flush()
                .await
                .map_err(|e| format!("{at} stopped responding while the job was finishing: {e}"))?;
            Ok::<(), String>(())
        };

        tokio::time::timeout(SEND_TIMEOUT, send).await.map_err(|_| {
            format!(
                "{at} stopped responding after {}s — check for a paper jam or out-of-paper, or that it is still connected",
                SEND_TIMEOUT.as_secs()
            )
        })?
    }

    /// Ask the printer about itself before the job goes out, and refuse to
    /// send if it says it cannot print.
    ///
    /// This is the only place a raw print can learn anything: the printer
    /// answers a status query but never a job, so without this every
    /// device-side fault — paper out, jammed, offline — arrives looking like
    /// a successful print. Which query is asked comes from the printer's own
    /// configured language (`status::dialect_for`); a language with no query
    /// we can stand behind sends nothing and behaves exactly as it did.
    ///
    /// Two things are deliberately *not* failures, because a false failure
    /// would be a worse bug than the one this fixes:
    ///
    /// - an answer we cannot read — it answered, so it speaks the dialect,
    ///   and `decode` only claims what the bytes unmistakably say;
    /// - silence, until this printer has answered once. A printer that never
    ///   replies may simply not implement the query, and refusing every job
    ///   because of a mis-set language column would stop printing outright.
    ///
    ///   Once it *has* answered, silence is reported — which is not a
    ///   liberty: Zebra's spec says a Zebra sends no `~HS` reply at all when
    ///   media is out, the ribbon is out or the head is open, so silence is
    ///   the signal there, and ESC/POS and TSPL are specified to always
    ///   answer.
    async fn precheck(&self, language: &PrinterLanguage) -> Result<(), String> {
        let Some(dialect) = status::dialect_for(language) else {
            return Ok(());
        };
        let addr = self.socket_addr();
        if !status::should_probe(&addr, Instant::now()) {
            return Ok(());
        }

        let mut stream = self.connect().await?;
        let at = self.at();
        let query = dialect.query();
        let mut reply = Vec::new();

        let asked = tokio::time::timeout(STATUS_REPLY_TIMEOUT, async {
            stream.write_all(&query).await?;
            // Stop at a complete answer rather than at end-of-stream: the
            // printer holds the connection open until its own idle timeout.
            let mut chunk = [0u8; 256];
            while !dialect.answered(&reply) {
                match stream.read(&mut chunk).await {
                    Ok(0) => break, // hung up mid-question
                    Ok(n) => reply.extend_from_slice(&chunk[..n]),
                    Err(_) => break,
                }
            }
            Ok::<(), std::io::Error>(())
        })
        .await;

        // The connection went away under the query itself. The job's own
        // send will say that better than any status message could, so do not
        // record or report anything here.
        if matches!(asked, Ok(Err(_))) && reply.is_empty() {
            return Ok(());
        }

        if reply.is_empty() {
            let was_answering = status::had_answered(&addr);
            status::note_silent(&addr, Instant::now());
            return if was_answering {
                Err(status::silence_message(&at, STATUS_REPLY_TIMEOUT))
            } else {
                Ok(())
            };
        }

        status::note_answered(&addr);
        match status::decode(dialect, &reply) {
            Some(fault) => Err(fault.message(&at)),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl PrinterTransport for RawTcpPrinter {
    async fn discover(&self) -> Vec<PrinterInfo> {
        vec![]
    }

    async fn test(&self) -> Result<(), String> {
        // Connectivity only: the status probe needs the printer's language,
        // which this check does not receive.
        self.send_raw(&[0x1B, 0x40]).await // ESC/POS init
    }

    async fn send(&self, job: RenderedJob) -> Result<(), String> {
        self.precheck(&job.language).await?;
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

    /// The probe and the job must dial the same place and be described the
    /// same way, or a failure about "the printer at …" would not be a
    /// failure about the printer the job went to.
    #[test]
    fn messages_name_the_address_the_job_uses() {
        let t = RawTcpPrinter::new("T".into(), "192.168.1.5:9292".into());
        assert_eq!(t.socket_addr(), "192.168.1.5:9292");
        assert_eq!(t.at(), "the printer at 192.168.1.5:9292");
        let t = RawTcpPrinter::new("T".into(), "::1".into());
        assert_eq!(t.socket_addr(), "[::1]:9100");
    }
}
