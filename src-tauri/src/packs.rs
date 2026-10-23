use crate::model::{self, Result};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashSet,
    io::{Cursor, Read},
    path::Path,
};

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
}
fn check_path(path: &str) -> Result<()> {
    model::safe_path(Path::new("C:/EasyCraftArchivePreview"), path).map(|_| ())
}
pub fn preview(bytes: &[u8]) -> Result<PackPreview> {
    // shortcut: IPC previews are limited to 16 MiB; use a streamed native picker before supporting large packs.
    if bytes.is_empty() || bytes.len() > 16 * 1024 * 1024 {
        return Err("预览文件须小于 16 MB".into());
    }
    preview_reader(Cursor::new(bytes))
}
pub(crate) fn preview_reader<R: Read + std::io::Seek>(input: R) -> Result<PackPreview> {
    let mut zip = zip::ZipArchive::new(input).map_err(|_| "不是有效的 ZIP / MRPACK 文件")?;
    if zip.len() > 10000 {
        return Err("整合包条目超过 10000 项上限".into());
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
        if !names.insert(name.trim_end_matches('/').to_ascii_lowercase()) {
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
        if name == "modrinth.index.json" {
            index = Some(i);
        }
        if name == "manifest.json" {
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
                    .push("已识别 CurseForge 清单；其下载 API 与安装尚未接入".into());
            }
        }
    }
    result.warnings.push("仅检查压缩包目录和索引，没有解压、下载或执行内容；目录检查不能证明 Mod 安全。批量导入尚未实现".into());
    Ok(result)
}
