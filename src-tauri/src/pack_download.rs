use crate::{
    host::Host,
    model::{self, Result},
};
use futures_util::StreamExt;
use std::{fs, io::Write, path::PathBuf};
use tokio_util::sync::CancellationToken;
fn allowed(url: &str) -> Result<()> {
    let url = reqwest::Url::parse(url).map_err(|_| "下载地址无效")?;
    if url.scheme() != "https"
        || ![
            "www.curseforge.com",
            "edge.forgecdn.net",
            "mediafilez.forgecdn.net",
            "maven.minecraftforge.net",
            "files.minecraftforge.net",
            "libraries.minecraft.net",
            "bmclapi2.bangbang93.com",
            "mirror.nju.edu.cn",
        ]
        .contains(&url.host_str().unwrap_or(""))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || (url.host_str() == Some("mirror.nju.edu.cn") && !url.path().starts_with("/bmclapi/"))
    {
        return Err("下载来源不在官方白名单".into());
    }
    Ok(())
}
async fn bytes_once(
    host: &Host,
    url: &str,
    limit: u64,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    allowed(url)?;
    let mut current = url.to_string();
    let mut hops = 0;
    let response = loop {
        allowed(&current)?;
        let response = tokio::select! {_=cancel.cancelled()=>return Err("下载已取消".into()),r=host.client.get(&current).timeout(std::time::Duration::from_secs(120)).send()=>r.map_err(|_|format!("无法连接下载来源：{current}"))?};
        if response.status().is_redirection() {
            hops += 1;
            if hops > 5 {
                return Err("下载重定向过多".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("重定向缺少地址")?;
            current = response
                .url()
                .join(location)
                .map_err(|_| "重定向地址无效")?
                .to_string();
            continue;
        }
        break response;
    };
    allowed(response.url().as_str())?;
    if !response.status().is_success() {
        return Err(format!(
            "下载返回 HTTP {}：{url}",
            response.status().as_u16()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];
    loop {
        let next = tokio::select! {_=cancel.cancelled()=>return Err("下载已取消".into()),r=stream.next()=>r};
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| "下载中断")?;
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("下载超过大小上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
async fn bytes(host: &Host, url: &str, limit: u64, cancel: &CancellationToken) -> Result<Vec<u8>> {
    let mut last = String::new();
    for attempt in 0..3 {
        match bytes_once(host, url, limit, cancel).await {
            Ok(value) => return Ok(value),
            Err(error) => {
                last = error;
                if cancel.is_cancelled() {
                    return Err(last);
                }
            }
        }
        if attempt < 2 {
            tokio::select! {_=cancel.cancelled()=>return Err("download cancelled".into()),_=tokio::time::sleep(std::time::Duration::from_secs(attempt+1))=>{}}
        }
    }
    Err(last)
}
pub async fn json(host: &Host, url: &str, cancel: &CancellationToken) -> Result<serde_json::Value> {
    serde_json::from_slice(&bytes(host, url, 2 * 1024 * 1024, cancel).await?)
        .map_err(|_| "官方元数据不是 JSON".into())
}
pub async fn fetch(
    host: &Host,
    url: &str,
    relative: &str,
    size: Option<u64>,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    fetch_content(host, url, relative, size, false, cancel).await
}
pub async fn fetch_content(
    host: &Host,
    url: &str,
    relative: &str,
    size: Option<u64>,
    opaque_jar: bool,
    cancel: &CancellationToken,
) -> Result<PathBuf> {
    let path = model::safe_path(&host.root, relative)?;
    if path.is_file()
        && size.is_some_and(|n| fs::metadata(&path).is_ok_and(|m| m.len() == n))
        && (if opaque_jar {
            crate::packs::preview_mod_reader(fs::File::open(&path).map_err(|_| "缓存不可读")?)
        } else {
            crate::packs::preview_resource_reader(fs::File::open(&path).map_err(|_| "缓存不可读")?)
        })
        .is_ok()
    {
        return Ok(path);
    }
    let data = bytes(
        host,
        url,
        size.unwrap_or(128 * 1024 * 1024).min(512 * 1024 * 1024),
        cancel,
    )
    .await?;
    if size.is_some_and(|n| data.len() as u64 != n) {
        return Err("下载大小与平台不符".into());
    }
    if opaque_jar {
        crate::packs::preview_mod_reader(std::io::Cursor::new(&data))?;
    } else {
        crate::packs::preview_resource_reader(std::io::Cursor::new(&data))?;
    }
    fs::create_dir_all(path.parent().ok_or("缓存路径无效")?).map_err(|_| "无法创建缓存目录")?;
    let temp = path.with_extension(format!("{}.part", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut output = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|_| "无法暂存下载")?;
        output.write_all(&data).map_err(|_| "缓存写入失败")?;
        output.sync_all().map_err(|_| "缓存同步失败")?;
        fs::rename(&temp, &path).map_err(|_| "缓存提交失败".to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result?;
    Ok(path)
}
pub async fn legacy_forge(
    host: &Host,
    game: &str,
    loader: &str,
    base: &serde_json::Value,
    cancel: &CancellationToken,
) -> Result<serde_json::Value> {
    let installer = match crate::forge::download(host, game, loader, cancel).await {
        Ok(path) => path,
        Err(error) => {
            if cancel.is_cancelled() {
                return Err(error);
            }
            host.progress(
                "pack-forge-mirror",
                "官方 Forge 源不可用，使用 BMCLAPI/NJU 镜像并核对 SHA-1",
                0,
                1,
            );
            let coordinate = format!(
                "net/minecraftforge/forge/{game}-{loader}/forge-{game}-{loader}-installer.jar"
            );
            let url = format!("https://bmclapi2.bangbang93.com/maven/{coordinate}");
            let hash = String::from_utf8(bytes(host, &format!("{url}.sha1"), 1024, cancel).await?)
                .map_err(|_| "镜像哈希无效")?;
            let hash = hash.trim();
            if !model::valid_sha1(hash) {
                return Err("镜像未提供有效 SHA-1，未安装".into());
            }
            let path = fetch(
                host,
                &url,
                &format!("downloads/forge/forge-{game}-{loader}-installer.jar"),
                None,
                cancel,
            )
            .await?;
            if !crate::net::matches(&path, hash, None)? {
                return Err("Forge 镜像安装器 SHA-1 不符".into());
            }
            path
        }
    };
    let mut zip = zip::ZipArchive::new(fs::File::open(installer).map_err(|_| "安装器不可读")?)
        .map_err(|_| "安装器无效")?;
    let profile: serde_json::Value = serde_json::from_reader(
        zip.by_name("install_profile.json")
            .map_err(|_| "安装器缺少配置")?,
    )
    .map_err(|_| "安装配置无效")?;
    let version = if profile["versionInfo"].is_object() {
        profile["versionInfo"].clone()
    } else {
        if profile["minecraft"] != game
            || profile["processors"]
                .as_array()
                .is_none_or(|v| !v.is_empty())
        {
            return Err("此安装器需要尚未支持的处理器，未伪造完成".into());
        }
        let path = profile["json"]
            .as_str()
            .ok_or("安装器缺少版本配置")?
            .trim_start_matches('/');
        serde_json::from_reader(zip.by_name(path).map_err(|_| "缺少版本 JSON")?)
            .map_err(|_| "版本 JSON 无效")?
    };
    if version["inheritsFrom"] != game {
        return Err("安装器目标版本不符".into());
    }
    let coordinate = profile["install"]["path"]
        .as_str()
        .or(profile["path"].as_str())
        .ok_or("缺少 Forge 坐标")?;
    let relative = crate::local_launch::coordinate_path(coordinate)?;
    let entry_owned = profile["install"]["filePath"]
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| format!("maven/{relative}"));
    let entry = entry_owned.as_str();
    let mut input = zip.by_name(entry).map_err(|_| "安装器缺少 universal JAR")?;
    let mut data = vec![];
    use std::io::Read;
    input
        .by_ref()
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|_| "无法读取 Forge 文件")?;
    if data.len() > 64 * 1024 * 1024 {
        return Err("Forge 文件过大".into());
    }
    let target = model::safe_path(&host.root, &format!("libraries/{relative}"))?;
    if target.exists() {
        if fs::read(&target).map_err(|_| "Forge 缓存不可读")? != data {
            return Err("已有 Forge 库内容不同，未覆盖".into());
        }
    } else {
        fs::create_dir_all(target.parent().ok_or("库路径无效")?).map_err(|_| "无法创建库目录")?;
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(target)
            .map_err(|_| "无法创建 Forge 库")?;
        file.write_all(&data)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Forge 库写入失败")?;
    }
    let mut merged = crate::local_launch::merge(&[version.clone(), base.clone()])?;
    if let Some(legacy) = merged["minecraftArguments"].as_str().map(str::to_string) {
        merged["arguments"]["game"] =
            serde_json::json!(legacy.split_whitespace().collect::<Vec<_>>());
        merged["arguments"]["jvm"] = serde_json::json!([
            "-Djava.library.path=${natives_directory}",
            "-cp",
            "${classpath}"
        ]);
    }
    let libraries = merged["libraries"].as_array().ok_or("缺少依赖列表")?;
    for (index, library) in libraries.iter().enumerate() {
        if !library["downloads"]["artifact"].is_object()
            && library["downloads"]["classifiers"].is_object()
        {
            continue;
        }
        let name = library["name"].as_str().ok_or("依赖缺少坐标")?;
        let relative = crate::local_launch::coordinate_path(name)?;
        let target = format!("libraries/{relative}");
        host.progress(
            "pack-forge-libraries",
            &format!("补齐 Forge 依赖：{name}"),
            index,
            libraries.len(),
        );
        if model::safe_path(&host.root, &target)?.is_file() {
            if let Some(hash) = library["downloads"]["artifact"]["sha1"].as_str() {
                if !crate::net::matches(
                    &model::safe_path(&host.root, &target)?,
                    hash,
                    library["downloads"]["artifact"]["size"].as_u64(),
                )? {
                    return Err(format!("已有依赖库校验失败，未覆盖：{name}"));
                }
            }
            continue;
        }
        let base = library["url"]
            .as_str()
            .unwrap_or("https://libraries.minecraft.net/");
        let url = format!("{}{relative}", base.trim_end_matches('/').to_string() + "/");
        let size = library["downloads"]["artifact"]["size"].as_u64();
        let official = library["downloads"]["artifact"]["url"]
            .as_str()
            .filter(|v| !v.is_empty())
            .unwrap_or(&url);
        let path = match fetch(host, official, &target, size, cancel).await {
            Ok(path) => path,
            Err(_) => {
                fetch(
                    host,
                    &format!("https://bmclapi2.bangbang93.com/maven/{relative}"),
                    &target,
                    size,
                    cancel,
                )
                .await?
            }
        };
        if let Some(hash) = library["downloads"]["artifact"]["sha1"].as_str() {
            if !crate::net::matches(&path, hash, size)? {
                return Err(format!("Forge 依赖校验失败：{name}"));
            }
        }
    }
    host.progress(
        "pack-forge-libraries",
        "Forge 依赖准备完成",
        libraries.len(),
        libraries.len(),
    );
    Ok(merged)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Explicit isolated Mercury launch diagnostics only"]
    fn mercury_isolated_command_diagnostics() {
        let root = std::path::PathBuf::from(std::env::var("EASYCRAFT_MERCURY_TEST_ROOT").unwrap());
        assert!(
            root.to_string_lossy().contains(".native")
                && root.to_string_lossy().contains("launch-smoke")
        );
        let host = Host::new(root.clone()).unwrap();
        let state = host.status();
        let instance = &state.instances[0];
        let prepared =
            crate::local_launch::prepare(&host, instance, &CancellationToken::new()).unwrap();
        crate::minecraft::extract_natives(
            &prepared.native_archives,
            &root,
            &format!("instances/{}/natives", instance.id),
        )
        .unwrap();
        let args = crate::minecraft::command_args(
            &host,
            instance,
            &prepared,
            &model::offline_profile("InstallCheck").unwrap(),
            "0",
            &instance.launch.resolve(&state.settings),
        )
        .unwrap();
        fs::write(root.join("direct-command.json"), serde_json::to_vec(&serde_json::json!({"java":instance.launch.java_path,"args":args,"cwd":instance.game_path(&root).unwrap()})).unwrap()).unwrap();
    }
    #[test]
    fn download_sources_reject_lookalikes_credentials_and_unrelated_mirror_paths() {
        for url in [
            "http://mediafilez.forgecdn.net/files/a.jar",
            "https://www.curseforge.com.evil.test/a",
            "https://user:pass@mediafilez.forgecdn.net/a.jar",
            "https://mirror.nju.edu.cn/private/a.jar",
        ] {
            assert!(allowed(url).is_err());
        }
        assert!(allowed("https://mirror.nju.edu.cn/bmclapi/net/a.jar").is_ok());
    }
    #[test]
    #[ignore = "Requires the real Mercury pack installed by Easy Craft"]
    fn installed_mercury_has_complete_launch_preparation_without_starting_minecraft() {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.native/mercury-reinstall");
        let host = Host::new(root).unwrap();
        let state = host.status();
        let instance = state
            .instances
            .iter()
            .find(|item| item.name.contains("水星"))
            .expect("Real pack not installed");
        let prepared =
            crate::local_launch::prepare(&host, instance, &CancellationToken::new()).unwrap();
        assert_eq!(
            prepared.metadata["mainClass"],
            "net.minecraft.launchwrapper.Launch"
        );
        assert_eq!(prepared.java_major, 8);
        let args = crate::minecraft::command_args(
            &host,
            instance,
            &prepared,
            &model::offline_profile("InstallCheck").unwrap(),
            "0",
            &state.settings,
        )
        .unwrap();
        assert!(args.iter().any(|arg| arg == "--tweakClass"));
        assert!(args
            .iter()
            .any(|arg| arg == "net.minecraftforge.fml.common.launcher.FMLTweaker"));
        assert!(prepared
            .classpath
            .iter()
            .any(|path| path.to_string_lossy().contains("14.23.5.2860")));
        println!(
            "Prepared real Mercury: {} libraries, {} native archives; no Minecraft process started",
            prepared.classpath.len(),
            prepared.native_archives.len()
        );
    }
}
