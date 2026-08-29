use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};

use serde_json::Value;
use tokio::sync::broadcast;

use crate::wire::{HostEvent, ServerIdentity};

const DEFAULT_EVENT_CAPACITY: usize = 1024;
const DEFAULT_EVENT_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
struct RetainedEvent {
    event: Arc<HostEvent>,
    bytes: usize,
}

#[derive(Debug)]
struct EventState {
    sequence: u64,
    history: VecDeque<RetainedEvent>,
    history_bytes: usize,
    history_dropped_through: u64,
}

/// Result of taking a reconnect replay snapshot.
#[derive(Clone, Debug)]
pub struct ReplayWindow {
    pub events: Vec<Arc<HostEvent>>,
    pub replay_floor: u64,
    pub last_sequence: u64,
    pub history_evicted: bool,
}

/// Sequenced fan-out plus a bounded replay ring for low-rate host events.
///
/// The hub retains each event in one `Arc`; WebSocket clients clone the pointer
/// instead of cloning event payload strings. PTY paint and semantic frames skip
/// this history because terminals own their replay state.
pub struct EventHub {
    identity: ServerIdentity,
    capacity: usize,
    max_history_bytes: usize,
    state: Mutex<EventState>,
    sender: broadcast::Sender<Arc<HostEvent>>,
}

impl EventHub {
    #[must_use]
    pub fn new(identity: ServerIdentity) -> Self {
        Self::with_limits(identity, DEFAULT_EVENT_CAPACITY, DEFAULT_EVENT_BYTES)
    }

    #[must_use]
    pub fn with_limits(
        identity: ServerIdentity,
        capacity: usize,
        max_history_bytes: usize,
    ) -> Self {
        let (sender, _) = broadcast::channel(capacity.max(1));
        Self {
            identity,
            capacity,
            max_history_bytes,
            state: Mutex::new(EventState {
                sequence: 0,
                history: VecDeque::with_capacity(capacity.min(DEFAULT_EVENT_CAPACITY)),
                history_bytes: 0,
                history_dropped_through: 0,
            }),
            sender,
        }
    }

    pub fn emit(
        &self,
        channel: impl Into<Arc<str>>,
        args: impl Into<Arc<[Value]>>,
    ) -> Arc<HostEvent> {
        let channel = channel.into();
        let args = args.into();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.sequence = state.sequence.saturating_add(1);
        let event = Arc::new(HostEvent::modern(
            &self.identity,
            state.sequence,
            Arc::clone(&channel),
            args,
        ));
        if !is_ephemeral(&channel) {
            let bytes = estimate_event_bytes(&event);
            state.history.push_back(RetainedEvent {
                event: Arc::clone(&event),
                bytes,
            });
            state.history_bytes = state.history_bytes.saturating_add(bytes);
            while !state.history.is_empty()
                && (state.history.len() > self.capacity
                    || state.history_bytes > self.max_history_bytes)
            {
                if let Some(dropped) = state.history.pop_front() {
                    state.history_bytes = state.history_bytes.saturating_sub(dropped.bytes);
                    state.history_dropped_through =
                        state.history_dropped_through.max(dropped.event.sequence);
                }
            }
        }
        // Send while the sequence lock is held. Concurrent producers cannot
        // publish sequence N+1 before sequence N.
        let _ = self.sender.send(Arc::clone(&event));
        event
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<HostEvent>> {
        self.sender.subscribe()
    }

    #[must_use]
    pub fn replay_window(&self, since: u64) -> ReplayWindow {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let events = state
            .history
            .iter()
            .filter(|retained| retained.event.sequence > since)
            .map(|retained| Arc::clone(&retained.event))
            .collect();
        let oldest = state
            .history
            .front()
            .map(|retained| retained.event.sequence);
        let replay_floor = oldest.unwrap_or_else(|| state.sequence.saturating_add(1));
        let history_evicted = since > 0
            && oldest.map_or(state.history_dropped_through > since, |oldest| {
                since < oldest.saturating_sub(1)
            });
        ReplayWindow {
            events,
            replay_floor,
            last_sequence: state.sequence,
            history_evicted,
        }
    }

    #[must_use]
    pub fn last_sequence(&self) -> u64 {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .sequence
    }
}

fn is_ephemeral(channel: &str) -> bool {
    channel == "terminal:data" || channel == "terminal:semantic"
}

fn estimate_event_bytes(event: &HostEvent) -> usize {
    let mut bytes = 64 + event.channel.len();
    for argument in event.args.iter() {
        bytes = bytes.saturating_add(match argument {
            Value::String(value) => value.len(),
            value => serde_json::to_vec(value).map_or(64, |encoded| encoded.len()),
        });
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> ServerIdentity {
        ServerIdentity {
            server_id: "server-1".to_owned(),
            server_epoch: "epoch-1".to_owned(),
            protocol_version: 2,
            runtime_version: "0.0.1".to_owned(),
            started_at: "2026-01-02T03:04:05.000Z".to_owned(),
        }
    }

    #[test]
    fn retains_non_terminal_events_with_monotonic_sequences() {
        let hub = EventHub::with_limits(identity(), 4, 4096);
        let first = hub.emit("mux:event", vec![serde_json::json!(1)]);
        let second = hub.emit("server:shuttingDown", Vec::<Value>::new());

        let replay = hub.replay_window(0);
        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);
        assert_eq!(replay.events.len(), 2);
        assert_eq!(replay.last_sequence, 2);
        assert!(!replay.history_evicted);
    }

    #[test]
    fn terminal_paint_is_live_only() {
        let hub = EventHub::with_limits(identity(), 4, 4096);
        hub.emit(
            "terminal:data",
            vec![serde_json::json!("term-1"), serde_json::json!("paint")],
        );
        hub.emit("mux:event", vec![serde_json::json!("retained")]);

        let replay = hub.replay_window(0);
        assert_eq!(replay.events.len(), 1);
        assert_eq!(replay.events[0].channel.as_ref(), "mux:event");
        assert_eq!(replay.events[0].sequence, 2);
    }

    #[test]
    fn reports_replay_gap_after_count_eviction() {
        let hub = EventHub::with_limits(identity(), 2, 4096);
        for value in 1..=4 {
            hub.emit("mux:event", vec![serde_json::json!(value)]);
        }

        let replay = hub.replay_window(1);
        assert_eq!(replay.replay_floor, 3);
        assert_eq!(replay.events.len(), 2);
        assert!(replay.history_evicted);
    }

    #[test]
    fn reports_replay_gap_when_all_history_was_dropped_by_byte_limit() {
        let hub = EventHub::with_limits(identity(), 8, 1);
        hub.emit("mux:event", vec![serde_json::json!("large-1")]);
        hub.emit("mux:event", vec![serde_json::json!("large-2")]);

        let replay = hub.replay_window(1);
        assert!(replay.events.is_empty());
        assert_eq!(replay.replay_floor, 3);
        assert!(replay.history_evicted);
    }
}
