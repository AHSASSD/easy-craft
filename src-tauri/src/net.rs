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
pub fn client() -> Result<Client> {
    Client::builder()
        .user_agent(concat!("EasyCraft/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化 HTTPS".into())
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
        let result = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), response = client.get(url.clone()).send() => response };
        match result {
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
    serde_json::from_slice(&bytes).map_err(|_| "元数据格式无效".into())
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
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
    let response = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), result = client.get(url).send() => result.map_err(|_| "无法读取 Fabric 校验值")? };
    if !response.status().is_success() {
        return Err("Fabric 校验值服务返回失败".into());
    }
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];
    while let Some(chunk) = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), result = stream.next() => result }
    {
        let chunk = chunk.map_err(|_| "校验值接收中断")?;
        if bytes.len() + chunk.len() > 256 {
            return Err("校验值响应过长".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let hash = std::str::from_utf8(&bytes)
        .map_err(|_| "校验值编码无效")?
        .trim();
    if !valid_sha1(hash) {
        return Err("Fabric SHA-1 无效".into());
    }
    Ok(hash.to_ascii_lowercase())
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
    if !valid_sha1(&artifact.sha1) || artifact.size.is_some_and(|size| size > 512 * 1024 * 1024) {
        return Err("下载校验信息或大小无效".into());
    }
    let path = safe_path(root, &artifact.path)?;
    if matches(&path, &artifact.sha1, artifact.size)? {
        return Ok(path);
    }
    let partial = safe_path(root, &format!("{}.part", artifact.path))?;
    fs::create_dir_all(path.parent().ok_or("无效缓存目录")?).map_err(|_| "无法创建缓存目录")?;
    let mut last_error = String::new();
    for attempt in 0..3 {
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        let result = download_once(client, url.clone(), artifact, &partial, cancel).await;
        match result {
            Ok(()) => {
                if !matches(&partial, &artifact.sha1, artifact.size)? {
                    fs::File::create(&partial).map_err(|_| "无法重置损坏的临时文件")?;
                    return Err("下载文件校验失败，未安装。请重试。".into());
                }
                fs::rename(&partial, &path).map_err(|_| "无法提交已校验的缓存文件")?;
                return Ok(path);
            }
            Err(error) => last_error = error,
        }
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        if attempt < 2 {
            tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), _ = tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))) => {} }
        }
    }
    Err(last_error)
}
async fn download_once(
    client: &Client,
    url: Url,
    artifact: &Artifact,
    partial: &Path,
    cancel: &CancellationToken,
) -> Result<()> {
    let mut offset = fs::metadata(partial).map(|meta| meta.len()).unwrap_or(0);
    if artifact.size == Some(offset) && matches(partial, &artifact.sha1, artifact.size)? {
        return Ok(());
    }
    if artifact.size.is_some_and(|size| offset >= size) {
        fs::File::create(partial).map_err(|_| "无法重置损坏的临时文件")?;
        offset = 0;
    }
    let mut request = client.get(url);
    if offset > 0 {
        request = request.header("Range", format!("bytes={offset}-"));
    }
    let response = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), response = request.send() => response.map_err(|_| "资源下载连接中断，保留临时文件，可重试")? };
    let start = resume_offset(
        response.status().as_u16(),
        offset,
        response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok()),
    )?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(start == 0)
        .append(start > 0)
        .open(partial)
        .map_err(|_| "无法写入下载缓存")?;
    let mut received = start;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), next = stream.next() => next };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|_| "资源下载中断，可重试续传")?;
        received += chunk.len() as u64;
        if received > artifact.size.unwrap_or(8 * 1024 * 1024) {
            return Err("资源超出声明大小".into());
        }
        file.write_all(&chunk)
            .map_err(|_| "磁盘写入失败，请检查空间")?;
    }
    file.sync_all().map_err(|_| "缓存同步失败".into())
}
