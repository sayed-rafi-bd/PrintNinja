//! Launching headless Edge for one render.
//!
//! Every PDF and screenshot render runs `msedge.exe` as its own process, on
//! its own `--user-data-dir`: a profile that is not the user's keeps headless
//! Edge from delegating to an already-open Edge window and exiting without
//! writing anything.
//!
//! Starting Edge on a brand-new, empty profile is the slow part of a print,
//! because it initialises the whole profile from scratch every time. So the
//! first job to find the reusable profile free runs on it and keeps what Edge
//! wrote there. A job that finds it busy, or whose run on it failed, uses a
//! throwaway profile exactly as every job used to, and removes it afterwards.
//! Two Edge processes never share a profile directory.
//!
//! The launching logic is platform independent so tests can drive it with a
//! fake executable. Only the Edge lookup (in `mod.rs`) and the no-console
//! flag below are Windows-specific.
// Only Windows calls `shared()`; the unit tests build the module everywhere.
#![cfg_attr(not(windows), allow(dead_code))]

use anyhow::Result;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// How long a job waits for a warm-up that is already running before it gives
/// up on the reusable profile and uses a throwaway one.
const WARM_UP_WAIT: Duration = Duration::from_secs(15);

/// A warm-up that has not finished by now is stuck; it is killed and the
/// profile discarded.
const WARM_UP_LIMIT: Duration = Duration::from_secs(30);

/// Directory, inside the cache dir, of the reusable profile.
///
/// Deliberately not named `edge-profile-*`: the startup sweep removes those,
/// and this one is meant to survive between runs.
pub const WARM_PROFILE_DIR: &str = "edge-warm-profile";

/// What one launch did, for the per-render timing log.
pub struct EdgeRun {
    pub output: std::process::Output,
    /// Edge process start to exit, in milliseconds.
    pub edge_ms: u64,
    /// Removing the throwaway profile afterwards (0 for the reusable one).
    pub cleanup_ms: u64,
    /// Whether the run used the reusable profile.
    pub warm: bool,
}

#[derive(Default)]
pub struct EdgeLauncher {
    /// Held for as long as a job (or the startup warm-up) runs on the
    /// reusable profile.
    warm: Arc<tokio::sync::Mutex<()>>,
    /// True while the startup warm-up owns the reusable profile. A job that
    /// sees it waits for the warm-up instead of building a cold throwaway
    /// profile, which is the slow print the warm-up exists to prevent.
    warming: Arc<AtomicBool>,
}

/// The startup warm-up's claim on the reusable profile, taken synchronously
/// so no job can slip in between app start and the warm-up's first await.
/// Dropping it, finished or not, releases the profile and clears the flag.
pub struct WarmUp {
    _guard: tokio::sync::OwnedMutexGuard<()>,
    warming: Arc<AtomicBool>,
}

impl Drop for WarmUp {
    fn drop(&mut self) {
        self.warming.store(false, Ordering::SeqCst);
    }
}

impl WarmUp {
    /// Run one throwaway render on the reusable profile so Edge initialises
    /// it now, before the first real job. `produced` is the file `args`
    /// make Edge write; it is removed afterwards. A failed or stuck warm-up
    /// deletes the profile so the first job starts clean rather than on a
    /// half-written one.
    pub async fn run(self, edge: &Path, cache_dir: &Path, args: &[String], produced: &Path) {
        let profile = cache_dir.join(WARM_PROFILE_DIR);
        let started = Instant::now();
        let result = tokio::time::timeout(WARM_UP_LIMIT, spawn(edge, &profile, args)).await;
        let edge_ms = ms(started);
        let ok = match &result {
            Ok(Ok(output)) => output.status.success() && produced.exists(),
            _ => false,
        };
        let _ = tokio::fs::remove_file(produced).await;
        if ok {
            tracing::info!(edge_ms, "Edge warmed up");
        } else {
            match result {
                Ok(Ok(output)) => tracing::warn!(
                    status = %output.status,
                    stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                    "Edge warm-up failed; discarding the reusable profile"
                ),
                Ok(Err(e)) => tracing::warn!(error = %e, "Edge warm-up could not start"),
                Err(_) => tracing::warn!("Edge warm-up timed out; discarding the reusable profile"),
            }
            remove_profile(&profile).await;
        }
        // `self` drops here: lock released, `warming` cleared.
    }
}

/// The launcher every render in this process goes through. A `PdfRenderer` is
/// built per job, so the lock that guards the reusable profile cannot live in
/// it.
pub fn shared() -> &'static EdgeLauncher {
    static LAUNCHER: OnceLock<EdgeLauncher> = OnceLock::new();
    LAUNCHER.get_or_init(EdgeLauncher::new)
}

