use crate::model::{self, Result};
use serde::Serialize;
use serde_json::Value;
use std::{collections::HashSet, io::Read};
pub(crate) const MAX_RESOURCE_ENTRIES: usize = 100000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackPreview {
    pub kind: String,
    pub name: String,
    pub files: usize,
    pub expanded_bytes: u64,
    pub downloads: usize,
    pub dependencies: Vec<String>,
    pub paths: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install: Option<crate::modpack::Plan>,
}
fn check_path(path: &str) -> Result<()> {
    model::validate_relative_path(path)
}
#[cfg(test)]
pub fn preview(bytes: &[u8]) -> Result<PackPreview> {
    // Byte-array/drop previews remain bounded; the native picker uses preview_reader directly.
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err("预览文件须小于 16 MB".into());
    }
    preview_reader(std::io::Cursor::new(bytes))
}
pub(crate) fn preview_reader<R: Read + std::io::Seek>(input: R) -> Result<PackPreview> {
    preview_bounded(input, 10000, false)
}
pub(crate) fn preview_resource_reader<R: Read + std::io::Seek>(input: R) -> Result<PackPreview> {
    preview_bounded(input, MAX_RESOURCE_ENTRIES, false)
}
pub(crate) fn preview_mod_reader<R: Read + std::io::Seek>(input: R) -> Result<PackPreview> {
    preview_bounded(input, MAX_RESOURCE_ENTRIES, true)
}
fn preview_bounded<R: Read + std::io::Seek>(
    input: R,
    max_entries: usize,
    opaque_jar: bool,
) -> Result<PackPreview> {
    let mut zip = zip::ZipArchive::new(input).map_err(|_| "不是有效的 ZIP / MRPACK 文件")?;
    if zip.len() > max_entries {
        return Err(format!("压缩包条目超过 {max_entries} 项上限"));
    }
    let mut result = PackPreview {
        kind: "ZIP".into(),
        name: "未命名 ZIP".into(),
        files: zip.len(),
        expanded_bytes: 0,
        downloads: 0,
        dependencies: vec![],
        paths: vec![],
        warnings: vec![],
        install: None,
    };
    let mut names = HashSet::new();
    let mut index = None;
    let mut curse = None;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|_| "无法读取压缩包目录")?;
        let name = entry.name().map_err(|_| "压缩条目名称无效")?;
        check_path(&name)?;
        if entry.enclosed_name().is_none()
            || entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("拒绝压缩包路径穿越或符号链接".into());
        }
        // JAR contents stay inside the archive; Java resource names are case-sensitive.
        // Extracted packs retain Windows case-insensitive collision protection.
        let key = if opaque_jar {
            name.trim_end_matches('/').to_string()
        } else {
            name.trim_end_matches('/').to_ascii_lowercase()
        };
        if !names.insert(key) {
            return Err("拒绝重复或大小写冲突的压缩条目".into());
        }
        result.expanded_bytes = result
            .expanded_bytes
            .checked_add(entry.size())
            .ok_or("解压大小溢出")?;
        if result.expanded_bytes > 1024 * 1024 * 1024 || entry.size() > 512 * 1024 * 1024 {
            return Err("压缩包解压大小超过预览上限".into());
        }
        if result.paths.len() < 30 {
            result.paths.push(name.to_string());
        }
        if !opaque_jar && name == "modrinth.index.json" {
            index = Some(i);
        }
        if !opaque_jar && name == "manifest.json" {
            curse = Some(i);
        }
    }
    let selected = index.or(curse);
    if let Some(i) = selected {
        let entry = zip.by_index(i).map_err(|_| "无法读取整合包索引")?;
        if entry.size() > 2 * 1024 * 1024 {
            return Err("整合包索引超过 2 MB".into());
        }
        let mut bytes = vec![];
        entry
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "索引读取或 CRC 检查失败")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("索引解压大小异常".into());
        }
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| "整合包索引 JSON 无效")?;
        result.name = manifest["name"]
            .as_str()
            .unwrap_or("未命名整合包")
            .chars()
            .take(100)
            .collect();
        if index.is_some() {
            if manifest["formatVersion"] != 1 || manifest["game"] != "minecraft" {
                return Err("不支持的 MRPACK 格式或游戏类型".into());
            }
            result.kind = "MRPACK".into();
            let deps = manifest["dependencies"]
                .as_object()
                .ok_or("MRPACK 缺少依赖清单")?;
            if !deps
                .get("minecraft")
                .and_then(Value::as_str)
                .is_some_and(model::valid_id)
            {
                return Err("MRPACK 缺少有效 Minecraft 依赖版本".into());
            }
            if deps.len() > 20 {
                return Err("整合包依赖数量异常".into());
            }
            for (name, version) in deps {
                let version = version.as_str().ok_or("依赖版本无效")?;
                if name.len() > 100 || version.len() > 100 {
                    return Err("依赖字段过长".into());
                }
                result.dependencies.push(format!("{name}: {version}"));
            }
            let files = manifest["files"].as_array().ok_or("MRPACK 缺少文件清单")?;
            if files.len() > 10000 {
                return Err("MRPACK 下载条目过多".into());
            }
            let mut targets = HashSet::new();
            for file in files {
                let path = file["path"].as_str().ok_or("MRPACK 缺少目标路径")?;
                check_path(path)?;
                if !targets.insert(path.to_ascii_lowercase()) {
                    return Err("MRPACK 存在重复下载目标".into());
                }
                if !file["hashes"]["sha1"]
                    .as_str()
                    .is_some_and(model::valid_sha1)
                    || !file["hashes"]["sha512"].as_str().is_some_and(|hash| {
                        hash.len() == 128 && hash.bytes().all(|c| c.is_ascii_hexdigit())
                    })
                {
                    return Err("MRPACK 内容哈希无效".into());
                }
                if !file["fileSize"]
                    .as_u64()
                    .is_some_and(|size| size <= 512 * 1024 * 1024)
                {
                    return Err("MRPACK 文件大小无效".into());
                }
                let urls = file["downloads"].as_array().ok_or("MRPACK 缺少下载来源")?;
                if urls.is_empty() || urls.len() > 10 {
                    return Err("MRPACK 下载来源数量无效".into());
                }
                for url in urls {
                    let url = reqwest::Url::parse(url.as_str().ok_or("下载地址无效")?)
                        .map_err(|_| "下载地址无效")?;
                    if url.scheme() != "https"
                        || url.host_str() != Some("cdn.modrinth.com")
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.port().is_some_and(|port| port != 443)
                    {
                        return Err("此预览仅接受 Modrinth 官方 CDN 下载来源".into());
                    }
                }
            }
            result.downloads = files.len();
        } else {
            if manifest["manifestType"] == "minecraftModpack" {
                result.kind = "CurseForge ZIP".into();
                result
                    .warnings
                    .push("已识别 CurseForge 清单；可安装范围与文件来源以安装预览为准".into());
            }
        }
    }
    result.warnings.push("此次仅检查压缩包目录和索引，没有解压到实例、下载或执行内容；安装需另行确认，目录检查不能证明 Mod 安全。".into());
    Ok(result)
}

