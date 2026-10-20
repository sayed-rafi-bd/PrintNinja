//! Print queue: per-printer serialisation plus worker wake-ups.
//!
//! # Why a queue at all
//!
//! A thermal printer is a single-threaded device. Sending two jobs to the
//! same physical printer concurrently interleaves their bytes and produces
//! garbled, half-overlapping labels. So every job destined for a given
//! printer must be serialised behind that printer's semaphore.
//!
//! Jobs to *different* printers must still run in parallel, which is why the
//! semaphores are keyed by printer rather than being a single global lock.
//!
//! # Why `&self` everywhere
//!
//! The first version kept its semaphore map as a plain `HashMap` and took
//! `&mut self` in `get_semaphore`. That cannot be called from an async task
//! (the borrow is held across an await point) and made the queue impossible
//! to share between the Tauri command handlers, the REST API routes, and a
//! background worker. The map now lives behind an `Arc<Mutex<..>>` so the
//! whole queue is `Clone` + `Send` + `Sync` and every method takes `&self`.
//!
//! # What replaced the channel (Phase 0, P8)
//!
//! The queue used to own an mpsc channel whose receiver only logged the jobs
//! it admitted: `submit` was back-pressure theatre, because nothing was ever
//! consumed from it. Queued work now lives in the database — a row with
//! `status = 'queued'` — and [`crate::worker::Worker`] is the one place that
//! consumes it. What the queue keeps is the part that was always real (the
//! per-printer semaphores, now also bounding global in-flight sends) plus
//! the one thing a database queue still needs from a shared object: a way to
//! wake the worker the moment rows appear.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify, Semaphore};

/// Upper bound on sends in flight across all printers. Two jobs for the
/// same printer are already serialised by that printer's semaphore; this
/// keeps a burst of prints (a big batch drained at once) from growing
/// without limit.
pub const MAX_IN_FLIGHT_SENDS: usize = 100;

/// Per-printer serialisation, a global in-flight bound, and a wake-up
/// channel for the print worker.
///
/// Clone is cheap: every clone shares the same semaphore map, the same
/// in-flight budget and the same wake-up target.
#[derive(Clone)]
pub struct PrintQueue {
    semaphores: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    in_flight: Arc<Semaphore>,
    work: Arc<Notify>,
}

impl std::fmt::Debug for PrintQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PrintQueue")
            .field("max_in_flight", &MAX_IN_FLIGHT_SENDS)
            .finish_non_exhaustive()
    }
}

impl PrintQueue {
    pub fn new() -> Self {
        Self {
            semaphores: Arc::new(Mutex::new(HashMap::new())),
            in_flight: Arc::new(Semaphore::new(MAX_IN_FLIGHT_SENDS)),
            work: Arc::new(Notify::new()),
        }
    }

    /// The key a printer's permit is stored under.
    ///
    /// Case- and padding-insensitive (P8): "Desk" and "desk" are one
    /// physical printer and must share one lock, exactly like the printer
    /// lookup itself, which is `COLLATE NOCASE`.
    fn printer_key(printer_id: &str) -> String {
        printer_id.trim().to_ascii_lowercase()
    }

    /// The permit gate for a printer, created on first use.
    ///
    /// Takes `&self`, so it is callable concurrently from any number of
    /// tasks and from a `dyn` context. Concurrent first-calls for the same
    /// printer all receive the *same* `Arc<Semaphore>`, which is what makes
    /// the serialisation actually work.
    pub async fn semaphore(&self, printer_id: &str) -> Arc<Semaphore> {
        let mut map = self.semaphores.lock().await;
        map.entry(Self::printer_key(printer_id))
            .or_insert_with(|| Arc::new(Semaphore::new(1)))
            .clone()
    }

    /// Run `f` while holding the printer's permit and one slot of the global
    /// in-flight budget.
    ///
    /// This is the API callers should use: it makes it impossible to send
    /// without serialising, because you cannot get at the printer any other
    /// way from inside the queue. Permits are always acquired in one order —
    /// global, then per-printer — so two held permits can never deadlock.
    pub async fn with_permit<F, T>(&self, printer_id: &str, f: F) -> Result<T, String>
    where
        F: std::future::Future<Output = Result<T, String>>,
    {
        let global = self
            .in_flight
            .acquire()
            .await
            .map_err(|e| format!("Print queue closed: {e}"))?;
        let sem = self.semaphore(printer_id).await;
        let printer = sem
            .acquire()
            .await
            .map_err(|e| format!("Printer semaphore closed for {printer_id}: {e}"))?;
        let out = f.await;
        drop(printer);
        drop(global);
        out
    }

