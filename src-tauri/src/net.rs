use crate::model::{safe_path, valid_sha1, Result};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub const MANIFEST: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
pub async fn download_from_local(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    sources: &[PathBuf],
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    if cancel.is_cancelled() {
        return Err("操作已取消".into());
    }
    if sources.is_empty() {
        return download(client, root, artifact, cancel).await;
    }
    if !valid_sha1(&artifact.sha1) || artifact.size.is_some_and(|size| size > 512 * 1024 * 1024) {
        return Err("下载校验信息或大小无效".into());
    }
    trusted_url(&artifact.url)?;
    let target = safe_path(root, &artifact.path)?;
    if matches(&target, &artifact.sha1, artifact.size)? {
        return Ok(target);
    }
    for source in sources {
        if reuse_local(root, artifact, source, &artifact.path, cancel)? {
            return Ok(target);
        }
    }
    download(client, root, artifact, cancel).await
}
pub fn reuse_local(
    root: &Path,
    artifact: &Artifact,
    source: &Path,
    relative: &str,
    cancel: &CancellationToken,
) -> Result<bool> {
    trusted_url(&artifact.url)?;
    reuse_local_checked(root, artifact, source, relative, cancel)
}
pub fn reuse_installer_library(
    root: &Path,
    artifact: &Artifact,
    source: &Path,
    cancel: &CancellationToken,
) -> Result<bool> {
    installer_library_url(&artifact.url)?;
    reuse_local_checked(root, artifact, source, &artifact.path, cancel)
}
fn reuse_local_checked(
    root: &Path,
    artifact: &Artifact,
    source: &Path,
    relative: &str,
    cancel: &CancellationToken,
) -> Result<bool> {
    if !valid_sha1(&artifact.sha1) || artifact.size.is_some_and(|size| size > 512 * 1024 * 1024) {
        return Err("本地复用校验值无效".into());
    }
    let target = safe_path(root, &artifact.path)?;
    if matches(&target, &artifact.sha1, artifact.size)? {
        return Ok(true);
    }
    if cancel.is_cancelled() {
        return Err("导入已取消".into());
    }
    let Ok(path) = safe_path(source, relative) else {
        return Ok(false);
    };
    let Ok(metadata) = fs::metadata(&path) else {
        return Ok(false);
    };
    if !metadata.is_file() || metadata.len() > 512 * 1024 * 1024 {
        return Ok(false);
    }
    let Ok(mut guard) = crate::file_guard::Guard::open(source, relative, metadata.len(), false)
    else {
        return Ok(false);
    };
    let mut hash = Sha1::new();
    let mut bytes = [0; 65536];
    loop {
        if cancel.is_cancelled() {
            return Err("导入已取消".into());
        }
        let n = guard
            .file
            .read(&mut bytes)
            .map_err(|_| "本地资源校验读取失败")?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    if hash
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
        != artifact.sha1.to_ascii_lowercase()
        || artifact.size.is_some_and(|size| size != metadata.len())
    {
        return Ok(false);
    }
    use std::io::{Seek, SeekFrom};
    guard
        .file
        .seek(SeekFrom::Start(0))
        .map_err(|_| "无法重读本地资源")?;
    fs::create_dir_all(target.parent().ok_or("资源路径无效")?).map_err(|_| "无法创建资源缓存")?;
    let partial = safe_path(
        root,
        &format!("{}.local-{}.part", artifact.path, uuid::Uuid::new_v4()),
    )?;
    let result = (|| -> Result<()> {
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&partial)
            .map_err(|_| "无法暂存本地资源")?;
        loop {
            if cancel.is_cancelled() {
                return Err("导入已取消".into());
            }
            let n = guard
                .file
                .read(&mut bytes)
                .map_err(|_| "本地资源读取失败")?;
            if n == 0 {
                break;
            }
            output
                .write_all(&bytes[..n])
                .map_err(|_| "资源缓存写入失败")?;
        }
        output.sync_all().map_err(|_| "资源缓存同步失败")?;
        drop(output);
        if !matches(&partial, &artifact.sha1, artifact.size)? {
            return Err("本地复用校验失败".into());
        }
        fs::rename(&partial, &target).map_err(|_| "无法提交资源缓存")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
    }
    result?;
    Ok(true)
}
pub fn client() -> Result<Client> {
    let mut builder = Client::builder()
        .user_agent(concat!("EasyCraft/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .tcp_nodelay(true)
        .pool_max_idle_per_host(8);
    if std::env::var("EASYCRAFT_NETWORK_DIRECT").as_deref() == Ok("1") {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|_| "无法初始化 HTTPS".into())
}
// Same origin and checksum, independent HTTP/1 connection pool. A failed system
// proxy / HTTP2 connection must not monopolize every resumed CDN attempt.
pub(crate) fn fallback_client() -> Result<&'static Client> {
    static CLIENT: std::sync::OnceLock<std::result::Result<Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .no_proxy()
                .http1_only()
                .tcp_nodelay(true)
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(90))
                .user_agent(concat!("EasyCraft/", env!("CARGO_PKG_VERSION")))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "无法初始化直连备用连接".into())
        })
        .as_ref()
        .map_err(Clone::clone)
}
fn modrinth_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("cdn.modrinth.com" | "api.modrinth.com")
        )
}
#[cfg(test)]
#[tokio::test]
async fn direct_fallback_ignores_broken_proxy_and_keeps_origin_boundary() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut request = [0; 2048];
        socket.read(&mut request).unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .unwrap();
    });
    let broken = Client::builder()
        .proxy(reqwest::Proxy::all("http://127.0.0.1:1").unwrap())
        .build()
        .unwrap();
    assert!(broken
        .get(format!("http://{address}"))
        .send()
        .await
        .is_err());
    assert_eq!(
        fallback_client()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "ok"
    );
    assert!(modrinth_origin(
        &Url::parse("https://cdn.modrinth.com/a").unwrap()
    ));
    assert!(!modrinth_origin(
        &Url::parse("https://cdn.modrinth.com.evil/a").unwrap()
    ));
    server.join().unwrap();
}
pub fn trusted_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| "无效下载地址")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || ![
            "piston-meta.mojang.com",
            "piston-data.mojang.com",
            "launchermeta.mojang.com",
            "launcher.mojang.com",
            "libraries.minecraft.net",
            "resources.download.minecraft.net",
            "meta.fabricmc.net",
            "maven.fabricmc.net",
        ]
        .contains(&url.host_str().unwrap_or_default())
    {
        return Err("拒绝非官方资源来源".into());
    }
    Ok(url)
}
pub async fn get_json(
    client: &Client,
    url: &str,
    cancel: &CancellationToken,
) -> Result<serde_json::Value> {
    let url = trusted_url(url)?;
    json_url(client, url, cancel).await
}
pub async fn resource_json(
    client: &Client,
    raw: &str,
    cancel: &CancellationToken,
) -> Result<serde_json::Value> {
    let url = Url::parse(raw).map_err(|_| "无效资源地址")?;
    if url.scheme() != "https"
        || url.host_str() != Some("api.modrinth.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || !url.path().starts_with("/v2/")
    {
        return Err("拒绝非 Modrinth 元数据来源".into());
    }
    tokio::time::timeout(Duration::from_secs(45), json_url(client, url, cancel))
        .await
        .map_err(|_| "资源查询超时，请重试".to_string())?
}
async fn json_url(
    client: &Client,
    url: Url,
    cancel: &CancellationToken,
) -> Result<serde_json::Value> {
    let mut attempt = 0;
    let response = loop {
        let transport = if attempt > 0 && modrinth_origin(&url) {
            fallback_client()?
        } else {
            client
        };
        let result = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), response = transport.get(url.clone()).header(reqwest::header::ACCEPT_ENCODING, "gzip").timeout(if modrinth_origin(&url) { Duration::from_secs(12) } else { Duration::from_secs(90) }).send() => response };
        match result {
            Ok(response) if response.status().is_server_error() && attempt < 2 => {
                attempt += 1;
                tokio::select! { _=cancel.cancelled()=>return Err("操作已取消".into()), _=tokio::time::sleep(Duration::from_millis(500*attempt))=>{} }
            }
            Ok(response) => break response,
            Err(error) if attempt < 2 && !error.is_builder() => {
                attempt += 1;
                tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), _ = tokio::time::sleep(Duration::from_millis(250 * attempt)) => {} }
            }
            Err(error) => {
                let mut cause: &dyn std::error::Error = &error;
                while let Some(source) = cause.source() {
                    cause = source;
                }
                return Err(format!("无法连接元数据服务：{cause}"));
            }
        }
    };
    if response.status().as_u16() == 429 {
        return Err("查询过于频繁，请稍后重试；原查询与结果已保留".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "元数据服务返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let encoding = response
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .map(|v| v.to_str().unwrap_or_default().trim().to_ascii_lowercase());
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];
    loop {
        let next = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), next = stream.next() => next };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|_| "元数据接收中断")?;
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("元数据超过大小上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    decode_metadata(&bytes, encoding.as_deref())
}

