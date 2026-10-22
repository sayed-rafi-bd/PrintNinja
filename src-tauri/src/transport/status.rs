//! Asking a raw printer whether it can print, *before* the job goes out.
//!
//! A raw (JetDirect) printer gives no reply to a job: the bytes are accepted,
//! the send is reported as done, and whatever the printer then does with them
//! is invisible. Every device-side fault — out of paper, jammed, offline —
//! therefore looked like a successful print, because the only evidence lives
//! in a status query nobody was sending. This module asks.
//!
//! One dialect per command language a raw printer can be configured with,
//! picked from the printer's `language` column, so a query is never sent to a
//! printer that speaks a different language (a stray `ESC !?` at a non-TSPL
//! printer would print as text):
//!
//! | language | query | what is read back |
//! |---|---|---|
//! | `escpos` | `DLE EOT 1..4` | Epson status bytes: offline, cover, paper, errors |
//! | `zpl` | `~HS` | Zebra host status line 1: paper-out and pause flags |
//! | `tspl` | `ESC !?` | one byte: head open, jam, paper, ribbon, pause, error |
//!
//! Every other language (PDF, raster, CPCL) has no query worth standing
//! behind, so nothing is sent and those printers behave exactly as before.
//!
//! Two rules keep this from ever being worse than the bug it fixes:
//!
//! 1. **Silence does not block a job the first time.** A printer that has
//!    never answered is assumed not to implement the query — otherwise a
//!    mis-set language would stop every print. Once a printer *has* answered,
//!    silence becomes evidence and the job fails: that reading is required by
//!    Zebra's own spec, which says a Zebra sends no `~HS` reply at all when
//!    media is out, the ribbon is out or the head is open.
//! 2. **An unreadable answer is a healthy answer.** Every decode returns
//!    `None` unless the bytes unmistakably claim otherwise, and an answer
//!    that does not parse still counts as *answering* for rule 1. We would
//!    rather print and be wrong than refuse to print.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use super::PrinterLanguage;

/// What the printer said about itself, in words an operator can act on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fault {
    /// The conditions, phrased the way the IPP path phrases its
    /// `printer-state-reasons`, so the same fault reads the same wherever it
    /// was found.
    pub phrases: Vec<String>,
    /// The bytes behind the claim. A support exchange starts here.
    pub evidence: Vec<String>,
}

impl Fault {
    fn new(phrases: Vec<String>, evidence: Vec<String>) -> Option<Self> {
        if phrases.is_empty() || evidence.is_empty() {
            return None;
        }
        Some(Self { phrases, evidence })
    }

    /// `{at} did not print the job: … [evidence]` — the shape the IPP path
    /// already writes into `print_jobs.error`, where this lands too.
    pub fn message(&self, at: &str) -> String {
        format!(
            "{at} did not print the job: {} [{}]",
            self.phrases.join(" and "),
            self.evidence.join(", ")
        )
    }
}

/// The generic ESC/POS/TSPL error bits, which only say *that* something is
/// wrong. Named causes are preferred (see `finish`), so this is what the
/// operator gets when the printer refused to be more specific.
const GENERIC_ERROR: &str = "it reports an error (check for a paper jam or an open cover)";

/// Append a phrase unless it is already there: several status bytes routinely
/// describe one condition, and "out of paper and out of paper" helps nobody.
fn push(list: &mut Vec<String>, phrase: &str) {
    if !list.iter().any(|p| p == phrase) {
        list.push(phrase.to_string());
    }
}

/// Prefer the named conditions; fall back to the generic one.
///
/// When a printer reports both "its cover is open" and a bare error flag, the
/// cover *is* the error — quoting both would read like two faults.
fn finish(specific: Vec<String>, generic: Vec<String>, evidence: Vec<String>) -> Option<Fault> {
    let phrases = if specific.is_empty() {
        generic
    } else {
        specific
    };
    Fault::new(phrases, evidence)
}

/// A status query we can ask, and an answer we know how to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    /// `DLE EOT 1..4`, Epson's real-time status: the ESC/POS standard, and
    /// answered even while offline or mid-buffer.
    EscPos,
    /// `~HS` (host status), Zebra's three-line reply.
    Zpl,
    /// `ESC !?`, TSPL's status poll: one byte back, "even in the event of a
    /// printer error".
    Tspl,
}

