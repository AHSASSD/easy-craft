//! Official Windows x64 runtimes, verified in a resumable staging area before publication.
use crate::{
    host::Host,
    minecraft,
    model::{self, Instance, Result},
    net,
};
use futures_util::{stream, StreamExt, TryStreamExt};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

const INDEX: &str = "https://piston-meta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

fn component(major: u32) -> Result<&'static str> {
    match major {
        8 => Ok("jre-legacy"),
        16 => Ok("java-runtime-alpha"),
        17 => Ok("java-runtime-gamma"),
        21 => Ok("java-runtime-delta"),
        25 => Ok("java-runtime-epsilon"),
        _ => Err(format!(
            "暂不支持自动准备 Java {major}，请手动选择兼容 Java"
        )),
    }
}
fn artifact(value: &Value, path: String, maximum: u64) -> Result<net::Artifact> {
    let result = net::Artifact {
        url: value["url"].as_str().ok_or("Java 下载地址缺失")?.into(),
        sha1: value["sha1"]
            .as_str()
            .filter(|v| model::valid_sha1(v))
            .ok_or("Java 校验值无效")?
            .into(),
        size: Some(
            value["size"]
                .as_u64()
                .filter(|v| *v > 0 && *v <= maximum)
                .ok_or("Java 文件大小无效")?,
        ),
        path,
    };
    let url = net::trusted_url(&result.url)?;
    if ![
        Some("piston-meta.mojang.com"),
        Some("piston-data.mojang.com"),
    ]
    .contains(&url.host_str())
    {
        return Err("Java 文件不是受支持的 Mojang 官方来源".into());
    }
    model::validate_relative_path(&result.path)?;
    Ok(result)
}
fn plan(manifest: &Value, prefix: &str) -> Result<Vec<net::Artifact>> {
    let entries = manifest["files"]
        .as_object()
        .filter(|v| !v.is_empty() && v.len() <= 4096)
        .ok_or("Java 文件清单无效或过大")?;
    let mut files = Vec::new();
    let mut names = HashSet::new();
    let mut bytes = 0u64;
    for (name, entry) in entries {
        model::validate_relative_path(name)?;
        if !names.insert(name.to_ascii_lowercase()) {
            return Err("Java 清单包含大小写冲突路径".into());
        }
        match entry["type"].as_str() {
            Some("directory") => {}
            Some("file") => {
                let file = artifact(
                    &entry["downloads"]["raw"],
                    format!("{prefix}/{name}"),
                    256 * 1024 * 1024,
                )?;
                bytes += file.size.unwrap_or_default();
                if bytes > 1024 * 1024 * 1024 {
                    return Err("Java 运行时总大小超限".into());
                }
                files.push(file);
            }
            _ => return Err("Java 清单包含不支持的链接或文件类型".into()),
        }
    }
    if !entries.contains_key("bin/java.exe")
        || !files
            .iter()
            .any(|v| v.path == format!("{prefix}/bin/java.exe"))
    {
        return Err("Java 清单缺少 bin/java.exe".into());
    }
    Ok(files)
}

pub async fn ensure(
    host: &Host,
    instance: &Instance,
    configured: &str,
    cancel: &CancellationToken,
) -> Result<minecraft::JavaInfo> {
    if cancel.is_cancelled() {
        return Err("操作已取消".into());
    }
    if instance.launch.java_path.is_some() {
        let java = minecraft::probe_java(configured).await?;
        if java.major != instance.java_major || !java.is_64_bit {
            return Err(format!(
                "该实例需要 64 位 Java {}，请核对指定路径",
                instance.java_major
            ));
        }
        return Ok(java);
    }
    if let Ok(java) = crate::local_launch::java_for(instance, configured, &host.root).await {
        return Ok(java);
    }
    install(host, instance.java_major, cancel).await
}

