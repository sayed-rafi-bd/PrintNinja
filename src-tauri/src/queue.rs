//! Print queue: per-printer serialisation and job admission.
//!
//! # Why a queue at all
//!
//! A thermal printer is a single-threaded device. Sending two jobs to the
//! same physical printer concurrently interleaves their bytes and produces
//! garbled, half-overlapping labels. So every job destined for a given
//! printer must be serialised behind that printer's semaphore.
//!
//! Jobs to *different* printers must still run in parallel, which is why the
//! semaphores are keyed by printer id rather than being a single global lock.
//!
//! # Why `&self` everywhere
//!
//! The first version kept its semaphore map as a plain `HashMap` and took
//! `&mut self` in `get_semaphore`. That cannot be called from an async task
//! (the borrow is held across an await point) and made the queue impossible
//! to share between the Tauri command handlers, the REST API routes, and a
//! background worker. The map now lives behind an `Arc<Mutex<..>>` so the
//! whole queue is `Clone` + `Send` + `Sync` and every method takes `&self`.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, Mutex, Semaphore};

/// Upper bound on queued jobs before `submit` starts applying back-pressure.
pub const QUEUE_CAPACITY: usize = 100;

/// How long `submit` waits for room in the channel before giving up.
const SUBMIT_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueJob {
    pub job_id: String,
    pub printer_id: String,
    pub data: Vec<u8>,
    pub mime_type: String,
    pub copies: u32,
}

/// Per-printer serialisation plus a bounded admission channel.
///
/// Clone is cheap: every clone shares the same semaphore map and the same
/// channel, so all senders observe the same queue depth.
#[derive(Clone)]
pub struct PrintQueue {
    semaphores: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    tx: mpsc::Sender<QueueJob>,
    submit_timeout: Arc<Duration>,
}

impl std::fmt::Debug for PrintQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrintQueue")
            .field("capacity", &QUEUE_CAPACITY)
            .finish_non_exhaustive()
    }
}

impl PrintQueue {
    pub fn new() -> (Self, mpsc::Receiver<QueueJob>) {
        Self::build(QUEUE_CAPACITY, Duration::from_secs(SUBMIT_TIMEOUT_SECS))
    }

    /// Build a queue with a custom capacity and back-pressure timeout.
    ///
    /// Exposed so tests can exercise the "queue is full" path without
    /// waiting out the production timeout.
    pub fn build(capacity: usize, submit_timeout: Duration) -> (Self, mpsc::Receiver<QueueJob>) {
        let (tx, rx) = mpsc::channel(capacity);
        let queue = Self {
            semaphores: Arc::new(Mutex::new(HashMap::new())),
            tx,
            submit_timeout: Arc::new(submit_timeout),
        };
        (queue, rx)
    }

    /// Enqueue a job.
    ///
    /// Applies back-pressure rather than blocking forever: if the channel is
    /// full for longer than the submit timeout this fails instead of parking
    /// a Tauri command task indefinitely.
    pub async fn submit(&self, job: QueueJob) -> Result<(), String> {
        let job_id = job.job_id.clone();
        match tokio::time::timeout(*self.submit_timeout, self.tx.send(job)).await {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(format!("Queue rejected job {job_id}: {e}")),
            Err(_) => Err(format!(
                "Queue is full ({} jobs); job {job_id} timed out waiting for room",
                self.tx.max_capacity()
            )),
        }
    }

    /// Jobs waiting to be picked up by a worker.
    pub fn pending(&self) -> usize {
        self.tx.max_capacity() - self.tx.capacity()
    }

    /// True once every receiver has been dropped.
    pub fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }

    /// The permit gate for a printer, created on first use.
    ///
    /// Takes `&self`, so it is callable concurrently from any number of
    /// tasks and from a `dyn` context. Concurrent first-calls for the same
    /// printer all receive the *same* `Arc<Semaphore>`, which is what makes
    /// the serialisation actually work.
    pub async fn semaphore(&self, printer_id: &str) -> Arc<Semaphore> {
        let mut map = self.semaphores.lock().await;
        map.entry(printer_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone()
    }

    /// Run `f` while holding `printer_id`'s permit.
    ///
    /// This is the API callers should use: it makes it impossible to send
    /// without serialising, because you cannot get at the printer any other
    /// way from inside the queue.
    pub async fn with_permit<F, T>(&self, printer_id: &str, f: F) -> Result<T, String>
    where
        F: std::future::Future<Output = Result<T, String>>,
    {
        let sem = self.semaphore(printer_id).await;
        let permit = sem
            .acquire()
            .await
            .map_err(|e| format!("Printer semaphore closed for {printer_id}: {e}"))?;
        let out = f.await;
        drop(permit);
        out
    }

    /// Number of printers currently tracked. Exposed for tests/metrics.
    pub async fn tracked_printers(&self) -> usize {
        self.semaphores.lock().await.len()
    }
}

