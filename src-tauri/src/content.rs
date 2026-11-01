use crate::model::{self, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Cursor, Read, Seek, SeekFrom},
    os::windows::{ffi::OsStrExt, fs::MetadataExt},
    path::{Path, PathBuf},
};

const MAX_IMPORT: usize = 16 * 1024 * 1024;
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Mods,
    Resourcepacks,
    Shaderpacks,
    Screenshots,
    #[serde(skip)]
    Datapacks,
}
impl Kind {
    fn dir(self) -> &'static str {
        match self {
            Self::Mods => "mods",
            Self::Resourcepacks => "resourcepacks",
            Self::Shaderpacks => "shaderpacks",
            Self::Screenshots => "screenshots",
            Self::Datapacks => "datapacks",
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub file: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub editable: bool,
    pub bytes: u64,
    pub revision: String,
}
fn filename(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 240
        || value.contains(['/', '\\'])
        || value == "."
        || value == ".."
    {
        return Err("无效文件名".into());
    }
    Ok(())
}
fn file_path(root: &Path, kind: Kind, file: &str) -> Result<PathBuf> {
    filename(file)?;
    model::safe_path(root, &format!("{}/{file}", kind.dir()))
}
fn revision(metadata: &fs::Metadata, path: &Path) -> Result<String> {
    let identity = crate::resource_install::file_identity(path)?;
    Ok(format!(
        "{}:{}:{}:{}:{}",
        metadata.len(),
        metadata.last_write_time(),
        identity.0,
        identity.1,
        identity.2
    ))
}
pub(crate) fn fabric_metadata<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<serde_json::Value> {
    let entry = archive
        .by_name("fabric.mod.json")
        .map_err(|_| "不是可识别的 Fabric 模组")?;
    if entry.size() > 512 * 1024 {
        return Err("模组描述文件过大".into());
    }
    let mut bytes = vec![];
    entry
        .take(512 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取模组信息")?;
    let value = parse_fabric_json(&bytes)?;
    Ok(value)
}
// Fabric Loader's JsonReader accepts literal controls inside quoted strings
// (notably multiline descriptions). Normalize only that syntax for serde_json;
// retain strict structural parsing and never rewrite the downloaded JAR.
fn parse_fabric_json(bytes: &[u8]) -> Result<serde_json::Value> {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    let mut normalized = Vec::with_capacity(bytes.len());
    let (mut quoted, mut escaped) = (false, false);
    const HEX: &[u8] = b"0123456789abcdef";
    for &byte in bytes {
        if quoted && !escaped && byte < 0x20 {
            normalized.extend_from_slice(&[
                b'\\',
                b'u',
                b'0',
                b'0',
                HEX[(byte >> 4) as usize],
                HEX[(byte & 15) as usize],
            ]);
            continue;
        }
        normalized.push(byte);
        if escaped {
            escaped = false;
        } else if quoted && byte == b'\\' {
            escaped = true;
        } else if byte == b'"' {
            quoted = !quoted;
        }
    }
    serde_json::from_slice(&normalized).map_err(|error| {
        format!(
            "fabric.mod.json 无法解析：第 {} 行，第 {} 列：{error}",
            error.line(),
            error.column()
        )
    })
}
fn fabric_info<R: Read + std::io::Seek>(
    archive: &mut zip::ZipArchive<R>,
) -> Result<(String, String)> {
    let value = fabric_metadata(archive)?;
    let id = value
        .get("id")
        .and_then(|v| v.as_str())
        .filter(|id| !id.is_empty() && id.len() <= 128)
        .ok_or("缺少模组 ID")?;
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|name| name.len() <= 256)
        .unwrap_or(id);
    let version = value
        .get("version")
        .and_then(|v| v.as_str())
        .filter(|v| v.len() <= 128)
        .ok_or("缺少模组版本")?;
    Ok((name.into(), version.into()))
}
fn inspect_entry(root: &Path, kind: Kind, file: String) -> Result<Entry> {
    let path = file_path(root, kind, &file)?;
    let meta = fs::metadata(&path).map_err(|_| "无法读取文件状态")?;
    let enabled = !file.to_ascii_lowercase().ends_with(".disabled");
    let mut name = file.clone();
    let mut version = if meta.is_dir() {
        "文件夹 · 只读"
    } else {
        "未知文件 · 保留原样"
    }
    .to_string();
    let mut editable = false;
    if meta.is_file()
        && kind == Kind::Mods
        && (file.to_ascii_lowercase().ends_with(".jar")
            || file.to_ascii_lowercase().ends_with(".jar.disabled"))
        && meta.len() <= crate::file_picker::MAX_FILE
    {
        if let Ok(input) = fs::File::open(&path) {
            if let Ok(mut zip) = zip::ZipArchive::new(input) {
                if zip.len() <= crate::packs::MAX_RESOURCE_ENTRIES {
                    if let Ok(info) = crate::mod_info::read(&mut zip) {
                        name = info.name;
                        version = info.version;
                        editable = true;
                    }
                }
            }
        }
    }
    let fingerprint = revision(&meta, &path).unwrap_or_else(|_| {
        editable = false;
        format!("{}:{}", meta.len(), meta.last_write_time())
    });
    Ok(Entry {
        file,
        name,
        version,
        enabled,
        editable,
        bytes: meta.len(),
        revision: fingerprint,
    })
}
pub fn list(root: &Path, kind: Kind) -> Result<Vec<Entry>> {
    let directory = model::safe_path(root, kind.dir())?;
    if !directory.exists() {
        return Ok(vec![]);
    }
    let mut result = vec![];
    for (index, item) in fs::read_dir(directory)
        .map_err(|_| "无法读取内容目录")?
        .enumerate()
    {
        if index >= 1000 {
            return Err("目录超过 1000 项，请缩小范围后重试".into());
        }
        let item = item.map_err(|_| "内容目录读取失败")?;
        let file = item
            .file_name()
            .into_string()
            .map_err(|_| "文件名包含无效 Unicode")?;
        result.push(inspect_entry(root, kind, file)?);
    }
    result.sort_by_key(|item| item.name.to_lowercase());
    Ok(result)
}
pub fn toggle(root: &Path, file: &str, expected: &str, enabled: bool) -> Result<()> {
    let _locks = crate::worlds::lock_worlds(root)?;
    crate::resource_install::recover_all(root)?;
    let old = file_path(root, Kind::Mods, file)?;
    let entry = inspect_entry(root, Kind::Mods, file.into())?;
    if !entry.editable || entry.revision != expected {
        return Err("模组已变化或格式不支持，请重新读取".into());
    }
    if entry.enabled == enabled {
        return Ok(());
    }
    let target = if enabled {
        file.strip_suffix(".disabled")
            .ok_or("禁用文件名无效")?
            .to_string()
    } else {
        format!("{file}.disabled")
    };
    let new = file_path(root, Kind::Mods, &target)?;
    move_no_replace(&old, &new)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub entry: Entry,
    pub path: String,
    pub information: Option<crate::mod_info::Information>,
    pub note: String,
}
fn mod_entry(root: &Path, file: &str, expected: &str) -> Result<(PathBuf, Entry)> {
    let path = file_path(root, Kind::Mods, file)?;
    let entry = inspect_entry(root, Kind::Mods, file.into())?;
    if entry.revision != expected {
        return Err("文件已变化，请重新读取模组列表".into());
    }
    Ok((path, entry))
}
pub fn details(root: &Path, file: &str, expected: &str) -> Result<Details> {
    let (path, entry) = mod_entry(root, file, expected)?;
    let result = if path.is_file() && entry.bytes <= crate::file_picker::MAX_FILE {
        fs::File::open(&path)
            .map_err(|_| "模组文件不可读".into())
            .and_then(|file| zip::ZipArchive::new(file).map_err(|_| "不是有效 JAR".into()))
            .and_then(|mut zip| crate::mod_info::read(&mut zip))
    } else {
        Err("此项不是可识别的模组文件".into())
    };
    let (information, note) = match result {
        Ok(info) => (Some(info), String::new()),
        Err(note) => (None, note),
    };
    Ok(Details {
        entry,
        path: path.to_string_lossy().into_owned(),
        information,
        note,
    })
}
pub fn reveal(root: &Path, file: &str, expected: &str) -> Result<()> {
    let (path, _) = mod_entry(root, file, expected)?;
    std::process::Command::new("explorer.exe")
        .arg("/select,")
        .arg(path)
        .spawn()
        .map_err(|_| "无法打开模组文件位置")?;
    Ok(())
}
pub fn remove_mod(root: &Path, file: &str, expected: &str) -> Result<String> {
    let _locks = crate::worlds::lock_worlds(root)?;
    crate::resource_install::recover_all(root)?;
    let (path, entry) = mod_entry(root, file, expected)?;
    if !entry.editable {
        return Err("未识别的文件保留为只读，请在文件夹中核对".into());
    }
    let folder = model::safe_path(
        root,
        &format!(".easycraft-mod-trash/{}", uuid::Uuid::new_v4()),
    )?;
    fs::create_dir_all(folder.parent().ok_or("回收区路径无效")?)
        .map_err(|_| "无法创建模组回收区")?;
    fs::create_dir(&folder).map_err(|_| "无法创建本次回收目录")?;
    let target = model::safe_path(&folder, file)?;
    // Recheck after preparing the destination; never remove an unknown replacement.
    if revision(&fs::metadata(&path).map_err(|_| "模组已移除")?, &path)? != expected {
        return Err("模组已变化，未删除".into());
    }
    if let Err(error) = move_no_replace(&path, &target) {
        let _ = fs::remove_dir(&folder);
        return Err(error);
    }
    if revision(
        &fs::metadata(&target).map_err(|_| "无法核对回收文件")?,
        &target,
    )? != expected
    {
        let _ = move_no_replace(&target, &path);
        return Err(format!(
            "文件在操作期间变化，未永久删除；请核对 {}",
            folder.display()
        ));
    }
    if let Err(error) = model::save_json(
        &folder,
        "restore.json",
        &serde_json::json!({"file":file,"originalPath":path,"revision":expected}),
    ) {
        let rollback = move_no_replace(&target, &path);
        return Err(format!(
            "回收记录保存失败：{error}；{}",
            if rollback.is_ok() {
                "原文件已恢复".into()
            } else {
                format!("文件保留在 {}", target.display())
            }
        ));
    }
    Ok(target.to_string_lossy().into_owned())
}
pub(crate) fn move_no_replace(old: &Path, new: &Path) -> Result<()> {
    fn extended(path: &Path) -> Result<Vec<u16>> {
        let absolute = std::path::absolute(path).map_err(|_| "无法定位提交路径")?;
        let value: Vec<u16> = absolute.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err("提交路径含无效字符".into());
        }
        let mut wide = if value.starts_with(&[92, 92, 63, 92]) {
            value
        } else if value.starts_with(&[92, 92]) {
            "\\\\?\\UNC\\"
                .encode_utf16()
                .chain(value.into_iter().skip(2))
                .collect()
        } else {
            "\\\\?\\".encode_utf16().chain(value).collect()
        };
        wide.push(0);
        Ok(wide)
    }
    let from = extended(old)?;
    let to = extended(new)?;
    // MoveFileW refuses to overwrite an existing destination, including a racing external writer.
    if unsafe { windows_sys::Win32::Storage::FileSystem::MoveFileW(from.as_ptr(), to.as_ptr()) }
        == 0
    {
        return Err(format!(
            "无法提交文件：目标已存在或文件被占用，原文件保留（{}）",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}
pub fn import(root: &Path, kind: Kind, file: &str, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_IMPORT {
        return Err("本地导入须为 16 MB 以内的模组或资源 ZIP".into());
    }
    import_reader(root, kind, file, Cursor::new(bytes))
}
pub fn import_reader(root: &Path, kind: Kind, file: &str, input: impl Read) -> Result<()> {
    import_reader_cancellable(
        root,
        kind,
        file,
        input,
        &tokio_util::sync::CancellationToken::new(),
    )
}
pub fn import_reader_cancellable(
    root: &Path,
    kind: Kind,
    file: &str,
    input: impl Read,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<()> {
    if cancel.is_cancelled() {
        return Err("本地导入已取消，未提交文件".into());
    }
    let _locks = crate::worlds::lock_worlds(root)?;
    crate::resource_install::recover_all(root)?;
    if kind == Kind::Screenshots || kind == Kind::Datapacks {
        return Err("此类别不支持实例级本地导入".into());
    }
    if !(if kind == Kind::Mods {
        file.to_ascii_lowercase().ends_with(".jar")
    } else {
        file.to_ascii_lowercase().ends_with(".zip")
    }) {
        return Err("文件扩展名与资源类别不符".into());
    }
    let path = file_path(root, kind, file)?;
    fs::create_dir_all(path.parent().ok_or("目录无效")?).map_err(|_| "无法创建资源目录")?;
    let staging = file_path(root, kind, &format!(".{}.importing", uuid::Uuid::new_v4()))?;
    let mut output = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(|_| "无法创建临时资源文件，未覆盖")?;
    let result = (|| -> Result<()> {
        let copied = std::io::copy(
            &mut input.take(crate::file_picker::MAX_FILE + 1),
            &mut output,
        )
        .map_err(|_| "复制所选文件失败")?;
        if copied == 0 || copied > crate::file_picker::MAX_FILE {
            return Err("本地文件超过 512 MiB 或为空".into());
        }
        output.sync_all().map_err(|_| "无法同步临时资源")?;
        output.rewind().map_err(|_| "无法读取临时资源")?;
        if matches!(kind, Kind::Mods) {
            crate::packs::preview_mod_reader(&mut output)?;
        } else {
            crate::packs::preview_resource_reader(&mut output)?;
        }
        output
            .seek(SeekFrom::Start(0))
            .map_err(|_| "无法读取临时资源")?;
        let mut zip = zip::ZipArchive::new(&mut output).map_err(|_| "不是可读取的 ZIP")?;
        validate_archive(kind, &mut zip)
    })();
    drop(output);
    let result = result.and_then(|()| {
        if cancel.is_cancelled() {
            return Err("本地导入已取消，未提交文件".into());
        }
        move_no_replace(&staging, &path)
    });
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}
pub(crate) fn validate_archive<R: Read + std::io::Seek>(
    kind: Kind,
    zip: &mut zip::ZipArchive<R>,
) -> Result<()> {
    match kind {
        Kind::Mods => {
            fabric_info(zip)?;
        }
        Kind::Resourcepacks | Kind::Datapacks => {
            let entry = zip
                .by_name("pack.mcmeta")
                .map_err(|_| "资源包缺少 pack.mcmeta")?;
            if entry.size() > 512 * 1024 {
                return Err("资源包描述过大".into());
            }
            let value: serde_json::Value = serde_json::from_reader(entry.take(512 * 1024 + 1))
                .map_err(|_| "资源包描述无效")?;
            pack_range(&value, kind == Kind::Datapacks)?;
            if kind == Kind::Datapacks {
                let mut found = false;
                for name in zip.file_names() {
                    if name.map_err(|_| "数据包文件名无效")?.starts_with("data/") {
                        found = true;
                    }
                }
                if !found {
                    return Err("数据包缺少根目录 data/，请使用 Java 数据包 ZIP".into());
                }
            }
        }
        Kind::Shaderpacks => {
            let mut found = false;
            for i in 0..zip.len() {
                let entry = zip.by_index(i).map_err(|_| "光影目录无效")?;
                if entry
                    .name()
                    .map_err(|_| "光影文件名无效")?
                    .starts_with("shaders/")
                {
                    found = true;
                    break;
                }
            }
            if !found {
                return Err("光影包缺少 shaders 目录".into());
            }
        }
        Kind::Screenshots => unreachable!(),
    }
    Ok(())
}
pub(crate) type PackVersion = (u32, u32);
pub(crate) type PackRange = (PackVersion, PackVersion);
pub(crate) fn pack_bound(value: &serde_json::Value, upper: bool) -> Result<PackVersion> {
    let integer = |v: &serde_json::Value| {
        v.as_u64()
            .filter(|n| *n <= i32::MAX as u64)
            .map(|n| n as u32)
            .ok_or_else(|| "包格式版本必须是非负整数".to_string())
    };
    if let Some(values) = value.as_array() {
        return match values.as_slice() {
            [major] => Ok((integer(major)?, if upper { i32::MAX as u32 } else { 0 })),
            [major, minor] => Ok((integer(major)?, integer(minor)?)),
            _ => Err("包格式版本数组须为一到两个整数".into()),
        };
    }
    Ok((integer(value)?, if upper { i32::MAX as u32 } else { 0 }))
}
pub(crate) fn pack_range(value: &serde_json::Value, datapack: bool) -> Result<PackRange> {
    let pack = value
        .get("pack")
        .and_then(|v| v.as_object())
        .ok_or("缺少 pack 元数据")?;
    let range = if pack.contains_key("min_format") || pack.contains_key("max_format") {
        (
            pack_bound(pack.get("min_format").ok_or("缺少 min_format")?, false)?,
            pack_bound(pack.get("max_format").ok_or("缺少 max_format")?, true)?,
        )
    } else {
        legacy_pack_range(pack, datapack)?
    };
    if range.0 > range.1 {
        return Err("包格式版本范围倒置".into());
    }
    Ok(range)
}
fn legacy_pack_range(
    pack: &serde_json::Map<String, serde_json::Value>,
    datapack: bool,
) -> Result<PackRange> {
    let original = pack.get("pack_format").ok_or("缺少包格式版本")?;
    if !original.is_u64() {
        return Err("pack_format 必须是非负整数".into());
    }
    let original = pack_bound(original, false)?;
    if original.0 >= if datapack { 82 } else { 65 } {
        return Err("新版包格式需要 min_format 和 max_format".into());
    }
    let range = if let Some(supported) = pack.get("supported_formats") {
        if let Some(object) = supported.as_object() {
            (
                pack_bound(
                    object.get("min_inclusive").ok_or("缺少 min_inclusive")?,
                    false,
                )?,
                pack_bound(
                    object.get("max_inclusive").ok_or("缺少 max_inclusive")?,
                    true,
                )?,
            )
        } else if let Some(values) = supported.as_array() {
            match values.as_slice() {
                [min, max] => (pack_bound(min, false)?, pack_bound(max, true)?),
                _ => return Err("supported_formats 范围无效".into()),
            }
        } else {
            (pack_bound(supported, false)?, pack_bound(supported, true)?)
        }
    } else {
        (original, (original.0, i32::MAX as u32))
    };
    if range.0 > range.1 {
        return Err("包格式版本范围倒置".into());
    }
    Ok(range)
}
pub(crate) fn validate_pack_target(
    value: &serde_json::Value,
    datapack: bool,
    expected: PackVersion,
) -> Result<()> {
    let declared = pack_range(value, datapack)?;
    let pack = value
        .get("pack")
        .and_then(|v| v.as_object())
        .ok_or("包元数据无效")?;
    let range = if expected.0 < if datapack { 82 } else { 65 } {
        legacy_pack_range(pack, datapack)?
    } else {
        if !pack.contains_key("min_format") || !pack.contains_key("max_format") {
            return Err("目标游戏需要新版 min_format/max_format 声明".into());
        }
        declared
    };
    if expected < range.0 || expected > range.1 || expected < declared.0 || expected > declared.1 {
        return Err(format!(
            "包声明的格式不包含目标 {}.{}，未安装",
            expected.0, expected.1
        ));
    }
    Ok(())
}
pub fn image(root: &Path, file: &str) -> Result<String> {
    if !file.to_ascii_lowercase().ends_with(".png") {
        return Err("仅预览 PNG 游戏截图".into());
    }
    let path = file_path(root, Kind::Screenshots, file)?;
    let input = fs::File::open(path).map_err(|_| "无法读取截图")?;
    let mut bytes = vec![];
    input
        .take(MAX_IMPORT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "截图读取失败")?;
    if bytes.len() > MAX_IMPORT
        || bytes.len() < 33
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || &bytes[12..16] != b"IHDR"
    {
        return Err("截图过大或不是 PNG".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().map_err(|_| "截图宽度无效")?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().map_err(|_| "截图高度无效")?);
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16 * 1024 * 1024 {
        return Err("截图尺寸超过 1600 万像素，无法安全预览".into());
    }
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(bytes)))
}
pub fn open(root: &Path, kind: Option<Kind>) -> Result<()> {
    open_folder(root, kind.map(|kind| kind.dir()).unwrap_or("game"))
}
pub(crate) fn folder_path(root: &Path, folder: &str) -> Result<PathBuf> {
    let directory = match folder {
        "mods" | "saves" | "screenshots" | "resourcepacks" | "shaderpacks" => {
            model::safe_path(root, folder)?
        }
        "game" => root.to_path_buf(),
        _ => return Err("不支持的实例文件夹".into()),
    };
    if !directory.is_dir() {
        return Err("该文件夹尚未生成或不可访问；可先在游戏中使用对应功能。".into());
    }
    Ok(directory)
}
pub fn open_folder(root: &Path, folder: &str) -> Result<()> {
    let directory = folder_path(root, folder)?;
    std::process::Command::new("explorer.exe")
        .arg(directory)
        .spawn()
        .map_err(|_| "无法打开资源管理器")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn no_replace_move_supports_long_paths_and_keeps_collision_protection() {
        let root =
            std::env::temp_dir().join(format!("easycraft-long-move-{}", uuid::Uuid::new_v4()));
        let nested = root
            .join("a".repeat(80))
            .join("b".repeat(80))
            .join("c".repeat(80));
        std::fs::create_dir_all(&nested).unwrap();
        let from = nested.join("library.jar.part");
        let to = nested.join("library.jar");
        std::fs::write(&from, b"verified library").unwrap();
        super::move_no_replace(&from, &to).unwrap();
        std::fs::write(&from, b"another file").unwrap();
        assert!(super::move_no_replace(&from, &to).is_err());
        assert_eq!(std::fs::read(&to).unwrap(), b"verified library");
        assert_eq!(std::fs::read(&from).unwrap(), b"another file");
        std::fs::remove_dir_all(root).unwrap();
    }
    use super::*;
    use std::io::Write;
    #[test]
    fn fabric_descriptions_accept_loader_compatible_literal_line_breaks() {
        let bytes=b"{\"schemaVersion\":1,\"id\":\"fixture\",\"version\":\"1.0\",\"description\":\"first\nsecond\tline\",\"custom\":\"escaped \\\" quote and \\\\ slash\"}";
        let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
        output
            .start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        output.write_all(bytes).unwrap();
        let mut archive =
            zip::ZipArchive::new(Cursor::new(output.finish().unwrap().into_inner())).unwrap();
        let metadata = fabric_metadata(&mut archive).unwrap();
        assert_eq!(metadata["description"], "first\nsecond\tline");
        assert_eq!(metadata["custom"], "escaped \" quote and \\ slash");
        assert!(parse_fabric_json(b"{\"id\":\"broken\"").is_err());
        assert!(parse_fabric_json(b"{\"id\":\"bad\\q\"}").is_err());
        assert!(parse_fabric_json(b"{\"id\":\"ok\",}").is_err());
    }
    #[test]
    fn no_overwrite_move_refuses_an_open_directory_and_preserves_existing_target() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = root();
        let old = root.join("old");
        let new = root.join("new");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("resource.jar"), b"fixture").unwrap();
        let input = fs::OpenOptions::new()
            .read(true)
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
            .open(old.join("resource.jar"))
            .unwrap();
        assert!(move_no_replace(&old, &new).is_err());
        assert!(!new.exists());
        drop(input);
        move_no_replace(&old, &new).unwrap();
        assert_eq!(fs::read(new.join("resource.jar")).unwrap(), b"fixture");
        fs::create_dir(&old).unwrap();
        assert!(move_no_replace(&old, &new).is_err());
        assert!(old.exists());
        assert!(new.join("resource.jar").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn streamed_file_import_exceeds_ipc_limit_and_cleans_failed_staging() {
        let root = root();
        let source = root.join("large.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&source).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("pack.mcmeta", options).unwrap();
        zip.write_all(br#"{"pack":{"pack_format":34,"description":"large fixture"}}"#)
            .unwrap();
        zip.start_file("assets/fixture/large.bin", options).unwrap();
        std::io::copy(&mut std::io::repeat(0).take(17 * 1024 * 1024), &mut zip).unwrap();
        zip.finish().unwrap();
        let fixture_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.native/fixtures");
        fs::create_dir_all(&fixture_dir).unwrap();
        fs::copy(&source, fixture_dir.join("local-large-resource.zip")).unwrap();
        let (name, mut file) = crate::file_picker::open(source.clone(), &["zip"]).unwrap();
        assert!(file.metadata().unwrap().len() > MAX_IMPORT as u64);
        crate::packs::preview_reader(&file).unwrap();
        file.rewind().unwrap();
        import_reader(&root, Kind::Resourcepacks, &name, file).unwrap();
        assert_eq!(
            fs::read(&source).unwrap(),
            fs::read(root.join("resourcepacks/large.zip")).unwrap()
        );
        let (_, file) = crate::file_picker::open(source.clone(), &["zip"]).unwrap();
        assert!(import_reader(&root, Kind::Resourcepacks, &name, file).is_err());
        assert!(crate::file_picker::open(source, &["jar"]).is_err());
        struct Broken;
        impl Read for Broken {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("fixture"))
            }
        }
        assert!(import_reader(&root, Kind::Resourcepacks, "broken.zip", Broken).is_err());
        assert!(import_reader(
            &root,
            Kind::Resourcepacks,
            "invalid.zip",
            Cursor::new(b"invalid")
        )
        .is_err());
        assert_eq!(fs::read_dir(root.join("resourcepacks")).unwrap().count(), 1);
        let oversized = root.join("oversized.zip");
        fs::File::create(&oversized)
            .unwrap()
            .set_len(crate::file_picker::MAX_FILE + 1)
            .unwrap();
        assert!(crate::file_picker::open(oversized, &["zip"]).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    fn root() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/content-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn jar() -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(br#"{"id":"testmod","name":"Test Mod","version":"1.0"}"#)
            .unwrap();
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn mod_details_toggle_archive_and_stale_identity_preserve_user_files() {
        use std::io::Write;
        let root = root();
        fs::create_dir_all(root.join("mods")).unwrap();
        fs::write(root.join("mods/fabric.jar"), jar()).unwrap();
        fs::write(root.join("mods/unknown.jar"), b"unrecognized").unwrap();
        let item = list(&root, Kind::Mods)
            .unwrap()
            .into_iter()
            .find(|entry| entry.file == "fabric.jar")
            .unwrap();
        let info = details(&root, &item.file, &item.revision).unwrap();
        assert_eq!(info.information.unwrap().ids, vec!["testmod"]);
        assert!(details(&root, "../fabric.jar", &item.revision).is_err());
        let old_metadata = fs::metadata(root.join("mods/fabric.jar")).unwrap();
        fs::rename(root.join("mods/fabric.jar"), root.join("original.jar")).unwrap();
        fs::write(root.join("mods/fabric.jar"), jar()).unwrap();
        fs::File::options()
            .write(true)
            .open(root.join("mods/fabric.jar"))
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old_metadata.modified().unwrap()))
            .unwrap();
        assert!(remove_mod(&root, "fabric.jar", &item.revision).is_err());
        let current = list(&root, Kind::Mods)
            .unwrap()
            .into_iter()
            .find(|entry| entry.file == "fabric.jar")
            .unwrap();
        toggle(&root, &current.file, &current.revision, false).unwrap();
        let disabled = list(&root, Kind::Mods)
            .unwrap()
            .into_iter()
            .find(|entry| entry.file == "fabric.jar.disabled")
            .unwrap();
        assert!(!disabled.enabled);
        let archived = remove_mod(&root, &disabled.file, &disabled.revision).unwrap();
        assert_eq!(fs::read(&archived).unwrap(), jar());
        assert!(Path::new(&archived)
            .parent()
            .unwrap()
            .join("restore.json")
            .is_file());
        assert!(!root.join("mods/fabric.jar.disabled").exists());
        let unknown = list(&root, Kind::Mods)
            .unwrap()
            .into_iter()
            .find(|entry| entry.file == "unknown.jar")
            .unwrap();
        assert!(remove_mod(&root, &unknown.file, &unknown.revision).is_err());
        assert!(details(&root, &unknown.file, &unknown.revision)
            .unwrap()
            .information
            .is_none());
        assert_eq!(
            fs::read(root.join("mods/unknown.jar")).unwrap(),
            b"unrecognized"
        );
        for (name,path,metadata) in [
            ("forge.jar","META-INF/mods.toml","modLoader='javafml'\nlicense='MIT'\n[[mods]]\nmodId='forge_fixture'\ndisplayName='Forge fixture'\nversion='1.2.3'"),
            ("neo.jar","META-INF/neoforge.mods.toml","modLoader='javafml'\n[[mods]]\nmodId='neo_fixture'\ndisplayName='Neo fixture'\nversion='1.2.3'")
        ] {
            let mut zip=zip::ZipWriter::new(Cursor::new(vec![]));zip.start_file(path,zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(metadata.as_bytes()).unwrap();
            fs::write(root.join("mods").join(name),zip.finish().unwrap().into_inner()).unwrap();
            let item=list(&root,Kind::Mods).unwrap().into_iter().find(|entry|entry.file==name).unwrap();
            assert!(item.editable);assert_eq!(item.version,"1.2.3");
            toggle(&root,&item.file,&item.revision,false).unwrap();
        }
    }
    #[test]
    fn busy_mod_archive_refuses_and_leaves_the_original_in_place() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = root();
        fs::create_dir_all(root.join("mods")).unwrap();
        fs::write(root.join("mods/locked.jar"), jar()).unwrap();
        let entry = list(&root, Kind::Mods).unwrap().remove(0);
        let _handle = fs::OpenOptions::new()
            .read(true)
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
            .open(root.join("mods/locked.jar"))
            .unwrap();
        assert!(remove_mod(&root, &entry.file, &entry.revision).is_err());
        assert_eq!(fs::read(root.join("mods/locked.jar")).unwrap(), jar());
    }
    #[test]
    fn pack_formats_check_legacy_ranges_modern_minor_versions_and_backwards_declarations() {
        use serde_json::json;
        let legacy = json!({"pack":{"pack_format":48,"supported_formats":[41,48]}});
        validate_pack_target(&legacy, true, (48, 0)).unwrap();
        validate_pack_target(&legacy, true, (41, 0)).unwrap();
        assert!(validate_pack_target(&legacy, true, (49, 0)).is_err());
        assert!(validate_pack_target(&legacy, true, (88, 0)).is_err());
        let modern = json!({"pack":{"min_format":[88,1],"max_format":88}});
        validate_pack_target(&modern, true, (88, 100)).unwrap();
        assert!(validate_pack_target(&modern, true, (88, 0)).is_err());
        assert!(validate_pack_target(&modern, true, (89, 0)).is_err());
        assert!(validate_pack_target(
            &json!({"pack":{"min_format":48,"max_format":48}}),
            true,
            (48, 0)
        )
        .is_err());
        for pack in [
            json!({"pack_format":-1}),
            json!({"pack_format":[48]}),
            json!({"min_format":[88,1,2],"max_format":89}),
            json!({"min_format":90,"max_format":88}),
            json!({"pack_format":88}),
        ] {
            assert!(pack_range(&json!({"pack":pack}), true).is_err());
        }
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file("pack.mcmeta", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(br#"{"pack":{"pack_format":48,"description":"fixture"}}"#)
            .unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        assert!(validate_archive(Kind::Datapacks, &mut zip).is_err());
    }
    #[test]
    fn imports_identifies_toggles_without_overwriting_and_preserves_unknown_files() {
        let root = root();
        let bytes = jar();
        model::write_file(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("..").as_path(),
            ".native/fixtures/local-test.jar",
            &bytes,
        )
        .unwrap();
        import(&root, Kind::Mods, "test.jar", &bytes).unwrap();
        fs::write(root.join("mods/unknown.txt"), b"preserve").unwrap();
        let item = list(&root, Kind::Mods)
            .unwrap()
            .into_iter()
            .find(|e| e.editable)
            .unwrap();
        assert_eq!(item.name, "Test Mod");
        toggle(&root, "test.jar", "stale", false).unwrap_err();
        toggle(&root, "test.jar", &item.revision, false).unwrap();
        assert_eq!(
            fs::read(root.join("mods/test.jar.disabled")).unwrap(),
            bytes
        );
        fs::write(root.join("mods/test.jar"), b"do not replace").unwrap();
        let item = list(&root, Kind::Mods)
            .unwrap()
            .into_iter()
            .find(|e| e.editable)
            .unwrap();
        assert!(toggle(&root, &item.file, &item.revision, true).is_err());
        assert_eq!(
            fs::read(root.join("mods/test.jar")).unwrap(),
            b"do not replace"
        );
        assert_eq!(
            fs::read(root.join("mods/unknown.txt")).unwrap(),
            b"preserve"
        );
        assert!(import(&root, Kind::Mods, "../bad.jar", &jar()).is_err());
        assert!(import(&root, Kind::Resourcepacks, "bad.zip", &jar()).is_err());
    }
    #[test]
    fn pack_import_and_screenshot_boundaries_use_only_the_selected_directory() {
        let root = root();
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file("pack.mcmeta", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(br#"{"pack":{"pack_format":34,"description":"fixture"}}"#)
            .unwrap();
        let pack = zip.finish().unwrap().into_inner();
        model::write_file(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("..").as_path(),
            ".native/fixtures/local-resource.zip",
            &pack,
        )
        .unwrap();
        let mut shader = zip::ZipWriter::new(Cursor::new(vec![]));
        shader
            .start_file(
                "shaders/fixture.fsh",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        shader
            .write_all(b"// fixture, not a working shader")
            .unwrap();
        let shader = shader.finish().unwrap().into_inner();
        model::write_file(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("..").as_path(),
            ".native/fixtures/local-shader.zip",
            &shader,
        )
        .unwrap();
        import(&root, Kind::Resourcepacks, "pack.zip", &pack).unwrap();
        assert!(root.join("resourcepacks/pack.zip").is_file());
        assert!(!root.join("mods/pack.zip").exists());
        assert!(import(&root, Kind::Resourcepacks, "pack.zip", &pack).is_err());
        assert_eq!(fs::read(root.join("resourcepacks/pack.zip")).unwrap(), pack);
        assert_eq!(fs::read_dir(root.join("resourcepacks")).unwrap().count(), 1);
        assert!(image(&root, "../other.png").is_err());
        assert!(import(&root, Kind::Screenshots, "x.png", &pack).is_err());
        model::write_file(&root, "saves/occupied/level.dat", b"fixture").unwrap();
        use std::os::windows::fs::OpenOptionsExt;
        let _lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(root.join("saves/occupied/session.lock"))
            .unwrap();
        assert!(import(&root, Kind::Resourcepacks, "blocked.zip", &pack).is_err());
        assert!(!root.join("resourcepacks/blocked.zip").exists());
    }
    #[test]
    fn instance_rename_persists_without_moving_world_data() {
        let root = root();
        let id = uuid::Uuid::new_v4().to_string();
        model::save_json(
            &root,
            "instances.json",
            &vec![model::Instance {
                version_folder: None,
                storage_root: None,
                id: id.clone(),
                name: "Before".into(),
                version: "1.21.1".into(),
                manifest_sha1: "a".repeat(40),
                java_major: 21,
                fabric_version: String::new(),
                fabric_sha1: String::new(),
                launch: Default::default(),
                local: None,
            }],
        )
        .unwrap();
        model::write_file(
            &root,
            &format!("instances/{id}/game/saves/preserve.txt"),
            b"world bytes",
        )
        .unwrap();
        let host = crate::host::Host::new(root.clone()).unwrap();
        host.rename_instance(&id, "After").unwrap();
        assert!(host.rename_instance(&id, "\n").is_err());
        assert_eq!(host.status().instances[0].name, "After");
        drop(host);
        assert_eq!(
            crate::host::Host::new(root.clone())
                .unwrap()
                .status()
                .instances[0]
                .name,
            "After"
        );
        assert_eq!(
            fs::read(root.join(format!("instances/{id}/game/saves/preserve.txt"))).unwrap(),
            b"world bytes"
        );
    }
    #[test]
    fn screenshot_header_rejects_excessive_dimensions_before_browser_decode() {
        let root = root();
        fs::create_dir_all(root.join("screenshots")).unwrap();
        let mut png = vec![0; 33];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&100_000u32.to_be_bytes());
        png[20..24].copy_from_slice(&100_000u32.to_be_bytes());
        fs::write(root.join("screenshots/bomb.png"), png).unwrap();
        assert!(image(&root, "bomb.png").unwrap_err().contains("像素"));
        fs::write(root.join("screenshots/truncated.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        assert!(image(&root, "truncated.png").is_err());
    }
}