impl Dialect {
    /// The bytes that ask. Four questions for ESC/POS, because each reply is
    /// a single naked byte with no indication of which question it answers —
    /// the order *is* the labelling.
    pub fn query(self) -> Vec<u8> {
        match self {
            Dialect::EscPos => vec![0x10, 0x04, 1, 0x10, 0x04, 2, 0x10, 0x04, 3, 0x10, 0x04, 4],
            Dialect::Zpl => b"~HS".to_vec(),
            Dialect::Tspl => vec![0x1B, b'!', b'?'],
        }
    }

    /// Whether `reply` is complete enough to read — the read stops here
    /// rather than waiting for the printer to close the connection, which it
    /// will only do after its idle timeout.
    pub fn answered(self, reply: &[u8]) -> bool {
        match self {
            Dialect::EscPos => reply.len() >= 4,
            Dialect::Zpl => reply.iter().filter(|&&b| b == 0x02).count() >= 3,
            Dialect::Tspl => !reply.is_empty(),
        }
    }
}

/// The dialect for a printer's configured language, if there is one.
pub fn dialect_for(language: &PrinterLanguage) -> Option<Dialect> {
    match language {
        PrinterLanguage::Escpos => Some(Dialect::EscPos),
        PrinterLanguage::Zpl => Some(Dialect::Zpl),
        PrinterLanguage::Tspl => Some(Dialect::Tspl),
        // PDF is not sent through a dialect at all, and raster and CPCL have
        // no status query with a documented answer.
        PrinterLanguage::Pdf | PrinterLanguage::Raster | PrinterLanguage::Cpcl => None,
    }
}

// ─────────────────────────────────────────────────────────────────────
// decoders
// ─────────────────────────────────────────────────────────────────────

/// Read the four `DLE EOT` answers, in query order.
///
/// Bits follow the Epson TM reference, which every ESC/POS printer we checked
/// copies: `n=1` bit 3 is offline; `n=2` bits 2/5/6 are cover open, paper end
/// and error; `n=3` bits 3/5/6 are cutter, unrecoverable and recoverable
/// error; `n=4` bits 5-6 are paper end. Near-end (bits 2-3) is deliberately
/// not a fault: the printer still prints.
fn escpos(reply: &[u8]) -> Option<Fault> {
    // Which bits in each reply mean "cannot print now".
    const FAULT_BITS: [u8; 4] = [
        0x08, // 1: offline
        0x64, // 2: cover | paper end | error
        0x68, // 3: cutter | unrecoverable | recoverable
        0x60, // 4: paper end (near-end 0x0C excluded)
    ];

    let mut specific = Vec::new();
    let mut generic = Vec::new();
    let mut evidence = Vec::new();

    for (i, &b) in reply.iter().take(4).enumerate() {
        // Structure bits — bits 1 and 4 set, 0 and 7 clear — are fixed in
        // the spec. Anything else is job data or line noise read off a live
        // socket, and trusting it would fail a healthy print.
        if (b & 0x12) != 0x12 || (b & 0x81) != 0 {
            continue;
        }
        if b & FAULT_BITS[i] == 0 {
            continue;
        }
        evidence.push(format!("DLE EOT {} = {b:#04x}", i + 1));
        match i {
            0 => push(&mut specific, "it is offline"),
            1 => {
                if b & 0x04 != 0 {
                    push(&mut specific, "its cover is open");
                }
                if b & 0x20 != 0 {
                    push(&mut specific, "it is out of paper");
                }
                if b & 0x40 != 0 {
                    push(&mut generic, GENERIC_ERROR);
                }
            }
            2 => {
                if b & 0x08 != 0 {
                    push(&mut specific, "the cutter has jammed");
                }
                if b & 0x60 != 0 {
                    push(&mut generic, GENERIC_ERROR);
                }
            }
            _ => push(&mut specific, "it is out of paper"),
        }
    }
    finish(specific, generic, evidence)
}

