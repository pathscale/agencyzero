//! What the browser did, where someone looking at the window can read it.

use std::collections::VecDeque;

use serde::Serialize;

/// One line in the debugging panel.
///
/// A browser says most of this on stderr, where nobody watching the window can
/// see it. A page that renders and then does nothing is almost always a script
/// or a module that never arrived, and that fact existing only in a terminal
/// the person looking at the blank page does not have open is why this is a
/// panel rather than a log line.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugEntry {
    /// Monotonic, so the chrome can ask for everything after what it has
    /// rather than re-reading the buffer and guessing what is new.
    pub seq: u64,
    /// `info`, `warn` or `error`. Drives the colour and nothing else.
    pub level: &'static str,
    /// Which part said it: `net`, `page`, `script`, `nav`.
    pub source: &'static str,
    pub message: String,
}

/// The last [`DebugLog::CAPACITY`] things the browser did.
///
/// A ring rather than a growing list: this records every subresource of every
/// page for the life of the process, and a browser that leaks a line per
/// request is a browser that eventually stops.
#[derive(Clone, Debug, Default)]
pub struct DebugLog {
    next_seq: u64,
    entries: VecDeque<DebugEntry>,
}

impl DebugLog {
    pub const CAPACITY: usize = 500;

    pub fn push(&mut self, level: &'static str, source: &'static str, message: String) -> u64 {
        let seq = self.next_seq;
        self.next_seq += 1;
        if self.entries.len() == Self::CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(DebugEntry {
            seq,
            level,
            source,
            message,
        });
        seq
    }

    /// Everything the caller has not seen. `since` is the last `seq` it holds.
    pub fn since(&self, since: Option<u64>) -> Vec<DebugEntry> {
        match since {
            Some(seq) => self
                .entries
                .iter()
                .filter(|entry| entry.seq > seq)
                .cloned()
                .collect(),
            None => self.entries.iter().cloned().collect(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_drops_the_oldest_rather_than_growing() {
        let mut log = DebugLog::default();
        for index in 0..DebugLog::CAPACITY + 10 {
            log.push("info", "net", format!("line {index}"));
        }
        assert_eq!(log.len(), DebugLog::CAPACITY);
        let all = log.since(None);
        assert_eq!(all.first().unwrap().message, "line 10");
    }

    /// Sequence numbers keep counting past an eviction. A chrome polling with
    /// `since` would otherwise be handed lines it has already drawn.
    #[test]
    fn sequence_numbers_survive_eviction() {
        let mut log = DebugLog::default();
        for index in 0..DebugLog::CAPACITY + 5 {
            log.push("info", "net", format!("line {index}"));
        }
        let last = log.since(None).last().unwrap().seq;
        assert_eq!(last as usize, DebugLog::CAPACITY + 4);
        assert!(log.since(Some(last)).is_empty());
    }

    #[test]
    fn since_returns_only_what_the_caller_has_not_seen() {
        let mut log = DebugLog::default();
        let first = log.push("info", "net", "a".into());
        log.push("warn", "page", "b".into());
        let fresh = log.since(Some(first));
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].message, "b");
    }
}
