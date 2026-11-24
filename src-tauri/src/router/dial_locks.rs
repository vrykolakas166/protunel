use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

#[derive(Default)]
pub(super) struct DialLocks {
    locks: Mutex<HashMap<Uuid, Weak<AsyncMutex<()>>>>,
}

impl DialLocks {
    pub(super) async fn lock_all(&self, ids: &[Uuid]) -> Vec<OwnedMutexGuard<()>> {
        let locks: Vec<_> = {
            let mut locks = self.locks.lock().unwrap();
            // Owners and waiters keep the lock alive. Drop expired entries on
            // lookup so completed dials don't accumulate in the map.
            locks.retain(|_, lock| lock.strong_count() > 0);
            ids.iter()
                .map(|id| {
                    let entry = locks.entry(*id).or_default();
                    entry.upgrade().unwrap_or_else(|| {
                        let lock = Arc::new(AsyncMutex::new(()));
                        *entry = Arc::downgrade(&lock);
                        lock
                    })
                })
                .collect()
        };

        let mut guards = Vec::with_capacity(locks.len());
        guards.resize_with(locks.len(), || None);
        'retry: loop {
            for (index, lock) in locks.iter().enumerate() {
                if guards[index].is_some() {
                    continue;
                }
                let Ok(guard) = Arc::clone(lock).try_lock_owned() else {
                    // A waiter for a busy child leaves its jumps available.
                    // Keep the acquired guard on retry so queued waiters can
                    // take turns even when they all need the same lock.
                    guards.fill_with(|| None);
                    guards[index] = Some(Arc::clone(lock).lock_owned().await);
                    continue 'retry;
                };
                guards[index] = Some(guard);
            }
            return guards.into_iter().flatten().collect();
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::timeout;

    use super::*;

    const TEST_TIMEOUT: Duration = Duration::from_secs(1);

    #[tokio::test]
    async fn same_id_serializes() {
        let locks = DialLocks::default();
        let ids = [Uuid::new_v4()];
        let first = locks.lock_all(&ids).await;
        let next = locks.lock_all(&ids);
        tokio::pin!(next);

        assert!(timeout(Duration::ZERO, &mut next).await.is_err());
        drop(first);
        let _next = timeout(TEST_TIMEOUT, next).await.unwrap();
    }

    #[tokio::test]
    async fn different_ids_can_hold_locks_concurrently() {
        let locks = DialLocks::default();
        let _first = locks.lock_all(&[Uuid::from_u128(1)]).await;
        let _second = timeout(TEST_TIMEOUT, locks.lock_all(&[Uuid::from_u128(2)]))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn waiting_for_a_child_leaves_its_jump_available() {
        let locks = DialLocks::default();
        let jump = Uuid::from_u128(1);
        let child = Uuid::from_u128(2);
        let sibling = Uuid::from_u128(3);
        let _child = locks.lock_all(&[child]).await;
        let chain = [jump, child];
        let waiting = locks.lock_all(&chain);
        tokio::pin!(waiting);

        assert!(timeout(Duration::ZERO, &mut waiting).await.is_err());
        let _sibling = timeout(TEST_TIMEOUT, locks.lock_all(&[jump, sibling]))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn expired_locks_are_pruned() {
        let locks = DialLocks::default();
        let first = Uuid::from_u128(1);
        drop(locks.lock_all(&[first]).await);
        let _second = locks.lock_all(&[Uuid::from_u128(2)]).await;

        assert!(!locks.locks.lock().unwrap().contains_key(&first));
    }
}