/// Read Zebra's `~HS` reply: three STX/ETX frames, of which line 1 carries
/// `aaa,b,c,…` — paper-out and pause.
///
/// Line 1 has no jam flag; a real Zebra reports a jam by pausing (read here)
/// or by not answering at all (read by the silence rule).
fn zpl(reply: &[u8]) -> Option<Fault> {
    let start = reply.iter().position(|&b| b == 0x02)? + 1;
    let end = start + reply[start..].iter().position(|&b| b == 0x03)?;
    let line = std::str::from_utf8(&reply[start..end]).ok()?;
    let fields: Vec<&str> = line.split(',').collect();
    if fields.len() < 3 {
        return None;
    }

    let mut phrases = Vec::new();
    let mut evidence = Vec::new();
    // Compared as text rather than parsed: anything that is not exactly `1`
    // is treated as "not set", so a field we do not understand cannot fail a
    // print.
    if fields[1].trim() == "1" {
        push(&mut phrases, "it is out of paper");
        evidence.push("~HS paper-out flag = 1".to_string());
    }
    if fields[2].trim() == "1" {
        push(&mut phrases, "it is paused");
        evidence.push("~HS pause flag = 1".to_string());
    }
    Fault::new(phrases, evidence)
}

/// Read TSPL's `ESC !?`: exactly one byte, a bitmask whose documented values
/// (`00` normal, `01` head open, `04` out of paper … `80` other error) are
/// combinations of the same bits.
fn tspl(reply: &[u8]) -> Option<Fault> {
    if reply.len() != 1 {
        return None;
    }
    let b = reply[0];
    let mut specific = Vec::new();
    let mut generic = Vec::new();
    if b & 0x01 != 0 {
        push(&mut specific, "its print head is open");
    }
    if b & 0x02 != 0 {
        push(&mut specific, "there is a paper jam");
    }
    if b & 0x04 != 0 {
        push(&mut specific, "it is out of paper");
    }
    if b & 0x08 != 0 {
        push(&mut specific, "it has run out of ribbon");
    }
    if b & 0x10 != 0 {
        push(&mut specific, "it is paused");
    }
    if b & 0x40 != 0 {
        push(&mut specific, "its cover is open");
    }
    if b & 0x80 != 0 {
        push(&mut generic, GENERIC_ERROR);
    }
    // 0x20 is "printing" — not a fault — and is the only common bit this
    // leaves out.
    let evidence = if specific.is_empty() && generic.is_empty() {
        Vec::new()
    } else {
        vec![format!("TSPL status {b:#04x}")]
    };
    finish(specific, generic, evidence)
}

/// Turn a reply into a [`Fault`], or `None` when it says nothing we can act
/// on — which includes every reply we cannot read.
pub fn decode(dialect: Dialect, reply: &[u8]) -> Option<Fault> {
    match dialect {
        Dialect::EscPos => escpos(reply),
        Dialect::Zpl => zpl(reply),
        Dialect::Tspl => tspl(reply),
    }
}

// ─────────────────────────────────────────────────────────────────────
// who answers, and what silence means
// ─────────────────────────────────────────────────────────────────────

/// How long to go without re-asking a printer that has never answered.
///
/// A printer whose query we get wrong would otherwise cost its full reply
/// timeout on every job. An hour is short enough that fixing the language
/// column, or the printer coming online, is picked up without restarting.
const SILENT_COOLDOWN: Duration = Duration::from_secs(60 * 60);

/// What this address has told us about itself.
///
/// Absent from the map means *never asked*, which is what
/// [`Support::Silent`] is deliberately not: silence there is the printer's
/// answer, not ours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Support {
    /// Never answered. Not re-asked for [`SILENT_COOLDOWN`] from the last
    /// try, so a printer that does not do status costs one reply timeout
    /// rather than one per job.
    Silent(Instant),
    /// Has answered, so silence now means the printer has stopped.
    Answers,
}

static SUPPORT: LazyLock<Mutex<HashMap<String, Support>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Whether to spend a probe on `addr` right now.
pub fn should_probe(addr: &str, now: Instant) -> bool {
    match SUPPORT.lock().unwrap().get(addr).copied() {
        None | Some(Support::Answers) => true,
        Some(Support::Silent(at)) => now.duration_since(at) >= SILENT_COOLDOWN,
    }
}