impl Default for PrintQueue {
    fn default() -> Self {
        Self::new().0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc as StdArc;

    fn job(id: &str, printer: &str) -> QueueJob {
        QueueJob {
            job_id: id.into(),
            printer_id: printer.into(),
            data: vec![1, 2, 3],
            mime_type: "application/pdf".into(),
            copies: 1,
        }
    }

    #[test]
    fn submit_then_receive() {
        runtime().block_on(async {
            let (q, mut rx) = PrintQueue::new();
            q.submit(job("a", "p1")).await.unwrap();
            let got = rx.recv().await.unwrap();
            assert_eq!(got.job_id, "a");
            assert_eq!(got.printer_id, "p1");
        });
    }

    #[test]
    fn pending_tracks_depth() {
        runtime().block_on(async {
            let (q, mut rx) = PrintQueue::new();
            assert_eq!(q.pending(), 0);
            q.submit(job("a", "p1")).await.unwrap();
            assert_eq!(q.pending(), 1);
            let _ = rx.recv().await;
            assert_eq!(q.pending(), 0);
        });
    }

    #[test]
    fn semaphore_is_stable_per_printer() {
        runtime().block_on(async {
            let (q, _rx) = PrintQueue::new();
            let a = q.semaphore("p1").await;
            let b = q.semaphore("p1").await;
            // Same Arc => a permit held via `a` blocks a caller holding `b`.
            assert!(Arc::ptr_eq(&a, &b));
            assert_eq!(q.tracked_printers().await, 1);
        });
    }

    #[test]
    fn different_printers_get_different_semaphores() {
        runtime().block_on(async {
            let (q, _rx) = PrintQueue::new();
            let a = q.semaphore("p1").await;
            let b = q.semaphore("p2").await;
            assert!(!Arc::ptr_eq(&a, &b));
            assert_eq!(q.tracked_printers().await, 2);
        });
    }

    /// Regression for #17: `get_semaphore(&mut self)` could not be called
    /// from a shared/async context at all. `&self` must be usable from many
    /// concurrent tasks, each getting the same gate.
    #[tokio::test]
    async fn semaphore_is_concurrency_safe() {
        let (q, _rx) = PrintQueue::new();
        let handles: Vec<_> = (0..16)
            .map(|_| {
                let q = q.clone();
                tokio::spawn(async move { q.semaphore("p1").await })
            })
            .collect();

        let mut sems = Vec::new();
        for h in handles {
            sems.push(h.await.unwrap());
        }
        for s in &sems {
            assert!(Arc::ptr_eq(s, &sems[0]), "all callers share one gate");
        }
        assert_eq!(q.tracked_printers().await, 1);
    }

    /// The whole point of the queue: two jobs to the SAME printer must not
    /// overlap, or the bytes interleave and the label is garbled.
    #[tokio::test]
    async fn jobs_to_one_printer_are_serialised() {
        let (q, _rx) = PrintQueue::new();
        let inflight = StdArc::new(AtomicUsize::new(0));
        let peak = StdArc::new(AtomicUsize::new(0));

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let q = q.clone();
            let inflight = inflight.clone();
            let peak = peak.clone();
            tasks.push(tokio::spawn(async move {
                q.with_permit("p1", async move {
                    let now = inflight.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    inflight.fetch_sub(1, Ordering::SeqCst);
                    Ok::<(), String>(())
                })
                .await
            }));
        }
        for t in tasks {
            t.await.unwrap().unwrap();
        }
        assert_eq!(
            peak.load(Ordering::SeqCst),
            1,
            "never more than one in flight"
        );
    }

    /// Serialising must not turn the queue into a global lock.
    #[tokio::test]
    async fn jobs_to_different_printers_run_in_parallel() {
        let (q, _rx) = PrintQueue::new();
        let barrier = StdArc::new(tokio::sync::Barrier::new(2));

        let mut tasks = Vec::new();
        for printer in ["p1", "p2"] {
            let q = q.clone();
            let barrier = barrier.clone();
            tasks.push(tokio::spawn(async move {
                q.with_permit(printer, async move {
                    // Both tasks must be able to hold their permit at once;
                    // if the queue serialised globally this deadlocks.
                    barrier.wait().await;
                    Ok::<_, String>(())
                })
                .await
            }));
        }
        for t in tasks {
            tokio::time::timeout(Duration::from_secs(5), t)
                .await
                .expect("different printers must not block each other")
                .unwrap()
                .unwrap();
        }
    }

    #[tokio::test]
    async fn permit_is_released_when_the_work_fails() {
        let (q, _rx) = PrintQueue::new();
        let first = q.with_permit("p1", async {
            Err::<(), String>("printer offline".to_string())
        });
        assert_eq!(first.await.unwrap_err(), "printer offline");

        // A later job must not be stuck behind the failed one.
        q.with_permit("p1", async { Ok::<(), String>(()) })
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn submit_reports_a_closed_queue() {
        let (q, rx) = PrintQueue::new();
        drop(rx);
        assert!(q.is_closed());
        let err = q.submit(job("a", "p1")).await.unwrap_err();
        assert!(err.contains("rejected"), "{err}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn submit_times_out_instead_of_hanging_forever() {
        // A 1-slot channel with a live-but-not-draining receiver: the second
        // submit blocks. It must give up with a clear error, not park a
        // Tauri command forever.
        let (q, _rx) = PrintQueue::build(1, Duration::from_millis(200));
        q.submit(job("first", "p1")).await.unwrap();

        let err = q
            .submit(job("second", "p1"))
            .await
            .expect_err("must not block past the submit timeout");
        assert!(err.contains("Queue is full"), "{err}");
        assert!(err.contains("second"), "{err}");
    }

    #[tokio::test]
    async fn clone_shares_one_queue() {
        let (q, mut rx) = PrintQueue::new();
        let q2 = q.clone();
        q2.submit(job("from-clone", "p1")).await.unwrap();
        assert_eq!(q.pending(), 1);
        assert_eq!(rx.recv().await.unwrap().job_id, "from-clone");
    }

    /// Minimal single-threaded runtime for the `#[test]` cases that need to
    /// call `block_on`. `with_permit` uses `tokio::time`, which a bare
    /// `Runtime` does not enable.
    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }
}