async fn install(
    host: &Host,
    major: u32,
    cancel: &CancellationToken,
) -> Result<minecraft::JavaInfo> {
    let component = component(major)?;
    host.progress(
        "java-index",
        &format!("读取官方 Java {major} 运行时清单"),
        0,
        1,
    );
    let index = net::get_json(&host.client, INDEX, cancel).await?;
    let record = index["windows-x64"][component]
        .as_array()
        .and_then(|v| v.first())
        .ok_or("官方清单没有兼容的 Windows x64 Java")?;
    let hash = record["manifest"]["sha1"]
        .as_str()
        .filter(|v| model::valid_sha1(v))
        .ok_or("Java 清单校验值无效")?;
    let metadata = artifact(
        &record["manifest"],
        format!("cache/java-runtime/{hash}/manifest.json"),
        4 * 1024 * 1024,
    )?;
    let path = net::download(&host.client, &host.root, &metadata, cancel).await?;
    let manifest: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "Java 清单不可读")?)
        .map_err(|_| "Java 清单内容无效")?;
    let prefix = format!("cache/java-runtime/{hash}/files");
    let files = plan(&manifest, &prefix)?;
    let count = files.len();
    let completed = AtomicUsize::new(0);
    host.progress(
        "java-download",
        &format!("下载并校验 Java {major} 文件"),
        0,
        count,
    );
    let completed = &completed;
    stream::iter(files)
        .map(|file: net::Artifact| async move {
            net::download(&host.client, &host.root, &file, cancel).await?;
            let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
            host.progress(
                "java-download",
                &format!("Java {major} 已校验 {done}/{count} 个文件"),
                done,
                count,
            );
            Ok::<(), String>(())
        })
        .buffer_unordered(6)
        .try_collect::<Vec<_>>()
        .await?;
    if cancel.is_cancelled() {
        return Err("操作已取消".into());
    }
    let executable = model::safe_path(&host.root, &format!("{prefix}/bin/java.exe"))?;
    let java = minecraft::probe_java(executable.to_str().ok_or("Java 路径无效")?).await?;
    if java.major != major || !java.is_64_bit {
        return Err("下载的 Java 版本或架构与要求不符".into());
    }
    if cancel.is_cancelled() {
        return Err("操作已取消".into());
    }
    let destination = format!("runtimes/java{major}-{hash}-{}", uuid::Uuid::new_v4());
    let target = model::safe_path(&host.root, &destination)?;
    fs::create_dir_all(target.parent().ok_or("Java 目标目录无效")?)
        .map_err(|_| "无法创建运行时目录")?;
    fs::rename(model::safe_path(&host.root, &prefix)?, &target)
        .map_err(|_| "无法提交 Java 运行时，已保留校验缓存")?;
    host.progress(
        "java-committed",
        &format!("Java {major} 已准备好"),
        count,
        count,
    );
    Ok(minecraft::JavaInfo {
        path: target.join("bin/java.exe").to_string_lossy().into_owned(),
        ..java
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancelled_runtime_preparation_never_publishes_or_changes_explicit_java() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        let host = Host::new(root.clone()).unwrap();
        let instance: Instance = serde_json::from_value(serde_json::json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Cancel fixture","version":"1.21.1","manifestSha1":"a".repeat(40),"javaMajor":21,"launch":{"javaPath":"Z:/missing-easycraft/java.exe"}})).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(
            ensure(&host, &instance, "Z:/missing-easycraft/java.exe", &cancel)
                .await
                .is_err()
        );
        assert!(!root.join("runtimes").exists());
        assert!(!root.join("cache/java-runtime").exists());
        let live = CancellationToken::new();
        assert!(
            ensure(&host, &instance, "Z:/missing-easycraft/java.exe", &live)
                .await
                .is_err()
        );
        assert!(!root.join("cache/java-runtime").exists());
    }
    #[test]
    fn runtime_plans_reject_unsafe_sources_paths_links_and_missing_java() {
        let file = serde_json::json!({"type":"file","downloads":{"raw":{"url":"https://piston-data.mojang.com/v1/objects/test/java.exe","sha1":"a".repeat(40),"size":10}}});
        let good = serde_json::json!({"files":{"bin/java.exe":file}});
        assert_eq!(plan(&good, "cache/fixture").unwrap().len(), 1);
        for name in ["../escape", "C:/escape", "bin/JAVA.exe"] {
            let mut value = good.clone();
            value["files"][name] = file.clone();
            assert!(plan(&value, "cache/fixture").is_err());
        }
        for invalid in [
            serde_json::json!({"files":{"bin/java.exe":{"type":"link","target":"outside"}}}),
            serde_json::json!({"files":{"other":file}}),
        ] {
            assert!(plan(&invalid, "cache/fixture").is_err());
        }
        let mut bad = good;
        bad["files"]["bin/java.exe"]["downloads"]["raw"]["url"] =
            "https://example.com/java.exe".into();
        assert!(plan(&bad, "cache/fixture").is_err());
        assert!(component(99).is_err());
    }
    #[tokio::test]
    #[ignore = "downloads and probes an official runtime in an isolated directory"]
    async fn official_java_runtime_downloads_and_reuses_without_launching_game() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/java-runtime")
            .join(uuid::Uuid::new_v4().to_string());
        let host = Host::new(root.clone()).unwrap();
        let cancel = CancellationToken::new();
        let java = install(&host, 21, &cancel).await.unwrap();
        assert_eq!(java.major, 21);
        assert!(java.is_64_bit);
        let instance: Instance = serde_json::from_value(serde_json::json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Runtime fixture","version":"1.21.1","manifestSha1":"a".repeat(40),"javaMajor":21})).unwrap();
        let reused = ensure(&host, &instance, "", &cancel).await.unwrap();
        assert_eq!(reused.path, java.path);
        fs::write(
            root.join("verification.json"),
            serde_json::to_vec_pretty(&java).unwrap(),
        )
        .unwrap();
        println!("Verified runtime only: {}", root.display());
    }
}
