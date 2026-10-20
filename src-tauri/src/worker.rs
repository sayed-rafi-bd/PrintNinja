//! The queued-print worker (Phase 0, item 0.4, P3).
//!
//! Reprint, retry, batch and `POST /v1/print/batch` all write rows with
//! `status = 'queued'`; before this worker existed nothing consumed them,
//! so "queued" meant "never prints" and batch counters never moved. This
//! module is the one place that runs them: it claims a row atomically
//! (`queued` → `printing`, which is also what makes a row cancelled in
//! between simply be skipped), rebuilds the request the row describes and
//! runs the same pipeline a direct print runs — the per-printer permit
//! included ([`crate::commands::print::run_claimed_job`]).
//!
//! A row the worker cannot run ends `failed` with the reason. That is the
//! invariant of a queue: every row ends `success`, `failed` or
//! `cancelled`; none stays `queued` or `printing` forever. Rows a dead
//! process left `printing` are failed at startup by
//! [`Worker::recover_interrupted`] — re-printing them automatically could
//! duplicate labels, so the person decides with a retry.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::commands::print::{run_claimed_job, JobRenderer};
use crate::db::DbState;
use crate::error::AppResult;
use crate::queue::PrintQueue;
use crate::render::PdfRenderer;

/// How often the worker re-scans the queue even without a wake-up, so a
/// missed wake can never strand a row.
const SWEEP: Duration = Duration::from_secs(5);

/// At most this many queued jobs run at once. The per-printer permit
/// serialises each printer's own jobs; this bounds how many renders sit in
/// flight at all, so a 5,000-record batch cannot launch 5,000 renders.
const MAX_IN_FLIGHT: usize = 4;

/// Consumes `queued` print jobs from the database.
pub struct Worker {
    db: DbState,
    queue: PrintQueue,
    cache_dir: PathBuf,
    in_flight: Arc<Semaphore>,
}

impl Worker {
    pub fn new(db: DbState, queue: PrintQueue, cache_dir: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            db,
            queue,
            cache_dir,
            in_flight: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
        })
    }

    /// Fail the rows a dead process left in `printing`: they belong to
    /// nobody, and re-printing them automatically could duplicate labels.
    /// Returns how many rows were failed.
    pub fn recover_interrupted(&self) -> AppResult<usize> {
        let guard = self
            .db
            .lock()
            .map_err(|_| crate::error::AppError::Internal("DB lock poisoned".into()))?;
        let n = guard.connection().execute(
            "UPDATE print_jobs
             SET status = 'failed', error = 'interrupted by application restart',
                 finished_at = datetime('now')
             WHERE status = 'printing'",
            [],
        )?;
        Ok(n)
    }

    /// Claim and run every job currently `queued`, oldest first; returns how
    /// many jobs were claimed.
    ///
    /// Jobs for different printers run in parallel (bounded by
    /// `MAX_IN_FLIGHT`); one printer's own jobs stay serialised by the
    /// per-printer permit inside the pipeline.
    pub async fn drain(self: &Arc<Self>, renderer: Arc<dyn JobRenderer>) -> usize {
        let mut set = JoinSet::new();
        let mut claimed = 0usize;

        while let Some(job_id) = claim_next(&self.db) {
            let Ok(permit) = self.in_flight.clone().acquire_owned().await else {
                break; // the semaphore is closed: nothing more may run
            };
            let worker = Arc::clone(self);
            let renderer = renderer.clone();
            set.spawn(async move {
                let _permit = permit;
                match run_claimed_job(
                    &worker.cache_dir,
                    &worker.db,
                    &worker.queue,
                    job_id,
                    renderer.as_ref(),
                )
                .await
                {
                    Ok(resp) => {
                        tracing::info!(job_id, success = resp.success, "queued job finished")
                    }
                    Err(e) => tracing::error!(job_id, error = %e, "queued job errored"),
                }
                // The batch moves with every job that ends: counters first,
                // then the batch's own end state once nothing is left.
                if let Some(batch_id) = batch_of(&worker.db, job_id) {
                    let _ = update_batch_progress(&worker.db, batch_id);
                }
            });
            claimed += 1;
        }

        while let Some(res) = set.join_next().await {
            if let Err(e) = res {
                tracing::error!(error = %e, "queued job task panicked");
            }
        }
        claimed
    }

    /// The production loop: drain what is queued, then wait for a wake-up
    /// or the sweep interval, whichever comes first.
    pub async fn run(self: &Arc<Self>) {
        let renderer: Arc<dyn JobRenderer> = Arc::new(PdfRenderer::new(self.cache_dir.clone()));
        loop {
            let n = self.drain(renderer.clone()).await;
            if n > 0 {
                tracing::info!(jobs = n, "drained queued print jobs");
            }
            tokio::select! {
                _ = self.queue.wait_for_work() => {}
                _ = tokio::time::sleep(SWEEP) => {}
            }
        }
    }
}