    /// Wake the worker: rows were queued (or re-queued) in the database.
    ///
    /// `Notify` stores one permit when no worker is waiting, so a wake that
    /// lands mid-drain is not lost — the worker scans the queue when it next
    /// waits.
    pub fn kick(&self) {
        self.work.notify_one();
    }

    /// Wait for the next [`Self::kick`].
    pub async fn wait_for_work(&self) {
        self.work.notified().await;
    }

    /// Number of printers currently tracked. Exposed for tests/metrics.
    pub async fn tracked_printers(&self) -> usize {
        self.semaphores.lock().await.len()
    }
}

impl Default for PrintQueue {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc as StdArc;
    use std::time::Duration;

    #[test]
    fn semaphore_is_stable_per_printer() {
        runtime().block_on(async {
            let q = PrintQueue::new();
            let a = q.semaphore("p1").await;
            let b = q.semaphore("p1").await;
            // Same Arc => a permit held via `a` blocks a caller holding `b`.
            assert!(Arc::ptr_eq(&a, &b));
            assert_eq!(q.tracked_printers().await, 1);
        });
    }

    /// P8: the permit key used to be the printer name as typed, so "Desk"
    /// and "desk" got separate locks and two jobs could overlap on one
    /// printer. Lookups ignore case; the queue key must too.
    #[test]
    fn the_printer_key_ignores_case_and_padding() {
        runtime().block_on(async {
            let q = PrintQueue::new();
            let a = q.semaphore("Desk").await;
            let b = q.semaphore("desk").await;
            let c = q.semaphore("  DESK  ").await;
            assert!(Arc::ptr_eq(&a, &b), "Desk and desk share one lock");
            assert!(Arc::ptr_eq(&a, &c), "padding is trimmed");
            assert_eq!(q.tracked_printers().await, 1);
        });
    }

    #[test]
    fn different_printers_get_different_semaphores() {
        runtime().block_on(async {
            let q = PrintQueue::new();
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
        let q = PrintQueue::new();
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
        let q = PrintQueue::new();
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
        let q = PrintQueue::new();
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
        let q = PrintQueue::new();
        let first = q.with_permit("p1", async {
            Err::<(), String>("printer offline".to_string())
        });
        assert_eq!(first.await.unwrap_err(), "printer offline");

        // A later job must not be stuck behind the failed one.
        q.with_permit("p1", async { Ok::<(), String>(()) })
            .await
            .unwrap();
    }

    /// Clones are one queue: they share printer gates and the wake-up, so a
    /// kick from any clone wakes the worker waiting on another.
    #[tokio::test]
    async fn clone_shares_one_queue() {
        let q1 = PrintQueue::new();
        let q2 = q1.clone();

        let a = q1.semaphore("p1").await;
        let b = q2.semaphore("p1").await;
        assert!(Arc::ptr_eq(&a, &b), "clones share printer gates");
        assert_eq!(q2.tracked_printers().await, 1);

        let waiting = q2.wait_for_work();
        q1.kick();
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("a kick from any clone wakes the worker");
    }

    /// A kick wakes a waiting worker — and one that lands while the worker
    /// is busy is not lost, because `Notify` keeps a permit.
    #[tokio::test]
    async fn a_kick_wakes_the_worker() {
        let q = PrintQueue::new();
        let waiting = q.wait_for_work();
        q.kick();
        tokio::time::timeout(Duration::from_secs(1), waiting)
            .await
            .expect("a kick wakes a waiter");
    }

    #[tokio::test]
    async fn a_kick_that_lands_early_is_not_lost() {
        let q = PrintQueue::new();
        q.kick();
        tokio::time::timeout(Duration::from_secs(1), q.wait_for_work())
            .await
            .expect("a stored permit wakes the next waiter");
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
