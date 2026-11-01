//! Bounded, read-only local Mod descriptions. No network or executable code.
use crate::model::Result;
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Seek};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Information {
    pub name: String,
    pub version: String,
    pub loader: String,
    pub ids: Vec<String>,
    pub authors: Vec<String>,
    pub description: String,
    pub license: String,
    pub dependencies: Vec<String>,
}
fn text(value: Option<&str>, max: usize) -> String {
    value.unwrap_or_default().chars().take(max).collect()
}
fn json_authors(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(|item| item.as_str().or_else(|| item["name"].as_str()))
        .map(|name| text(Some(name), 256))
        .collect()
}
pub fn read<R: Read + Seek>(zip: &mut zip::ZipArchive<R>) -> Result<Information> {
    if zip.len() > crate::packs::MAX_RESOURCE_ENTRIES {
        return Err("模组归档条目过多".into());
    }
    let has = |name: &str| zip.index_for_name(name).is_some();
    if has("fabric.mod.json") {
        let value = crate::content::fabric_metadata(zip)?;
        let id = value["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("缺少有效模组 ID")?;
        let version = value["version"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 128)
            .ok_or("缺少有效模组版本")?;
        let mut dependencies = vec![];
        for key in ["depends", "recommends", "suggests", "breaks", "conflicts"] {
            if let Some(items) = value[key].as_object() {
                for (id, range) in items.iter().take(128) {
                    if dependencies.len() >= 256 {
                        break;
                    }
                    dependencies.push(text(Some(&format!("{key}: {id} {range}")), 1024));
                }
            }
        }
        return Ok(Information {
            name: text(value["name"].as_str().or(Some(id)), 256),
            version: version.into(),
            loader: "Fabric".into(),
            ids: vec![id.into()],
            authors: json_authors(&value["authors"]),
            description: text(value["description"].as_str(), 16000),
            license: text(value["license"].as_str(), 512),
            dependencies,
        });
    }
    let format = if has("META-INF/neoforge.mods.toml") {
        Some(("META-INF/neoforge.mods.toml", "NeoForge"))
    } else if has("META-INF/mods.toml") {
        Some(("META-INF/mods.toml", "Forge"))
    } else {
        None
    };
    let mut info = Information {
        name: String::new(),
        version: String::new(),
        loader: String::new(),
        ids: vec![],
        authors: vec![],
        description: String::new(),
        license: String::new(),
        dependencies: vec![],
    };
    if let Some((path, loader)) = format {
        let raw = read_text(zip, path)?;
        let value: toml::Value = toml::from_str(&raw).map_err(|_| "模组 TOML 声明无效")?;
        let rows = value
            .get("mods")
            .and_then(toml::Value::as_array)
            .filter(|rows| !rows.is_empty() && rows.len() <= 128)
            .ok_or("缺少模组声明")?;
        for row in rows {
            if let Some(id) = row
                .get("modId")
                .and_then(toml::Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 128)
            {
                info.ids.push(id.to_string());
            }
        }
        let row = &rows[0];
        info.name = text(
            row.get("displayName")
                .and_then(toml::Value::as_str)
                .or_else(|| info.ids.first().map(String::as_str)),
            256,
        );
        info.version = text(row.get("version").and_then(toml::Value::as_str), 128);
        if info.version == "${file.jarVersion}" {
            info.version = crate::mod_check::jar_version(zip)?.unwrap_or(info.version);
        }
        info.loader = loader.into();
        info.description = text(row.get("description").and_then(toml::Value::as_str), 16000);
        info.license = text(value.get("license").and_then(toml::Value::as_str), 512);
        if let Some(author) = row.get("authors").and_then(toml::Value::as_str) {
            info.authors.push(text(Some(author), 512));
        }
        if let Some(dependencies) = value.get("dependencies").and_then(toml::Value::as_table) {
            for (owner, rows) in dependencies {
                for dependency in rows.as_array().into_iter().flatten() {
                    if info.dependencies.len() >= 256 {
                        break;
                    }
                    let id = dependency
                        .get("modId")
                        .and_then(toml::Value::as_str)
                        .unwrap_or("?");
                    let range = dependency
                        .get("versionRange")
                        .and_then(toml::Value::as_str)
                        .unwrap_or("*");
                    info.dependencies
                        .push(text(Some(&format!("{owner} → {id} {range}")), 1024));
                }
            }
        }
    } else if has("mcmod.info") {
        let value: Value = serde_json::from_str(&read_text(zip, "mcmod.info")?)
            .map_err(|_| "mcmod.info 声明无效")?;
        let rows = value
            .as_array()
            .or_else(|| value["modList"].as_array())
            .ok_or("缺少模组清单")?;
        let row = rows.first().ok_or("模组清单为空")?;
        info.ids = rows
            .iter()
            .take(128)
            .filter_map(|row| row["modid"].as_str())
            .map(|id| text(Some(id), 128))
            .collect();
        info.name = text(
            row["name"]
                .as_str()
                .or_else(|| info.ids.first().map(String::as_str)),
            256,
        );
        info.version = text(row["version"].as_str(), 128);
        info.loader = "Forge（旧版）".into();
        info.description = text(row["description"].as_str(), 16000);
        info.authors = json_authors(&row["authorList"]);
        info.dependencies = row["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .take(256)
            .map(|value| text(value.as_str(), 1024))
            .collect();
    } else {
        return Err("未识别的模组声明，保留为只读".into());
    }
    if info.ids.is_empty() || info.name.is_empty() || info.version.is_empty() {
        return Err("模组声明缺少 ID、名称或版本".into());
    }
    Ok(info)
}
fn read_text<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, path: &str) -> Result<String> {
    let entry = zip.by_name(path).map_err(|_| "模组声明缺失")?;
    if entry.size() > 512 * 1024 {
        return Err("模组声明超过 512 KiB".into());
    }
    let mut value = String::new();
    entry
        .take(512 * 1024 + 1)
        .read_to_string(&mut value)
        .map_err(|_| "模组声明不可读")?;
    if value.len() > 512 * 1024 {
        return Err("模组声明实际大小超限".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    fn declaration(path: &str, value: &str) -> Result<Information> {
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        zip.start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(value.as_bytes()).unwrap();
        let mut archive = zip::ZipArchive::new(zip.finish().unwrap()).unwrap();
        read(&mut archive)
    }
    #[test]
    fn legacy_descriptions_parse_and_invalid_or_oversized_metadata_is_rejected() {
        let info = declaration("mcmod.info", r#"[{"modid":"legacy","name":"Legacy Mod","version":"1.0","authorList":["Author"],"description":"Local description"}]"#).unwrap();
        assert_eq!(info.loader, "Forge（旧版）");
        assert_eq!(info.ids, ["legacy"]);
        assert_eq!(info.authors, ["Author"]);
        assert_eq!(info.description, "Local description");
        // Missing TOML keys must return an error, never panic during list rendering.
        for value in ["license = 'MIT'", "mods = []", "[[mods]]\nmodId = 'test'"] {
            assert!(declaration("META-INF/mods.toml", value).is_err());
        }
        assert!(declaration("mcmod.info", "not JSON").is_err());
        assert!(declaration("mcmod.info", &" ".repeat(512 * 1024 + 1)).is_err());
    }
}
