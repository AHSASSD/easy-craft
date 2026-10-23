use crate::{
    model::{self, Result},
    net,
};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Mod,
    Resourcepack,
    Shader,
    Datapack,
    Modpack,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Mod => "mod",
            Self::Resourcepack => "resourcepack",
            Self::Shader => "shader",
            Self::Datapack => "datapack",
            Self::Modpack => "modpack",
        }
    }
    fn loaders(self) -> &'static [&'static str] {
        match self {
            Self::Mod => &["fabric"],
            Self::Resourcepack => &["minecraft"],
            Self::Shader => &["iris", "optifine"],
            Self::Datapack => &["datapack"],
            Self::Modpack => &["fabric", "forge", "neoforge", "quilt", "minecraft"],
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    id: String,
    title: String,
    description: String,
    author: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Search {
    hits: Vec<Hit>,
    total: u64,
    offset: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    filename: String,
    size: u64,
    sha1: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    project_id: Option<String>,
    version_id: Option<String>,
    kind: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    id: String,
    name: String,
    number: String,
    environment: String,
    loaders: Vec<String>,
    files: Vec<File>,
    dependencies: Vec<Dependency>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    id: String,
    title: String,
    description: String,
    body: String,
    versions: Vec<Version>,
}
fn text(value: &Value, key: &str, max: usize) -> Result<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= max)
        .map(str::to_string)
        .ok_or_else(|| format!("资源字段无效：{key}"))
}
fn id(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 64 || !value.bytes().all(|c| c.is_ascii_alphanumeric()) {
        return Err("资源 ID 无效".into());
    }
    Ok(())
}
fn strings(value: &Value, key: &str) -> Result<Vec<String>> {
    let values = value
        .get(key)
        .and_then(Value::as_array)
        .filter(|v| v.len() <= 512)
        .ok_or("资源列表无效")?;
    values
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|s| s.len() <= 128)
                .map(str::to_string)
                .ok_or_else(|| "资源列表字段无效".into())
        })
        .collect()
}
fn search_url(kind: Kind, query: &str, game: &str, offset: u64) -> Result<Url> {
    if !crate::fabric::valid_version(game) {
        return Err("游戏版本无效".into());
    }
    if query.len() > 256 || query.chars().any(char::is_control) || offset > 10000 {
        return Err("搜索条件超出范围".into());
    }
    let mut facets = vec![
        vec![format!("project_type:{}", kind.name())],
        vec![format!("versions:{game}")],
    ];
    if matches!(kind, Kind::Mod) {
        facets.push(vec!["categories:fabric".into()]);
    }
    let mut url =
        Url::parse("https://api.modrinth.com/v2/search").map_err(|_| "资源服务地址无效")?;
    url.query_pairs_mut()
        .append_pair("query", query)
        .append_pair("facets", &json!(facets).to_string())
        .append_pair("limit", "20")
        .append_pair("offset", &offset.to_string())
        .append_pair("index", "relevance");
    Ok(url)
}
fn parse_search(value: &Value, offset: u64) -> Result<Search> {
    let rows = value
        .get("hits")
        .and_then(Value::as_array)
        .filter(|v| v.len() <= 20)
        .ok_or("资源搜索格式无效")?;
    let mut hits = vec![];
    for row in rows {
        let project = text(row, "project_id", 64)?;
        id(&project)?;
        hits.push(Hit {
            id: project,
            title: text(row, "title", 512)?,
            description: text(row, "description", 4096)?,
            author: text(row, "author", 128)?,
        });
    }
    Ok(Search {
        hits,
        total: value
            .get("total_hits")
            .and_then(Value::as_u64)
            .filter(|n| *n <= 10_000_000)
            .ok_or("资源数量无效")?,
        offset,
    })
}
pub async fn search(kind: Kind, query: &str, game: &str, offset: u64) -> Result<Search> {
    let url = search_url(kind, query, game, offset)?;
    let value =
        net::resource_json(&net::client()?, url.as_str(), &CancellationToken::new()).await?;
    parse_search(&value, offset)
}
fn parse_versions(value: &Value, project: &str, kind: Kind, game: &str) -> Result<Vec<Version>> {
    let rows = value
        .as_array()
        .filter(|v| v.len() <= 1000)
        .ok_or("资源版本列表过大或格式无效")?;
    let mut result = vec![];
    for row in rows {
        if text(row, "project_id", 64)? != project {
            return Err("资源版本归属不符".into());
        }
        let games = strings(row, "game_versions")?;
        let loaders = strings(row, "loaders")?;
        if !games.iter().any(|v| v == game)
            || !loaders.iter().any(|v| kind.loaders().contains(&v.as_str()))
        {
            continue;
        }
        let version = text(row, "id", 64)?;
        id(&version)?;
        let mut files = vec![];
        for file in row
            .get("files")
            .and_then(Value::as_array)
            .filter(|v| !v.is_empty() && v.len() <= 64)
            .ok_or("资源文件列表无效")?
        {
            let sha1 = file
                .pointer("/hashes/sha1")
                .and_then(Value::as_str)
                .filter(|h| model::valid_sha1(h))
                .ok_or("资源校验值无效")?;
            files.push(File {
                filename: text(file, "filename", 512)?,
                size: file
                    .get("size")
                    .and_then(Value::as_u64)
                    .filter(|n| *n <= 2 * 1024 * 1024 * 1024)
                    .ok_or("资源大小无效")?,
                sha1: sha1.into(),
            });
        }
        let mut dependencies = vec![];
        for dep in row
            .get("dependencies")
            .and_then(Value::as_array)
            .filter(|v| v.len() <= 256)
            .ok_or("资源依赖列表无效")?
        {
            let optional_id = |key: &str| -> Result<Option<String>> {
                match dep.get(key) {
                    Some(Value::Null) | None => Ok(None),
                    Some(Value::String(value)) => {
                        id(value)?;
                        Ok(Some(value.clone()))
                    }
                    _ => Err("依赖 ID 无效".into()),
                }
            };
            let dep_kind = text(dep, "dependency_type", 32)?;
            if !["required", "optional", "incompatible", "embedded"].contains(&dep_kind.as_str()) {
                return Err("未知依赖类型".into());
            }
            dependencies.push(Dependency {
                project_id: optional_id("project_id")?,
                version_id: optional_id("version_id")?,
                kind: dep_kind,
            });
        }
        result.push(Version {
            id: version,
            name: text(row, "name", 512)?,
            number: text(row, "version_number", 256)?,
            environment: row
                .get("environment")
                .and_then(Value::as_str)
                .filter(|s| s.len() <= 64)
                .unwrap_or("unknown")
                .into(),
            loaders,
            files,
            dependencies,
        });
    }
    Ok(result)
}
pub async fn detail(project: &str, kind: Kind, game: &str) -> Result<Detail> {
    id(project)?;
    if !crate::fabric::valid_version(game) {
        return Err("游戏版本无效".into());
    }
    let client = net::client()?;
    let cancel = CancellationToken::new();
    let mut versions_url = Url::parse(&format!(
        "https://api.modrinth.com/v2/project/{project}/version"
    ))
    .map_err(|_| "项目地址无效")?;
    versions_url
        .query_pairs_mut()
        .append_pair("game_versions", &json!([game]).to_string())
        .append_pair("loaders", &json!(kind.loaders()).to_string())
        .append_pair("include_changelog", "false");
    let project_url = format!("https://api.modrinth.com/v2/project/{project}");
    let (info, versions) = tokio::try_join!(
        net::resource_json(&client, &project_url, &cancel),
        net::resource_json(&client, versions_url.as_str(), &cancel)
    )?;
    if text(&info, "id", 64)? != project {
        return Err("资源项目归属不符".into());
    }
    Ok(Detail {
        id: project.into(),
        title: text(&info, "title", 512)?,
        description: text(&info, "description", 4096)?,
        body: text(&info, "body", 256 * 1024)?,
        versions: parse_versions(&versions, project, kind, game)?,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn queries_encode_facets_and_responses_require_exact_version_and_owner() {
        let url = search_url(Kind::Mod, "中文 & test", "1.21.1", 20).unwrap();
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().collect();
        assert_eq!(pairs.get("query").unwrap(), "中文 & test");
        assert!(pairs.get("facets").unwrap().contains("categories:fabric"));
        assert!(!search_url(Kind::Resourcepack, "", "1.21.1", 0)
            .unwrap()
            .as_str()
            .contains("fabric"));
        assert!(search_url(Kind::Mod, "", "../escape", 0).is_err());
        assert!(id("../project").is_err());
        assert!(parse_search(
            &json!({"hits": [{"project_id":"../bad"}], "total_hits":1}),
            0
        )
        .is_err());
        let row = json!({"project_id":"Test1234", "id":"Vers1234", "game_versions":["1.21.1"], "loaders":["minecraft"], "name":"Fixture", "version_number":"1", "files":[{"filename":"pack.zip", "size":100, "hashes":{"sha1":"a".repeat(40)}}], "dependencies":[]});
        assert_eq!(
            parse_versions(
                &json!([row.clone()]),
                "Test1234",
                Kind::Resourcepack,
                "1.21.1"
            )
            .unwrap()
            .len(),
            1
        );
        assert!(
            parse_versions(&json!([row.clone()]), "Test1234", Kind::Mod, "1.21.1")
                .unwrap()
                .is_empty()
        );
        assert!(parse_versions(&json!([row]), "Other123", Kind::Resourcepack, "1.21.1").is_err());
    }
    #[tokio::test]
    #[ignore = "Requires public Modrinth API; queries metadata only"]
    async fn modrinth_metadata_integration() {
        let hits = search(Kind::Mod, "FerriteCore", "1.21.1", 0).await.unwrap();
        assert!(hits.hits.iter().any(|hit| hit.id == "uXXizFIs"));
        let result = detail("uXXizFIs", Kind::Mod, "1.21.1").await.unwrap();
        assert!(result
            .versions
            .iter()
            .any(|version| version.id == "sOzRw3CG"));
        let packs = detail("6SLU7tS5", Kind::Resourcepack, "1.21.1")
            .await
            .unwrap();
        assert!(!packs.versions.is_empty());
        for kind in [
            Kind::Shader,
            Kind::Datapack,
            Kind::Modpack,
            Kind::Resourcepack,
        ] {
            assert!(!search(kind, "", "1.21.1", 0).await.unwrap().hits.is_empty());
        }
    }
    #[tokio::test]
    async fn resource_origins_do_not_weaken_original_download_policy() {
        assert!(net::trusted_url("https://api.modrinth.com/v2/search").is_err());
        let client = net::client().unwrap();
        for url in [
            "http://api.modrinth.com/v2/search",
            "https://api.modrinth.com.evil.test/v2/search",
            "https://user@api.modrinth.com/v2/search",
            "https://api.modrinth.com/v3/search",
        ] {
            assert!(net::resource_json(&client, url, &CancellationToken::new())
                .await
                .is_err());
        }
    }
}
