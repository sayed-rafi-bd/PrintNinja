//! Print tests against a real printer endpoint, not a mock.
//!
//! Everything else that touches printing is exercised through a mock IPP
//! server that answers one fixed status code, so the *device* half of the
//! conversation — what a printer does when it is out of paper, jammed,
//! stopped, or has simply gone quiet — was never covered. This file closes
//! that gap with the Virtual Printer
//! (<https://github.com/sayed-rafi-bd/virtual-printer>), vendored from its
//! `rust` branch under `e2e/support/virtual-printer/`. It is std-only and
//! builds in under a second, so the fixture is compiled once on demand and
//! spawned as a subprocess: no Python, no network, no service to install.
//!
//! Its fault states, and what each one found:
//!
//! | state | what the device does | what happened before |
//! |---|---|---|
//! | `ok` | stores the job | — |
//! | `paperout` | `media-empty`, only via Get-Printer-Attributes | counted as success |
//! | `jam` | `media-jam`, likewise | counted as success |
//! | `offline` | `offline-report`, likewise | counted as success |
//! | `hang` | accepts the connection, never answers | job stuck `printing` |
//! | `drop` | closes the connection at once | opaque `TCP write failed` |
//!
//! Three separate defects, all of which reported a failed print as a good
//! one:
//!
//! 1. **Raw sends had no deadline.** A raw printer sends no reply, so
//!    `write_all` against a printer that stops reading ran forever: the job
//!    row stayed `printing`, the UI spun, and history never learned
//!    anything. The deadline bounds the *transfer*, not the outcome — see
//!    [`BIG`] for what that distinction costs.
//! 2. **The IPP job state was never read.** RFC 8011 separates the
//!    *operation* status (the request was accepted) from the *job* state
//!    (the print happened), and a device reports `media-empty` only in the
//!    latter. `job-state` is an `enum` (tag `0x23`) holding a 4-byte
//!    big-endian integer, not the `integer` tag we first looked for.
//! 3. **The cause was in a different message.** A Print-Job reply says
//!    `printer-stopped` whether the printer is jammed, out of paper or
//!    paused; the specific condition lives in `printer-state-reasons` on
//!    Get-Printer-Attributes. A failed job now asks — once, on its own
//!    short deadline — so the operator reads "out of paper" instead of
//!    "the printer stopped".
//!
//! Raw/ESC-POS printers still report success whenever the bytes are
//! accepted: they answer paper-out only to a `DLE EOT` status query, which
//! the app does not send yet. That is a documented limit, not an oversight.
//!
//! Every test here needs `cargo` and nothing else, so none of them skip.

use printninja_lib::commands::print::{run_print_with, JobRenderer, PrintRequest};
use printninja_lib::db::Database;
use printninja_lib::queue::PrintQueue;
use printninja_lib::transport::ipp::IppPrinter;
use printninja_lib::transport::raw_tcp::RawTcpPrinter;
use printninja_lib::transport::{PrinterType, TransportRegistry};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Db = Arc<Mutex<Database>>;

/// The vendored crate's manifest, relative to this crate (`src-tauri/`).
const FIXTURE_MANIFEST: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../e2e/support/virtual-printer/Cargo.toml"
);

/// Build the vendored printer once per test binary, then hand back the path.
///
/// Cargo is invoked on a manifest that sits outside this crate with its own
/// target directory, so it never contends with the lock held by the
/// `cargo test` that is running this test. `OnceLock` keeps the eleven tests
/// here from starting eleven builds of the same crate.
fn fixture_binary() -> PathBuf {
    static BIN: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    BIN.get_or_init(|| {
        let manifest = PathBuf::from(FIXTURE_MANIFEST);
        assert!(
            manifest.exists(),
            "the vendored virtual printer is missing at {FIXTURE_MANIFEST}"
        );
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
        let out = Command::new(&cargo)
            .arg("build")
            .arg("--quiet")
            .arg("--manifest-path")
            .arg(&manifest)
            .output()
            .expect("cargo must be on PATH to build the print-test fixture");
        assert!(
            out.status.success(),
            "the vendored virtual printer did not build:\n{}",
            String::from_utf8_lossy(&out.stderr)
        );

        let target = manifest
            .parent()
            .expect("manifest dir")
            .join("target/debug");
        let exe = if cfg!(windows) {
            "virtualprinter.exe"
        } else {
            "virtualprinter"
        };
        let path = target.join(exe);
        assert!(path.exists(), "built fixture missing at {}", path.display());
        path
    })
    .clone()
}