impl EdgeLauncher {
    pub fn new() -> Self {
        Self::default()
    }

    /// Claim the reusable profile for the startup warm-up. `None` when a job
    /// already holds it, in which case the profile is being warmed anyway.
    /// Synchronous on purpose: call it before the worker starts.
    pub fn claim_warm_up(&self) -> Option<WarmUp> {
        let guard = self.warm.clone().try_lock_owned().ok()?;
        self.warming.store(true, Ordering::SeqCst);
        Some(WarmUp {
            _guard: guard,
            warming: self.warming.clone(),
        })
    }

    /// Run `edge` with `args` and report how it went.
    ///
    /// `produced` is the file the run is expected to write. A run on the
    /// reusable profile that exits non-zero or leaves no file there is
    /// treated as a damaged profile: it is deleted and the job runs again on
    /// a throwaway one, so a bad profile costs one slow print, not a failing
    /// printer. The throwaway run's outcome is returned as it is; judging it
    /// is the caller's job.
    pub async fn run(
        &self,
        edge: &Path,
        cache_dir: &Path,
        args: &[String],
        produced: &Path,
    ) -> Result<EdgeRun> {
        // `try_lock`, never an open-ended `lock`: waiting for the reusable
        // profile would serialise renders that used to run side by side. The
        // one exception is the startup warm-up, which is nearly done and
        // leaves a profile that makes this job fast; wait for that, briefly.
        let guard = if self.warming.load(Ordering::SeqCst) {
            tokio::time::timeout(WARM_UP_WAIT, self.warm.lock())
                .await
                .ok()
        } else {
            self.warm.try_lock().ok()
        };
        if let Some(_guard) = guard {
            let profile = cache_dir.join(WARM_PROFILE_DIR);
            let started = Instant::now();
            let result = spawn(edge, &profile, args).await;
            let edge_ms = ms(started);
            match result {
                Ok(output) if output.status.success() && produced.exists() => {
                    return Ok(EdgeRun {
                        output,
                        edge_ms,
                        cleanup_ms: 0,
                        warm: true,
                    });
                }
                Ok(output) => tracing::warn!(
                    status = %output.status,
                    stderr = %String::from_utf8_lossy(&output.stderr).trim(),
                    "Edge failed on the reusable profile; retrying on a throwaway one"
                ),
                Err(e) => tracing::warn!(
                    error = %e,
                    "Edge could not start on the reusable profile; retrying on a throwaway one"
                ),
            }
            let _ = tokio::fs::remove_file(produced).await;
            remove_profile(&profile).await;
        }

        let profile = cache_dir.join(format!("edge-profile-{}", uuid::Uuid::new_v4()));
        let started = Instant::now();
        let result = spawn(edge, &profile, args).await;
        let edge_ms = ms(started);
        // Removed whether the run worked or not.
        let cleanup = Instant::now();
        remove_profile(&profile).await;
        let cleanup_ms = ms(cleanup);
        Ok(EdgeRun {
            output: result?,
            edge_ms,
            cleanup_ms,
            warm: false,
        })
    }
}

fn ms(since: Instant) -> u64 {
    since.elapsed().as_millis() as u64
}

/// One Edge process, run to completion. `kill_on_drop` so a job that is
/// dropped mid-render does not leave Edge running on the profile.
async fn spawn(
    edge: &Path,
    profile: &Path,
    args: &[String],
) -> std::io::Result<std::process::Output> {
    let mut cmd = tokio::process::Command::new(edge);
    // After `args`: the unit tests run `sh script.sh <args>`, where a leading
    // switch would be read as an option of `sh`. Edge does not care.
    cmd.args(args)
        .arg(format!("--user-data-dir={}", profile.to_string_lossy()))
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(windows::Win32::System::Threading::CREATE_NO_WINDOW.0);
    cmd.output().await
}

/// Best-effort removal of an Edge profile, with retries.
///
/// Edge can still hold handles briefly after it exits; a single
/// fire-and-forget `remove_dir_all` then left the whole profile in the
/// cache dir — its certificate-transparency and trust material showed up
/// as a stray `.pem` next to `last-render.pdf`, looking like the app had
/// written a key file. Retry, and log if the profile really cannot go.
async fn remove_profile(dir: &Path) {
    for attempt in 0..5u32 {
        match tokio::fs::remove_dir_all(dir).await {
            Ok(()) => return,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) if attempt < 4 => {
                tracing::debug!(error = %e, "Edge still holds its profile; retrying removal");
                tokio::time::sleep(std::time::Duration::from_millis(
                    80 * u64::from(attempt + 1),
                ))
                .await;
            }
            Err(e) => {
                tracing::warn!(
                    dir = %dir.display(),
                    error = %e,
                    "Edge profile could not be removed; it holds no secrets \
                     but should not accumulate in the cache dir"
                );
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A stand-in for Edge, run as `sh <script> <args…>`. It "initialises"
    /// the profile it is given, counts its runs there, optionally takes a
    /// while (`--slow`), fails if the profile holds a `poison` file, and
    /// otherwise writes the `--print-to-pdf=` target.
    const FAKE_EDGE: &str = r#"
profile=""; out=""; slow=0
for a in "$@"; do
  case "$a" in
    --user-data-dir=*) profile="${a#--user-data-dir=}";;
    --print-to-pdf=*) out="${a#--print-to-pdf=}";;
    --slow) slow=1;;
  esac
