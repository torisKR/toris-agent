//! Bounded, tail-preserving capture of a child's stdout/stderr.
//!
//! Two invariants drive the design:
//!
//! 1. **Never stop reading.** Once the cap is reached we keep draining and
//!    discarding. A reader that stops leaves the pipe buffer full, which blocks
//!    the child mid-write — and a child blocked in `write(2)` never observes the
//!    signal we send it on timeout.
//! 2. **Never lose what was read.** The buffer is shared with the collector
//!    rather than handed over at EOF, so a stream that never reaches EOF (a
//!    survivor still holding the write end) still yields everything captured up
//!    to that point instead of an empty string.

use std::io::{ErrorKind, Read};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const READ_BUF_BYTES: usize = 32 * 1024;

/// Headroom allowed above `cap` before the buffer is trimmed back down.
///
/// Trimming moves every byte we keep, so trimming on each read makes capture
/// O(bytes x cap). Overshooting by a fixed slack and trimming in one pass
/// amortises it to O(bytes): with a 32 KiB read that is one memmove per 32
/// reads instead of one per read, at a bounded 1 MiB of extra residency.
const TRIM_SLACK_BYTES: usize = 1024 * 1024;

/// Bytes kept from a stream, plus whether anything was discarded.
#[derive(Default)]
pub struct Captured {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

impl Captured {
    fn push(&mut self, chunk: &[u8], cap: usize) {
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > cap.saturating_add(TRIM_SLACK_BYTES) {
            self.trim_to(cap);
        }
    }

    /// Drop from the front so the tail survives — the end of a build log is
    /// where the error is.
    fn trim_to(&mut self, cap: usize) {
        if self.bytes.len() <= cap {
            return;
        }
        let excess = self.bytes.len() - cap;
        self.bytes.drain(..excess);
        self.truncated = true;
    }
}

/// A reader thread draining one pipe into a shared, capped buffer.
pub struct Capture {
    shared: Arc<Mutex<Captured>>,
    finished: Receiver<()>,
    cap: usize,
}

impl Capture {
    /// Start draining `src` on a dedicated thread.
    pub fn spawn<R: Read + Send + 'static>(mut src: R, cap: usize) -> Self {
        let shared = Arc::new(Mutex::new(Captured::default()));
        let (tx, finished) = mpsc::channel();
        let sink = Arc::clone(&shared);

        thread::spawn(move || {
            let mut buf = [0u8; READ_BUF_BYTES];
            loop {
                match src.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => match sink.lock() {
                        Ok(mut held) => held.push(&buf[..n], cap),
                        // Poisoned only if a collector panicked; nobody is left
                        // to read what we would append.
                        Err(_) => break,
                    },
                    // A signal delivered mid-read is not an error.
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            if let Ok(mut held) = sink.lock() {
                held.trim_to(cap);
            }
            let _ = tx.send(());
        });

        Self {
            shared,
            finished,
            cap,
        }
    }

    /// Wait up to `grace` for EOF, then take whatever has been captured.
    ///
    /// EOF means every process holding the write end has exited. When that
    /// never arrives we still return the partial capture: a timed-out build's
    /// output is the most useful thing we have, and discarding it would make
    /// the failure harder to diagnose than the timeout itself.
    pub fn collect(self, grace: Duration) -> Captured {
        let _ = self.finished.recv_timeout(grace);
        let mut held = match self.shared.lock() {
            Ok(held) => held,
            Err(poisoned) => poisoned.into_inner(),
        };
        held.trim_to(self.cap);
        std::mem::take(&mut held)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const GRACE: Duration = Duration::from_secs(5);

    fn capture(input: &[u8], cap: usize) -> Captured {
        Capture::spawn(Cursor::new(input.to_vec()), cap).collect(GRACE)
    }

    #[test]
    fn keeps_everything_below_the_cap() {
        let out = capture(b"hello", 1024);
        assert_eq!(out.bytes, b"hello");
        assert!(!out.truncated);
    }

    #[test]
    fn exactly_at_the_cap_is_not_truncated() {
        let out = capture(b"abcd", 4);
        assert_eq!(out.bytes, b"abcd");
        assert!(!out.truncated);
    }

    #[test]
    fn keeps_the_tail_when_over_the_cap() {
        let input: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        let out = capture(&input, 100);
        assert_eq!(out.bytes.len(), 100);
        assert!(out.truncated);
        assert_eq!(out.bytes, input[input.len() - 100..]);
    }

    #[test]
    fn trims_on_collect_even_within_the_slack_window() {
        // Larger than the cap but inside TRIM_SLACK_BYTES, so the reader never
        // trims mid-stream — only the final pass can enforce the cap here.
        let input = vec![b'x'; 4096];
        let out = capture(&input, 1024);
        assert_eq!(out.bytes.len(), 1024);
        assert!(out.truncated);
    }

    #[test]
    fn survives_a_cap_of_zero() {
        let out = capture(b"anything", 0);
        assert!(out.bytes.is_empty());
        assert!(out.truncated);
    }

    #[test]
    fn empty_stream_is_not_truncated() {
        let out = capture(b"", 128);
        assert!(out.bytes.is_empty());
        assert!(!out.truncated);
    }
}