/// Large enough that the kernel cannot swallow it whole.
///
/// On Linux `tcp_wmem` max defaults to 4 MiB, so a job smaller than that is
/// copied into the send buffer, `write_all` returns, and the send is
/// *reported* as done even though nobody ever read it. A deadline can only
/// catch a transfer that is still outstanding — which is the honest limit of
/// a protocol with no reply: a small job to a silent JetDirect printer is
/// still acknowledged by the kernel and still counted as printed. Detecting
/// that case needs a status query, which raw printers only answer when
/// asked (see the note in the header).
///
/// So this is 8 MiB: over the 4 MiB default with room to spare, whatever the
/// peer's advertised window.
const BIG: usize = 8 << 20;

// ───────────────────────────────────────────────────────────────
// harness
// ───────────────────────────────────────────────────────────────

/// A running Virtual Printer on its own set of ports, plus the directory its
/// received jobs land in.
struct VirtualPrinter {
    child: Child,
    offset: u16,
    jobs: PathBuf,
}

impl VirtualPrinter {
    /// Start one on a free offset, retrying when a port is already taken.
    ///
    /// Always available: the fixture is a Rust binary built on demand, so
    /// these tests neither skip nor depend on an interpreter.
    fn start(state: &str) -> Option<Self> {
        let exe = fixture_binary();

        for _ in 0..8 {
            let offset = 11000 + (uuid::Uuid::new_v4().as_u128() as u16) % 2000;
            let jobs = std::env::temp_dir().join(format!("pn-vprinter-{}", uuid::Uuid::new_v4()));
            let child = Command::new(&exe)
                .arg("--host")
                .arg("127.0.0.1")
                .arg("--offset")
                .arg(offset.to_string())
                .arg("--jobs")
                .arg(&jobs)
                .arg("--state")
                .arg(state)
                .arg("--name")
                .arg("PrintNinja Test Printer")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("spawn the virtual printer");

            let mut printer = Self {
                child,
                offset,
                jobs,
            };
            if printer.wait_until_ready() {
                return Some(printer);
            }
            // Port taken or start-up lost the race: try another offset.
        }
        panic!("the virtual printer never became ready on any offset");
    }

    fn http_port(&self) -> u16 {
        80 + self.offset
    }

    fn raw_port(&self) -> u16 {
        9100 + self.offset
    }

    fn ipp_url(&self) -> String {
        format!("http://127.0.0.1:{}/ipp/print", 631 + self.offset)
    }

    /// Poll the dashboard until it answers, so the next line does not race
    /// the listener threads coming up.
    ///
    /// Any status counts as ready, so a future change to how the dashboard
    /// reports an unready state cannot silently stop every test here.
    fn wait_until_ready(&mut self) -> bool {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if self.get("/").starts_with("HTTP/1.") {
                return true;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
        let _ = self.child.kill();
        false
    }

    /// Switch the injected fault state, e.g. `jam` → `/set?state=jam`.
    ///
    /// The dashboard is explicitly exempt from `hang`/`drop` so a state can
    /// always be switched back, which is why this call still answers while
    /// the printer port is wedged.
    fn set_state(&self, state: &str) {
        let answer = self.get(&format!("/set?state={state}"));
        assert!(
            answer.starts_with("HTTP/1.1 200"),
            "the printer refused to change state: {answer}"
        );
    }

    /// A blocking GET on the dashboard port. Deliberately not an HTTP client:
    /// this harness should not need one, and a stalled printer must not take
    /// the test down with it.
    fn get(&self, path: &str) -> String {
        let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", self.http_port())) else {
            return String::new();
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
        if stream.write_all(request.as_bytes()).is_err() {
            return String::new();
        }
        let mut buf = Vec::new();
        // A close before a full body is not an error for this harness.
        let _ = stream.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).into_owned()
    }

    /// The payload of every job the printer has received so far.
    fn received(&self) -> Vec<u8> {
        let mut all = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.jobs) else {
            return all;
        };
        for entry in entries.flatten() {
            if let Ok(bytes) = std::fs::read(entry.path()) {
                all.extend_from_slice(&bytes);
            }
        }
        all
    }

    /// Wait until something recognisable has been stored, or give up.
    fn received_containing(&self, needle: &[u8]) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if self.received().windows(needle.len()).any(|w| w == needle) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }
}

impl Drop for VirtualPrinter {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.jobs);
    }
}

