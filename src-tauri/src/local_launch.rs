//! Existing installations use their own libraries/assets; registration never copies world contents.
use crate::{
    host::Host,
    minecraft,
    model::{self, Instance, Result},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

fn library_key(value: &Value) -> String {
    let name = value["name"].as_str().unwrap_or_default();
    let (coordinate, extension) = name.split_once('@').unwrap_or((name, "jar"));
    let parts: Vec<_> = coordinate.split(':').collect();
    format!(
        "{}:{}:{}@{}",
        parts.first().unwrap_or(&""),
        parts.get(1).unwrap_or(&""),
        parts.get(3).unwrap_or(&""),
        extension
    )
}
pub fn merge(profiles: &[Value]) -> Result<Value> {
    let mut merged = json!({"arguments":{"jvm":[],"game":[]},"libraries":[]});
    for child in profiles.iter().rev() {
        let mut libraries = merged["libraries"].as_array().cloned().unwrap_or_default();
        let mut positions: HashMap<String, usize> = libraries
            .iter()
            .enumerate()
            .map(|(i, v)| (library_key(v), i))
            .collect();
        for library in child["libraries"].as_array().ok_or("版本缺少依赖库清单")? {
            if !minecraft::allowed(library.get("rules"))? {
                continue;
            }
            let key = library_key(library);
            if let Some(index) = positions.get(&key) {
                libraries[*index] = library.clone();
            } else {
                positions.insert(key, libraries.len());
                libraries.push(library.clone());
            }
        }
        let mut arguments = merged["arguments"].clone();
        for kind in ["jvm", "game"] {
            if let Some(rows) = child["arguments"][kind].as_array() {
                arguments[kind]
                    .as_array_mut()
                    .ok_or("启动参数无效")?
                    .extend(rows.clone());
            }
        }
        for (key, value) in child.as_object().ok_or("版本元数据不是对象")? {
            if !["libraries", "arguments", "inheritsFrom"].contains(&key.as_str())
                && !(key == "logging" && value.as_object().is_some_and(|v| v.is_empty()))
            {
                merged[key] = value.clone();
            }
        }
        merged["libraries"] = Value::Array(libraries);
        merged["arguments"] = arguments;
    }
    if merged["libraries"]
        .as_array()
        .is_none_or(|v| v.len() > 4000)
    {
        return Err("合并后的依赖数量异常".into());
    }
    Ok(merged)
}
pub fn loader(profile: &Value) -> (String, String) {
    let libraries = profile["libraries"].as_array().cloned().unwrap_or_default();
    for (kind, prefix) in [
        ("neoforge", "net.neoforged:neoforge:"),
        ("forge", "net.minecraftforge:forge:"),
        ("fabric", "net.fabricmc:fabric-loader:"),
    ] {
        if let Some(version) = libraries
            .iter()
            .filter_map(|v| v["name"].as_str())
            .find_map(|v| v.strip_prefix(prefix))
        {
            let version = version.split([':', '@']).next().unwrap_or(version);
            return (kind.into(), version.into());
        }
    }
    // NeoForge versions may list only its processed client JAR and FML libraries.
    if let Some(args) = profile["arguments"]["game"].as_array() {
        for (kind, flag) in [
            ("neoforge", "--fml.neoForgeVersion"),
            ("forge", "--fml.forgeVersion"),
        ] {
            if let Some(pair) = args.windows(2).find(|v| v[0] == flag) {
                return (kind.into(), pair[1].as_str().unwrap_or_default().into());
            }
        }
    }
    ("vanilla".into(), String::new())
}
pub fn coordinate_path(name: &str) -> Result<String> {
    let (coordinate, extension) = name.split_once('@').unwrap_or((name, "jar"));
    let parts: Vec<_> = coordinate.split(':').collect();
    if !(3..=4).contains(&parts.len())
        || !["jar", "zip"].contains(&extension)
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        })
    {
        return Err("本地依赖坐标无效".into());
    }
    let classifier = parts.get(3).map(|v| format!("-{v}")).unwrap_or_default();
    Ok(format!(
        "{}/{}/{}/{}-{}{classifier}.{extension}",
        parts[0].replace('.', "/"),
        parts[1],
        parts[2],
        parts[1],
        parts[2]
    ))
}
// FML resolves processed artifacts itself, outside the JSON classpath.
pub fn companion_libraries(profile: &Value) -> Result<Vec<String>> {
    let kind = loader(profile).0;
    if ![
        "cpw.mods.modlauncher.Launcher",
        "cpw.mods.bootstraplauncher.BootstrapLauncher",
    ]
    .iter()
    .any(|v| profile["mainClass"] == *v)
        || !["forge", "neoforge"].contains(&kind.as_str())
    {
        return Ok(vec![]);
    }
    let args = profile["arguments"]["game"]
        .as_array()
        .ok_or("Forge 游戏参数缺失")?;
    let value = |flag: &str| -> Result<&str> {
        args.windows(2)
            .find(|v| v[0] == flag)
            .and_then(|v| v[1].as_str())
            .ok_or_else(|| format!("Forge 缺少参数 {flag}"))
    };
    let mc = value("--fml.mcVersion")?;
    let coordinates = if kind == "neoforge" && args.iter().any(|v| v == "--fml.neoFormVersion") {
        let neo = value("--fml.neoForgeVersion")?;
        let form = value("--fml.neoFormVersion")?;
        vec![
            format!("net.neoforged:neoforge:{neo}:universal"),
            format!("net.neoforged:neoforge:{neo}:client"),
            format!("net.minecraft:client:{mc}-{form}:srg"),
            format!("net.minecraft:client:{mc}-{form}:extra"),
        ]
    } else {
        let forge = value("--fml.forgeVersion")?;
        let group = value("--fml.forgeGroup")?;
        let mcp = value("--fml.mcpVersion")?;
        vec![
            format!("{group}:forge:{mc}-{forge}:universal"),
            format!("{group}:forge:{mc}-{forge}:client"),
            format!("net.minecraft:client:{mc}-{mcp}:srg"),
            format!("net.minecraft:client:{mc}-{mcp}:extra"),
        ]
    };
    coordinates
        .iter()
        .map(|name| coordinate_path(name))
        .collect()
}
pub fn read_profile(root: &Path, instance: &Instance) -> Result<Value> {
    let path = model::safe_path(&instance.directory(root)?, "local-profile.json")?;
    if fs::metadata(&path)
        .map_err(|_| "本地启动配置快照缺失，请重新添加版本")?
        .len()
        > 8 * 1024 * 1024
        || !crate::net::matches(&path, &instance.manifest_sha1, None)?
    {
        return Err("本地启动配置快照已变化，请重新添加版本".into());
    }
    let profile: Value =
        serde_json::from_slice(&fs::read(path).map_err(|_| "无法读取本地启动配置")?)
            .map_err(|_| "本地启动配置无效")?;
    // Older managed 1.12 Forge snapshots lost OS-specific LWJGL rows during merging.
    // Rehydrate from the hash-verified official base without modifying the saved snapshot.
    if instance.version == "1.12.2"
        && instance
            .local
            .as_ref()
            .is_some_and(|v| v.loader == "forge" && Path::new(&v.root) == root)
    {
        let directory = model::safe_path(root, "versions/1.12.2")?;
        for item in fs::read_dir(directory)
            .map_err(|_| "原版元数据目录不可读")?
            .take(32)
        {
            let path = item.map_err(|_| "原版元数据不可读")?.path();
            let hash = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
            if path.extension().is_some_and(|v| v == "json")
                && model::valid_sha1(hash)
                && fs::metadata(&path).is_ok_and(|m| m.len() <= 8 * 1024 * 1024)
                && crate::net::matches(&path, hash, None)?
            {
                let base: Value =
                    serde_json::from_slice(&fs::read(&path).map_err(|_| "原版元数据不可读")?)
                        .map_err(|_| "原版元数据无效")?;
                if base["id"] == instance.version {
                    return merge(&[profile, base]);
                }
            }
        }
        return Err("缺少已校验的 1.12.2 原版元数据，无法修复图形库配置".into());
    }
    Ok(profile)
}
// Repair processed NeoForge artifacts through its verified official installer, never
// substitute another loader version or treat a generated client as a CDN download.
pub async fn repair_neoforge(
    host: &Host,
    instance: &Instance,
    java: &str,
    cancel: &CancellationToken,
) -> Result<()> {
    let local = instance.local.as_ref().ok_or("不是本地实例")?;
    let source = crate::local_import::checked_directory(Path::new(&local.root))?;
    let profile = read_profile(&host.root, instance)?;
    let outputs = companion_libraries(&profile)?;
    if local.loader != "neoforge"
        || outputs
            .iter()
            .all(|p| source.join("libraries").join(p).is_file())
    {
        return Ok(());
    }
    let version = &local.loader_version;
    if version.is_empty()
        || version.len() > 64
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
    {
        return Err("NeoForge 版本号无效".into());
    }
    let base = format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{version}/neoforge-{version}-installer.jar");
    host.progress("local-repair", "获取 NeoForge 官方安装器与校验值", 0, 3);
    let sha1 = crate::net::neoforge_checksum(&host.client, &format!("{base}.sha1"), cancel).await?;
    let installer = crate::net::neoforge_download(
        &host.client,
        &host.root,
        &crate::net::Artifact {
            url: base,
            sha1,
            size: None,
            path: format!("downloads/neoforge/{version}-installer.jar"),
        },
        cancel,
    )
    .await?;
    let stage = model::safe_path(&host.root, &format!("repair/neoforge/{version}"))?;
    fs::create_dir_all(&stage).map_err(|_| "无法创建修复暂存目录")?;
    fs::write(stage.join("launcher_profiles.json"), b"{\"profiles\":{}}")
        .map_err(|_| "无法初始化修复目录")?;
    // Only seed named launch libraries, never traverse worlds or launcher accounts.
    for lib in profile["libraries"].as_array().ok_or("依赖清单缺失")? {
        let relative = lib["downloads"]["artifact"]["path"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| lib["name"].as_str().and_then(|n| coordinate_path(n).ok()));
        if let Some(relative) = relative {
            let from = model::safe_path(&source, &format!("libraries/{relative}"))?;
            let to = model::safe_path(&stage, &format!("libraries/{relative}"))?;
            if from.is_file() && !to.exists() {
                if cancel.is_cancelled() {
                    return Err("修复已取消".into());
                }
                fs::create_dir_all(to.parent().ok_or("修复路径无效")?)
                    .map_err(|_| "无法创建修复缓存")?;
                fs::copy(from, to).map_err(|_| "无法复用本地依赖")?;
            }
        }
    }
    let manifest: Value = {
        use std::io::Read;
        let file = fs::File::open(&installer).map_err(|_| "无法读取官方安装器")?;
        let mut zip = zip::ZipArchive::new(file).map_err(|_| "官方安装器不是有效归档")?;
        let entry = zip
            .by_name("install_profile.json")
            .map_err(|_| "官方安装器清单缺失")?;
        if entry.size() > 8 * 1024 * 1024 {
            return Err("安装器清单过大".into());
        }
        serde_json::from_reader(entry.take(8 * 1024 * 1024)).map_err(|_| "安装器清单无效")?
    };
    let libraries = manifest["libraries"]
        .as_array()
        .ok_or("安装器依赖清单缺失")?;
    if libraries.len() > 2000 {
        return Err("安装器依赖过多".into());
    }
    for (index, lib) in libraries.iter().enumerate() {
        let value = &lib["downloads"]["artifact"];
        let url = value["url"].as_str().unwrap_or_default();
        if url.is_empty() {
            continue;
        } // Generated outputs are produced by the processors.
        let relative = value["path"].as_str().ok_or("安装器依赖路径缺失")?;
        let artifact = crate::net::Artifact {
            url: url.into(),
            sha1: value["sha1"].as_str().ok_or("安装器依赖校验缺失")?.into(),
            size: value["size"].as_u64(),
            path: format!("libraries/{relative}"),
        };
        host.progress(
            "local-repair-download",
            "自动补齐并校验 NeoForge 处理器依赖",
            index,
            libraries.len(),
        );
        crate::net::installer_library_download(&host.client, &stage, &artifact, cancel).await?;
    }
    host.progress(
        "local-repair",
        "执行官方 NeoForge 处理器，详情见任务日志",
        1,
        3,
    );
    let log_path = stage.join("installer-output.log");
    let log = fs::File::create(&log_path).map_err(|_| "无法创建修复日志")?;
    let mut child = tokio::process::Command::new(java)
        .arg("-jar")
        .arg(installer)
        .arg("--installClient")
        .arg(&stage)
        .current_dir(&stage)
        .stdout(log.try_clone().map_err(|_| "无法打开修复日志")?)
        .stderr(log)
        .kill_on_drop(true)
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|_| "无法启动官方修复处理器")?;
    let status = tokio::select! {
        result = child.wait() => result.map_err(|_| "无法读取修复结果")?,
        _ = cancel.cancelled() => { let _ = child.kill().await; let _ = child.wait().await; return Err("修复已取消".into()); },
        _ = tokio::time::sleep(std::time::Duration::from_secs(900)) => { let _ = child.kill().await; let _ = child.wait().await; return Err("NeoForge 修复超时，请检查网络后重试".into()); }
    };
    host.log(
        &format!("NeoForge 官方处理器日志：{}", log_path.display()),
        &[],
    );
    if !status.success() {
        return Err(format!(
            "NeoForge 官方处理器失败；日志：{}",
            log_path.display()
        ));
    }
    for relative in outputs {
        if cancel.is_cancelled() {
            return Err("修复已取消".into());
        }
        commit_repaired_library(&stage, &source, &relative)?;
    }
    host.progress(
        "local-repair",
        "NeoForge 缺失依赖已补齐，重新检查启动环境",
        3,
        3,
    );
    Ok(())
}
pub async fn repair_downloads(
    host: &Host,
    instance: &Instance,
    cancel: &CancellationToken,
) -> Result<()> {
    let local = instance.local.as_ref().ok_or("不是本地实例")?;
    let source = crate::local_import::checked_directory(Path::new(&local.root))?;
    let profile = read_profile(&host.root, instance)?;
    let mut artifacts = vec![];
    let make = |value: &Value, relative: String| -> Result<crate::net::Artifact> {
        Ok(crate::net::Artifact {
            url: value["url"]
                .as_str()
                .ok_or("缺失依赖没有官方下载地址")?
                .into(),
            sha1: value["sha1"]
                .as_str()
                .ok_or("缺失依赖没有官方校验值")?
                .into(),
            size: value["size"].as_u64(),
            path: relative,
        })
    };
    for lib in profile["libraries"].as_array().ok_or("本地依赖清单缺失")? {
        if !minecraft::allowed(lib.get("rules"))? {
            continue;
        }
        let mut values = vec![&lib["downloads"]["artifact"]];
        if let Some(native) = lib["natives"]["windows"].as_str() {
            values.push(&lib["downloads"]["classifiers"][native.replace("${arch}", "64")]);
        }
        for value in values {
            if let Some(path) = value["path"].as_str() {
                let relative = format!("libraries/{path}");
                if !model::safe_path(&source, &relative)?.is_file() {
                    artifacts.push(make(value, relative)?);
                }
            }
        }
    }
    if !model::safe_path(&source, &local.client_jar)?.is_file() {
        artifacts.push(make(
            &profile["downloads"]["client"],
            local.client_jar.clone(),
        )?);
    }
    let index = &profile["assetIndex"];
    let index_id = index["id"].as_str().ok_or("资源索引标识缺失")?;
    let relative = format!("assets/indexes/{index_id}.json");
    let index_path = model::safe_path(&source, &relative)?;
    if !index_path.is_file() {
        artifacts.push(make(index, relative)?);
    }
    for (i, artifact) in artifacts.iter().enumerate() {
        host.progress(
            "local-repair-download",
            "自动补齐并校验游戏启动依赖",
            i,
            artifacts.len(),
        );
        crate::net::installer_library_download(&host.client, &source, artifact, cancel).await?;
    }
    if fs::metadata(&index_path)
        .map_err(|_| "无法读取资源索引")?
        .len()
        > 16 * 1024 * 1024
    {
        return Err("资源索引过大".into());
    }
    let assets: Value =
        serde_json::from_slice(&fs::read(index_path).map_err(|_| "无法读取资源索引")?)
            .map_err(|_| "资源索引损坏，请重新安装资源索引")?;
    let objects = assets["objects"].as_object().ok_or("资源索引内容无效")?;
    if objects.len() > 100000 {
        return Err("资源索引项目过多".into());
    }
    for (i, value) in objects.values().enumerate() {
        if cancel.is_cancelled() {
            return Err("启动准备已取消".into());
        }
        let hash = value["hash"]
            .as_str()
            .filter(|s| model::valid_sha1(s))
            .ok_or("资源哈希无效")?;
        let relative = format!("assets/objects/{}/{hash}", &hash[..2]);
        if !model::safe_path(&source, &relative)?.is_file() {
            host.progress(
                "local-repair-assets",
                "自动补齐并校验游戏资源",
                i,
                objects.len(),
            );
            crate::net::download(
                &host.client,
                &source,
                &crate::net::Artifact {
                    url: format!(
                        "https://resources.download.minecraft.net/{}/{hash}",
                        &hash[..2]
                    ),
                    sha1: hash.into(),
                    size: value["size"].as_u64(),
                    path: relative,
                },
                cancel,
            )
            .await?;
        }
    }
    Ok(())
}
pub(crate) fn commit_repaired_library(stage: &Path, source: &Path, relative: &str) -> Result<()> {
    let from = model::safe_path(stage, &format!("libraries/{relative}"))?;
    let target = model::safe_path(source, &format!("libraries/{relative}"))?;
    if target.is_file() {
        return Ok(());
    }
    let file = fs::File::open(&from).map_err(|_| format!("官方处理器未生成 {relative}"))?;
    zip::ZipArchive::new(file).map_err(|_| "修复产物不是有效 JAR")?;
    fs::create_dir_all(target.parent().ok_or("修复路径无效")?).map_err(|_| "无法创建依赖目录")?;
    let temporary = target.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::copy(&from, &temporary).map_err(|_| "无法暂存修复依赖".to_string())?;
        fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .and_then(|f| f.sync_all())
            .map_err(|_| "无法同步修复依赖".to_string())?;
        crate::content::move_no_replace(&temporary, &target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
pub fn prepare(
    host: &Host,
    instance: &Instance,
    cancel: &CancellationToken,
) -> Result<minecraft::Prepared> {
    let local = instance.local.as_ref().ok_or("不是本地引用版本")?;
    local.validate()?;
    let source = crate::local_import::checked_directory(Path::new(&local.root))?;
    let metadata = read_profile(&host.root, instance)?;
    let mut classpath = vec![];
    let mut natives = vec![];
    let mut missing = vec![];
    let rows = metadata["libraries"]
        .as_array()
        .ok_or("本地版本缺少依赖清单")?;
    host.progress(
        "local-libraries",
        "检查本地库位置，不遍历存档或 Mod 内容",
        0,
        rows.len() + 2,
    );
    for (index, library) in rows.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err("启动准备已取消".into());
        }
        if !minecraft::allowed(library.get("rules"))? {
            continue;
        }
        let artifact = if let Some(path) = library["downloads"]["artifact"]["path"].as_str() {
            Some(path.to_string())
        } else if library.get("downloads").is_none() {
            Some(coordinate_path(
                library["name"].as_str().ok_or("依赖名称缺失")?,
            )?)
        } else {
            None
        };
        if let Some(artifact) = artifact {
            let path = model::safe_path(&source, &format!("libraries/{artifact}"))?;
            if path.is_file() {
                classpath.push(path);
            } else {
                missing.push(format!("libraries/{artifact}"));
            }
        }
        if let Some(native) = library["natives"]["windows"].as_str() {
            let native = native.replace("${arch}", "64");
            let relative = library["downloads"]["classifiers"][&native]["path"]
                .as_str()
                .ok_or("原生库未提供本地路径")?;
            let path = model::safe_path(&source, &format!("libraries/{relative}"))?;
            if path.is_file() {
                natives.push(path);
            } else {
                missing.push(format!("libraries/{relative}"));
            }
        }
        host.progress(
            "local-libraries",
            "检查已安装的本地依赖",
            index + 1,
            rows.len() + 2,
        );
    }
    for relative in companion_libraries(&metadata)? {
        if !model::safe_path(&source, &format!("libraries/{relative}"))?.is_file() {
            missing.push(format!("libraries/{relative}"));
        }
    }
    let client = model::safe_path(&source, &local.client_jar)?;
    if client.is_file() {
        classpath.push(client);
    } else {
        missing.push(local.client_jar.clone());
    }
    let index = metadata["assetIndex"]["id"]
        .as_str()
        .ok_or("本地版本缺少资源索引名称")?;
    if !model::safe_path(&source, &format!("assets/indexes/{index}.json"))?.is_file() {
        missing.push(format!("assets/indexes/{index}.json"));
    }
    if !missing.is_empty() {
        return Err(format!("仍缺少 {} 项启动依赖：{}。无法确认来源或尚未支持自动生成的文件不会猜测替代；请核对安装版本与任务日志。",missing.len(),missing.iter().take(6).cloned().collect::<Vec<_>>().join("；")));
    }
    host.progress(
        "local-libraries",
        "本地启动依赖位置检查完成",
        rows.len() + 2,
        rows.len() + 2,
    );
    Ok(minecraft::Prepared {
        metadata,
        classpath,
        native_archives: natives,
        java_major: instance.java_major,
    })
}

