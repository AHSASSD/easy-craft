use crate::{
    host::Host,
    model::{safe_path, valid_id, valid_sha1, Instance, Profile, Result, Version},
    net::{self, Artifact},
};
use futures_util::{stream, StreamExt, TryStreamExt};
use serde_json::Value;
use std::{collections::HashMap, fs, io::Read, path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

pub async fn versions(host: &Host, cancel: &CancellationToken) -> Result<Vec<Version>> {
    let value = net::get_json(&host.client, net::MANIFEST, cancel).await?;
    let entries: Vec<Version> =
        serde_json::from_value(value["versions"].clone()).map_err(|_| "官方版本列表格式无效")?;
    Ok(entries
        .into_iter()
        .filter(|entry| entry.kind == "release" && valid_id(&entry.id) && valid_sha1(&entry.sha1))
        .collect())
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .ok_or_else(|| format!("官方元数据缺少字段 {field}"))
}
pub fn allowed(rules: Option<&Value>) -> Result<bool> {
    let Some(rules) = rules else {
        return Ok(true);
    };
    let rules = rules.as_array().ok_or("无效平台规则")?;
    let mut allow = false;
    for rule in rules {
        let mut matches = true;
        if let Some(os) = rule.get("os") {
            if let Some(name) = os["name"].as_str() {
                matches &= name == "windows";
            }
            if let Some(arch) = os["arch"].as_str() {
                matches &= arch == "x86_64" || arch == "amd64";
            }
            // shortcut: legacy OS-version rules are unsupported; extend only with version-specific integration fixtures.
            if os.get("version").is_some() && matches {
                return Err("此旧版 Windows 平台规则尚不支持".into());
            }
        }
        if let Some(features) = rule.get("features") {
            for (_, value) in features.as_object().ok_or("无效功能规则")? {
                matches &= value.as_bool() == Some(false);
            }
        }
        if matches {
            allow = match text(rule, "action")? {
                "allow" => true,
                "disallow" => false,
                _ => return Err("未知平台规则动作".into()),
            };
        }
    }
    Ok(allow)
}
fn artifact(value: &Value, prefix: &str) -> Result<Artifact> {
    let path = format!("{prefix}{}", text(value, "path")?);
    Ok(Artifact {
        url: text(value, "url")?.into(),
        sha1: text(value, "sha1")?.into(),
        size: value["size"].as_u64(),
        path,
    })
}
pub struct Prepared {
    pub metadata: Value,
    pub classpath: Vec<PathBuf>,
    pub native_archives: Vec<PathBuf>,
    pub java_major: u32,
}
pub struct DatapackVersion {
    pub world: u32,
    pub format: crate::content::PackVersion,
}
pub fn datapack_version(host: &Host, instance: &Instance) -> Result<DatapackVersion> {
    let metadata = safe_path(
        &host.root,
        &format!(
            "versions/{}/{}.json",
            instance.version, instance.manifest_sha1
        ),
    )?;
    if !net::matches(&metadata, &instance.manifest_sha1, None)?
        || fs::metadata(&metadata)
            .map_err(|_| "无法读取游戏版本")?
            .len()
            > 8 * 1024 * 1024
    {
        return Err("官方版本元数据缺失或损坏，请先修复实例".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(metadata).map_err(|_| "无法读取游戏版本")?)
        .map_err(|_| "游戏版本元数据无效")?;
    let client = safe_path(
        &host.root,
        &format!("versions/{}/client.jar", instance.version),
    )?;
    let hash = value
        .pointer("/downloads/client/sha1")
        .and_then(Value::as_str)
        .ok_or("游戏文件校验信息缺失")?;
    if !net::matches(
        &client,
        hash,
        value
            .pointer("/downloads/client/size")
            .and_then(Value::as_u64),
    )? {
        return Err("原版游戏文件缺失或损坏，请先修复实例".into());
    }
    let mut archive = zip::ZipArchive::new(fs::File::open(client).map_err(|_| "无法读取游戏文件")?)
        .map_err(|_| "游戏 JAR 无效")?;
    let entry = archive
        .by_name("version.json")
        .map_err(|_| "此游戏版本未提供内置数据包格式，暂不自动安装")?;
    if entry.size() > 64 * 1024 {
        return Err("游戏版本信息过大".into());
    }
    let info: Value =
        serde_json::from_reader(entry.take(64 * 1024 + 1)).map_err(|_| "游戏内置版本信息无效")?;
    if info.get("id").and_then(Value::as_str) != Some(instance.version.as_str()) {
        return Err("游戏内置版本与实例不符".into());
    }
    let world = info
        .get("world_version")
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or("缺少世界数据版本")?;
    let mut format = crate::content::pack_bound(
        info.pointer("/pack_version/data").ok_or("缺少数据包格式")?,
        false,
    )?;
    if let Some(minor) = info.pointer("/pack_version/data_minor") {
        format.1 = minor
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or("数据包次版本无效")?;
    }
    Ok(DatapackVersion { world, format })
}
pub async fn prepare(host: &Host, entry: &Version, cancel: &CancellationToken) -> Result<Prepared> {
    if !valid_id(&entry.id) || !valid_sha1(&entry.sha1) {
        return Err("无效版本标识或校验信息".into());
    }
    host.progress("metadata", "校验官方版本元数据", 0, 1);
    let path = net::download(
        &host.client,
        &host.root,
        &Artifact {
            url: entry.url.clone(),
            sha1: entry.sha1.clone(),
            size: None,
            path: format!("versions/{}/{}.json", entry.id, entry.sha1),
        },
        cancel,
    )
    .await?;
    let metadata: Value =
        serde_json::from_slice(&fs::read(path).map_err(|_| "无法读取版本元数据")?)
            .map_err(|_| "版本元数据格式无效")?;
    if text(&metadata, "id")? != entry.id
        || metadata.get("inheritsFrom").is_some()
        || metadata.get("minecraftArguments").is_some()
        || !metadata["arguments"]["game"].is_array()
    {
        return Err("V0.3 仅支持现代原版格式，不支持旧式参数或继承版本".into());
    }
    let java_major = metadata["javaVersion"]["majorVersion"]
        .as_u64()
        .ok_or("缺少 Java 版本要求")? as u32;
    let client = &metadata["downloads"]["client"];
    let mut artifacts = vec![Artifact {
        url: text(client, "url")?.into(),
        sha1: text(client, "sha1")?.into(),
        size: client["size"].as_u64(),
        path: format!("versions/{}/client.jar", entry.id),
    }];
    let mut classpath = vec![];
    let mut native_archives = vec![];
    let libraries = metadata["libraries"].as_array().ok_or("缺少依赖库清单")?;
    if libraries.len() > 2000 {
        return Err("依赖库数量异常".into());
    }
    for library in libraries {
        if !allowed(library.get("rules"))? {
            continue;
        }
        if let Some(value) = library["downloads"].get("artifact") {
            let file = artifact(value, "libraries/")?;
            classpath.push(safe_path(&host.root, &file.path)?);
            artifacts.push(file);
        }
        if let Some(native) = library["natives"]["windows"].as_str() {
            let classifier = native.replace("${arch}", "64");
            let file = artifact(
                &library["downloads"]["classifiers"][&classifier],
                "libraries/",
            )?;
            native_archives.push(safe_path(&host.root, &file.path)?);
            artifacts.push(file);
        }
    }
    classpath.push(safe_path(&host.root, &artifacts[0].path)?);
    let index = &metadata["assetIndex"];
    let index_id = text(index, "id")?;
    if !valid_id(index_id) {
        return Err("无效资源索引标识".into());
    }
    let index_file = Artifact {
        url: text(index, "url")?.into(),
        sha1: text(index, "sha1")?.into(),
        size: index["size"].as_u64(),
        path: format!("assets/indexes/{index_id}.json"),
    };
    let path = net::download(&host.client, &host.root, &index_file, cancel).await?;
    let assets: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "无法读取资源索引")?)
        .map_err(|_| "资源索引格式无效")?;
    if assets["virtual"] == true || assets["map_to_resources"] == true {
        return Err("此旧版资源布局暂不支持".into());
    }
    let objects = assets["objects"].as_object().ok_or("缺少资源对象清单")?;
    if objects.len() > 50000 {
        return Err("资源数量异常".into());
    }
    let mut hashes = std::collections::HashSet::new();
    for value in objects.values() {
        let hash = text(value, "hash")?;
        if !valid_sha1(hash) {
            return Err("无效资源哈希".into());
        }
        if hashes.insert(hash) {
            let suffix = format!("{}/{hash}", &hash[..2]);
            artifacts.push(Artifact {
                url: format!("https://resources.download.minecraft.net/{suffix}"),
                sha1: hash.into(),
                size: value["size"].as_u64(),
                path: format!("assets/objects/{suffix}"),
            });
        }
    }
    let total = artifacts.len();
    host.progress(
        "download",
        "下载并校验官方资源；可取消，重试会复用已校验缓存",
        0,
        total,
    );
    let mut completed = 0;
    let results = stream::iter(artifacts.into_iter().map(|artifact| async move {
        net::download(&host.client, &host.root, &artifact, cancel).await
    }))
    .buffer_unordered(8);
    tokio::pin!(results);
    while results.try_next().await?.is_some() {
        completed += 1;
        host.progress("download", "下载与 SHA-1 校验", completed, total);
    }
    Ok(Prepared {
        metadata,
        classpath,
        native_archives,
        java_major,
    })
}
pub fn extract_natives(
    archives: &[PathBuf],
    root: &std::path::Path,
    directory: &str,
) -> Result<()> {
    let mut total = 0;
    for archive in archives {
        let file = fs::File::open(archive).map_err(|_| "无法打开已校验本地库")?;
        let mut zip = zip::ZipArchive::new(file).map_err(|_| "本地库归档格式无效")?;
        for index in 0..zip.len() {
            let file = zip.by_index(index).map_err(|_| "无法读取本地库条目")?;
            if !file
                .name()
                .map_err(|_| "ZIP 条目名称无效")?
                .to_ascii_lowercase()
                .ends_with(".dll")
            {
                continue;
            }
            let path = file.enclosed_name().ok_or("拒绝越界 ZIP 条目")?;
            if file
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err("拒绝 ZIP 链接条目".into());
            }
            if file.size() > 64 * 1024 * 1024 {
                return Err("本地库条目过大".into());
            }
            let relative = format!("{directory}/{}", path.to_string_lossy().replace('\\', "/"));
            let path = safe_path(root, &relative)?;
            total += file.size();
            if total > 512 * 1024 * 1024 {
                return Err("本地库解压大小异常".into());
            }
            fs::create_dir_all(path.parent().ok_or("无效本地库目录")?)
                .map_err(|_| "无法创建本地库目录")?;
            let mut out = fs::File::create(path).map_err(|_| "无法保存本地库")?;
            std::io::copy(&mut file.take(64 * 1024 * 1024 + 1), &mut out)
                .map_err(|_| "本地库提取失败")?;
        }
    }
    Ok(())
}
pub fn arguments(values: &Value, substitutions: &HashMap<&str, String>) -> Result<Vec<String>> {
    let mut result = vec![];
    for value in values.as_array().ok_or("无效启动参数列表")? {
        let value = if value.is_string() {
            value
        } else {
            if !allowed(value.get("rules"))? {
                continue;
            }
            &value["value"]
        };
        let parts: Vec<&str> = if let Some(value) = value.as_str() {
            vec![value]
        } else {
            value
                .as_array()
                .ok_or("无效参数值")?
                .iter()
                .map(|item| item.as_str().ok_or("无效参数值".to_string()))
                .collect::<Result<_>>()?
        };
        for part in parts {
            let mut part = part.to_owned();
            for (key, value) in substitutions {
                part = part.replace(&format!("${{{key}}}"), value);
            }
            if part.contains("${") || part.contains('\0') {
                return Err("版本包含未支持的启动参数".into());
            }
            result.push(part);
        }
    }
    Ok(result)
}
pub fn command_args(
    host: &Host,
    instance: &Instance,
    prepared: &Prepared,
    profile: &Profile,
    token: &str,
    settings: &crate::model::Settings,
) -> Result<Vec<String>> {
    let game = safe_path(&host.root, &format!("instances/{}/game", instance.id))?;
    let natives = safe_path(&host.root, &format!("instances/{}/natives", instance.id))?;
    fs::create_dir_all(&game)
        .and_then(|_| fs::create_dir_all(&natives))
        .map_err(|_| "无法创建隔离游戏目录")?;
    let classpath = std::env::join_paths(&prepared.classpath)
        .map_err(|_| "依赖库路径无法构造")?
        .to_string_lossy()
        .into_owned();
    let substitutions = HashMap::from([
        ("auth_player_name", profile.name.clone()),
        ("auth_uuid", profile.id.clone()),
        ("auth_access_token", token.into()),
        ("auth_xuid", profile.xuid.clone()),
        (
            "clientid",
            if settings.launch_mode == crate::model::LaunchMode::Offline {
                String::new()
            } else {
                settings.client_id.clone()
            },
        ),
        (
            "user_type",
            if settings.launch_mode == crate::model::LaunchMode::Offline {
                "legacy"
            } else {
                "msa"
            }
            .into(),
        ),
        ("user_properties", "{}".into()),
        ("version_name", instance.version.clone()),
        ("version_type", "release".into()),
        ("game_directory", game.to_string_lossy().into()),
        (
            "assets_root",
            host.root.join("assets").to_string_lossy().into(),
        ),
        (
            "assets_index_name",
            text(&prepared.metadata["assetIndex"], "id")?.into(),
        ),
        ("natives_directory", natives.to_string_lossy().into()),
        ("launcher_name", "EasyCraft".into()),
        ("launcher_version", "0.3.0".into()),
        ("classpath", classpath),
        ("classpath_separator", ";".into()),
        (
            "library_directory",
            host.root.join("libraries").to_string_lossy().into(),
        ),
    ]);
    let mut args = vec![format!("-Xmx{}M", settings.memory_mb)];
    args.extend(arguments(
        &prepared.metadata["arguments"]["jvm"],
        &substitutions,
    )?);
    args.push(text(&prepared.metadata, "mainClass")?.into());
    args.extend(arguments(
        &prepared.metadata["arguments"]["game"],
        &substitutions,
    )?);
    Ok(args)
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInfo {
    pub major: u32,
    pub is_64_bit: bool,
    pub path: String,
}
pub fn parse_java(raw: &str) -> Result<(u32, bool)> {
    let version = raw
        .lines()
        .find_map(|line| line.trim().strip_prefix("java.specification.version = "))
        .ok_or("无法读取 Java 版本")?;
    let major = version
        .strip_prefix("1.")
        .unwrap_or(version)
        .split('.')
        .next()
        .and_then(|value| value.parse().ok())
        .ok_or("Java 版本格式无效")?;
    Ok((
        major,
        raw.lines()
            .any(|line| line.trim() == "sun.arch.data.model = 64"),
    ))
}
pub async fn probe_java(path: &str) -> Result<JavaInfo> {
    let executable = std::path::Path::new(path);
    if !executable.is_absolute()
        || !executable
            .file_name()
            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case("java.exe"))
        || !executable.is_file()
    {
        return Err("请选择可信 Java 安装目录中的 java.exe 完整路径".into());
    }
    let mut command = tokio::process::Command::new(executable);
    command
        .args(["-XshowSettings:properties", "-version"])
        .kill_on_drop(true)
        .creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| "Java 检测超时")?
        .map_err(|_| "无法运行选择的 Java")?;
    if !output.status.success() || output.stderr.len() > 128 * 1024 {
        return Err("Java 检测失败".into());
    }
    let raw = String::from_utf8_lossy(&output.stderr);
    let (major, is_64_bit) = parse_java(&raw)?;
    Ok(JavaInfo {
        major,
        is_64_bit,
        path: path.into(),
    })
}