fn decode_metadata(bytes: &[u8], encoding: Option<&str>) -> Result<serde_json::Value> {
    const LIMIT: usize = 8 * 1024 * 1024;
    let mut decoded = Vec::new();
    let bytes = match encoding {
        Some("gzip") => {
            flate2::read::MultiGzDecoder::new(bytes)
                .take((LIMIT + 1) as u64)
                .read_to_end(&mut decoded)
                .map_err(|_| "压缩元数据无效")?;
            &decoded
        }
        None | Some("identity") => bytes,
        _ => return Err("元数据压缩格式不支持".into()),
    };
    if bytes.len() > LIMIT {
        return Err("元数据超过大小上限".into());
    }
    serde_json::from_slice(bytes).map_err(|_| "元数据格式无效".into())
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    #[test]
    fn installer_cache_reuse_verifies_official_sources_and_repairs_corrupt_owned_cache() {
        let root = std::env::temp_dir().join(format!(
            "easycraft-installer-cache-{}",
            uuid::Uuid::new_v4()
        ));
        let source = root.join("source");
        let cache = root.join("cache");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&cache).unwrap();
        let bytes = b"official library fixture";
        let sha1 = Sha1::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        fs::write(source.join("library.jar"), bytes).unwrap();
        fs::write(cache.join("library.jar"), b"corrupt").unwrap();
        let artifact = Artifact {
            path: "library.jar".into(),
            url: "https://maven.minecraftforge.net/net/example/library.jar".into(),
            sha1,
            size: Some(bytes.len() as u64),
        };
        assert!(
            reuse_installer_library(&cache, &artifact, &source, &CancellationToken::new()).unwrap()
        );
        assert_eq!(fs::read(cache.join("library.jar")).unwrap(), bytes);
        for raw in [
            "http://maven.minecraftforge.net/lib.jar",
            "https://maven.minecraftforge.net.evil.example/lib.jar",
            "https://example.com/lib.jar",
        ] {
            assert!(installer_library_url(raw).is_err());
        }
        assert!(installer_library_url(
            "https://maven.neoforged.net/releases/net/neoforged/lib.jar"
        )
        .is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn checksums_retry_temporary_failures_but_reject_permanent_failures() {
        let client = Client::builder().no_proxy().build().unwrap();
        let (url, server) = download_server(vec![
            ("503 Service Unavailable", b""),
            ("200 OK", b"0123456789012345678901234567890123456789"),
        ]);
        let result = checksum_url(&client, url, &CancellationToken::new()).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(server.join().unwrap(), 2);
        let (url, server) = download_server(vec![("404 Not Found", b"")]);
        assert!(checksum_url(&client, url, &CancellationToken::new())
            .await
            .is_err());
        assert_eq!(server.join().unwrap(), 1);
    }
    fn download_server(
        bodies: Vec<(&'static str, &'static [u8])>,
    ) -> (Url, std::thread::JoinHandle<usize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!(
            "http://{}/artifact",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let worker = std::thread::spawn(move || {
            let mut count = 0;
            for (status, body) in bodies {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                loop {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // Winsock can inherit the listener's nonblocking mode.
                            // The request reader below is intentionally synchronous.
                            stream.set_nonblocking(false).unwrap();
                            stream
                                .set_read_timeout(Some(Duration::from_secs(2)))
                                .unwrap();
                            let mut request = [0; 4096];
                            let mut length = 0;
                            while length < request.len()
                                && !request[..length].windows(4).any(|v| v == b"\r\n\r\n")
                            {
                                let count = stream.read(&mut request[length..]).unwrap();
                                if count == 0 {
                                    break;
                                }
                                length += count;
                            }
                            count += 1;
                            write!(stream,"HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).unwrap();
                            let _ = stream.write_all(body);
                            break;
                        }
                        Err(_) if std::time::Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => return count,
                    }
                }
            }
            count
        });
        (url, worker)
    }
    #[tokio::test]
    async fn download_recovers_corruption_but_does_not_retry_missing_files() {
        let root =
            std::env::temp_dir().join(format!("easycraft-transfer-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let artifact = Artifact {
            path: "artifact.data".into(),
            url: "https://cdn.modrinth.com/data/test/artifact".into(),
            sha1: Sha1::digest(b"abcdef")
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            size: Some(6),
        };
        let client = Client::builder().no_proxy().build().unwrap();
        let (url, server) = download_server(vec![("200 OK", b"broken"), ("200 OK", b"abcdef")]);
        let result = download_url(&client, &root, &artifact, url, &CancellationToken::new()).await;
        let requests = server.join().unwrap();
        assert!(
            result.is_ok(),
            "corrupt response should recover: {result:?}"
        );
        assert_eq!(requests, 2);
        fs::remove_file(root.join("artifact.data")).unwrap();
        let (url, server) = download_server(vec![
            ("404 Not Found", b""),
            ("404 Not Found", b""),
            ("404 Not Found", b""),
        ]);
        assert!(
            download_url(&client, &root, &artifact, url, &CancellationToken::new())
                .await
                .is_err()
        );
        assert_eq!(
            server.join().unwrap(),
            1,
            "permanent failures must not consume three attempts"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn download_can_resume_more_than_three_progressing_interruptions() {
        let body = vec![b'x'; 4 * 262144 + 17];
        let sha1 = {
            use sha1::Digest;
            sha1::Sha1::digest(&body)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/large", listener.local_addr().unwrap())).unwrap();
        let server = std::thread::spawn(move || {
            let mut offset = 0;
            let mut count = 0;
            while offset < body.len() {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let text = String::from_utf8(request).unwrap().to_lowercase();
                if offset == 0 {
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .unwrap();
                } else {
                    assert!(text.contains(&format!("range: bytes={offset}-")));
                    write!(stream,"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {offset}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()-1,body.len(),body.len()-offset).unwrap();
                }
                let end = (offset + 262144).min(body.len());
                stream.write_all(&body[offset..end]).unwrap();
                offset = end;
                count += 1;
            }
            count
        });
        let root =
            std::env::temp_dir().join(format!("easycraft-progress-retry-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let artifact = Artifact {
            path: "large.jar".into(),
            url: url.to_string(),
            sha1,
            size: Some(4 * 262144 + 17),
        };
        let client = Client::builder().no_proxy().build().unwrap();
        let result = download_url(&client, &root, &artifact, url, &CancellationToken::new()).await;
        assert!(
            result.is_ok(),
            "progressing partial download should finish: {result:?}"
        );
        assert_eq!(server.join().unwrap(), 5);
        assert!(matches(&root.join("large.jar"), &artifact.sha1, artifact.size).unwrap());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn resumed_download_handles_ignored_ranges_expired_ranges_and_cached_progress() {
        let root = std::env::temp_dir().join(format!("easycraft-resume-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let artifact = Artifact {
            path: "artifact.data".into(),
            url: "https://cdn.modrinth.com/data/test/file".into(),
            sha1: Sha1::digest(b"abcdef")
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            size: Some(6),
        };
        let client = Client::builder().no_proxy().build().unwrap();
        for responses in [
            vec![("200 OK", b"abcdef".as_slice())],
            vec![
                ("416 Range Not Satisfiable", b"".as_slice()),
                ("200 OK", b"abcdef".as_slice()),
            ],
            vec![(
                "206 Partial Content\r\nContent-Range: bytes 3-5/6",
                b"def".as_slice(),
            )],
        ] {
            fs::write(root.join("artifact.data.part"), b"abc").unwrap();
            let (url, server) = download_server(responses);
            download_url(&client, &root, &artifact, url, &CancellationToken::new())
                .await
                .unwrap();
            server.join().unwrap();
            assert_eq!(fs::read(root.join("artifact.data")).unwrap(), b"abcdef");
            fs::remove_file(root.join("artifact.data")).unwrap();
        }
        fs::write(root.join("artifact.data"), b"abcdef").unwrap();
        let updates = std::sync::Mutex::new(vec![]);
        download_observed(
            &client,
            &root,
            &artifact,
            Url::parse("http://127.0.0.1:1/offline").unwrap(),
            &CancellationToken::new(),
            Some(&|event| updates.lock().unwrap().push(event)),
        )
        .await
        .unwrap();
        assert!(matches!(
            updates.lock().unwrap().as_slice(),
            [TransferUpdate::Cached]
        ));
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn cancelling_a_stream_preserves_partial_data_without_publishing() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!("http://{}/slow", listener.local_addr().unwrap())).unwrap();
        let cancel = CancellationToken::new();
        let signal = cancel.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nabc")
                .unwrap();
            std::thread::sleep(Duration::from_millis(80));
            signal.cancel();
            std::thread::sleep(Duration::from_millis(80));
        });
        let root = std::env::temp_dir().join(format!("easycraft-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let artifact = Artifact {
            path: "file.data".into(),
            url: "https://cdn.modrinth.com/data/test/file".into(),
            sha1: "a".repeat(40),
            size: Some(6),
        };
        let result = download_url(
            &Client::builder().no_proxy().build().unwrap(),
            &root,
            &artifact,
            url,
            &cancel,
        )
        .await;
        assert!(result.unwrap_err().contains("取消"));
        server.join().unwrap();
        assert!(!root.join("file.data").exists());
        assert_eq!(fs::read(root.join("file.data.part")).unwrap(), b"abc");
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn local_cache_reuse_checks_official_hash_and_copies_without_mutating_source() {
        let root = std::env::temp_dir().join(format!("easycraft-reuse-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let target = root.join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("file.jar"), b"verified bytes").unwrap();
        let sha = Sha1::digest(b"verified bytes")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let mut artifact = Artifact {
            url: "https://libraries.minecraft.net/test.jar".into(),
            sha1: "0".repeat(40),
            size: Some(14),
            path: "libraries/test.jar".into(),
        };
        assert!(!reuse_local(
            &target,
            &artifact,
            &source,
            "file.jar",
            &CancellationToken::new()
        )
        .unwrap());
        artifact.sha1 = sha;
        assert!(reuse_local(
            &target,
            &artifact,
            &source,
            "file.jar",
            &CancellationToken::new()
        )
        .unwrap());
        fs::write(target.join("libraries/test.jar"), b"changed target").unwrap();
        assert_eq!(
            fs::read(source.join("file.jar")).unwrap(),
            b"verified bytes"
        );
        assert!(!reuse_local(
            &target,
            &artifact,
            &source,
            "../file.jar",
            &CancellationToken::new()
        )
        .unwrap());
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(download_from_local(
            &client().unwrap(),
            &target,
            &artifact,
            &[source.clone()],
            &cancelled
        )
        .await
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(bytes).unwrap();
        encoder.finish().unwrap()
    }
    #[test]
    fn compressed_metadata_preserves_json_validation_and_expanded_size_limit() {
        assert_eq!(
            decode_metadata(&gzip(br#"{"ok":true}"#), Some("gzip")).unwrap()["ok"],
            true
        );
        assert_eq!(
            decode_metadata(br#"{"ok":true}"#, None).unwrap()["ok"],
            true
        );
        assert!(decode_metadata(b"broken gzip", Some("gzip")).is_err());
        assert!(decode_metadata(&gzip(b"not json"), Some("gzip")).is_err());
        assert!(decode_metadata(b"{}", Some("br")).is_err());
        assert!(
            decode_metadata(&gzip(&vec![b' '; 8 * 1024 * 1024 + 1]), Some("gzip"))
                .unwrap_err()
                .contains("上限")
        );
    }
    #[tokio::test]
    async fn metadata_http_negotiates_and_reads_gzip() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/metadata",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let length = stream.read(&mut request).unwrap();
            assert!(String::from_utf8_lossy(&request[..length])
                .to_ascii_lowercase()
                .contains("accept-encoding: gzip"));
            let body = gzip(br#"{"ok":true}"#);
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
            stream.write_all(&body).unwrap();
        });
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        assert_eq!(
            json_url(&client, url, &CancellationToken::new())
                .await
                .unwrap()["ok"],
            true
        );
        server.join().unwrap();
    }
    #[tokio::test]
    async fn metadata_get_recovers_a_closed_connection_and_honors_cancel() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = Url::parse(&format!(
            "http://{}/metadata",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = std::thread::spawn(move || {
            for attempt in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).unwrap();
                if attempt == 1 {
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}").unwrap();
                }
            }
        });
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        let cancel = CancellationToken::new();
        assert_eq!(
            json_url(&client, url.clone(), &cancel).await.unwrap()["ok"],
            true
        );
        server.join().unwrap();
        cancel.cancel();
        assert!(json_url(&client, url, &cancel)
            .await
            .unwrap_err()
            .contains("取消"));
    }
}
pub async fn checksum(client: &Client, url: &str, cancel: &CancellationToken) -> Result<String> {
    let url = trusted_url(url)?;
    if url.host_str() != Some("maven.fabricmc.net") {
        return Err("校验值来源无效".into());
    }
    checksum_url(client, url, cancel).await
}
async fn checksum_url(client: &Client, url: Url, cancel: &CancellationToken) -> Result<String> {
    for attempt in 0..3 {
        match checksum_once(client, url.clone(), cancel).await {
            Ok(hash) => return Ok(hash),
            Err(error) if error.retry && attempt < 2 => {
                tokio::select! { _=cancel.cancelled()=>return Err("操作已取消".into()), _=tokio::time::sleep(Duration::from_millis(500*(attempt+1)))=>{} }
            }
            Err(error) => return Err(error.message),
        }
    }
    Err("官方校验值暂时不可用".into())
}
async fn checksum_once(
    client: &Client,
    url: Url,
    cancel: &CancellationToken,
) -> std::result::Result<String, DownloadFailure> {
    let response = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), result = client.get(url).timeout(Duration::from_secs(30)).send() => result.map_err(|_| DownloadFailure::retry("无法读取官方校验值"))? };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let message = format!("官方校验服务 HTTP {status}");
        return Err(if status == 408 || status == 429 || status >= 500 {
            DownloadFailure::retry(&message)
        } else {
            message.into()
        });
    }
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];
    while let Some(chunk) = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), result = stream.next() => result }
    {
        let chunk = chunk.map_err(|_| DownloadFailure::retry("校验值接收中断"))?;
        if bytes.len() + chunk.len() > 256 {
            return Err("校验值响应过长".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let hash = std::str::from_utf8(&bytes)
        .map_err(|_| "校验值编码无效")?
        .trim();
    if !valid_sha1(hash) {
        return Err("官方 SHA-1 无效".into());
    }
    Ok(hash.to_ascii_lowercase())
}
pub async fn forge_checksum(
    client: &Client,
    raw: &str,
    cancel: &CancellationToken,
) -> Result<String> {
    checksum_url(client, forge_url(raw)?, cancel).await
}
pub fn neoforge_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| "NeoForge 地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("maven.neoforged.net")
        || !url.path().starts_with("/releases/net/neoforged/neoforge/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("拒绝非 NeoForge 官方资源来源".into());
    }
    Ok(url)
}
pub async fn neoforge_checksum(
    client: &Client,
    raw: &str,
    cancel: &CancellationToken,
) -> Result<String> {
    checksum_url(client, neoforge_url(raw)?, cancel).await
}
pub async fn neoforge_download(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    download_url(client, root, artifact, neoforge_url(&artifact.url)?, cancel).await
}
// Artifacts must come from the SHA-1 verified official installer manifest.
pub async fn installer_library_download(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    download_url(
        client,
        root,
        artifact,
        installer_library_url(&artifact.url)?,
        cancel,
    )
    .await
}
fn installer_library_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| "安装器依赖地址无效")?;
    if trusted_url(raw).is_err()
        && !(url.scheme() == "https"
            && ((url.host_str() == Some("maven.neoforged.net")
                && url.path().starts_with("/releases/"))
                || url.host_str() == Some("maven.minecraftforge.net"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.port().is_none()
            && url.query().is_none()
            && url.fragment().is_none())
    {
        return Err("拒绝非官方安装器依赖来源".into());
    }
    Ok(url)
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub url: String,
    pub sha1: String,
    pub size: Option<u64>,
    pub path: String,
}
pub fn matches(path: &Path, hash: &str, size: Option<u64>) -> Result<bool> {
    if !valid_sha1(hash) {
        return Err("无效 SHA-1 校验信息".into());
    }
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("无法读取缓存文件".into()),
    };
    if size.is_some_and(|size| {
        file.metadata()
            .map(|meta| meta.len() != size)
            .unwrap_or(true)
    }) {
        return Ok(false);
    }
    let mut digest = Sha1::new();
    let mut bytes = [0; 65536];
    loop {
        let count = file.read(&mut bytes).map_err(|_| "无法校验缓存")?;
        if count == 0 {
            break;
        }
        digest.update(&bytes[..count]);
    }
    let actual: String = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(actual.eq_ignore_ascii_case(hash))
}
pub fn resume_offset(status: u16, offset: u64, content_range: Option<&str>) -> Result<u64> {
    match status {
        200 => Ok(0),
        206 if offset > 0
            && content_range
                .is_some_and(|range| range.starts_with(&format!("bytes {offset}-"))) =>
        {
            Ok(offset)
        }
        _ => Err(format!("下载服务返回异常 HTTP {status} 或续传范围不匹配")),
    }
}
pub async fn download(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    let url = trusted_url(&artifact.url)?;
    download_url(client, root, artifact, url, cancel).await
}
pub fn resource_download_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| "资源文件地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("cdn.modrinth.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || !url.path().starts_with("/data/")
    {
        return Err("拒绝非 Modrinth 文件来源".into());
    }
    Ok(url)
}
pub async fn resource_download(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    let url = resource_download_url(&artifact.url)?;
    download_url(client, root, artifact, url, cancel).await
}
#[derive(Clone, Debug)]
pub enum TransferUpdate {
    Cached,
    Bytes(u64),
    Verified,
    Retrying(usize),
}
pub type DownloadObserver<'a> = dyn Fn(TransferUpdate) + Send + Sync + 'a;
pub async fn resource_download_observed(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    cancel: &CancellationToken,
    observer: &DownloadObserver<'_>,
) -> Result<PathBuf> {
    download_observed(
        client,
        root,
        artifact,
        resource_download_url(&artifact.url)?,
        cancel,
        Some(observer),
    )
    .await
}
pub fn curseforge_download_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| "CurseForge 文件地址无效")?;
    if url.scheme() != "https"
        || !["edge.forgecdn.net", "mediafilez.forgecdn.net"]
            .contains(&url.host_str().unwrap_or_default())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.path().starts_with("/files/")
    {
        return Err("拒绝非 CurseForge 官方 CDN 文件来源".into());
    }
    Ok(url)
}
pub async fn curseforge_download(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    download_url(
        client,
        root,
        artifact,
        curseforge_download_url(&artifact.url)?,
        cancel,
    )
    .await
}
pub fn forge_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw).map_err(|_| "Forge 地址无效")?;
    let official = (url.host_str() == Some("files.minecraftforge.net")
        && [
            "/net/minecraftforge/forge/promotions_slim.json",
            "/net/minecraftforge/forge/maven-metadata.json",
        ]
        .contains(&url.path()))
        || (url.host_str() == Some("maven.minecraftforge.net")
            && url.path().starts_with("/net/minecraftforge/forge/"));
    if url.scheme() != "https"
        || !official
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err("拒绝非 Forge 官方资源来源".into());
    }
    Ok(url)
}
pub async fn forge_json(
    client: &Client,
    raw: &str,
    cancel: &CancellationToken,
) -> Result<serde_json::Value> {
    json_url(client, forge_url(raw)?, cancel).await
}
pub async fn forge_download(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    download_url(client, root, artifact, forge_url(&artifact.url)?, cancel).await
}
async fn download_url(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    url: Url,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    download_observed(client, root, artifact, url, cancel, None).await
}
async fn matches_async(path: &Path, hash: &str, size: Option<u64>) -> Result<bool> {
    let path = path.to_owned();
    let hash = hash.to_owned();
    tokio::task::spawn_blocking(move || matches(&path, &hash, size))
        .await
        .map_err(|_| "缓存校验任务失败")?
}
fn notify(observer: Option<&DownloadObserver<'_>>, update: TransferUpdate) {
    if let Some(observer) = observer {
        observer(update);
    }
}
async fn download_observed(
    client: &Client,
    root: &Path,
    artifact: &Artifact,
    url: Url,
    cancel: &CancellationToken,
    observer: Option<&DownloadObserver<'_>>,
) -> Result<PathBuf> {
    if !valid_sha1(&artifact.sha1) || artifact.size.is_some_and(|size| size > 512 * 1024 * 1024) {
        return Err("下载校验信息或大小无效".into());
    }
    let path = safe_path(root, &artifact.path)?;
    if cancel.is_cancelled() {
        return Err("操作已取消".into());
    }
    if matches_async(&path, &artifact.sha1, artifact.size).await? {
        notify(observer, TransferUpdate::Cached);
        return Ok(path);
    }
    let partial = safe_path(root, &format!("{}.part", artifact.path))?;
    fs::create_dir_all(path.parent().ok_or("无效缓存目录")?).map_err(|_| "无法创建缓存目录")?;
    let mut last_error = String::new();
    let started = std::time::Instant::now();
    let mut stalled = 0;
    // Interrupted large responses may still make useful progress. Keep the
    // three-failure limit for stalls, with a separate total/time bound.
    for attempt in 0..64 {
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        let before = fs::metadata(&partial).map(|file| file.len()).unwrap_or(0);
        let transport = if attempt > 0 && modrinth_origin(&url) {
            fallback_client()?
        } else {
            client
        };
        let result =
            download_once(transport, url.clone(), artifact, &partial, cancel, observer).await;
        let mut wait = Duration::from_millis(500);
        match result {
            Ok(()) => {
                if !matches_async(&partial, &artifact.sha1, artifact.size).await? {
                    fs::File::create(&partial).map_err(|_| "无法重置损坏的临时文件")?;
                    last_error = "下载文件校验失败，损坏临时文件已清空".into();
                } else {
                    if cancel.is_cancelled() {
                        return Err("操作已取消，已校验临时文件保留".into());
                    }
                    fs::rename(&partial, &path).map_err(|_| "无法提交已校验的缓存文件")?;
                    notify(observer, TransferUpdate::Verified);
                    return Ok(path);
                }
            }
            Err(error) => {
                if !error.retry {
                    return Err(error.message);
                }
                if error.reset {
                    fs::File::create(&partial).map_err(|_| "无法重置过期的续传缓存")?;
                }
                wait = wait.max(error.wait);
                last_error = error.message;
            }
        }
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        let after = fs::metadata(&partial).map(|file| file.len()).unwrap_or(0);
        stalled = if after >= before.saturating_add(256 * 1024) {
            0
        } else {
            stalled + 1
        };
        if stalled >= 3 || attempt == 63 || started.elapsed() > Duration::from_secs(15 * 60) {
            break;
        }
        wait = wait.max(Duration::from_millis(500 * (stalled + 1)));
        {
            notify(observer, TransferUpdate::Retrying(attempt as usize + 1));
            tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), _ = tokio::time::sleep(wait) => {} }
        }
    }
    Err(last_error)
}
struct DownloadFailure {
    message: String,
    retry: bool,
    reset: bool,
    wait: Duration,
}
impl From<&str> for DownloadFailure {
    fn from(value: &str) -> Self {
        Self {
            message: value.into(),
            retry: false,
            reset: false,
            wait: Duration::ZERO,
        }
    }
}
impl From<String> for DownloadFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            retry: false,
            reset: false,
            wait: Duration::ZERO,
        }
    }
}
impl DownloadFailure {
    fn retry(message: &str) -> Self {
        Self {
            message: message.into(),
            retry: true,
            reset: false,
            wait: Duration::ZERO,
        }
    }
}
async fn download_once(
    client: &Client,
    url: Url,
    artifact: &Artifact,
    partial: &Path,
    cancel: &CancellationToken,
    observer: Option<&DownloadObserver<'_>>,
) -> std::result::Result<(), DownloadFailure> {
    let mut offset = fs::metadata(partial).map(|meta| meta.len()).unwrap_or(0);
    if artifact.size == Some(offset)
        && matches_async(partial, &artifact.sha1, artifact.size).await?
    {
        return Ok(());
    }
    if artifact.size.is_some_and(|size| offset >= size) {
        fs::File::create(partial).map_err(|_| "无法重置损坏的临时文件")?;
        offset = 0;
    }
    let mut request = client.get(url).timeout(Duration::from_secs(15 * 60));
    if offset > 0 {
        request = request.header("Range", format!("bytes={offset}-"));
    }
    let response = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), response = tokio::time::timeout(Duration::from_secs(30),request.send()) => response.map_err(|_|DownloadFailure::retry("等待下载响应超过 30 秒，正在重试"))?.map_err(|_| DownloadFailure::retry("资源下载连接中断，保留临时文件，可重试"))? };
    let status = response.status().as_u16();
    if status == 408 || status == 429 || (500..600).contains(&status) {
        let mut error = DownloadFailure::retry(&format!("下载来源 HTTP {status}，正在等待重试"));
        error.wait = Duration::from_secs(
            response
                .headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
                .min(30),
        );
        return Err(error);
    }
    let start = resume_offset(
        response.status().as_u16(),
        offset,
        response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok()),
    )
    .map_err(|message| DownloadFailure {
        message,
        retry: offset > 0 && [206, 416].contains(&status),
        reset: offset > 0 && [206, 416].contains(&status),
        wait: Duration::ZERO,
    })?;
    notify(observer, TransferUpdate::Bytes(start));
    let output = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(start == 0)
        .append(start > 0)
        .open(partial)
        .map_err(|_| "无法写入下载缓存")?;
    let mut file = std::io::BufWriter::with_capacity(256 * 1024, output);
    let mut received = start;
    let mut reported = std::time::Instant::now();
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), next = tokio::time::timeout(Duration::from_secs(20),stream.next()) => next.map_err(|_|DownloadFailure::retry("下载连续 20 秒未收到数据，保留已下载部分并重试"))? };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|_| DownloadFailure::retry("资源下载中断，可重试续传"))?;
        received += chunk.len() as u64;
        if received > artifact.size.unwrap_or(8 * 1024 * 1024) {
            return Err("资源超出声明大小".into());
        }
        file.write_all(&chunk)
            .map_err(|_| "磁盘写入失败，请检查空间")?;
        if reported.elapsed() >= Duration::from_millis(200) {
            notify(observer, TransferUpdate::Bytes(received));
            reported = std::time::Instant::now();
        }
    }
    file.flush().map_err(|_| "下载缓存刷新失败")?;
    file.get_ref().sync_all().map_err(|_| "缓存同步失败")?;
    notify(observer, TransferUpdate::Bytes(received));
    Ok(())
}