/// Spawn the production worker: fail rows a dead process left running, then
/// consume the queue for the life of the app.
pub fn spawn(db: DbState, queue: PrintQueue, cache_dir: PathBuf) {
    let worker = Worker::new(db, queue, cache_dir);
    tauri::async_runtime::spawn(async move {
        match worker.recover_interrupted() {
            Ok(0) => {}
            Ok(n) => tracing::warn!(jobs = n, "failed jobs interrupted by the previous shutdown"),
            Err(e) => tracing::error!(error = %e, "could not recover interrupted jobs"),
        }
        worker.run().await;
    });
}

/// Claim the oldest `queued` row: the atomic `queued` → `printing` flip is
/// what stops two claimers from printing one row twice, and what makes a
/// row cancelled in between simply be skipped. A batch shows `printing` as
/// soon as one of its jobs starts.
fn claim_next(db: &DbState) -> Option<i64> {
    loop {
        let id = {
            let guard = db.lock().ok()?;
            guard
                .connection()
                .query_row(
                    "SELECT id FROM print_jobs WHERE status = 'queued' ORDER BY id LIMIT 1",
                    [],
                    |r| r.get(0),
                )
                .ok()?
        };

        let claimed = {
            let guard = db.lock().ok()?;
            let conn = guard.connection();
            let n = conn
                .execute(
                    "UPDATE print_jobs
                     SET status = 'printing', started_at = datetime('now'), error = NULL
                     WHERE id = ?1 AND status = 'queued'",
                    [id],
                )
                .unwrap_or(0);
            if n == 1 {
                let _ = conn.execute(
                    "UPDATE batches SET status = 'printing'
                     WHERE id = (SELECT batch_id FROM print_jobs WHERE id = ?1)
                       AND status = 'queued'",
                    [id],
                );
            }
            n
        };

        if claimed == 1 {
            return Some(id);
        }
        // The row vanished under us (cancelled, or already claimed): next.
    }
}

fn batch_of(db: &DbState, job_id: i64) -> Option<i64> {
    let guard = db.lock().ok()?;
    guard
        .connection()
        .query_row(
            "SELECT batch_id FROM print_jobs WHERE id = ?1",
            [job_id],
            |r| r.get(0),
        )
        .ok()
        .flatten()
}

/// Move a batch's counters and end state with the jobs that finished.
///
/// `done` counts records that reached a terminal state, `failed` the
/// failures among them; when nothing is left to run the batch ends
/// `success`, or `failed` when any record failed. A cancelled batch stays
/// `cancelled` — the guard keeps finished jobs from resurrecting it.
fn update_batch_progress(db: &DbState, batch_id: i64) -> AppResult<()> {
    let guard = db
        .lock()
        .map_err(|_| crate::error::AppError::Internal("DB lock poisoned".into()))?;
    guard.connection().execute(
        "UPDATE batches SET
            done = (SELECT COUNT(*) FROM print_jobs
                     WHERE batch_id = ?1 AND status IN ('success', 'failed', 'cancelled')),
            failed = (SELECT COUNT(*) FROM print_jobs
                       WHERE batch_id = ?1 AND status = 'failed'),
            status = CASE
                WHEN (SELECT COUNT(*) FROM print_jobs
                       WHERE batch_id = ?1 AND status IN ('queued', 'printing')) > 0
                    THEN 'printing'
                WHEN (SELECT COUNT(*) FROM print_jobs
                       WHERE batch_id = ?1 AND status = 'failed') > 0
                    THEN 'failed'
                ELSE 'success'
            END
         WHERE id = ?1 AND status != 'cancelled'",
        [batch_id],
    )?;
    Ok(())
}