done
mkdir -p "$profile"
echo run >> "$profile/runs"
[ "$slow" = 1 ] && sleep 0.4
[ -e "$profile/poison" ] && exit 1
echo ok > "$out"
"#;

    struct Rig {
        cache: PathBuf,
        script: PathBuf,
    }

    impl Rig {
        fn new() -> Self {
            let cache = std::env::temp_dir().join(format!("pn-edge-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&cache).unwrap();
            let script = cache.join("fake-edge.sh");
            std::fs::write(&script, FAKE_EDGE).unwrap();
            Rig { cache, script }
        }

        fn args(&self, out: &str, extra: &[&str]) -> Vec<String> {
            let mut a = vec![self.script.to_string_lossy().into_owned()];
            a.extend(extra.iter().map(|s| s.to_string()));
            a.push(format!("--print-to-pdf={}", self.cache.join(out).display()));
            a
        }

        async fn run(&self, launcher: &EdgeLauncher, out: &str, extra: &[&str]) -> Result<EdgeRun> {
            launcher
                .run(
                    Path::new("/bin/sh"),
                    &self.cache,
                    &self.args(out, extra),
                    &self.cache.join(out),
                )
                .await
        }

        fn throwaway_dirs(&self) -> Vec<String> {
            std::fs::read_dir(&self.cache)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("edge-profile-"))
                .collect()
        }
    }

    impl Drop for Rig {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.cache);
        }
    }

    /// The point of the change: the second print runs on the profile the
    /// first one initialised instead of building a new one.
    #[tokio::test]
    async fn consecutive_jobs_reuse_the_warm_profile() {
        let rig = Rig::new();
        let launcher = EdgeLauncher::new();

        let a = rig.run(&launcher, "a.pdf", &[]).await.unwrap();
        let b = rig.run(&launcher, "b.pdf", &[]).await.unwrap();

        assert!(a.warm && b.warm, "both runs used the reusable profile");
        let runs = std::fs::read_to_string(rig.cache.join(WARM_PROFILE_DIR).join("runs")).unwrap();
        assert_eq!(
            runs.lines().count(),
            2,
            "the second run saw the first's profile"
        );
        assert!(
            rig.throwaway_dirs().is_empty(),
            "no throwaway profile was made"
        );
    }

    /// The point of the warm-up: it initialises the profile before any job,
    /// and the first job then runs on it.
    #[tokio::test]
    async fn warm_up_initialises_the_profile_for_the_first_job() {
        let rig = Rig::new();
        let launcher = EdgeLauncher::new();

        let claim = launcher.claim_warm_up().expect("profile is free");
        claim
            .run(
                Path::new("/bin/sh"),
                &rig.cache,
                &rig.args("warm.pdf", &[]),
                &rig.cache.join("warm.pdf"),
            )
            .await;
        assert!(
            !rig.cache.join("warm.pdf").exists(),
            "warm-up output removed"
        );

        let a = rig.run(&launcher, "a.pdf", &[]).await.unwrap();
        assert!(a.warm);
        let runs = std::fs::read_to_string(rig.cache.join(WARM_PROFILE_DIR).join("runs")).unwrap();
        assert_eq!(
            runs.lines().count(),
            2,
            "warm-up run + first job, one profile"
        );
        assert!(rig.throwaway_dirs().is_empty());
    }

    /// A job that arrives while the warm-up runs waits for it rather than
    /// paying for a cold throwaway profile.
    #[tokio::test]
    async fn a_job_during_warm_up_waits_for_it() {
        let rig = Rig::new();
        let launcher = EdgeLauncher::new();
        let claim = launcher.claim_warm_up().expect("profile is free");

        let warm_args = rig.args("warm.pdf", &["--slow"]);
        let warm_out = rig.cache.join("warm.pdf");
        let (_, job) = tokio::join!(
            claim.run(Path::new("/bin/sh"), &rig.cache, &warm_args, &warm_out),
            rig.run(&launcher, "a.pdf", &[]),
        );

        assert!(
            job.unwrap().warm,
            "the job waited and used the warm profile"
        );
        assert!(rig.throwaway_dirs().is_empty());
        let runs = std::fs::read_to_string(rig.cache.join(WARM_PROFILE_DIR).join("runs")).unwrap();
        assert_eq!(runs.lines().count(), 2);
    }

    /// A failed warm-up deletes the profile and releases it.
    #[tokio::test]
    async fn a_failed_warm_up_discards_the_profile() {
        let rig = Rig::new();
        let launcher = EdgeLauncher::new();
        let warm = rig.cache.join(WARM_PROFILE_DIR);
        std::fs::create_dir_all(&warm).unwrap();
        std::fs::write(warm.join("poison"), b"x").unwrap();

        let claim = launcher.claim_warm_up().unwrap();
        claim
            .run(
                Path::new("/bin/sh"),
                &rig.cache,
                &rig.args("warm.pdf", &[]),
                &rig.cache.join("warm.pdf"),
            )
            .await;

        assert!(!warm.exists());
        assert!(launcher.claim_warm_up().is_some(), "profile was released");
    }

    /// Two Edge processes must never share a profile directory: the job that
    /// finds it busy gets a throwaway one, which is removed afterwards.
    #[tokio::test]
    async fn a_busy_warm_profile_sends_the_next_job_to_a_throwaway_one() {
        let rig = Rig::new();
        let launcher = EdgeLauncher::new();

        // `join!` polls the first future first, so it takes the profile and
        // is still holding it (sleeping) when the second one looks.
        let (a, b) = tokio::join!(
            rig.run(&launcher, "a.pdf", &["--slow"]),
            rig.run(&launcher, "b.pdf", &[]),
        );
        let (a, b) = (a.unwrap(), b.unwrap());

        assert!(a.warm, "the first job took the reusable profile");
        assert!(!b.warm, "the second job did not wait for it");
        assert!(rig.cache.join("a.pdf").exists() && rig.cache.join("b.pdf").exists());
        assert!(
            rig.throwaway_dirs().is_empty(),
            "the throwaway profile is removed"
        );
        let runs = std::fs::read_to_string(rig.cache.join(WARM_PROFILE_DIR).join("runs")).unwrap();
        assert_eq!(runs.lines().count(), 1, "only the first job touched it");
    }

    /// A damaged reusable profile costs one slow print, not a failing printer.
    #[tokio::test]
    async fn a_failing_warm_profile_is_dropped_and_the_job_retried() {
        let rig = Rig::new();
        let launcher = EdgeLauncher::new();
        let warm = rig.cache.join(WARM_PROFILE_DIR);
        std::fs::create_dir_all(&warm).unwrap();
        std::fs::write(warm.join("poison"), b"x").unwrap();

        let run = rig.run(&launcher, "a.pdf", &[]).await.unwrap();

        assert!(!run.warm, "the result comes from the throwaway retry");
        assert!(run.output.status.success());
        assert!(rig.cache.join("a.pdf").exists());
        assert!(!warm.exists(), "the damaged profile is deleted");
        assert!(rig.throwaway_dirs().is_empty());

        // The next job starts a fresh reusable profile.
        let next = rig.run(&launcher, "b.pdf", &[]).await.unwrap();
        assert!(next.warm);
    }

    /// A failure that is not the profile's fault still surfaces: both runs
    /// fail, and the caller gets the throwaway run's failing output.
    #[tokio::test]
    async fn a_run_that_fails_everywhere_is_reported_not_hidden() {
        let rig = Rig::new();
        let launcher = EdgeLauncher::new();
        // This Edge fails on any profile, the warm one and the throwaway alike.
        std::fs::write(&rig.script, "exit 3").unwrap();
        let args = vec![
            rig.script.to_string_lossy().into_owned(),
            format!("--print-to-pdf={}", rig.cache.join("a.pdf").display()),
        ];

        let run = launcher
            .run(
                Path::new("/bin/sh"),
                &rig.cache,
                &args,
                &rig.cache.join("a.pdf"),
            )
            .await
            .unwrap();

        assert!(!run.output.status.success());
        assert!(!run.warm);
        assert!(!rig.cache.join("a.pdf").exists());
        assert!(rig.throwaway_dirs().is_empty());
    }

    #[tokio::test]
    async fn a_missing_executable_is_an_error() {
        let rig = Rig::new();
        let launcher = EdgeLauncher::new();
        let missing = rig.cache.join("no-such-edge");
        let err = launcher
            .run(&missing, &rig.cache, &[], &rig.cache.join("a.pdf"))
            .await;
        assert!(err.is_err());
        assert!(rig.throwaway_dirs().is_empty(), "nothing is left behind");
    }
}
