//! Short-lived Modrinth browsing metadata only; installation never uses this cache.
use crate::model::Result;
use serde_json::Value;
use std::{
    collections::VecDeque,
    future::Future,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::OnceCell;

struct Entry {
    key: String,
    expires: Instant,
    value: Arc<OnceCell<(Arc<Value>, usize)>>,
}

#[derive(Default)]
pub struct BrowseCache(Mutex<VecDeque<Entry>>);

impl BrowseCache {
    pub async fn get<F, Fut>(&self, key: &str, ttl: Duration, fetch: F) -> Result<Arc<Value>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Value>>,
    {
        let cell = {
            let mut entries = self.0.lock().map_err(|_| "浏览缓存不可用")?;
            entries.retain(|e| e.expires > Instant::now());
            if let Some(index) = entries.iter().position(|e| e.key == key) {
                let entry = entries.remove(index).unwrap();
                let cell = entry.value.clone();
                entries.push_back(entry);
                cell
            } else {
                while entries.len() >= 32 {
                    entries.pop_front();
                }
                let cell = Arc::new(OnceCell::new());
                entries.push_back(Entry {
                    key: key.into(),
                    expires: Instant::now() + ttl,
                    value: cell.clone(),
                });
                cell
            }
        };
        // OnceCell merges concurrent requests for exactly the same URL. Errors are not cached.
        let (value, _) = cell
            .get_or_try_init(|| async {
                let value = fetch().await?;
                let size = serde_json::to_vec(&value)
                    .map_err(|_| "浏览元数据格式无效".to_string())?
                    .len();
                Ok::<_, String>((Arc::new(value), size))
            })
            .await?;
        let mut entries = self.0.lock().map_err(|_| "浏览缓存不可用")?;
        while entries
            .iter()
            .filter_map(|e| e.value.get().map(|(_, size)| size))
            .sum::<usize>()
            > 16 * 1024 * 1024
        {
            entries.pop_front();
        }
        Ok(value.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn repeated_and_concurrent_queries_share_success_but_not_errors_or_filters() {
        let cache = BrowseCache::default();
        let calls = AtomicUsize::new(0);
        let fetch = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(json!({"versions": ["1.21.1"]}))
        };
        let ttl = Duration::from_secs(60);
        let (a, b) = tokio::join!(
            cache.get("game=1.21.1", ttl, fetch),
            cache.get("game=1.21.1", ttl, fetch)
        );
        assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
        cache.get("game=1.21.1", ttl, fetch).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        cache.get("game=1.20.1", ttl, fetch).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(cache
            .get("failed", ttl, || async { Err("HTTP 429".into()) })
            .await
            .is_err());
        cache.get("failed", ttl, fetch).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        cache.get("expired", Duration::ZERO, fetch).await.unwrap();
        cache.get("expired", ttl, fetch).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 5);
    }

    #[tokio::test]
    async fn browsing_cache_evicts_by_recency_and_limits_memory() {
        let cache = BrowseCache::default();
        let ttl = Duration::from_secs(60);
        for i in 0..33 {
            if i == 32 {
                cache
                    .get("0", ttl, || async {
                        panic!("cached entry was fetched again")
                    })
                    .await
                    .unwrap();
            }
            cache
                .get(&i.to_string(), ttl, || async { Ok(json!(i)) })
                .await
                .unwrap();
        }
        {
            let entries = cache.0.lock().unwrap();
            assert_eq!(entries.len(), 32);
            assert!(entries.iter().any(|e| e.key == "0"));
            assert!(!entries.iter().any(|e| e.key == "1"));
        }
        for i in 0..3 {
            cache
                .get(&format!("big-{i}"), ttl, || async {
                    Ok(json!("x".repeat(6 * 1024 * 1024)))
                })
                .await
                .unwrap();
        }
        let entries = cache.0.lock().unwrap();
        assert!(
            entries
                .iter()
                .filter_map(|e| e.value.get().map(|(_, size)| size))
                .sum::<usize>()
                <= 16 * 1024 * 1024
        );
        assert_eq!(entries.len(), 2);
    }
}
