//! Process-lifetime operational counters (P2 metrics).
//!
//! The gauges on `/v1/metrics` are read live from the DB on each scrape.
//! These counters are monotonic since boot and make `rate()` queries
//! possible; a restart resets them, which is the documented semantics on
//! both the JSON and the Prometheus endpoints. No client library: the
//! label set is a fixed enum, so rendering is a few lines.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

static JOBS_SUCCESS: AtomicU64 = AtomicU64::new(0);
static JOBS_FAILED: AtomicU64 = AtomicU64::new(0);
static JOBS_CANCELLED: AtomicU64 = AtomicU64::new(0);

/// Record one terminal transition. Call only when the row actually moved
/// (the close paths guard on the previous status, so a retried finish
/// must not double-count).
pub fn count_finished(status: &str) {
    count_finished_n(status, 1);
}

/// Record `n` terminal transitions at once (the restart-recovery sweep
/// fails rows in bulk).
pub fn count_finished_n(status: &str, n: u64) {
    if n == 0 {
        return;
    }
    let counter = match status {
        "success" => &JOBS_SUCCESS,
        "failed" => &JOBS_FAILED,
        "cancelled" => &JOBS_CANCELLED,
        _ => return,
    };
    counter.fetch_add(n, Ordering::Relaxed);
}

/// (success, failed, cancelled) completions since boot, in that order.
pub fn finished_counts() -> (u64, u64, u64) {
    (
        JOBS_SUCCESS.load(Ordering::Relaxed),
        JOBS_FAILED.load(Ordering::Relaxed),
        JOBS_CANCELLED.load(Ordering::Relaxed),
    )
}

/// Prometheus text exposition 0.0.4: the monotonic counters above plus
/// the live gauges read at scrape time. Statuses sort so scrapes diff
/// cleanly; names and label values are static, so no escaping is needed.
pub fn render_prometheus(
    by_status: &HashMap<String, i64>,
    batches_active: i64,
    tracked: usize,
    finished: (u64, u64, u64),
) -> String {
    let mut out = String::from(
        "# HELP printninja_jobs Print jobs by status.\n# TYPE printninja_jobs gauge\n",
    );
    let mut statuses: Vec<(&String, &i64)> = by_status.iter().collect();
    statuses.sort_by(|a, b| a.0.cmp(b.0));
    for (status, count) in statuses {
        out.push_str(&format!("printninja_jobs{{status=\"{status}\"}} {count}\n"));
    }
    out.push_str(
        "# HELP printninja_jobs_completed_total Print jobs finished since boot, by outcome.\n# TYPE printninja_jobs_completed_total counter\n",
    );
    for (outcome, count) in [
        ("success", finished.0),
        ("failed", finished.1),
        ("cancelled", finished.2),
    ] {
        out.push_str(&format!(
            "printninja_jobs_completed_total{{outcome=\"{outcome}\"}} {count}\n"
        ));
    }
    out.push_str(
        "# HELP printninja_batches_active Batches still printing.\n# TYPE printninja_batches_active gauge\n",
    );
    out.push_str(&format!("printninja_batches_active {batches_active}\n"));
    out.push_str(
        "# HELP printninja_printers_tracked Printers the queue currently serialises.\n# TYPE printninja_printers_tracked gauge\n",
    );
    out.push_str(&format!("printninja_printers_tracked {tracked}\n"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_accumulate_per_outcome_and_ignore_unknown() {
        let before = finished_counts();
        count_finished("success");
        count_finished_n("failed", 2);
        count_finished("bogus");
        count_finished_n("cancelled", 0);
        let after = finished_counts();
        assert_eq!(after.0 - before.0, 1);
        assert_eq!(after.1 - before.1, 2);
        assert_eq!(after.2 - before.2, 0);
    }

    #[test]
    fn exposition_marks_types_and_sorts_labels() {
        let by_status: HashMap<String, i64> = [
            ("success".to_string(), 3),
            ("queued".to_string(), 1),
            ("failed".to_string(), 0),
        ]
        .into_iter()
        .collect();
        let text = render_prometheus(&by_status, 2, 1, (10, 4, 1));
        assert!(text.contains("# TYPE printninja_jobs gauge\n"));
        assert!(text.contains("# TYPE printninja_jobs_completed_total counter\n"));
        assert!(text.contains("printninja_jobs{status=\"success\"} 3\n"));
        assert!(text.contains("printninja_jobs_completed_total{outcome=\"failed\"} 4\n"));
        assert!(text.contains("printninja_batches_active 2\n"));
        assert!(text.contains("printninja_printers_tracked 1\n"));
        // Sorted label values: failed < queued < success.
        let failed = text.find("status=\"failed\"").unwrap();
        let queued = text.find("status=\"queued\"").unwrap();
        let success = text.find("status=\"success\"").unwrap();
        assert!(failed < queued && queued < success);
    }
}