/// Record that `addr` answered: from here on, silence is a fault.
pub fn note_answered(addr: &str) {
    SUPPORT
        .lock()
        .unwrap()
        .insert(addr.to_string(), Support::Answers);
}

/// Record that `addr` said nothing.
///
/// Deliberately never downgrades a printer that has answered before: the
/// answer proves it speaks the dialect, so its silence stays the signal —
/// and we keep paying the (failed) job its reply timeout rather than letting
/// a retry through.
pub fn note_silent(addr: &str, now: Instant) {
    let mut guard = SUPPORT.lock().unwrap();
    if guard.get(addr) != Some(&Support::Answers) {
        guard.insert(addr.to_string(), Support::Silent(now));
    }
}

/// Whether `addr` has ever answered a status query.
///
/// Read *before* [`note_silent`] records a silence, which is what turns this
/// silence from "does not support status" into "has stopped responding".
pub fn had_answered(addr: &str) -> bool {
    SUPPORT.lock().unwrap().get(addr) == Some(&Support::Answers)
}

/// What a printer that answers, then stops, has to be told.
///
/// The causes named here are Zebra's own list for `~HS` staying silent;
/// ESC/POS and TSPL printers are specified to always answer, so for them
/// silence means the device has stopped responding entirely.
pub fn silence_message(at: &str, waited: Duration) -> String {
    format!(
        "{at} stopped answering status queries (waited {}s) — it replied to an earlier one, so check for media out, an open head or a paper jam",
        waited.as_secs()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A healthy ESC/POS answer: the fixed structure bits and nothing else.
    const READY: [u8; 4] = [0x12, 0x12, 0x12, 0x12];

    fn at(fault: &Fault) -> String {
        fault.message("the printer at 127.0.0.1:9100")
    }

    // ── dialect selection ───────────────────────────────────────────

    #[test]
    fn a_language_without_a_query_gets_no_dialect() {
        // These print as before: no query, no new way to fail.
        for language in [
            PrinterLanguage::Pdf,
            PrinterLanguage::Raster,
            PrinterLanguage::Cpcl,
        ] {
            assert_eq!(dialect_for(&language), None, "{language:?}");
        }
        assert_eq!(dialect_for(&PrinterLanguage::Escpos), Some(Dialect::EscPos));
        assert_eq!(dialect_for(&PrinterLanguage::Zpl), Some(Dialect::Zpl));
        assert_eq!(dialect_for(&PrinterLanguage::Tspl), Some(Dialect::Tspl));
    }

    #[test]
    fn each_dialect_asks_in_its_own_language() {
        assert_eq!(
            Dialect::EscPos.query(),
            b"\x10\x04\x01\x10\x04\x02\x10\x04\x03\x10\x04\x04"
        );
        assert_eq!(Dialect::Zpl.query(), b"~HS");
        assert_eq!(Dialect::Tspl.query(), b"\x1b!?");
        // Complete-ness drives when the read stops.
        assert!(Dialect::EscPos.answered(&READY));
        assert!(!Dialect::EscPos.answered(&READY[..3]));
        assert!(Dialect::Tspl.answered(&[0x00]));
        assert!(!Dialect::Tspl.answered(&[]));
        assert!(Dialect::Zpl
            .answered(b"\x02030,0,0,1,2,3,4,5,6,7,8,9\x03\r\n\x02000,0\x03\r\n\x020000,0\x03\r\n"));
        assert!(!Dialect::Zpl.answered(b"\x02030,0,0\x03\r\n"));
    }

    // ── ESC/POS ─────────────────────────────────────────────────────

    #[test]
    fn a_healthy_escpos_printer_reports_nothing() {
        assert_eq!(escpos(&READY), None);
        // Paper *low* (near-end bits) still prints.
        assert_eq!(escpos(&[0x12, 0x12, 0x12, 0x1E]), None);
    }

    #[test]
    fn escpos_reads_paper_out_from_the_sensor_query() {
        let fault = escpos(&[0x12, 0x12, 0x12, 0x72]).expect("paper end");
        assert_eq!(fault.phrases, vec!["it is out of paper"]);
        assert_eq!(fault.evidence, vec!["DLE EOT 4 = 0x72"]);
        assert_eq!(
            at(&fault),
            "the printer at 127.0.0.1:9100 did not print the job: it is out of paper [DLE EOT 4 = 0x72]"
        );
    }

    #[test]
    fn escpos_reads_offline_from_the_printer_status() {
        let fault = escpos(&[0x1E, 0x12, 0x12, 0x12]).expect("offline");
        assert_eq!(fault.phrases, vec!["it is offline"]);
        assert_eq!(fault.evidence, vec!["DLE EOT 1 = 0x1e"]);
    }

    #[test]
    fn escpos_names_what_it_can_and_explains_what_it_cannot() {
        // Cover open raises the cover bit *and* the generic error bit in one
        // byte (0x12 structure + 0x04 cover + 0x40 error): the cover explains
        // the error, so only one is reported.
        let fault = escpos(&[0x12, 0x56, 0x12, 0x12]).expect("cover");
        assert_eq!(fault.phrases, vec!["its cover is open"]);

        // A jam is not a status bit of its own in ESC/POS — the spec only
        // offers "an error exists" — so the operator gets that, plus where
        // to look, plus both bytes that said it.
        let fault = escpos(&[0x12, 0x52, 0x32, 0x12]).expect("jam");
        assert_eq!(fault.phrases, vec![GENERIC_ERROR]);
        assert_eq!(fault.evidence, vec!["DLE EOT 2 = 0x52", "DLE EOT 3 = 0x32"]);
    }

    #[test]
    fn escpos_reports_several_conditions_together() {
        let fault = escpos(&[0x1E, 0x64, 0x12, 0x72]).expect("offline and paper");
        assert!(fault.phrases.contains(&"it is offline".to_string()));
        assert!(fault.phrases.contains(&"it is out of paper".to_string()));
        assert_eq!(fault.phrases.len(), 2, "each condition once: {fault:?}");
    }

    #[test]
    fn escpos_ignores_bytes_that_are_not_status_replies() {
        // No structure bits: job data or noise off a live socket.
        assert_eq!(escpos(&[0x00, 0xFF, 0x41, 0x42]), None);
        // Too short to say anything about two of the four queries.
        assert_eq!(escpos(&[0x12, 0x12]), None);
        assert_eq!(escpos(&[]), None);
        // A wrong-but-plausible first byte must not read as offline.
        assert_eq!(escpos(&[0x10, 0x12, 0x12, 0x12]), None);
    }

    // ── ZPL ─────────────────────────────────────────────────────────

    #[test]
    fn zpl_reads_the_paper_out_flag_from_line_one() {
        let fault =
            zpl(b"\x02030,1,0,1234,000,0,0,0,000,0,0,0\x03\r\n\x02000,0\x03\r\n\x020000,0\x03\r\n")
                .expect("paper out");
        assert_eq!(fault.phrases, vec!["it is out of paper"]);
        assert_eq!(fault.evidence, vec!["~HS paper-out flag = 1"]);
    }

    #[test]
    fn zpl_reads_pause_and_has_no_offline_flag_of_its_own() {
        // ~HS knows "pause", not "offline"; a paused printer will not print.
        let fault =
            zpl(b"\x02030,0,1,1234,000,0,0,0,000,0,0,0\x03\r\n\x02000,0\x03\r\n\x020000,0\x03\r\n")
                .expect("pause");
        assert_eq!(fault.phrases, vec!["it is paused"]);
    }

    #[test]
    fn zpl_needs_a_frame_it_recognises() {
        assert_eq!(zpl(b"030,1,1,1234,000"), None, "no STX");
        assert_eq!(zpl(b"\x02030"), None, "no ETX");
        assert_eq!(zpl(b"\x02abc\x03\r\n"), None, "too few fields");
        assert_eq!(zpl(b"\x02030,1,1\r\n"), None, "unterminated text");
        assert_eq!(zpl(b"\x02030,0,0,0\x03\r\n"), None, "healthy");
        // A field that is not `1` is not a fault: an unreadable field must
        // never stop a print.
        assert_eq!(zpl(b"\x02030,?,0,0\x03\r\n"), None);
        assert_eq!(zpl(&[]), None);
    }

    // ── TSPL ────────────────────────────────────────────────────────

    #[test]
    fn tspl_reads_the_documented_status_bytes() {
        assert_eq!(tspl(&[0x00]), None, "normal");
        assert_eq!(tspl(&[0x20]), None, "printing is not a fault");
        for (code, phrase) in [
            (0x01, "its print head is open"),
            (0x02, "there is a paper jam"),
            (0x04, "it is out of paper"),
            (0x08, "it has run out of ribbon"),
            (0x10, "it is paused"),
            (0x40, "its cover is open"),
        ] {
            let fault = tspl(&[code]).unwrap_or_else(|| panic!("{code:#04x} should fault"));
            assert_eq!(fault.phrases, vec![phrase], "{code:#04x}");
            assert_eq!(fault.evidence, vec![format!("TSPL status {code:#04x}")]);
        }
    }

    #[test]
    fn tspl_combines_flags_that_the_manual_documents_as_combinations() {
        // 0x0C = out of ribbon and out of paper, straight from the table.
        let fault = tspl(&[0x0C]).expect("two faults");
        assert_eq!(
            fault.phrases,
            vec!["it is out of paper", "it has run out of ribbon"]
        );
        // 0x0D adds the head: three conditions, one byte.
        let fault = tspl(&[0x0D]).expect("three faults");
        assert_eq!(fault.phrases.len(), 3);
        // Only "other error" left, so the generic wording applies.
        let fault = tspl(&[0x80]).expect("other error");
        assert_eq!(fault.phrases, vec![GENERIC_ERROR]);
    }

    #[test]
    fn tspl_needs_exactly_one_byte() {
        assert_eq!(tspl(&[]), None);
        assert_eq!(tspl(&[0x00, 0x04]), None, "not the documented reply");
    }

    #[test]
    fn decode_reaches_every_dialect() {
        assert!(decode(Dialect::EscPos, &[0x12, 0x12, 0x12, 0x72]).is_some());
        assert!(decode(Dialect::Tspl, &[0x04]).is_some());
        assert!(decode(
            Dialect::Zpl,
            b"\x02030,1,0,0\x03\r\n\x02000,0\x03\r\n\x020000,0\x03\r\n"
        )
        .is_some());
        assert_eq!(decode(Dialect::EscPos, &READY), None);
    }

    // ── who answers, and what silence means ─────────────────────────

    #[test]
    fn the_first_silence_is_not_a_fault() {
        // Never answered: we cannot tell "does not do status" from "broken",
        // so the job goes out. Otherwise a mis-set language stops every print.
        let addr = "cooldown-unknown";
        let now = Instant::now();
        assert!(should_probe(addr, now), "a new printer is worth asking");
        assert!(!had_answered(addr));
        note_silent(addr, now);
        assert!(!had_answered(addr), "silence must not become an answer");
    }

    #[test]
    fn a_printer_that_has_answered_is_asked_again_and_its_silence_is_the_fault() {
        let addr = "cooldown-answered";
        let now = Instant::now();
        note_answered(addr);
        assert!(had_answered(addr));
        assert!(should_probe(addr, now), "status can change between jobs");

        // Silence after an answer stays a fault on every following job: the
        // retry must not slip through just because we already noticed once.
        note_silent(addr, now);
        assert!(had_answered(addr), "a known talker is never demoted");
        assert!(should_probe(addr, now + Duration::from_secs(1)));
        assert!(
            silence_message("the printer at 127.0.0.1:9100", Duration::from_secs(3))
                .contains("stopped answering status queries"),
            "the operator must see why"
        );
    }

    #[test]
    fn a_printer_that_never_answers_is_not_asked_on_every_job() {
        let addr = "cooldown-silent";
        let base = Instant::now();
        note_silent(addr, base);
        assert!(
            !should_probe(addr, base + Duration::from_secs(60)),
            "within the cooldown, do not spend the reply timeout again"
        );
        assert!(
            should_probe(addr, base + SILENT_COOLDOWN + Duration::from_secs(1)),
            "but do re-check: the language may have been fixed"
        );
        // Answering once promotes it for good.
        note_answered(addr);
        assert!(should_probe(addr, base + Duration::from_secs(61)));
        assert!(had_answered(addr));
    }
}
