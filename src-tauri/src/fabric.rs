use crate::{
    host::Host,
    minecraft::Prepared,
    model::{self, Instance, Result},
    net::{self, Artifact},
};
use serde_json::Value;
use sha1::{Digest, Sha1};
use tokio_util::sync::CancellationToken;

pub fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-+".contains(&c))
}
pub fn maven_path(name: &str) -> Result<String> {
    let parts: Vec<_> = name.split(':').collect();
    if parts.len() != 3
        || parts
            .iter()
            .any(|part| !valid_version(part) || part.split('.').any(str::is_empty))
    {
        return Err("不支持的 Fabric Maven 坐标".into());
    }
    Ok(format!(
        "{}/{}/{}/{}-{}.jar",
        parts[0].replace('.', "/"),
        parts[1],
        parts[2],
        parts[1],
        parts[2]
    ))
}
pub async fn versions(host: &Host, game: &str, cancel: &CancellationToken) -> Result<Vec<String>> {
    Ok(loader_catalog(host, game, cancel).await?.stable_versions)
}
#[derive(serde::Serialize)]
pub struct LoaderCatalog {
    pub versions: Vec<String>,
    pub recommended: Option<String>,
    #[serde(skip)]
    stable_versions: Vec<String>,
}
pub async fn loader_catalog(
    host: &Host,
    game: &str,
    cancel: &CancellationToken,
) -> Result<LoaderCatalog> {
    if !model::valid_id(game) {
        return Err("无效 Minecraft 版本".into());
    }
    let value = net::get_json(
        &host.client,
        &format!("https://meta.fabricmc.net/v2/versions/loader/{game}"),
        cancel,
    )
    .await?;
    let rows = value
        .as_array()
        .filter(|rows| rows.len() <= 5000)
        .ok_or("Fabric 版本响应无效")?;
    let stable_versions: Vec<_> = rows
        .iter()
        .filter(|item| item["loader"]["stable"] == true)
        .filter_map(|item| item["loader"]["version"].as_str())
        .filter(|version| valid_version(version))
        .map(str::to_string)
        .collect();
    let recommended = stable_versions.first().cloned();
    let versions = rows
        .iter()
        .filter_map(|item| item["loader"]["version"].as_str())
        .filter(|item| valid_version(item))
        .map(str::to_owned)
        .collect();
    Ok(LoaderCatalog {
        versions,
        recommended,
        stable_versions,
    })
}
pub async fn games(host: &Host) -> Result<Vec<String>> {
    let value = net::get_json(
        &host.client,
        "https://meta.fabricmc.net/v2/versions/game",
        &CancellationToken::new(),
    )
    .await?;
    Ok(value
        .as_array()
        .filter(|rows| rows.len() <= 10000)
        .ok_or("Fabric 游戏版本目录无效")?
        .iter()
        .filter_map(|row| row["version"].as_str())
        .filter(|game| model::valid_id(game))
        .map(str::to_string)
        .collect())
}
fn validate_profile(value: &Value, game: &str, loader: &str) -> Result<()> {
    if value["id"] != format!("fabric-loader-{loader}-{game}")
        || value["inheritsFrom"] != game
        || value["mainClass"] != "net.fabricmc.loader.impl.launch.knot.KnotClient"
    {
        return Err("Fabric 启动配置与游戏版本不匹配".into());
    }
    let libraries = value["libraries"].as_array().ok_or("Fabric 缺少依赖库")?;
    if libraries.is_empty() || libraries.len() > 100 {
        return Err("Fabric 依赖数量异常".into());
    }
    if !libraries
        .iter()
        .any(|lib| lib["name"] == format!("net.fabricmc:fabric-loader:{loader}"))
    {
        return Err("Fabric 配置缺少所选加载器版本".into());
    }
    for lib in libraries {
        maven_path(lib["name"].as_str().ok_or("Fabric 缺少依赖坐标")?)?;
        if lib["url"] != "https://maven.fabricmc.net/" {
            return Err("拒绝非 Fabric Maven 依赖来源".into());
        }
    }
    Ok(())
}
pub async fn install(
    host: &Host,
    game: &str,
    loader: &str,
    cancel: &CancellationToken,
) -> Result<String> {
    install_with_sources(host, game, loader, cancel, &[]).await
}
pub async fn install_with_sources(
    host: &Host,
    game: &str,
    loader: &str,
    cancel: &CancellationToken,
    sources: &[std::path::PathBuf],
) -> Result<String> {
    if !model::valid_id(game) || !valid_version(loader) {
        return Err("无效 Fabric 安装版本".into());
    }
    let mut value = net::get_json(
        &host.client,
        &format!("https://meta.fabricmc.net/v2/versions/loader/{game}/{loader}/profile/json"),
        cancel,
    )
    .await?;
    validate_profile(&value, game, loader)?;
    let libs = value["libraries"]
        .as_array_mut()
        .ok_or("Fabric 依赖格式无效")?;
    for lib in libs {
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        let path = maven_path(lib["name"].as_str().ok_or("缺少 Fabric 坐标")?)?;
        let hash = if let Some(hash) = lib["sha1"].as_str() {
            if !model::valid_sha1(hash) {
                return Err("Fabric 库哈希无效".into());
            }
            hash.to_owned()
        } else {
            net::checksum(
                &host.client,
                &format!("https://maven.fabricmc.net/{path}.sha1"),
                cancel,
            )
            .await?
        };
        lib["sha1"] = Value::String(hash.clone());
        net::download_from_local(
            &host.client,
            &host.root,
            &Artifact {
                url: format!("https://maven.fabricmc.net/{path}"),
                sha1: hash,
                size: lib["size"].as_u64(),
                path: format!("libraries/{path}"),
            },
            sources,
            cancel,
        )
        .await?;
    }
    let bytes = serde_json::to_vec(&value).map_err(|_| "无法保存 Fabric 配置")?;
    let hash: String = Sha1::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    model::write_file(&host.root, &format!("loaders/fabric/{hash}.json"), &bytes)?;
    Ok(hash)
}
pub async fn prepare(
    host: &Host,
    instance: &Instance,
    prepared: &mut Prepared,
    cancel: &CancellationToken,
) -> Result<()> {
    if !valid_version(&instance.fabric_version) || !model::valid_sha1(&instance.fabric_sha1) {
        return Err("Fabric 实例锁定信息无效".into());
    }
    let path = model::safe_path(
        &host.root,
        &format!("loaders/fabric/{}.json", instance.fabric_sha1),
    )?;
    if !net::matches(&path, &instance.fabric_sha1, None)? {
        return Err("Fabric 锁定配置损坏或缺失，请重新安装新实例；原存档保留".into());
    }
    let bytes = std::fs::read(path).map_err(|_| "无法读取 Fabric 配置")?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Fabric 配置过大".into());
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Fabric 配置无效")?;
    validate_profile(&value, &instance.version, &instance.fabric_version)?;
    let mut classpath = vec![];
    for lib in value["libraries"].as_array().ok_or("Fabric 依赖无效")? {
        let path = maven_path(lib["name"].as_str().ok_or("Fabric 坐标无效")?)?;
        classpath.push(
            net::download(
                &host.client,
                &host.root,
                &Artifact {
                    url: format!("https://maven.fabricmc.net/{path}"),
                    sha1: lib["sha1"].as_str().ok_or("缺少锁定哈希")?.into(),
                    size: lib["size"].as_u64(),
                    path: format!("libraries/{path}"),
                },
                cancel,
            )
            .await?,
        );
    }
    classpath.append(&mut prepared.classpath);
    prepared.classpath = classpath;
    prepared.metadata["mainClass"] = value["mainClass"].clone();
    if let Some(jvm) = value["arguments"]["jvm"].as_array() {
        prepared.metadata["arguments"]["jvm"]
            .as_array_mut()
            .ok_or("原版 JVM 参数无效")?
            .extend(jvm.iter().cloned());
    }
    Ok(())
}
pub(crate) fn loader_archive(
    root: &std::path::Path,
    instance: &Instance,
) -> Result<Option<std::path::PathBuf>> {
    if instance.fabric_version.is_empty() {
        return Ok(None);
    }
    let profile = model::safe_path(
        root,
        &format!("loaders/fabric/{}.json", instance.fabric_sha1),
    )?;
    if std::fs::metadata(&profile)
        .map_err(|_| "无法读取加载器锁定配置")?
        .len()
        > 8 * 1024 * 1024
        || !net::matches(&profile, &instance.fabric_sha1, None)?
    {
        return Err("加载器锁定配置校验失败".into());
    }
    let value: Value =
        serde_json::from_reader(std::fs::File::open(profile).map_err(|_| "无法读取加载器配置")?)
            .map_err(|_| "加载器配置格式无效")?;
    validate_profile(&value, &instance.version, &instance.fabric_version)?;
    let name = format!("net.fabricmc:fabric-loader:{}", instance.fabric_version);
    let library = value["libraries"]
        .as_array()
        .ok_or("缺少加载器依赖")?
        .iter()
        .find(|entry| entry["name"] == name)
        .ok_or("缺少加载器自身归档")?;
    let path = model::safe_path(root, &format!("libraries/{}", maven_path(&name)?))?;
    if !net::matches(
        &path,
        library["sha1"].as_str().ok_or("缺少加载器固定哈希")?,
        library["size"].as_u64(),
    )? {
        return Err("加载器归档校验失败，请修复后再安装模组".into());
    }
    Ok(Some(path))
}