/// An IPP endpoint that accepts the request and never answers: what a wedged
/// device looks like from the client's side.
///
/// Used for the IPP timeout because the Virtual Printer answers its IPP port
/// even in the `hang` state (only raw and LPD carry that guard, so the
/// dashboard can always switch it back).
fn silent_ipp_endpoint() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind silent endpoint");
    let addr = listener.local_addr().expect("silent address");
    listener.set_nonblocking(true).expect("nonblocking accept");
    std::thread::spawn(move || {
        // Hold every connection open for as long as the test needs it:
        // dropping a stream closes the socket, which turns the timeout this
        // exists to provoke into a plain connection error.
        let mut held: Vec<std::net::TcpStream> = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(90);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((stream, _)) => held.push(stream),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }
        std::thread::sleep(Duration::from_secs(1));
        drop(held);
    });
    format!("http://127.0.0.1:{}/ipp/print", addr.port())
}

fn test_db() -> Db {
    let path = std::env::temp_dir().join(format!("printninja_vprint_{}.db", uuid::Uuid::new_v4()));
    let db = Database::open(&format!("sqlite:{}", path.display())).expect("open db");
    Arc::new(Mutex::new(db))
}

fn cache_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("printninja_vcache_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create cache dir");
    dir
}

/// A printer row of the given type, pointing at the virtual printer.
fn seed_printer(db: &Db, name: &str, printer_type: &str, address: &str) {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .execute(
            "INSERT INTO printers (name, type, address, language) VALUES (?1, ?2, ?3, 'pdf')",
            rusqlite::params![name, printer_type, address],
        )
        .expect("seed printer");
}

fn print_request(printer: &str) -> PrintRequest {
    PrintRequest {
        printer_name: printer.to_string(),
        html: "<html><body><p>label</p></body></html>".to_string(),
        page_width_mm: Some(100.0),
        page_height_mm: Some(150.0),
        orientation: Some("portrait".to_string()),
        copies: Some(1),
        margin_top: None,
        margin_right: None,
        margin_bottom: None,
        margin_left: None,
        fit_mode: None,
        template_id: None,
        template_version_id: None,
        data: None,
        data_url: None,
        test: None,
        source: Some("ui".to_string()),
        idempotency_key: None,
    }
}

/// Stands in for Edge, so the pipeline under test is the real one minus the
/// browser. Everything else — the queue permit, the transport, the history
/// row — is the shipping code.
struct FakeRenderer(Vec<u8>);

impl FakeRenderer {
    /// A plausible rendered label.
    fn tiny() -> Self {
        Self(b"%PDF-1.4 virtual-printer-test".to_vec())
    }

    /// Big enough that the kernel will not simply swallow it. See [`BIG`].
    fn bigger_than_the_send_buffer() -> Self {
        Self(vec![0x25; BIG])
    }
}

#[async_trait::async_trait]
impl JobRenderer for FakeRenderer {
    async fn render(
        &self,
        _final_html: &str,
        _w_mm: f64,
        _h_mm: f64,
        _orientation: &str,
    ) -> anyhow::Result<Vec<u8>> {
        Ok(self.0.clone())
    }
}

/// `(status, error)` of the only job row.
fn only_job(db: &Db) -> (String, Option<String>) {
    let guard = db.lock().unwrap();
    guard
        .connection()
        .query_row("SELECT status, error FROM print_jobs", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .expect("one job row")
}

// ───────────────────────────────────────────────────────────────
// a printer that works
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_raw_job_reaches_the_printer() {
    let Some(printer) = VirtualPrinter::start("ok") else {
        return;
    };
    let sender = RawTcpPrinter::new(
        "Virtual".into(),
        format!("127.0.0.1:{}", printer.raw_port()),
    );

    sender.send_raw(b"PNJ-RAW-PAYLOAD").await.expect("raw send");

    // The bytes are the deliverable: a raw printer has no reply to check.
    assert!(
        printer.received_containing(b"PNJ-RAW-PAYLOAD"),
        "the printer stored nothing recognisable"
    );
}

#[tokio::test]
async fn an_ipp_job_reaches_the_printer() {
    let Some(printer) = VirtualPrinter::start("ok") else {
        return;
    };
    let sender = IppPrinter::new("Virtual".into(), printer.ipp_url());

    sender
        .send_pdf(b"%PDF-1.4 hello", 1)
        .await
        .expect("IPP print against a working printer");

    assert!(
        printer.received_containing(b"%PDF-1.4"),
        "the printer stored no PDF"
    );
}

// ───────────────────────────────────────────────────────────────
// the failure modes that used to be invisible
// ───────────────────────────────────────────────────────────────

/// The bug this file exists for: a printer that accepts the connection and
/// then stops reading must produce a timeout, not an infinite job.
///
/// Needs a payload the peer cannot absorb; see [`BIG`].
#[tokio::test]
async fn a_hanging_raw_printer_times_out_instead_of_blocking_forever() {
    let Some(printer) = VirtualPrinter::start("ok") else {
        return;
    };
    printer.set_state("hang");
    let sender = RawTcpPrinter::new(
        "Virtual".into(),
        format!("127.0.0.1:{}", printer.raw_port()),
    );

    let started = Instant::now();
    let err = sender
        .send_raw(&vec![0x42; BIG])
        .await
        .expect_err("a hanging printer must not report success");

    // The deadline is 30s; well past that means it is not being enforced.
    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(60), "took {elapsed:?}");
    assert!(err.contains("stopped responding"), "{err}");
    assert!(err.contains("the printer at"), "{err}");
}

