use crate::{
    model::{self, Result},
    net,
    resources::{self, Kind},
};
use futures_util::StreamExt;
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::sync::OnceLock;

pub fn number(value: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0 && *v <= i32::MAX as u64)
        .ok_or("CurseForge 项目或文件 ID 无效".into())
}
static API_KEY: OnceLock<Result<reqwest::header::HeaderValue>> = OnceLock::new();
fn api_key() -> Result<&'static reqwest::header::HeaderValue> {
    API_KEY.get_or_init(|| {
        let key=std::env::var("EASYCRAFT_CURSEFORGE_API_KEY").ok().filter(|key|!key.trim().is_empty()).ok_or("未配置 CurseForge API Key：请通过宿主环境变量 EASYCRAFT_CURSEFORGE_API_KEY 配置后重启；密钥不要填写在聊天或前端。")?;
        let mut header=reqwest::header::HeaderValue::from_str(&key).map_err(|_|"CurseForge 密钥格式无效")?;
        header.set_sensitive(true);Ok(header)
    }).as_ref().map_err(Clone::clone)
}
pub fn initialize() {
    let _ = api_key();
    // Read before creating any webview or Java child; child processes must not inherit the key.
    std::env::remove_var("EASYCRAFT_CURSEFORGE_API_KEY");
}
pub async fn get(path: &str) -> Result<Value> {
    let header = api_key()?.clone();
    let url = reqwest::Url::parse(&format!("https://api.curseforge.com/v1/{path}"))
        .map_err(|_| "CurseForge 地址无效")?;
    if url.host_str() != Some("api.curseforge.com") || !url.path().starts_with("/v1/") {
        return Err("CurseForge 地址无效".into());
    }
    let response = net::client()?
        .get(url)
        .timeout(std::time::Duration::from_secs(30))
        .header("x-api-key", header)
        .send()
        .await
        .map_err(|_| "无法连接 CurseForge API")?;
    if !response.status().is_success() {
        return Err(format!(
            "CurseForge API 返回 HTTP {}；请检查密钥权限或网络，未安装任何文件。",
            response.status().as_u16()
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "CurseForge 响应中断")?;
        if bytes.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("CurseForge 元数据超过 8 MiB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "CurseForge 响应格式无效".into())
}
fn text(v: &Value, key: &str, max: usize) -> Result<String> {
    resources::text(v, key, max)
}
fn class(kind: Kind) -> Result<u64> {
    match kind {
        Kind::Mod => Ok(6),
        _ => Err("CurseForge 当前仅接入 Fabric Mod；其他资源请使用 Modrinth。".into()),
    }
}
fn cdn_image(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    let u = reqwest::Url::parse(s).ok()?;
    (u.scheme() == "https"
        && u.host_str() == Some("media.forgecdn.net")
        && u.username().is_empty()
        && u.password().is_none()
        && u.port().is_none()
        && s.len() <= 2048)
        .then(|| s.to_string())
}
pub async fn search(
    kind: Kind,
    query: &str,
    game: &str,
    offset: u64,
    index: &str,
) -> Result<resources::Search> {
    class(kind)?;
    if query.len() > 256 || offset > 10000 || !crate::fabric::valid_version(game) {
        return Err("CurseForge 搜索条件无效".into());
    }
    let mut url = reqwest::Url::parse("https://api.curseforge.com/v1/mods/search").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("gameId", "432"),
        ("classId", "6"),
        ("modLoaderType", "4"),
        ("gameVersion", game),
        ("searchFilter", query),
        ("pageSize", "20"),
        ("index", &offset.to_string()),
        (
            "sortField",
            match index {
                "updated" => "3",
                "newest" => "11",
                "relevance" => "1",
                _ => "6",
            },
        ),
        ("sortOrder", "desc"),
    ]);
    let value = get(url
        .as_str()
        .strip_prefix("https://api.curseforge.com/v1/")
        .ok_or("地址无效")?)
    .await?;
    let rows = value["data"]
        .as_array()
        .filter(|v| v.len() <= 20)
        .ok_or("CurseForge 搜索格式无效")?;
    let mut hits = vec![];
    for row in rows {
        let id = row["id"]
            .as_u64()
            .ok_or("缺少 CurseForge 项目 ID")?
            .to_string();
        number(&id)?;
        if row["gameId"] != 432 || row["classId"] != 6 {
            return Err("CurseForge 返回了其他游戏或资源类别".into());
        }
        hits.push(resources::Hit {
            id,
            title: text(row, "name", 512)?,
            description: text(row, "summary", 4096)?,
            author: row["authors"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|a| a["name"].as_str())
                .unwrap_or("未提供")
                .chars()
                .take(128)
                .collect(),
            icon_url: cdn_image(&row["logo"]["thumbnailUrl"]),
            downloads: row["downloadCount"].as_u64(),
            updated: row["dateModified"]
                .as_str()
                .filter(|s| s.len() <= 64)
                .map(str::to_string),
            game_versions: vec![game.into()],
        });
    }
    Ok(resources::Search {
        hits,
        total: value["pagination"]["totalCount"]
            .as_u64()
            .filter(|n| *n <= 10_000_000)
            .ok_or("CurseForge 分页无效")?,
        offset,
    })
}
pub fn parse_file(row: &Value, project: u64) -> Result<resources::Version> {
    let id = row["id"].as_u64().ok_or("CurseForge 文件 ID 缺失")?;
    number(&id.to_string())?;
    if row["modId"] != project || row["gameId"] != 432 {
        return Err("CurseForge 文件归属不符".into());
    }
    let games: Vec<String> = row["gameVersions"]
        .as_array()
        .filter(|v| v.len() <= 512)
        .ok_or("CurseForge 兼容版本无效")?
        .iter()
        .filter_map(Value::as_str)
        .filter(|s| s.len() <= 128)
        .map(str::to_string)
        .collect();
    if !games.iter().any(|s| s == "Fabric") {
        return Err("此 CurseForge 文件不适用于 Fabric".into());
    }
    let sha1 = row["hashes"]
        .as_array()
        .and_then(|a| a.iter().find(|h| h["algo"] == 1))
        .and_then(|h| h["value"].as_str())
        .filter(|s| model::valid_sha1(s))
        .ok_or("CurseForge 文件缺少有效 SHA-1")?
        .to_string();
    let dependencies = row["dependencies"]
        .as_array()
        .filter(|v| v.len() <= 256)
        .ok_or("CurseForge 依赖无效")?
        .iter()
        .map(|d| {
            let id = d["modId"].as_u64().ok_or("依赖项目 ID 无效")?.to_string();
            number(&id)?;
            Ok(resources::Dependency {
                project_id: Some(id),
                version_id: None,
                kind: match d["relationType"].as_u64() {
                    Some(3) => "required",
                    Some(5) => "incompatible",
                    Some(1 | 6) => "embedded",
                    Some(2 | 4) => "optional",
                    _ => return Err("未知 CurseForge 依赖类型".into()),
                }
                .into(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(resources::Version {
        id: id.to_string(),
        name: text(row, "displayName", 512)?,
        number: text(row, "displayName", 256)?,
        environment: "unknown".into(),
        loaders: vec!["fabric".into()],
        files: vec![resources::File {
            filename: text(row, "fileName", 240)?,
            size: row["fileLength"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 512 * 1024 * 1024)
                .ok_or("CurseForge 文件大小无效")?,
            sha1,
        }],
        dependencies,
        game_versions: games
            .into_iter()
            .filter(|s| s.as_bytes().first().is_some_and(u8::is_ascii_digit))
            .collect(),
        published: row["fileDate"]
            .as_str()
            .filter(|s| s.len() <= 64)
            .map(str::to_string),
        downloads: row["downloadCount"].as_u64(),
        version_type: Some(
            match row["releaseType"].as_u64() {
                Some(1) => "release",
                Some(2) => "beta",
                Some(3) => "alpha",
                _ => return Err("CurseForge 发布类型无效".into()),
            }
            .into(),
        ),
    })
}
pub async fn detail(project: &str, kind: Kind) -> Result<resources::Detail> {
    class(kind)?;
    let id = number(project)?;
    let info = get(&format!("mods/{id}")).await?;
    let info = &info["data"];
    if info["id"] != id || info["gameId"] != 432 || info["classId"] != 6 {
        return Err("CurseForge 项目归属不符".into());
    }
    let mut versions = vec![];
    for offset in (0..1000).step_by(50) {
        let value = get(&format!(
            "mods/{id}/files?modLoaderType=4&pageSize=50&index={offset}"
        ))
        .await?;
        let rows = value["data"]
            .as_array()
            .filter(|a| a.len() <= 50)
            .ok_or("CurseForge 文件列表无效")?;
        for row in rows {
            versions.push(parse_file(row, id)?);
        }
        if rows.len() < 50 {
            break;
        }
    }
    Ok(resources::Detail { id:project.into(), title:text(info,"name",512)?,description:text(info,"summary",4096)?,body:"文件来自 CurseForge；作者未允许第三方下载的文件不会自动安装。列表最多读取 1000 个文件。".into(),versions })
}
pub async fn website(project: &str) -> Result<String> {
    let id = number(project)?;
    let info = get(&format!("mods/{id}")).await?;
    if info["data"]["id"] != id || info["data"]["gameId"] != 432 {
        return Err("CurseForge 项目归属不符".into());
    }
    let raw = info["data"]["links"]["websiteUrl"]
        .as_str()
        .filter(|s| s.len() <= 2048)
        .ok_or("CurseForge 未提供项目地址")?;
    let url = reqwest::Url::parse(raw).map_err(|_| "项目地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some("www.curseforge.com")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.path().starts_with("/minecraft/mc-mods/")
    {
        return Err("CurseForge 项目地址不是官方地址".into());
    }
    Ok(raw.into())
}
pub struct Download {
    pub project: String,
    pub version: String,
    pub name: String,
    pub sha1: String,
    pub size: u64,
    pub url: String,
}
pub async fn resolve(project: &str, file: &str, game: &str) -> Result<Vec<Download>> {
    let mut pending = vec![(number(project)?, Some(number(file)?))];
    let mut seen = std::collections::HashSet::new();
    let mut result = vec![];
    while let Some((project, fixed)) = pending.pop() {
        if !seen.insert(project) {
            continue;
        }
        if seen.len() > 64 {
            return Err("CurseForge 依赖超过 64 个项目".into());
        }
        let info = get(&format!("mods/{project}")).await?;
        if info["data"]["id"] != project
            || info["data"]["gameId"] != 432
            || info["data"]["classId"] != 6
        {
            return Err("CurseForge 项目归属不符".into());
        }
        if info["data"]["allowModDistribution"] == false {
            return Err("作者未允许第三方分发此 Mod，请在 CurseForge 官网下载。".into());
        }
        let value = if let Some(file) = fixed {
            get(&format!("mods/{project}/files/{file}")).await?["data"].clone()
        } else {
            let values = get(&format!(
                "mods/{project}/files?gameVersion={game}&modLoaderType=4&pageSize=50"
            ))
            .await?;
            values["data"]
                .as_array()
                .and_then(|a| a.iter().find(|r| r["releaseType"] == 1))
                .cloned()
                .ok_or("CurseForge 必需依赖没有匹配的正式版，请手动选择。")?
        };
        let parsed = parse_file(&value, project)?;
        if !parsed.game_versions.iter().any(|v| v == game) {
            return Err("CurseForge 文件与目标 Minecraft 版本不兼容".into());
        }
        if !value["isAvailable"].as_bool().unwrap_or(false) {
            return Err("CurseForge 文件不可下载".into());
        }
        for dep in &parsed.dependencies {
            if dep.kind == "required" {
                pending.push((
                    number(dep.project_id.as_deref().ok_or("依赖 ID 缺失")?)?,
                    None,
                ));
            }
        }
        let url = value["downloadUrl"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("CurseForge 未提供第三方下载地址，请在官网获取；不会推测 CDN 链接。")?;
        net::curseforge_download_url(url)?;
        let selected = &parsed.files[0];
        result.push(Download {
            project: format!("curseforge{project}"),
            version: format!("curseforge{}", parsed.id),
            name: selected.filename.clone(),
            sha1: selected.sha1.clone(),
            size: selected.size,
            url: url.into(),
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn curseforge_file_is_bound_to_owner_loader_and_verified_hash() {
        let row = json!({"id":123,"modId":42,"gameId":432,"displayName":"Example","fileName":"example.jar","fileLength":100,"hashes":[{"algo":1,"value":"a".repeat(40)}],"gameVersions":["1.21.1","Fabric"],"releaseType":1,"dependencies":[{"modId":43,"relationType":3}]});
        let file = parse_file(&row, 42).unwrap();
        assert_eq!(file.game_versions, vec!["1.21.1"]);
        assert_eq!(file.dependencies[0].kind, "required");
        assert!(parse_file(&row, 43).is_err());
        let mut bad = row.clone();
        bad["gameVersions"] = json!(["1.21.1", "Forge"]);
        assert!(parse_file(&bad, 42).is_err());
        let mut bad_hash = row.clone();
        bad_hash["hashes"] = json!([{"algo":2,"value":"a".repeat(32)}]);
        assert!(parse_file(&bad_hash, 42).is_err());
        assert!(number("../42").is_err());
        assert!(crate::net::curseforge_download_url(
            "https://edge.forgecdn.net/files/123/456/example.jar"
        )
        .is_ok());
        assert!(crate::net::curseforge_download_url(
            "https://edge.forgecdn.net@evil.example/files/123/example.jar"
        )
        .is_err());
    }
}
