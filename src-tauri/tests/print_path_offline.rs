//! The print path must work with the network off (MIGRATION_PLAN.md phase 2).
//!
//! A print reads the local copy: the template row, the version it points at and,
//! for a reprint, the HTML stored on the original job. Nothing here reaches the
//! share service. This test guards that by reading the sources of every print
//! route and failing if one grows an HTTP client.
//!
//! What it does not prove: that the code compiles against these exact strings,
//! or that a runtime path outside these files is offline. It is a tripwire, not
//! a sandbox.

/// Every file a print can travel through.
const PRINT_PATH: &[(&str, &str)] = &[
    ("commands/print.rs", include_str!("../src/commands/print.rs")),
    ("api/routes.rs", include_str!("../src/api/routes.rs")),
    ("deeplink.rs", include_str!("../src/deeplink.rs")),
    ("commands/batch.rs", include_str!("../src/commands/batch.rs")),
    ("commands/history.rs", include_str!("../src/commands/history.rs")),
    ("render/handlebars.rs", include_str!("../src/render/handlebars.rs")),
    ("render/raster.rs", include_str!("../src/render/raster.rs")),
];

/// Ways this crate could open a connection, none of which belong on the print path.
const NETWORK_MARKERS: &[&str] = &[
    "reqwest",
    "hyper::Client",
    "TcpStream",
    "ureq",
    "isahc",
    "surf::",
];

#[test]
fn the_print_path_contains_no_http_client() {
    let offenders: Vec<String> = PRINT_PATH
        .iter()
        .flat_map(|(name, source)| {
            NETWORK_MARKERS
                .iter()
                .filter(move |marker| source.contains(*marker))
                .map(move |marker| format!("{name}: {marker}"))
        })
        .collect();
    assert!(
        offenders.is_empty(),
        "printing must read the local copy only, but the print path mentions: {offenders:?}"
    );
}

/// A print may fetch live data, but only when the person set a URL for the job.
/// That is a feature of a job, not a step every print takes.
#[test]
fn the_one_data_fetch_is_reachable_only_through_a_job_data_url() {
    let print_rs = include_str!("../src/commands/print.rs");
    let guard = "if let Some(url) = &req.data_url";
    let call = "crate::data::fetcher::DataFetcher::new().fetch(&opts)";

    assert_eq!(
        print_rs.matches("DataFetcher::new()").count(),
        1,
        "a print should fetch at most one dataset, and only the one asked for"
    );
    let guard_at = print_rs.find(guard).unwrap_or_else(|| panic!("no {guard} guard"));
    let call_at = print_rs.find(call).unwrap_or_else(|| panic!("no {call} call"));
    assert!(
        guard_at < call_at,
        "the fetch must sit behind the job's data_url, not run for every print"
    );
}

/// The other half of "prints offline": a template cannot point the printer at a
/// remote asset, so nothing is fetched while printing either.
#[test]
fn the_renderer_refuses_remote_references() {
    let html = include_str!("../src/render/handlebars.rs");
    assert!(
        html.contains("@import") && html.contains("http://"),
        "the renderer is expected to reject @import with a remote URL"
    );

    let issues = printninja::render::handlebars::find_remote_refs(
        "<style>@import url('https://cdn.example.com/l.css');</style>",
        "",
    );
    assert!(
        issues.is_some(),
        "a template that pulls in a remote stylesheet must be refused"
    );
}

/// A reprint replays the HTML stored on the original job, so it needs no
/// template, no version and no network.
#[test]
fn reprint_replays_the_rendered_html_of_the_original_job() {
    let history = include_str!("../src/commands/history.rs");
    let start = history.find("fn reprint_job").expect("reprint_job exists");
    let body = &history[start..];
    let end = body[1..].find("\n}").map(|i| i + 1).unwrap_or(body.len());
    let body = &body[..end];

    assert!(
        body.contains("rendered_html"),
        "a reprint must use the HTML recorded on the original job"
    );
    assert!(
        !body.contains("reqwest") && !body.contains("http"),
        "a reprint must not reach the network"
    );
}