pub async fn java_for(
    instance: &Instance,
    configured: &str,
    root: &Path,
) -> Result<minecraft::JavaInfo> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        find_java(instance, configured, root),
    )
    .await
    .map_err(|_| "本机 Java 匹配超时，请在实例设置中手动选择 Java。".to_string())?
}
async fn find_java(
    instance: &Instance,
    configured: &str,
    root: &Path,
) -> Result<minecraft::JavaInfo> {
    if let Ok(java) = minecraft::probe_java(configured).await {
        if java.is_64_bit && java.major == instance.java_major {
            return Ok(java);
        }
    }
    let mut roots = vec![root.join("runtimes")];
    if let Some(local) = &instance.local {
        roots.push(PathBuf::from(&local.root).join("runtime"));
    }
    for variable in ["JAVA_HOME", "JDK_HOME"] {
        if let Some(value) = std::env::var_os(variable) {
            roots.push(PathBuf::from(value));
        }
    }
    if let Some(base) = Path::new(configured).ancestors().nth(4) {
        roots.push(base.join(format!("java{}", instance.java_major)));
    }
    if let Some(base) = std::env::var_os("APPDATA") {
        let base = PathBuf::from(base);
        roots.extend([
            base.join(".minecraft/runtime"),
            base.join(".hmcl/java"),
            base.join("PrismLauncher/java"),
            base.join("ModrinthApp/meta/java_versions"),
        ]);
    }
    if let Some(base) = std::env::var_os("ProgramFiles") {
        let base = PathBuf::from(base);
        roots.extend([
            base.join("Java"),
            base.join("Eclipse Adoptium"),
            base.join("Zulu"),
            base.join("Amazon Corretto"),
        ]);
    }
    fn visit(root: &Path, depth: usize, budget: &mut usize, paths: &mut Vec<PathBuf>) {
        use std::os::windows::fs::MetadataExt;
        if depth > 4 || *budget == 0 || paths.len() >= 24 {
            return;
        }
        *budget -= 1;
        if !fs::symlink_metadata(root).is_ok_and(|v| v.is_dir() && v.file_attributes() & 0x400 == 0)
        {
            return;
        }
        let executable = root.join("bin/java.exe");
        if executable.is_file() {
            paths.push(executable);
            return;
        }
        if let Ok(items) = fs::read_dir(root) {
            for item in items.take(64).flatten() {
                if item.file_type().is_ok_and(|v| v.is_dir()) {
                    visit(&item.path(), depth + 1, budget, paths);
                }
            }
        }
    }
    let mut paths = vec![];
    let mut budget = 256;
    for candidate in roots {
        visit(&candidate, 0, &mut budget, &mut paths);
    }
    for path in paths {
        if let Ok(java) = minecraft::probe_java(&path.to_string_lossy()).await {
            if java.is_64_bit && java.major == instance.java_major {
                return Ok(java);
            }
        }
    }
    Err(format!("此版本需要 64 位 Java {}。已检查配置与常见本机运行时目录，未找到匹配版本；请在实例设置中选择对应 java.exe。",instance.java_major))
}
pub struct JvmArgumentFile {
    path: PathBuf,
}
fn launcher_encoding(text: &str) -> Result<Vec<u8>> {
    use windows_sys::Win32::Globalization::{GetACP, WideCharToMultiByte, WC_NO_BEST_FIT_CHARS};
    let page = unsafe { GetACP() };
    if page == 65001 {
        return Ok(text.as_bytes().to_vec());
    }
    let wide: Vec<u16> = text.encode_utf16().collect();
    let mut replaced = 0;
    let size = unsafe {
        WideCharToMultiByte(
            page,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            wide.len() as i32,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            &mut replaced,
        )
    };
    if size <= 0 {
        return Err("无法编码 JVM 参数文件".into());
    }
    let mut bytes = vec![0u8; size as usize];
    let count = unsafe {
        WideCharToMultiByte(
            page,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            wide.len() as i32,
            bytes.as_mut_ptr(),
            size,
            std::ptr::null(),
            &mut replaced,
        )
    };
    if count != size || replaced != 0 {
        return Err("Java 参数文件无法表示此安装路径的字符，请使用较短的兼容路径。".into());
    }
    Ok(bytes)
}
impl Drop for JvmArgumentFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
pub fn command_arguments(
    root: &Path,
    instance: &Instance,
    args: &[String],
) -> Result<(Vec<String>, Option<JvmArgumentFile>)> {
    if instance.local.is_none()
        || instance.java_major < 9
        || args.iter().map(|v| v.len() + 3).sum::<usize>() < 12000
    {
        return Ok((args.to_vec(), None));
    }
    let profile = read_profile(root, instance)?;
    let main = profile["mainClass"].as_str().ok_or("缺少启动主类")?;
    let main_index = args
        .iter()
        .position(|v| v == main)
        .ok_or("启动主类参数不存在")?;
    let mut body = String::new();
    for arg in &args[..main_index] {
        if arg.contains(['\r', '\n', '\0']) {
            return Err("JVM 参数含无效控制字符".into());
        }
        body.push('"');
        body.push_str(&arg.replace('\\', "\\\\").replace('"', "\\\""));
        body.push_str("\"\n");
    }
    let relative = format!("instances/{}/launch-jvm.args", instance.id);
    let bytes = match launcher_encoding(&body) {
        Ok(v) => v,
        Err(_)
            if args
                .iter()
                .map(|v| v.encode_utf16().count() + 3)
                .sum::<usize>()
                < 26000 =>
        {
            return Ok((args.to_vec(), None))
        }
        Err(e) => return Err(e),
    };
    model::write_file(root, &relative, &bytes)?;
    let path = model::safe_path(root, &relative)?;
    let mut result = vec![format!("@{}", path.to_string_lossy())];
    result.extend_from_slice(&args[main_index..]);
    Ok((result, Some(JvmArgumentFile { path })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forge_processed_artifacts_are_checked_even_when_not_in_the_classpath() {
        let mut profile = json!({"mainClass":"cpw.mods.modlauncher.Launcher","libraries":[],"arguments":{"game":["--fml.mcVersion","1.16.5","--fml.forgeVersion","36.2.34","--fml.forgeGroup","net.minecraftforge","--fml.mcpVersion","20210115.111550"]}});
        let paths = companion_libraries(&profile).unwrap();
        assert_eq!(paths.len(), 4);
        assert_eq!(
            paths[0],
            "net/minecraftforge/forge/1.16.5-36.2.34/forge-1.16.5-36.2.34-universal.jar"
        );
        assert!(paths[3].ends_with("client-1.16.5-20210115.111550-extra.jar"));
        profile["arguments"]["game"][5] = json!("../escape");
        assert!(companion_libraries(&profile).is_err());
        assert!(
            companion_libraries(&json!({"mainClass":"net.minecraft.client.main.Main"}))
                .unwrap()
                .is_empty()
        );
        let neo = json!({"mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher","libraries":[],"arguments":{"game":["--fml.mcVersion","1.21.1","--fml.neoForgeVersion","21.1.139","--fml.neoFormVersion","20240808.144430"]}});
        let paths = companion_libraries(&neo).unwrap();
        assert_eq!(
            paths[2],
            "net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-srg.jar"
        );
    }
    #[test]
    fn repaired_libraries_are_validated_and_never_replace_existing_files() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("easycraft-repair-{}", uuid::Uuid::new_v4()));
        let stage = root.join("stage");
        let source = root.join("source");
        fs::create_dir_all(stage.join("libraries")).unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(stage.join("libraries/broken.jar"), b"not a jar").unwrap();
        assert!(commit_repaired_library(&stage, &source, "broken.jar").is_err());
        assert!(!source.join("libraries/broken.jar").exists());
        assert!(commit_repaired_library(&stage, &source, "../escape.jar").is_err());
        let file = fs::File::create(stage.join("libraries/good.jar")).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        zip.start_file("test", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"valid").unwrap();
        zip.finish().unwrap();
        commit_repaired_library(&stage, &source, "good.jar").unwrap();
        assert_eq!(
            fs::read(stage.join("libraries/good.jar")).unwrap(),
            fs::read(source.join("libraries/good.jar")).unwrap()
        );
        fs::write(source.join("libraries/good.jar"), b"keep original").unwrap();
        commit_repaired_library(&stage, &source, "good.jar").unwrap();
        assert_eq!(
            fs::read(source.join("libraries/good.jar")).unwrap(),
            b"keep original"
        );
        assert!(crate::net::neoforge_url("https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.265/neoforge-21.1.265-installer.jar").is_ok());
        assert!(
            crate::net::neoforge_url("https://evil.example/releases/net/neoforged/neoforge/a")
                .is_err()
        );
        assert!(crate::net::neoforge_url("https://maven.neoforged.net/other.jar").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn forge_and_neoforge_inheritance_preserves_base_args_and_replaces_library_versions() {
        let base = json!({"id":"1.16.5","mainClass":"net.minecraft.client.main.Main","arguments":{"jvm":["-cp","${classpath}"],"game":["--gameDir","${game_directory}"]},"libraries":[{"name":"org.ow2.asm:asm:5.0"}],"javaVersion":{"majorVersion":8}});
        let forge = json!({"id":"Forge","mainClass":"cpw.mods.modlauncher.Launcher","arguments":{"jvm":["--add-opens=java.base/java.util.jar=ALL-UNNAMED"],"game":["--launchTarget","fmlclient","--fml.forgeVersion","36.2.34"]},"libraries":[{"name":"org.ow2.asm:asm:9.1"}]});
        let merged = merge(&[forge, base]).unwrap();
        assert_eq!(merged["libraries"].as_array().unwrap().len(), 1);
        assert_eq!(merged["libraries"][0]["name"], "org.ow2.asm:asm:9.1");
        assert_eq!(merged["arguments"]["jvm"].as_array().unwrap().len(), 3);
        assert_eq!(loader(&merged), ("forge".into(), "36.2.34".into()));
        assert_eq!(
            coordinate_path("cpw.mods:modlauncher:11.0.4@jar").unwrap(),
            "cpw/mods/modlauncher/11.0.4/modlauncher-11.0.4.jar"
        );
        assert!(coordinate_path("a:../outside:1").is_err());
        assert_eq!(
            loader(
                &json!({"libraries":[],"arguments":{"game":["--fml.neoForgeVersion","21.1.139"]}})
            ),
            ("neoforge".into(), "21.1.139".into())
        );
    }
    #[test]
    fn os_alternatives_do_not_replace_windows_lwjgl() {
        let profile = json!({"libraries":[
            {"name":"org.lwjgl.lwjgl:lwjgl:2.9.4", "rules":[{"action":"allow"},{"action":"disallow","os":{"name":"osx"}}]},
            {"name":"org.lwjgl.lwjgl:lwjgl:2.9.2", "rules":[{"action":"allow","os":{"name":"osx"}}]}
        ]});
        let merged = merge(&[profile]).unwrap();
        assert_eq!(merged["libraries"].as_array().unwrap().len(), 1);
        assert_eq!(
            merged["libraries"][0]["name"],
            "org.lwjgl.lwjgl:lwjgl:2.9.4"
        );
    }
}
