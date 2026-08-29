use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Clone, Copy, Debug)]
pub struct MailboxLimits {
    pub reliable_max_frames: usize,
    pub reliable_max_bytes: usize,
    pub legacy_max_frames: usize,
    pub legacy_max_bytes: usize,
    pub semantic_max_terminals: usize,
    pub semantic_max_bytes: usize,
}

impl Default for MailboxLimits {
    fn default() -> Self {
        Self {
            reliable_max_frames: 256,
            reliable_max_bytes: 2 * 1024 * 1024,
            legacy_max_frames: 8_192,
            legacy_max_bytes: 32 * 1024 * 1024,
            semantic_max_terminals: 64,
            semantic_max_bytes: 16 * 1024 * 1024 + 6,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overflow {
    Reliable,
    Legacy,
    Semantic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EnqueueResult {
    pub accepted: bool,
    pub replaced: bool,
    pub requires_resync: bool,
    pub overflow: Option<Overflow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboundFrame {
    pub data: Vec<u8>,
    pub terminal_id: Option<String>,
}

impl OutboundFrame {
    #[must_use]
    pub fn new(data: impl Into<Vec<u8>>) -> Self {
        Self {
            data: data.into(),
            terminal_id: None,
        }
    }

    #[must_use]
    pub fn terminal(terminal_id: &str, data: impl Into<Vec<u8>>) -> Self {
        Self {
            data: data.into(),
            terminal_id: Some(terminal_id.to_owned()),
        }
    }

    fn bytes(&self) -> usize {
        self.data.len()
    }
}

#[derive(Clone)]
struct QueuedFrame {
    frame: OutboundFrame,
    order: u64,
}

/// Bounded per-client queue. Reliable and legacy frames remain FIFO while
/// semantic render state is replaceable by terminal.
pub struct OutboundMailbox {
    limits: MailboxLimits,
    reliable: VecDeque<QueuedFrame>,
    reliable_bytes: usize,
    legacy: VecDeque<QueuedFrame>,
    legacy_bytes: usize,
    semantic: HashMap<String, QueuedFrame>,
    semantic_bytes: usize,
    next_order: u64,
    resync: HashSet<String>,
}

impl OutboundMailbox {
    #[must_use]
    pub fn new(limits: MailboxLimits) -> Self {
        Self {
            limits,
            reliable: VecDeque::new(),
            reliable_bytes: 0,
            legacy: VecDeque::new(),
            legacy_bytes: 0,
            semantic: HashMap::new(),
            semantic_bytes: 0,
            next_order: 0,
            resync: HashSet::new(),
        }
    }

    pub fn enqueue_reliable(&mut self, frame: OutboundFrame) -> EnqueueResult {
        let bytes = frame.bytes();
        if bytes > self.limits.reliable_max_bytes
            || self.reliable.len() >= self.limits.reliable_max_frames
            || self.reliable_bytes.saturating_add(bytes) > self.limits.reliable_max_bytes
        {
            return rejected(Overflow::Reliable, false);
        }
        let queued = self.queued(frame);
        self.reliable.push_back(queued);
        self.reliable_bytes += bytes;
        accepted(false, false)
    }

    pub fn enqueue_legacy(&mut self, terminal_id: &str, mut frame: OutboundFrame) -> EnqueueResult {
        let bytes = frame.bytes();
        if terminal_id.is_empty()
            || bytes > self.limits.legacy_max_bytes
            || self.legacy.len() >= self.limits.legacy_max_frames
            || self.legacy_bytes.saturating_add(bytes) > self.limits.legacy_max_bytes
        {
            return rejected(Overflow::Legacy, false);
        }
        frame.terminal_id = Some(terminal_id.to_owned());
        let queued = self.queued(frame);
        self.legacy.push_back(queued);
        self.legacy_bytes += bytes;
        accepted(false, false)
    }

    pub fn enqueue_semantic(
        &mut self,
        terminal_id: &str,
        mut frame: OutboundFrame,
    ) -> EnqueueResult {
        let bytes = frame.bytes();
        if terminal_id.is_empty() || bytes > self.limits.semantic_max_bytes {
            self.resync.insert(terminal_id.to_owned());
            return rejected(Overflow::Semantic, true);
        }
        frame.terminal_id = Some(terminal_id.to_owned());
        if let Some(previous) = self.semantic.get_mut(terminal_id) {
            let next_bytes = self.semantic_bytes - previous.frame.bytes() + bytes;
            if next_bytes > self.limits.semantic_max_bytes {
                self.resync.insert(terminal_id.to_owned());
                return rejected(Overflow::Semantic, true);
            }
            self.semantic_bytes = next_bytes;
            previous.frame = frame;
            self.resync.insert(terminal_id.to_owned());
            return accepted(true, true);
        }
        if self.semantic.len() >= self.limits.semantic_max_terminals
            || self.semantic_bytes.saturating_add(bytes) > self.limits.semantic_max_bytes
        {
            self.resync.insert(terminal_id.to_owned());
            return rejected(Overflow::Semantic, true);
        }
        let queued = self.queued(frame);
        self.semantic.insert(terminal_id.to_owned(), queued);
        self.semantic_bytes += bytes;
        accepted(false, false)
    }

    pub fn pop_next(&mut self) -> Option<OutboundFrame> {
        enum Source {
            Reliable,
            Legacy,
            Semantic(String),
        }
        let mut selected = self
            .reliable
            .front()
            .map(|frame| (frame.order, Source::Reliable));
        if let Some(frame) = self.legacy.front()
            && selected
                .as_ref()
                .is_none_or(|(order, _)| frame.order < *order)
        {
            selected = Some((frame.order, Source::Legacy));
        }
        for (id, frame) in &self.semantic {
            if selected
                .as_ref()
                .is_none_or(|(order, _)| frame.order < *order)
            {
                selected = Some((frame.order, Source::Semantic(id.clone())));
            }
        }
        match selected?.1 {
            Source::Reliable => {
                let frame = self.reliable.pop_front()?.frame;
                self.reliable_bytes -= frame.bytes();
                Some(frame)
            }
            Source::Legacy => {
                let frame = self.legacy.pop_front()?.frame;
                self.legacy_bytes -= frame.bytes();
                Some(frame)
            }
            Source::Semantic(id) => {
                let frame = self.semantic.remove(&id)?.frame;
                self.semantic_bytes -= frame.bytes();
                Some(frame)
            }
        }
    }

    #[must_use]
    pub fn pending_frames(&self) -> usize {
        self.reliable.len() + self.legacy.len() + self.semantic.len()
    }

    #[must_use]
    pub fn pending_bytes(&self) -> usize {
        self.reliable_bytes + self.legacy_bytes + self.semantic_bytes
    }

    pub fn consume_resync_required(&mut self) -> Vec<String> {
        let mut ids = self.resync.drain().collect::<Vec<_>>();
        ids.sort();
        ids
    }

    fn queued(&mut self, frame: OutboundFrame) -> QueuedFrame {
        let order = self.next_order;
        self.next_order = self.next_order.saturating_add(1);
        QueuedFrame { frame, order }
    }
}

fn accepted(replaced: bool, requires_resync: bool) -> EnqueueResult {
    EnqueueResult {
        accepted: true,
        replaced,
        requires_resync,
        overflow: None,
    }
}

fn rejected(overflow: Overflow, requires_resync: bool) -> EnqueueResult {
    EnqueueResult {
        accepted: false,
        replaced: false,
        requires_resync,
        overflow: Some(overflow),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> MailboxLimits {
        MailboxLimits {
            reliable_max_frames: 2,
            reliable_max_bytes: 10,
            legacy_max_frames: 2,
            legacy_max_bytes: 10,
            semantic_max_terminals: 2,
            semantic_max_bytes: 10,
        }
    }

    #[test]
    fn reliable_frames_are_ordered_and_bounded_without_silent_drops() {
        let mut mailbox = OutboundMailbox::new(limits());
        assert!(
            mailbox
                .enqueue_reliable(OutboundFrame::new(b"four".to_vec()))
                .accepted
        );
        assert!(
            mailbox
                .enqueue_reliable(OutboundFrame::new(b"more".to_vec()))
                .accepted
        );
        assert_eq!(
            mailbox
                .enqueue_reliable(OutboundFrame::new(b"nope".to_vec()))
                .overflow,
            Some(Overflow::Reliable)
        );
        assert_eq!(mailbox.pop_next().expect("first").data, b"four");
        assert_eq!(mailbox.pop_next().expect("second").data, b"more");
        assert!(mailbox.pop_next().is_none());
    }

    #[test]
    fn legacy_raw_chunks_stay_ordered_and_are_never_replaced() {
        let mut custom = limits();
        custom.legacy_max_frames = 8;
        custom.legacy_max_bytes = 32;
        let mut mailbox = OutboundMailbox::new(custom);
        for value in ["one", "two", "three"] {
            assert!(
                mailbox
                    .enqueue_legacy("a", OutboundFrame::new(value.as_bytes().to_vec()))
                    .accepted
            );
        }
        for value in ["one", "two", "three"] {
            assert_eq!(mailbox.pop_next().expect("frame").data, value.as_bytes());
        }
        assert!(mailbox.consume_resync_required().is_empty());
    }

    #[test]
    fn default_legacy_budget_tolerates_more_than_eight_mebibytes() {
        let mut mailbox = OutboundMailbox::new(MailboxLimits::default());
        assert!(
            mailbox
                .enqueue_legacy("a", OutboundFrame::new(vec![0; 9 * 1024 * 1024]))
                .accepted
        );
        assert!(
            !mailbox
                .enqueue_legacy("a", OutboundFrame::new(vec![0; 24 * 1024 * 1024]))
                .accepted
        );
    }

    #[test]
    fn legacy_overflow_rejects_instead_of_replacing_earlier_chunks() {
        let mut mailbox = OutboundMailbox::new(limits());
        assert!(
            mailbox
                .enqueue_legacy("a", OutboundFrame::new(b"one".to_vec()))
                .accepted
        );
        assert!(
            mailbox
                .enqueue_legacy("a", OutboundFrame::new(b"two".to_vec()))
                .accepted
        );
        let overflow = mailbox.enqueue_legacy("a", OutboundFrame::new(b"bad".to_vec()));
        assert_eq!(overflow.overflow, Some(Overflow::Legacy));
        assert_eq!(mailbox.pending_frames(), 2);
    }

    #[test]
    fn semantic_frames_replace_stale_state_and_mark_resync() {
        let mut mailbox = OutboundMailbox::new(limits());
        assert!(
            mailbox
                .enqueue_semantic("a", OutboundFrame::new(b"snap".to_vec()))
                .accepted
        );
        let replacement = mailbox.enqueue_semantic("a", OutboundFrame::new(b"newer".to_vec()));
        assert!(replacement.accepted && replacement.replaced && replacement.requires_resync);
        assert_eq!(mailbox.pop_next().expect("snapshot").data, b"newer");
        assert_eq!(mailbox.consume_resync_required(), vec!["a"]);
    }

    #[test]
    fn oversized_semantic_frame_is_rejected_without_using_memory() {
        let mut mailbox = OutboundMailbox::new(limits());
        let result = mailbox.enqueue_semantic("a", OutboundFrame::new(vec![0; 11]));
        assert_eq!(result.overflow, Some(Overflow::Semantic));
        assert!(result.requires_resync);
        assert_eq!(mailbox.pending_bytes(), 0);
    }

    #[test]
    fn reliable_responses_keep_order_relative_to_terminal_output() {
        let mut mailbox = OutboundMailbox::new(MailboxLimits::default());
        mailbox.enqueue_reliable(OutboundFrame::new(b"response".to_vec()));
        mailbox.enqueue_legacy("a", OutboundFrame::new(b"output".to_vec()));
        mailbox.enqueue_reliable(OutboundFrame::new(b"event".to_vec()));
        assert_eq!(mailbox.pop_next().expect("response").data, b"response");
        assert_eq!(mailbox.pop_next().expect("output").data, b"output");
        assert_eq!(mailbox.pop_next().expect("event").data, b"event");
    }
}
