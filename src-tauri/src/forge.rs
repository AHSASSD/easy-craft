use crate::{
    host::Host,
    model::{self, Result},
    net,
};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Versions {
    pub recommended: Option<String>,
    pub latest: Option<String>,
    pub versions: Vec<String>,
    pub game_versions: Vec<String>,
}
pub async fn versions(host: &Host, game: &str) -> Result<Versions> {
    if !model::valid_id(game) {
        return Err("Minecraft 版本无效".into());
    }
    let cancel = CancellationToken::new();
    let (value, metadata) = tokio::try_join!(
        net::forge_json(
            &host.client,
            "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json",
            &cancel,
        ),
        net::forge_json(
            &host.client,
            "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json",
            &cancel
        )
    )?;
    let catalog = metadata
        .as_object()
        .filter(|entries| entries.len() <= 5000)
        .ok_or("Forge Maven 目录格式无效")?;
    let loaders_for = |game: &str| -> Vec<String> {
        catalog
            .get(game)
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .filter_map(|coordinate| coordinate.strip_prefix(&format!("{game}-")))
            .filter(|loader| valid_loader(loader))
            .map(str::to_string)
            .collect()
    };
    let mut versions = loaders_for(game);
    versions.sort_by_cached_key(|version| {
        version
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    });
    versions.reverse();
    versions.dedup();
    let game_versions = catalog
        .keys()
        .filter(|game| model::valid_id(game) && !loaders_for(game).is_empty())
        .cloned()
        .collect();
    let version = |suffix: &str| {
        value["promos"][format!("{game}-{suffix}")]
            .as_str()
            .filter(|s| valid_loader(s))
            .map(str::to_string)
    };
    Ok(Versions {
        recommended: version("recommended"),
        latest: version("latest"),
        versions,
        game_versions,
    })
}
pub(crate) fn valid_loader(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 60
        && s.split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}
fn declared_size(headers: &reqwest::header::HeaderMap) -> Result<u64> {
    headers
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|size| *size > 0 && *size <= 64 * 1024 * 1024)
        .ok_or("Forge 安装器未提供有效大小或超过 64 MiB".into())
}
pub async fn download(
    host: &Host,
    game: &str,
    loader: &str,
    cancel: &CancellationToken,
) -> Result<std::path::PathBuf> {
    if !model::valid_id(game) || !valid_loader(loader) {
        return Err("Forge 版本无效".into());
    }
    let filename = format!("forge-{game}-{loader}-installer.jar");
    let url = format!(
        "https://maven.minecraftforge.net/net/minecraftforge/forge/{game}-{loader}/{filename}"
    );
    let hash = net::forge_checksum(&host.client, &format!("{url}.sha1"), cancel).await?;
    let response = tokio::select! { _ = cancel.cancelled() => return Err("下载已取消".into()), result = host.client.head(net::forge_url(&url)?).send() => result.map_err(|_| "无法读取 Forge 安装器大小")? };
    if !response.status().is_success() {
        return Err(format!(
            "Forge 文件信息 HTTP {}",
            response.status().as_u16()
        ));
    }
    let size = declared_size(response.headers())?;
    host.progress("forge-download", "下载并校验 Forge 官方安装器", 0, 1);
    let path = net::forge_download(
        &host.client,
        &host.root,
        &net::Artifact {
            path: format!("downloads/forge/{filename}"),
            url,
            sha1: hash,
            size: Some(size),
        },
        cancel,
    )
    .await?;
    if std::fs::metadata(&path)
        .map_err(|_| "无法读取 Forge 安装器")?
        .len()
        > 64 * 1024 * 1024
    {
        return Err("Forge 安装器超过 64 MiB 检查范围".into());
    }
    let mut zip =
        zip::ZipArchive::new(std::fs::File::open(&path).map_err(|_| "无法读取 Forge 安装器")?)
            .map_err(|_| "Forge 安装器不是有效 JAR")?;
    if zip.by_name("install_profile.json").is_err() {
        return Err("Forge 安装器缺少 install_profile.json".into());
    }
    Ok(path)
}
#[cfg(test)]
mod tests {
    #[test]
    fn head_uses_declared_header_instead_of_the_empty_head_body() {
        let mut headers = reqwest::header::HeaderMap::new();
        assert!(super::declared_size(&headers).is_err());
        headers.insert(reqwest::header::CONTENT_LENGTH, "9089841".parse().unwrap());
        assert_eq!(super::declared_size(&headers).unwrap(), 9089841);
        headers.insert(
            reqwest::header::CONTENT_LENGTH,
            "100000000".parse().unwrap(),
        );
        assert!(super::declared_size(&headers).is_err());
    }
    #[test]
    fn versions_and_origins_are_separate_from_modrinth() {
        assert!(super::valid_loader("52.1.20"));
        assert!(!super::valid_loader("../52"));
        assert!(crate::net::forge_url(
            "https://maven.minecraftforge.net/net/minecraftforge/forge/1.21.1-52.1.20/forge.jar"
        )
        .is_ok());
        assert!(
            crate::net::resource_download_url("https://edge.forgecdn.net/files/1/2/mod.jar")
                .is_err()
        );
        assert!(crate::net::curseforge_download_url(
            "https://edge.forgecdn.net.evil.test/files/1/mod.jar"
        )
        .is_err());
    }
}
