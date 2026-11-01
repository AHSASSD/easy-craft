//! CFPA resource-pack acquisition. No remote code, Mod installation or patch overlays.
use crate::{
    content,
    host::Host,
    model::{self, Instance, Result},
    net,
};
use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Cursor, Read},
    path::Path,
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const RELEASE: &str =
    "https://api.github.com/repos/CFPAOrg/Minecraft-Mod-Language-Package/releases/tags/autobuild";
const PREFIX: &str =
    "https://github.com/CFPAOrg/Minecraft-Mod-Language-Package/releases/download/autobuild/";
const MAX_PACK: u64 = 32 * 1024 * 1024;
pub(crate) fn has_translation(game: &Path) -> Result<bool> {
    for folder in ["resourcepacks", "mods"] {
        let dir = model::safe_path(game, folder)?;
        if !dir.is_dir() {
            continue;
        }
        for (index, item) in fs::read_dir(&dir)
            .map_err(|_| "无法检查现有汉化内容")?
            .enumerate()
        {
            if index >= 4000 {
                return Err("现有资源目录过大，未完成汉化检查".into());
            }
            let item = item.map_err(|_| "现有资源不可读")?;
            let name = item.file_name().to_string_lossy().into_owned();
            if !name
                .to_ascii_lowercase()
                .ends_with(if folder == "mods" { ".jar" } else { ".zip" })
            {
                continue;
            }
            let path = model::safe_path(&dir, &name)?;
            let file = fs::File::open(path).map_err(|_| "无法检查现有资源包")?;
            let mut zip =
                zip::ZipArchive::new(file).map_err(|_| "现有资源归档损坏，未自动添加其他汉化")?;
            if zip.len() > crate::packs::MAX_RESOURCE_ENTRIES {
                return Err("现有资源条目过多".into());
            }
            if folder == "mods" {
                if crate::mod_info::read(&mut zip).is_ok_and(|v| {
                    v.ids.iter().any(|id| {
                        [
                            "i18nupdatemod",
                            "i18nmod",
                            "i18nautoupdatemod",
                            "vmtranslationupdate",
                        ]
                        .contains(&id.as_str())
                    })
                }) {
                    return Ok(true);
                }
            } else {
                for name in zip.file_names() {
                    let name = name.map_err(|_| "汉化资源名无效")?.to_ascii_lowercase();
                    if name.starts_with("assets/")
                        && (name.ends_with("/lang/zh_cn.json")
                            || name.ends_with("/lang/zh_cn.lang"))
                    {
                        return Ok(true);
                    }
                }
            }
        }
    }
    Ok(false)
}
pub(crate) async fn after_pack_install(
    host: &Host,
    instance: &Instance,
    cancel: &CancellationToken,
) -> String {
    let result: Result<String> = async {
        if !host.status().settings.auto_translate_packs {
            return Ok("已关闭自动补充汉化".into());
        }
        if has_translation(&instance.game_path(&host.root)?)? {
            return Ok("整合包已带汉化资源，保留原配置".into());
        }
        if cancel.is_cancelled() {
            return Err("自动补充汉化已取消，可稍后手动重试".into());
        }
        let report = install(host, instance, cancel).await?;
        Ok(format!(
            "自动汉化已启用，匹配 {} 个资源命名空间",
            report.matched.len()
        ))
    }
    .await;
    let message = match result {
        Ok(message) => message,
        Err(error) => format!("整合包已安装；自动补充汉化未完成：{error}"),
    };
    host.log(&message, &[]);
    message
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub file: String,
    pub source: String,
    pub matched: Vec<String>,
    pub unmatched: Vec<String>,
    pub skipped_files: usize,
}
struct Asset {
    name: String,
    url: String,
    hash: String,
    size: u64,
}
fn asset_name(version: &str, fabric: bool) -> Result<String> {
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() < 2
        || parts.len() > 3
        || parts
            .iter()
            .any(|v| v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("当前汉化源仅支持已确认的正式游戏版本，未自动套用其他版本".into());
    }
    if fabric && parts[..2] == ["1", "12"] {
        return Err("CFPA 1.12.2 资源针对 Forge，未安装到 Fabric 实例".into());
    }
    let family = match parts[..2] {
        ["1", "10"] if version == "1.10.2" => "1-10-2",
        ["1", "12"] if version == "1.12.2" => {
            return Ok("Minecraft-Mod-Language-Modpack.zip".into())
        }
        ["1", "16"] => "1-16",
        ["1", "18"] => "1-18",
        ["1", "19"] => "1-19",
        ["1", "20"] => "1-20",
        ["1", "21"] => "1-21",
        ["26", "1"] => "26-1",
        _ => {
            return Err(format!(
                "CFPA 当前没有已接通的 Minecraft {version} 汉化包，未安装其他版本资源"
            ))
        }
    };
    if fabric && matches!(family, "1-10-2" | "1-19") {
        return Err(
            "CFPA 此版本没有可直接匹配的 Fabric 汉化包，尚未接入跨版本合并转换；未安装 Forge 资源"
                .into(),
        );
    }
    let suffix = if fabric && family != "1-19" && family != "1-10-2" {
        "-Fabric"
    } else {
        ""
    };
    Ok(format!(
        "Minecraft-Mod-Language-Modpack-{family}{suffix}.zip"
    ))
}
fn select_asset(value: &Value, name: &str) -> Result<Asset> {
    if value["tag_name"] != "autobuild" || value["draft"] == true {
        return Err("汉化来源发布信息无效".into());
    }
    let rows: Vec<_> = value["assets"]
        .as_array()
        .ok_or("汉化资源索引无效")?
        .iter()
        .filter(|v| v["name"] == name)
        .collect();
    if rows.len() != 1 {
        return Err("汉化源尚未发布对应游戏/加载器的资源，未更改实例".into());
    }
    let row = rows[0];
    let hash = row["digest"]
        .as_str()
        .and_then(|v| v.strip_prefix("sha256:"))
        .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("汉化源缺少 SHA-256，未下载未经校验的资源")?;
    let size = row["size"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= MAX_PACK)
        .ok_or("汉化资源大小无效")?;
    let url = row["browser_download_url"]
        .as_str()
        .filter(|v| *v == format!("{PREFIX}{name}"))
        .ok_or("拒绝来源不符的汉化下载地址")?;
    Ok(Asset {
        name: name.into(),
        url: url.into(),
        hash: hash.to_ascii_lowercase(),
        size,
    })
}
fn allowed(raw: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(raw).map_err(|_| "汉化资源地址无效")?;
    let source = raw == RELEASE
        || (url.host_str() == Some("github.com")
            && url.path().starts_with(
                "/CFPAOrg/Minecraft-Mod-Language-Package/releases/download/autobuild/",
            ))
        || (url.host_str() == Some("release-assets.githubusercontent.com")
            && url
                .path()
                .starts_with("/github-production-release-asset/88008282/"));
    if !source
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
    {
        return Err("拒绝非 CFPA 官方 HTTPS 资源来源".into());
    }
    Ok(url)
}
async fn request(
    host: &Host,
    raw: &str,
    limit: u64,
    cancel: &CancellationToken,
    phase: &str,
) -> Result<Vec<u8>> {
    let mut last = String::new();
    for attempt in 0..3 {
        let result = async {
            let client = if attempt == 1 { net::fallback_client()? } else { &host.client };
            let mut url = allowed(raw)?;
            let mut response = None;
            for _ in 0..5 {
                let timeout=if phase=="translation-index"{12}else{45};
                let r = tokio::select! { _=cancel.cancelled()=>return Err("汉化下载已取消".into()), r=client.get(url.clone()).header(reqwest::header::ACCEPT_ENCODING,"identity").timeout(Duration::from_secs(timeout)).send()=>r.map_err(|e|format!("汉化源连接失败：{}", if e.is_timeout(){"请求超时"}else{"网络连接中断"}))? };
                if r.status().is_redirection() {
                    let next = r.headers().get(reqwest::header::LOCATION).and_then(|v|v.to_str().ok()).ok_or("汉化源重定向缺少地址")?;
                    url = allowed(url.join(next).map_err(|_|"汉化源重定向无效")?.as_str())?;
                } else { response=Some(r); break; }
            }
            let response=response.ok_or("汉化源重定向次数过多")?;
            if !response.status().is_success() { return Err(format!("汉化源返回 HTTP {}；请稍后重试",response.status().as_u16())); }
            if response.content_length().is_some_and(|v|v>limit) { return Err("汉化源响应超过大小上限".into()); }
            let mut stream=response.bytes_stream();
            let mut data=vec![];
            while let Some(chunk) = tokio::select! { _=cancel.cancelled()=>return Err("汉化下载已取消".into()), r=tokio::time::timeout(Duration::from_secs(20),stream.next())=>r.map_err(|_|"汉化源连续 20 秒未返回数据")? } {
                let chunk=chunk.map_err(|_|"汉化下载中断，可重试")?;
                if data.len() as u64+chunk.len() as u64>limit { return Err("汉化资源超过声明大小".into()); }
                data.extend_from_slice(&chunk);
                host.progress(phase, if phase=="translation-download" {"下载 CFPA 汉化资源"} else {"读取 CFPA 汉化资源索引"}, data.len(), limit as usize);
            }
            Ok(data)
        }.await;
        match result {
            Ok(v) => return Ok(v),
            Err(e) => last = e,
        }
        if cancel.is_cancelled() {
            return Err("汉化任务已取消".into());
        }
        host.log(&format!("汉化下载第 {} 次未完成：{last}", attempt + 1), &[]);
        if attempt < 2 {
            tokio::select! { _=cancel.cancelled()=>return Err("汉化任务已取消".into()), _=tokio::time::sleep(Duration::from_millis(500*(attempt+1)))=>{} }
        }
    }
    Err(last)
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn checked(bytes: &[u8], asset: &Asset) -> bool {
    bytes.len() as u64 == asset.size && digest(bytes) == asset.hash
}
fn namespaces(root: &Path, cancel: &CancellationToken) -> Result<(BTreeSet<String>, usize)> {
    let dir = model::safe_path(root, "mods")?;
    let mut names = BTreeSet::new();
    let mut skipped = 0;
    if !dir.is_dir() {
        return Ok((names, skipped));
    }
    for (index, item) in fs::read_dir(&dir)
        .map_err(|_| "无法读取实例模组目录")?
        .enumerate()
    {
        if index >= 4000 {
            return Err("模组目录超过 4000 项，未完成自动汉化匹配".into());
        }
        if cancel.is_cancelled() {
            return Err("汉化扫描已取消".into());
        }
        let item = item.map_err(|_| "模组目录不可读")?;
        let name = item.file_name().to_string_lossy().into_owned();
        if !name.to_ascii_lowercase().ends_with(".jar") {
            continue;
        }
        let result = (|| -> Result<BTreeSet<String>> {
            let mut found = BTreeSet::new();
            let path = model::safe_path(&dir, &name)?;
            let size = fs::metadata(&path).map_err(|_| "模组状态不可读")?.len();
            if size > 512 * 1024 * 1024 {
                return Err("模组超过检查上限".into());
            }
            let guard = crate::file_guard::Guard::open(&dir, &name, size, false)?;
            let mut zip =
                zip::ZipArchive::new(guard.file.try_clone().map_err(|_| "模组文件不可读")?)
                    .map_err(|_| "模组归档无效")?;
            if zip.len() > crate::packs::MAX_RESOURCE_ENTRIES {
                return Err("模组内容过多".into());
            }
            if let Ok(info) = crate::mod_info::read(&mut zip) {
                found.extend(info.ids);
            }
            for entry in zip.file_names() {
                let entry = entry.map_err(|_| "模组文件名无效")?;
                if let Some(tail) = entry.strip_prefix("assets/") {
                    if let Some((ns, rest)) = tail.split_once('/') {
                        if rest.starts_with("lang/") && ns.len() <= 128 {
                            found.insert(ns.into());
                        }
                    }
                }
            }
            Ok(found)
        })();
        match result {
            Ok(found) => names.extend(found),
            Err(_) => skipped += 1,
        }
        if names.len() > 16000 {
            return Err("模组资源命名空间过多，未完成汉化匹配".into());
        }
    }
    for builtin in ["minecraft", "forge", "neoforge", "fabric", "fabricloader"] {
        names.remove(builtin);
    }
    Ok((names, skipped))
}
fn game_format(root: &Path, instance: &Instance) -> Result<content::PackVersion> {
    if instance.version == "1.12.2" {
        return Ok((3, 0));
    }
    if instance.version == "1.10.2" {
        return Ok((2, 0));
    }
    let path = if let Some(local) = &instance.local {
        model::safe_path(Path::new(&local.root), &local.client_jar)?
    } else {
        model::safe_path(root, &format!("versions/{}/client.jar", instance.version))?
    };
    let file =
        fs::File::open(path).map_err(|_| "缺少游戏客户端，无法核对汉化包格式；请先补齐游戏文件")?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "游戏客户端归档无效")?;
    let entry = zip
        .by_name("version.json")
        .map_err(|_| "游戏客户端缺少版本格式信息，未强制安装汉化")?;
    if entry.size() > 1024 * 1024 {
        return Err("游戏版本信息过大".into());
    }
    let value: Value =
        serde_json::from_reader(entry.take(1024 * 1024)).map_err(|_| "游戏版本格式信息无效")?;
    if value["id"] != instance.version {
        return Err("客户端版本与实例不符，未安装汉化资源".into());
    }
    let mut format = content::pack_bound(&value["pack_version"]["resource"], false)?;
    if let Some(minor) = value["pack_version"]["resource_minor"].as_u64() {
        format.1 = minor.try_into().map_err(|_| "游戏资源格式无效")?;
    }
    Ok(format)
}
fn coverage(
    bytes: &[u8],
    names: &BTreeSet<String>,
    format: content::PackVersion,
) -> Result<(Vec<String>, Vec<String>)> {
    crate::packs::preview_resource_reader(Cursor::new(bytes))?;
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| "汉化包不是有效 ZIP")?;
    content::validate_archive(content::Kind::Resourcepacks, &mut zip)?;
    let meta: Value = serde_json::from_reader(
        zip.by_name("pack.mcmeta")
            .map_err(|_| "汉化包缺少描述")?
            .take(512 * 1024),
    )
    .map_err(|_| "汉化包描述无效")?;
    content::validate_pack_target(&meta, false, format)?;
    let mut supported = BTreeSet::new();
    for path in zip.file_names() {
        let path = path.map_err(|_| "汉化资源名无效")?;
        if let Some(tail) = path.strip_prefix("assets/") {
            if let Some((ns, tail)) = tail.split_once('/') {
                if tail == "lang/zh_cn.json"
                    || tail == "lang/zh_cn.lang"
                    || tail == "lang/zh_CN.lang"
                {
                    supported.insert(ns.to_string());
                }
            }
        }
    }
    let matched = names.intersection(&supported).cloned().collect::<Vec<_>>();
    if matched.is_empty() {
        return Err("此实例的已启用模组未匹配到 CFPA 汉化资源，未更改实例".into());
    }
    Ok((matched, names.difference(&supported).cloned().collect()))
}
pub async fn install(
    host: &Host,
    instance: &Instance,
    cancel: &CancellationToken,
) -> Result<Report> {
    let game = instance.game_path(&host.root)?;
    if !game.is_dir() {
        return Err("实例目录暂不可用，未更改配置".into());
    }
    let name = asset_name(
        &instance.version,
        !instance.fabric_version.is_empty()
            || instance
                .local
                .as_ref()
                .is_some_and(|v| v.loader == "fabric"),
    )?;
    host.progress("translation-scan", "匹配当前实例已启用模组", 0, 1);
    let (names, skipped) = namespaces(&game, cancel)?;
    if names.is_empty() {
        return Err("当前实例未发现可识别的已启用模组，无需添加模组汉化包".into());
    }
    let format = game_format(&host.root, instance)?;
    let revision = crate::worlds::load_options(&game)?.revision;
    host.progress("translation-index", "读取 CFPA 官方发布索引", 0, 1);
    let index_path = "translation-cache/release.json";
    let metadata = match request(host, RELEASE, 2 * 1024 * 1024, cancel, "translation-index").await
    {
        Ok(bytes) => {
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| "CFPA 发布索引不是 JSON")?;
            select_asset(&value, &name)?;
            model::write_file(&host.root, index_path, &bytes)?;
            value
        }
        Err(error) if !cancel.is_cancelled() => {
            let cached: Value = model::load_json(&host.root, index_path)?;
            if cached.is_null() {
                return Err(error);
            }
            host.log(
                "联网索引暂不可用，使用上次保存的 CFPA 发布索引；文件仍按 SHA-256 校验",
                &[],
            );
            cached
        }
        Err(error) => return Err(error),
    };
    let asset = select_asset(&metadata, &name)?;
    let relative = format!("translation-cache/{}.zip", asset.hash);
    let cache = model::safe_path(&host.root, &relative)?;
    let cached = if fs::metadata(&cache).is_ok_and(|v| v.len() == asset.size) {
        fs::read(&cache).ok().filter(|v| checked(v, &asset))
    } else {
        None
    };
    let bytes = if let Some(bytes) = cached {
        host.progress(
            "translation-download",
            "复用已校验的 CFPA 汉化缓存",
            asset.size as usize,
            asset.size as usize,
        );
        bytes
    } else {
        let bytes = request(host, &asset.url, asset.size, cancel, "translation-download").await?;
        if !checked(&bytes, &asset) {
            return Err("汉化资源大小或 SHA-256 校验失败，未导入".into());
        }
        model::write_file(&host.root, &relative, &bytes)?;
        bytes
    };
    host.progress("translation-check", "检查资源包兼容性及模组覆盖范围", 0, 1);
    let (matched, unmatched) = coverage(&bytes, &names, format)?;
    let file = format!("EasyCraft-CFPA-{}.zip", &asset.hash[..16]);
    if cancel.is_cancelled() {
        return Err("汉化安装已取消".into());
    }
    host.progress("translation-import", "导入并启用汉化资源包", 0, 1);
    commit(&game, &file, &bytes, &instance.version, &revision, cancel)?;
    host.log(&format!("CFPA 源文件：{}；已匹配 {} 个资源命名空间，{} 个未覆盖，{} 个文件未能识别。匹配不等于词条完整翻译。",asset.name,matched.len(),unmatched.len(),skipped),&[]);
    Ok(Report {
        file,
        source: "CFPA 官方汉化资源".into(),
        matched,
        unmatched,
        skipped_files: skipped,
    })
}
fn commit(
    game: &Path,
    file: &str,
    bytes: &[u8],
    version: &str,
    revision: &str,
    cancel: &CancellationToken,
) -> Result<()> {
    let path = model::safe_path(game, &format!("resourcepacks/{file}"))?;
    if crate::worlds::load_options(game)?.revision != revision {
        return Err("下载期间游戏设置已变化，请重新读取设置后重试".into());
    }
    let mut created = None;
    if path.exists() {
        if fs::metadata(&path).map_err(|_| "汉化资源状态不可读")?.len() != bytes.len() as u64
            || digest(&fs::read(&path).map_err(|_| "已有汉化包不可读")?) != digest(bytes)
        {
            return Err("同名汉化文件内容不同，未覆盖".into());
        }
    } else {
        content::import_reader_cancellable(
            game,
            content::Kind::Resourcepacks,
            file,
            Cursor::new(bytes),
            cancel,
        )?;
        created = Some(crate::resource_install::file_identity(&path)?);
    }
    let result = if cancel.is_cancelled() {
        Err("汉化安装已取消".into())
    } else {
        crate::worlds::activate_translation(game, file, version, revision)
    };
    if let Err(error) = result {
        if let Some(identity) = created {
            let cleanup = (|| -> Result<()> {
                let mut guard = crate::file_guard::Guard::open(
                    game,
                    &format!("resourcepacks/{file}"),
                    bytes.len() as u64,
                    true,
                )?;
                if crate::resource_install::file_identity(&path)? != identity {
                    return Err("新文件身份发生变化".into());
                }
                let mut current = vec![];
                guard
                    .file
                    .read_to_end(&mut current)
                    .map_err(|_| "新文件无法读取")?;
                if digest(&current) != digest(bytes) {
                    return Err("新文件内容发生变化".into());
                }
                guard.remove()
            })();
            if let Err(reason) = cleanup {
                return Err(format!(
                    "{error}；{reason}，新汉化包已保留供检查：{}",
                    path.display()
                ));
            }
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[tokio::test]
    async fn automatic_pack_translation_skips_bundled_content_and_keeps_install_on_failure() {
        let root = root();
        let instance:Instance=serde_json::from_value(serde_json::json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Installed pack","version":"26.2","manifestSha1":"a".repeat(40),"javaMajor":21})).unwrap();
        model::save_json(&root, "instances.json", &vec![instance.clone()]).unwrap();
        let game = instance.game_path(&root).unwrap();
        fs::create_dir_all(game.join("resourcepacks")).unwrap();
        let bytes = zip(&[
            ("pack.mcmeta", r#"{"pack":{"pack_format":34}}"#),
            ("assets/test/lang/zh_cn.json", "{}"),
        ]);
        fs::write(game.join("resourcepacks/bundled.zip"), &bytes).unwrap();
        let host = Host::new(root.clone()).unwrap();
        let cancel = CancellationToken::new();
        assert!(after_pack_install(&host, &instance, &cancel)
            .await
            .contains("已带汉化"));
        assert_eq!(
            fs::read(game.join("resourcepacks/bundled.zip")).unwrap(),
            bytes
        );
        fs::remove_file(game.join("resourcepacks/bundled.zip")).unwrap();
        let result = after_pack_install(&host, &instance, &cancel).await;
        assert!(result.contains("整合包已安装") && result.contains("未完成"));
        assert_eq!(host.status().instances, vec![instance.clone()]);
        let mut settings = host.status().settings;
        settings.auto_translate_packs = false;
        host.save_settings(settings).await.unwrap();
        assert!(after_pack_install(&host, &instance, &cancel)
            .await
            .contains("已关闭"));
    }
    fn root() -> std::path::PathBuf {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn zip(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, text) in entries {
            zip.start_file(*path, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(text.as_bytes()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn source_matching_integrity_and_compatibility_reject_unsafe_fallbacks() {
        assert_eq!(
            asset_name("1.12.2", false).unwrap(),
            "Minecraft-Mod-Language-Modpack.zip"
        );
        assert!(asset_name("1.19.2", true).is_err());
        assert_eq!(
            asset_name("1.21.1", true).unwrap(),
            "Minecraft-Mod-Language-Modpack-1-21-Fabric.zip"
        );
        assert_eq!(
            asset_name("1.21.1", false).unwrap(),
            "Minecraft-Mod-Language-Modpack-1-21.zip"
        );
        for version in ["26.2", "1.17.1", "1.21-pre1", "../1.21"] {
            assert!(asset_name(version, false).is_err());
        }
        for url in ["http://github.com/CFPAOrg/Minecraft-Mod-Language-Package/releases/download/autobuild/x.zip","https://github.com.evil/x","https://github.com/Other/Repo/releases/download/autobuild/x.zip","https://release-assets.githubusercontent.com/github-production-release-asset/99999/x"] {assert!(allowed(url).is_err());}
        let name = asset_name("1.21.1", false).unwrap();
        let value = serde_json::json!({"tag_name":"autobuild","draft":false,"assets":[{"name":name,"size":3,"digest":format!("sha256:{}",digest(b"zip")),"browser_download_url":format!("{PREFIX}{name}")}]});
        let selected = select_asset(&value, &name).unwrap();
        assert!(checked(b"zip", &selected));
        assert!(!checked(b"bad", &selected));
        let mut invalid = value.clone();
        invalid["assets"][0]["digest"] = Value::Null;
        assert!(select_asset(&invalid, &name).is_err());
        let mut invalid = value.clone();
        invalid["assets"]
            .as_array_mut()
            .unwrap()
            .push(value["assets"][0].clone());
        assert!(select_asset(&invalid, &name).is_err());
        let bytes = zip(&[
            ("pack.mcmeta", r#"{"pack":{"pack_format":34}}"#),
            ("assets/create/lang/zh_cn.json", r#"{"test":"测试"}"#),
        ]);
        let names = ["create".into(), "unknown".into()].into_iter().collect();
        let (matched, missing) = coverage(&bytes, &names, (34, 0)).unwrap();
        assert_eq!(matched, vec!["create"]);
        assert_eq!(missing, vec!["unknown"]);
        assert!(coverage(&bytes, &names, (35, 0)).is_err());
        assert!(coverage(&bytes, &["other".into()].into_iter().collect(), (34, 0)).is_err());
    }
    #[test]
    fn scanning_ignores_disabled_mods_and_commit_is_repeatable_without_losing_player_packs() {
        let root = root();
        fs::create_dir(root.join("mods")).unwrap();
        let jar = zip(&[
            (
                "fabric.mod.json",
                r#"{"schemaVersion":1,"id":"create","version":"1.0"}"#,
            ),
            ("assets/create/lang/en_us.json", "{}"),
        ]);
        fs::write(root.join("mods/create.jar"), &jar).unwrap();
        fs::write(root.join("mods/disabled.jar.disabled"), &jar).unwrap();
        fs::write(root.join("mods/bad.jar"), b"broken").unwrap();
        let cancel = CancellationToken::new();
        let (names, skipped) = namespaces(&root, &cancel).unwrap();
        assert_eq!(names, ["create".into()].into_iter().collect());
        assert_eq!(skipped, 1);
        let original=b"lang:en_us\r\ncustom:keep\r\nsoundCategory_master:0.45\r\nresourcePacks:[\"vanilla\",\"file/player.zip\"]\r\n";
        fs::write(root.join("options.txt"), original).unwrap();
        let bytes = zip(&[
            ("pack.mcmeta", r#"{"pack":{"pack_format":34}}"#),
            ("assets/create/lang/zh_cn.json", "{}"),
        ]);
        let file = "EasyCraft-CFPA-aaaaaaaaaaaaaaaa.zip";
        let revision = crate::worlds::load_options(&root).unwrap().revision;
        commit(&root, file, &bytes, "1.21.1", &revision, &cancel).unwrap();
        let text = fs::read_to_string(root.join("options.txt")).unwrap();
        assert!(text.contains("custom:keep\r\nsoundCategory_master:0.45\r\n"));
        assert!(text.contains("lang:zh_cn\r\n"));
        assert!(text.contains(&format!(
            "resourcePacks:[\"vanilla\",\"file/{file}\",\"file/player.zip\"]"
        )));
        let revision = crate::worlds::load_options(&root).unwrap().revision;
        commit(&root, file, &bytes, "1.21.1", &revision, &cancel).unwrap();
        assert_eq!(fs::read_to_string(root.join("options.txt")).unwrap(), text);
        assert_eq!(
            fs::read(root.join(format!("resourcepacks/{file}"))).unwrap(),
            bytes
        );
        fs::write(
            root.join("options.txt"),
            b"resourcePacks:invalid\nlang:en_us\n",
        )
        .unwrap();
        let revision = crate::worlds::load_options(&root).unwrap().revision;
        let new_file = "EasyCraft-CFPA-bbbbbbbbbbbbbbbb.zip";
        assert!(commit(&root, new_file, &bytes, "1.21.1", &revision, &cancel).is_err());
        assert!(!root.join(format!("resourcepacks/{new_file}")).exists());
        assert_eq!(
            fs::read(root.join("options.txt")).unwrap(),
            b"resourcePacks:invalid\nlang:en_us\n"
        );
        cancel.cancel();
        assert!(commit(&root, new_file, &bytes, "1.21.1", &revision, &cancel).is_err());
        assert!(!root.join(format!("resourcepacks/{new_file}")).exists());
    }
    #[test]
    fn legacy_pack_identifiers_and_external_configuration_changes_are_handled() {
        let root = root();
        let file = "EasyCraft-CFPA-aaaaaaaaaaaaaaaa.zip";
        fs::write(
            root.join("options.txt"),
            b"lang:en_US\nresourcePacks:[\"player.zip\"]\n",
        )
        .unwrap();
        let revision = crate::worlds::load_options(&root).unwrap().revision;
        crate::worlds::activate_translation(&root, file, "1.10.2", &revision).unwrap();
        let text = fs::read_to_string(root.join("options.txt")).unwrap();
        assert!(text.contains("lang:zh_CN\n"));
        assert!(text.contains(&format!("resourcePacks:[\"{file}\",\"player.zip\"]")));
        assert!(crate::worlds::activate_translation(&root, file, "1.10.2", &revision).is_err());
        assert_eq!(fs::read_to_string(root.join("options.txt")).unwrap(), text);
        assert_eq!(
            crate::worlds::backups(&root, None).unwrap().entries.len(),
            1
        );
    }
}