#[cfg(test)]
mod resource_archive_tests {
    use super::*;
    use std::io::{Cursor, Write};
    #[test]
    fn opaque_mods_allow_case_distinct_resources_but_extracted_packs_do_not() {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        for name in [
            "assets/emotecraft/lang/en_US.json",
            "assets/emotecraft/lang/en_us.json",
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"{}").unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        assert!(preview_resource_reader(Cursor::new(&bytes)).is_err());
        assert!(preview_mod_reader(Cursor::new(&bytes)).is_ok());
        for name in ["../escape", "C:/escape", "x/CON.txt"] {
            let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            assert!(preview_mod_reader(Cursor::new(zip.finish().unwrap().into_inner())).is_err());
        }
    }
    #[test]
    #[ignore = "Uses a downloaded public Emotecraft JAR in output/"]
    fn real_emotecraft_case_resources_are_valid_opaque_mod_content() {
        let file =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../output/emotecraft.jar");
        assert!(preview_resource_reader(std::fs::File::open(&file).unwrap()).is_err());
        preview_mod_reader(std::fs::File::open(&file).unwrap()).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&file).unwrap()).unwrap();
        crate::content::validate_archive(crate::content::Kind::Mods, &mut zip).unwrap();
    }
    #[test]
    fn resource_entry_budget_does_not_relax_pack_or_path_boundaries() {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        for i in 0..10001 {
            zip.start_file(
                format!("assets/test/{i}.txt"),
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(b"x").unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        assert!(preview_reader(Cursor::new(&bytes)).is_err());
        assert_eq!(
            preview_resource_reader(Cursor::new(bytes)).unwrap().files,
            10001
        );
        for name in ["../escape", "C:/escape", "foo/CON.txt", "foo/bar."] {
            assert!(model::validate_relative_path(name).is_err());
        }
    }
}