/// A stalled IPP print against a real device must fail with something the
/// operator can read, and never report success.
///
/// The fixture's guard sleeps 30s before dropping the connection — the same
/// 30s our own deadline runs for — so whether the client observes a deadline
/// or an EOF is genuinely a coin toss. Both are mapped to the same sentence
/// (see the `send_pdf` error mapping), which is what makes this assertion
/// stable: the transport must not describe a printer that answered and then
/// went quiet as unreachable. The purely-deterministic timeout case is
/// [`a_silent_ipp_printer_times_out_with_a_readable_message`].
#[tokio::test]
async fn ipp_reports_a_stalled_print_as_a_failure() {
    let Some(printer) = VirtualPrinter::start("ok") else {
        return;
    };
    printer.set_state("hang");
    let sender = IppPrinter::new("Virtual".into(), printer.ipp_url());

    let err = sender
        .send_pdf(b"%PDF-1.4 stalled", 1)
        .await
        .expect_err("a stalled printer must not report success");
    assert!(err.contains("stopped responding"), "{err}");
    assert!(err.contains("the printer at"), "{err}");
    // Not "Could not reach": the connection was made, so the address was fine.
    assert!(!err.contains("Could not reach"), "{err}");
}

/// Nothing answers the socket at all: the transport's own deadline, phrased
/// so the operator knows a wedge rather than a refusal happened.
#[tokio::test]
async fn a_silent_ipp_printer_times_out_with_a_readable_message() {
    let endpoint = silent_ipp_endpoint();
    let sender = IppPrinter::new("Silent".into(), endpoint);

    let started = Instant::now();
    let err = sender
        .send_pdf(b"%PDF-1.4 silent", 1)
        .await
        .expect_err("a silent printer must not report success");

    let elapsed = started.elapsed();
    assert!(elapsed < Duration::from_secs(60), "took {elapsed:?}");
    assert!(err.contains("stopped responding"), "{err}");
    // Not the old opaque `IPP request failed: ...`.
    assert!(!err.starts_with("IPP request failed"), "{err}");
}

#[tokio::test]
async fn a_dropping_raw_printer_reports_a_closed_connection() {
    let Some(printer) = VirtualPrinter::start("ok") else {
        return;
    };
    printer.set_state("drop");
    let sender = RawTcpPrinter::new(
        "Virtual".into(),
        format!("127.0.0.1:{}", printer.raw_port()),
    );

    let err = sender
        .send_raw(&vec![0x43; BIG])
        .await
        .expect_err("a printer that closes immediately must fail the job");
    // Close is reported as a reset or a refused write depending on how fast
    // the peer gets there; both must name the printer.
    assert!(
        err.contains("closed the connection") || err.contains("Could not reach"),
        "{err}"
    );
    assert!(
        err.contains("the printer at") || err.contains("127.0.0.1"),
        "{err}"
    );
}

// ───────────────────────────────────────────────────────────────
// IPP: the operation succeeded, the print did not
// ───────────────────────────────────────────────────────────────

/// The case that used to be reported as a successful print: the operation
/// status is `successful-ok`, and the refusal lives in
/// `printer-state-reasons`, reached only by asking after the fact.
#[tokio::test]
async fn ipp_reports_paper_out_as_a_failure() {
    let Some(printer) = VirtualPrinter::start("paperout") else {
        return;
    };
    let sender = IppPrinter::new("Virtual".into(), printer.ipp_url());

    let err = sender
        .send_pdf(b"%PDF-1.4 paper", 1)
        .await
        .expect_err("a printer with no paper cannot have printed");
    assert!(err.contains("out of paper"), "{err}");
    // The raw keyword travels with the sentence, for support exchanges.
    assert!(err.contains("media-empty"), "{err}");
}

#[tokio::test]
async fn ipp_reports_a_paper_jam_as_a_failure() {
    let Some(printer) = VirtualPrinter::start("jam") else {
        return;
    };
    let sender = IppPrinter::new("Virtual".into(), printer.ipp_url());

    let err = sender
        .send_pdf(b"%PDF-1.4 jam", 1)
        .await
        .expect_err("a jammed printer cannot have printed");
    assert!(err.contains("paper jam"), "{err}");
    assert!(err.contains("media-jam"), "{err}");
}

#[tokio::test]
async fn ipp_reports_an_offline_printer_as_a_failure() {
    let Some(printer) = VirtualPrinter::start("offline") else {
        return;
    };
    let sender = IppPrinter::new("Virtual".into(), printer.ipp_url());

    let err = sender
        .send_pdf(b"%PDF-1.4 offline", 1)
        .await
        .expect_err("an offline printer cannot have printed");
    assert!(err.contains("offline"), "{err}");
    assert!(err.contains("offline-report"), "{err}");
}

// ───────────────────────────────────────────────────────────────
// the message has to reach the operator: history and the response
// ───────────────────────────────────────────────────────────────

/// A jam must end up as a `failed` job with a sentence the operator can act
/// on — not a successful row, and not a raw `IPP status 0x...`.
#[tokio::test]
async fn a_jam_fails_the_job_with_a_message_stored_in_history() {
    let Some(printer) = VirtualPrinter::start("jam") else {
        return;
    };
    let db = test_db();
    seed_printer(&db, "Jam", "ipp", &printer.ipp_url());
    let queue = PrintQueue::new();

    let response = run_print_with(
        &cache_dir(),
        &db,
        &queue,
        print_request("Jam"),
        &FakeRenderer::tiny(),
    )
    .await
    .expect("the pipeline answers");

    assert!(!response.success, "a jam must not report success");
    assert!(
        response
            .error
            .as_deref()
            .is_some_and(|e| e.contains("paper jam")),
        "the response carried no usable message: {:?}",
        response.error
    );

    let (status, error) = only_job(&db);
    assert_eq!(status, "failed", "history must record the failure");
    let error = error.expect("the history row must carry the error");
    assert!(error.contains("paper jam"), "{error}");
    assert!(
        !error.starts_with("IPP status"),
        "not operator-readable: {error}"
    );
}

/// A hung printer must leave a *finished* row. Before the deadline existed
/// the row stayed `printing` forever, which is indistinguishable from a job
/// that is still working.
#[tokio::test]
async fn a_hung_print_ends_as_a_failed_job_not_a_stuck_one() {
    let Some(printer) = VirtualPrinter::start("ok") else {
        return;
    };
    printer.set_state("hang");
    let db = test_db();
    seed_printer(
        &db,
        "Hung",
        "raw_tcp",
        &format!("127.0.0.1:{}", printer.raw_port()),
    );
    let queue = PrintQueue::new();

    let started = Instant::now();
    let response = run_print_with(
        &cache_dir(),
        &db,
        &queue,
        print_request("Hung"),
        &FakeRenderer::bigger_than_the_send_buffer(),
    )
    .await
    .expect("the pipeline answers");

    assert!(started.elapsed() < Duration::from_secs(90), "still slow");
    assert!(!response.success, "a hung printer must not report success");

    let (status, error) = only_job(&db);
    assert_eq!(status, "failed", "history must record the failure");
    assert!(
        error
            .as_deref()
            .is_some_and(|e| e.contains("stopped responding")),
        "the row did not explain the hang: {error:?}"
    );
}

// ───────────────────────────────────────────────────────────────
// dispatch keeps pointing at the same printers
// ───────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_registry_dispatches_a_raw_printer_to_the_virtual_one() {
    let Some(printer) = VirtualPrinter::start("ok") else {
        return;
    };
    TransportRegistry::test_printer(
        &PrinterType::RawTcp,
        "Virtual",
        &format!("127.0.0.1:{}", printer.raw_port()),
    )
    .await
    .expect("test connection to a working raw printer");
}
