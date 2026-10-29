//! Read-only discovery; directly register installed games or explicitly copy supported contents.
use crate::{
    host::Host,
    model::{self, Instance, Result},
    modpack, net,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Instant, SystemTime},
};
use tokio_util::sync::CancellationToken;

const DIRS: &[&str] = &[
    "mods",
    "config",
    "saves",
    "resourcepacks",
    "shaderpacks",
    "screenshots",
    "datapacks",
    "defaultconfigs",
    "kubejs",
    "scripts",
];
const FILES: &[&str] = &[
    "options.txt",
    "optionsof.txt",
    "optionsshaders.txt",
    "servers.dat",
    "servers.dat_old",
];
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: String,
    pub name: String,
    pub game_version: String,
    pub loader: String,
    pub directory: String,
    pub game_directory: String,
    pub supported: bool,
    pub duplicate: bool,
    pub files: usize,
    pub bytes: u64,
    pub content_indexed: bool,
    pub content_roots: Vec<String>,
    pub worlds: usize,
    pub source_isolation: bool,
    pub issues: Vec<String>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub directory: String,
    pub candidates: Vec<Candidate>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    path: String,
    size: u64,
    hash: String,
    identity: (u32, u32, u32),
    modified: SystemTime,
}
#[derive(Clone, PartialEq, Eq)]
struct ContentEntry {
    path: String,
    directory: bool,
    size: u64,
    modified: SystemTime,
}
#[derive(Clone, PartialEq, Eq)]
struct ContentSummary {
    entries: Vec<ContentEntry>,
    worlds: usize,
    warnings: Vec<String>,
}
#[derive(Clone)]
struct Source {
    info: Candidate,
    key: String,
    root: PathBuf,
    base_json: String,
    base_jar: String,
    game: PathBuf,
    metadata: Vec<Stamp>,
    content: Arc<ContentSummary>,
    roots: Vec<PathBuf>,
    fabric: String,
    loader: String,
    loader_version: String,
    profile: Value,
}
pub struct Scan {
    pub preview: Preview,
    sources: Vec<Source>,
    created: Instant,
}
#[derive(Default)]
struct ScanCache {
    content: HashMap<PathBuf, Arc<ContentSummary>>,
    jars: HashMap<String, (String, Stamp)>,
}
// ZIP 9 repeatedly seeks within its central directory. BufReader::seek flushes its
// buffer even for nearby offsets; retain it and track position without OS queries.
struct JarReader<R> {
    inner: BufReader<R>,
    position: u64,
}
impl<R: Read + Seek> JarReader<R> {
    fn new(mut reader: R) -> io::Result<Self> {
        let position = reader.stream_position()?;
        Ok(Self {
            inner: BufReader::new(reader),
            position,
        })
    }
}
impl<R: Read + Seek> Read for JarReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        let count = self.inner.read(bytes)?;
        self.position += count as u64;
        Ok(count)
    }
}
impl<R: Read + Seek> Seek for JarReader<R> {
    fn seek(&mut self, target: SeekFrom) -> io::Result<u64> {
        let relative = match target {
            SeekFrom::Start(position) => {
                i64::try_from(i128::from(position) - i128::from(self.position)).ok()
            }
            SeekFrom::Current(offset) => Some(offset),
            SeekFrom::End(_) => None,
        };
        if let Some(offset) = relative {
            let position = self
                .position
                .checked_add_signed(offset)
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "negative JAR seek"))?;
            self.inner.seek_relative(offset)?;
            self.position = position;
        } else {
            self.position = self.inner.seek(target)?;
        }
        Ok(self.position)
    }
    fn stream_position(&mut self) -> io::Result<u64> {
        Ok(self.position)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub mode: ImportMode,
}
#[derive(Clone, Copy, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ImportMode {
    #[default]
    Reference,
    Copy,
}

fn checkpoint(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err("本地版本导入已取消".into())
    } else {
        Ok(())
    }
}
pub(crate) fn checked_directory(path: &Path) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err("请选择本地绝对目录".into());
    }
    use std::os::windows::fs::MetadataExt;
    for parent in path.ancestors() {
        let m = fs::symlink_metadata(parent).map_err(|_| "目录不存在或不可读")?;
        if !m.is_dir() || m.file_attributes() & 0x400 != 0 {
            return Err("不支持链接、重解析点或非目录路径".into());
        }
    }
    let canonical = path.canonicalize().map_err(|_| "无法定位本地目录")?;
    let text = canonical.to_str().ok_or("目录名称无效")?;
    Ok(PathBuf::from(text.strip_prefix("\\\\?\\").unwrap_or(text)))
}
fn relative(root: &Path, path: &Path) -> Result<String> {
    let value = path
        .strip_prefix(root)
        .map_err(|_| "资源路径越界")?
        .to_str()
        .ok_or("文件名无效")?
        .replace('\\', "/");
    model::safe_path(root, &value)?;
    Ok(value)
}
fn read_json(root: &Path, path: &str) -> Result<Value> {
    let target = model::safe_path(root, path)?;
    let size = fs::metadata(&target).map_err(|_| "版本 JSON 不存在")?.len();
    if size > 8 * 1024 * 1024 {
        return Err("版本 JSON 超过 8 MiB".into());
    }
    let guard = crate::file_guard::Guard::open(root, path, size, false)?;
    serde_json::from_reader(std::io::BufReader::new(
        guard.file.take(8 * 1024 * 1024 + 1),
    ))
    .map_err(|_| "版本 JSON 损坏".into())
}
fn stamp(root: &Path, path: &str, cancel: &CancellationToken) -> Result<Stamp> {
    snapshot(root, path, cancel, true)
}
fn snapshot(root: &Path, path: &str, cancel: &CancellationToken, deep: bool) -> Result<Stamp> {
    checkpoint(cancel)?;
    let file = model::safe_path(root, path)?;
    let metadata = fs::metadata(&file).map_err(|_| "文件不存在或不可读")?;
    if !metadata.is_file() {
        return Err("所选条目不是文件".into());
    }
    let size = metadata.len();
    if size > crate::file_picker::MAX_FILE {
        return Err("单个游戏内容文件超过 512 MiB，暂不支持导入".into());
    }
    let hash = if deep {
        let mut guard = crate::file_guard::Guard::open(root, path, size, false)?;
        crate::file_guard::digest(&mut guard.file, cancel)?
    } else {
        String::new()
    };
    Ok(Stamp {
        path: path.into(),
        size,
        hash,
        identity: crate::resource_install::file_identity(&file)?,
        modified: metadata.modified().map_err(|_| "无法读取文件修改时间")?,
    })
}
#[cfg(test)]
fn inventory(root: &Path, cancel: &CancellationToken) -> Result<Vec<Stamp>> {
    inventory_progress(root, cancel, None)
}
fn inventory_progress(
    root: &Path,
    cancel: &CancellationToken,
    host: Option<&Host>,
) -> Result<Vec<Stamp>> {
    fn visit(
        root: &Path,
        rel: &str,
        result: &mut Vec<Stamp>,
        total: &mut u64,
        cancel: &CancellationToken,
        visited: &mut usize,
        host: Option<&Host>,
    ) -> Result<()> {
        checkpoint(cancel)?;
        *visited += 1;
        if (*visited).is_multiple_of(32) {
            if let Some(host) = host {
                host.progress(
                    "local-index",
                    &format!(
                        "已索引 {} 个游戏文件 · {:.1} MiB",
                        result.len(),
                        *total as f64 / 1048576.0
                    ),
                    0,
                    0,
                );
            }
        }
        if rel.split('/').count() > 24 || result.len() >= 19000 || *visited > 20000 {
            return Err("游戏目录超出扫描深度或文件数量限制".into());
        }
        let path = model::safe_path(root, rel)?;
        if path.is_dir() {
            for entry in fs::read_dir(&path)
                .map_err(|_| "游戏目录不可读")?
                .take(19001)
            {
                let entry = entry.map_err(|_| "无法读取游戏内容")?;
                let name = entry
                    .file_name()
                    .into_string()
                    .map_err(|_| "游戏文件名无效")?;
                visit(
                    root,
                    &format!("{rel}/{name}"),
                    result,
                    total,
                    cancel,
                    visited,
                    host,
                )?;
            }
        } else {
            let value = snapshot(root, rel, cancel, false)?;
            *total = total.checked_add(value.size).ok_or("内容大小溢出")?;
            if *total > 2 * 1024 * 1024 * 1024 {
                return Err("游戏内容超过 2 GiB，本轮暂不支持整体复制".into());
            }
            result.push(value);
        }
        Ok(())
    }
    let mut result = vec![];
    let mut total = 0;
    let mut visited = 0;
    for name in DIRS.iter().chain(FILES) {
        let path = model::safe_path(root, name)?;
        if path.exists() {
            visit(
                root,
                name,
                &mut result,
                &mut total,
                cancel,
                &mut visited,
                host,
            )?;
        }
    }
    result.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(result)
}
fn json_file(directory: &Path) -> Result<PathBuf> {
    let name = directory
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("版本目录名称无效")?;
    let expected = directory.join(format!("{name}.json"));
    if expected.is_file() {
        return Ok(expected);
    }
    let mut files = fs::read_dir(directory)
        .map_err(|_| "版本目录不可读")?
        .take(512)
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension()
                .is_some_and(|s| s.eq_ignore_ascii_case("json"))
        })
        .filter(|p| {
            !p.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_ascii_lowercase()
                .split(['.', '-', '_'])
                .any(|part| {
                    [
                        "account", "accounts", "auth", "token", "tokens", "launcher", "hmcl", "pcl",
                    ]
                    .contains(&part)
                })
        })
        .filter(|p| {
            relative(directory, p)
                .ok()
                .and_then(|rel| read_json(directory, &rel).ok())
                .is_some_and(|v| v["id"].is_string() && v["libraries"].is_array())
        })
        .collect::<Vec<_>>();
    if files.len() != 1 {
        return Err("找不到唯一的版本 JSON，请选择具体版本目录".into());
    }
    Ok(files.remove(0))
}
fn has_game_content(directory: &Path) -> Result<bool> {
    for name in FILES {
        if model::safe_path(directory, name)?.is_file() {
            return Ok(true);
        }
    }
    for name in DIRS {
        let path = model::safe_path(directory, name)?;
        if path.is_dir()
            && fs::read_dir(path)
                .map_err(|_| "游戏内容目录不可读")?
                .next()
                .is_some()
        {
            return Ok(true);
        }
    }
    Ok(false)
}
// Discovery visits known entry points and immediate world folders only. Content is indexed on import.
fn discover_content(root: &Path, cancel: &CancellationToken) -> Result<ContentSummary> {
    let mut entries = vec![];
    let mut warnings = vec![];
    for name in DIRS.iter().chain(FILES) {
        checkpoint(cancel)?;
        let path = model::safe_path(root, name)?;
        if !path.exists() {
            continue;
        }
        let m = fs::metadata(path).map_err(|_| "无法读取游戏内容目录信息")?;
        entries.push(ContentEntry {
            path: (*name).into(),
            directory: m.is_dir(),
            size: if m.is_dir() { 0 } else { m.len() },
            modified: m.modified().map_err(|_| "无法读取游戏目录修改时间")?,
        });
    }
    let saves = model::safe_path(root, "saves")?;
    let mut worlds = 0;
    if saves.is_dir() {
        match fs::read_dir(&saves) {
            Ok(items) => {
                for (index, item) in items.take(1001).enumerate() {
                    checkpoint(cancel)?;
                    if index == 1000 {
                        warnings.push("存档目录仅快速检查前 1000 项，其余将在导入时检查。".into());
                        break;
                    }
                    let Ok(item) = item else {
                        warnings.push("部分存档目录不可读，未确认其内容。".into());
                        continue;
                    };
                    let Ok(path) = checked_directory(&item.path()) else {
                        continue;
                    };
                    if ["level.dat", "level.dat_old"]
                        .iter()
                        .any(|name| model::safe_path(&path, name).is_ok_and(|p| p.is_file()))
                    {
                        worlds += 1;
                    }
                }
            }
            Err(_) => warnings.push("存档目录不可读，尚未检查世界内容。".into()),
        }
    }
    Ok(ContentSummary {
        entries,
        worlds,
        warnings,
    })
}
fn source_key(root: &Path, json: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(format!("{}/{}", root.display(), json).to_lowercase())
    )
}
fn unique_name(name: &str, existing: &[Instance]) -> String {
    if !existing.iter().any(|v| v.name == name.trim()) {
        return name.trim().into();
    }
    for index in 2..10000 {
        let suffix = format!(" ({index})");
        let value = format!(
            "{}{}",
            name.trim()
                .chars()
                .take(60 - suffix.chars().count())
                .collect::<String>(),
            suffix
        );
        if !existing.iter().any(|v| v.name == value) {
            return value;
        }
    }
    uuid::Uuid::new_v4().to_string()
}
pub fn is_imported(host: &Host, key: &str) -> bool {
    host.status().instances.iter().any(|instance| {
        if instance.local.as_ref().is_some_and(|v| v.source_key == key) {
            return true;
        }
        read_json(
            &host.root,
            &format!(
                "instances/{}/game/.easycraft-local-import.json",
                instance.id
            ),
        )
        .is_ok_and(|v| v["sourceKey"] == key)
    })
}
fn inspect(
    root: &Path,
    directory: &Path,
    catalog: &HashMap<String, PathBuf>,
    cancel: &CancellationToken,
    cache: &mut ScanCache,
) -> Result<Source> {
    let selected = json_file(directory)?;
    let json_rel = relative(root, &selected)?;
    let key = source_key(root, &json_rel);
    let mut current = selected;
    let mut visited = HashSet::new();
    let mut metadata = vec![];
    let mut fabric = String::new();
    let mut profiles = vec![];
    let mut first = true;
    let (base, base_path) = loop {
        if metadata.len() >= 16 {
            return Err("版本继承超过 16 层".into());
        }
        let rel = relative(root, &current)?;
        if !visited.insert(rel.clone()) {
            return Err("版本继承存在循环".into());
        }
        let value = read_json(root, &rel)?;
        metadata.push(stamp(root, &rel, cancel)?);
        let libraries = value["libraries"].as_array().ok_or("版本缺少依赖库清单")?;
        if libraries.len() > 2000 {
            return Err("版本依赖库数量异常".into());
        }
        let main = value["mainClass"].as_str().unwrap_or("");
        if main.contains("quilt") {
            return Err("当前暂不支持 Quilt 本地版本导入".into());
        }
        if first && main == "net.fabricmc.loader.impl.launch.knot.KnotClient" {
            fabric = libraries
                .iter()
                .filter_map(|v| v["name"].as_str())
                .find_map(|s| s.strip_prefix("net.fabricmc:fabric-loader:"))
                .filter(|s| crate::fabric::valid_version(s))
                .ok_or("Fabric 加载器版本缺失")?
                .into();
        } else if ![
            "net.minecraft.client.main.Main",
            "cpw.mods.modlauncher.Launcher",
            "cpw.mods.bootstraplauncher.BootstrapLauncher",
        ]
        .contains(&main)
        {
            return Err("该启动主类或自定义加载器尚不支持导入".into());
        }
        profiles.push(value.clone());
        first = false;
        if let Some(parent) = value["inheritsFrom"].as_str() {
            if !model::valid_id(parent) {
                return Err("继承版本名称无效".into());
            }
            current = catalog
                .get(parent)
                .cloned()
                .ok_or("找不到继承的基础版本，请改选完整 Minecraft 根目录")?;
        } else {
            break (value, rel);
        }
    };
    if base.get("minecraftArguments").is_some() || !base["arguments"]["game"].is_array() {
        return Err("仅支持现代 Minecraft 参数格式，远古版本暂不支持".into());
    }
    let base_dir = model::safe_path(root, &base_path)?
        .parent()
        .ok_or("基础版本目录无效")?
        .to_path_buf();
    let mut jar = model::safe_path(root, &base_path)?.with_extension("jar");
    if !jar.is_file() {
        jar = base_dir.join(format!("{}.jar", base["id"].as_str().unwrap_or_default()));
    }
    let jar_rel = relative(root, &jar)?;
    let (game_version, jar_stamp) = if let Some(value) = cache.jars.get(&jar_rel) {
        value.clone()
    } else {
        let file_size = fs::metadata(&jar).map_err(|_| "基础游戏 JAR 缺失")?.len();
        let guard = crate::file_guard::Guard::open(root, &jar_rel, file_size, false)?;
        let mut zip =
            zip::ZipArchive::new(JarReader::new(guard.file).map_err(|_| "基础游戏 JAR 不可读")?)
                .map_err(|_| "基础游戏 JAR 损坏")?;
        let game_version = match zip.by_name("version.json") {
            Ok(file) => {
                if file.size() > 65536 {
                    return Err("游戏内置版本信息过大".into());
                }
                let v: Value = serde_json::from_reader(file.take(65537))
                    .map_err(|_| "游戏内置版本信息损坏")?;
                v["id"].as_str().ok_or("缺少游戏内置版本 ID")?.to_string()
            }
            Err(_) => base["id"].as_str().ok_or("版本 ID 缺失")?.into(),
        };
        if !model::valid_id(&game_version) {
            return Err("游戏版本 ID 无效".into());
        }
        let value = (game_version, snapshot(root, &jar_rel, cancel, false)?);
        cache.jars.insert(jar_rel.clone(), value.clone());
        value
    };
    metadata.push(jar_stamp);
    let profile = crate::local_launch::merge(&profiles)?;
    let (loader, loader_version) = crate::local_launch::loader(&profile);
    let game = if has_game_content(directory)? {
        directory.to_path_buf()
    } else {
        root.to_path_buf()
    };
    let content = if let Some(value) = cache.content.get(&game) {
        value.clone()
    } else {
        let value = Arc::new(discover_content(&game, cancel)?);
        cache.content.insert(game.clone(), value.clone());
        value
    };
    let mut warnings = vec![
        "默认直接添加原安装：复用原目录中的库、资源、Mod、存档与游戏设置，不遍历复制内容、不联网；游戏启动后在该目录正常读写。账号和第三方启动器私有配置不会导入。"
            .into(),
        "仅在选择复制为独立副本时逐文件校验与复制；原版/Fabric 副本可联网补齐官方资源。Forge/NeoForge 当前使用已经安装完成的本地版本，不执行安装器处理器。"
            .into(),
    ];
    warnings.extend(content.warnings.clone());
    if !root.join("libraries").is_dir() {
        warnings
            .push("共享 libraries 目录缺失，直接添加不会自动联网；请先在原启动器修复安装。".into());
    }
    if !root.join("assets").is_dir() {
        warnings
            .push("共享 assets 目录缺失，直接添加不会自动联网；请先在原启动器修复资源。".into());
    }
    warnings.push("副本模式仅复制常见游戏内容目录及 options/servers 文件；日志、启动器配置和其他自定义根目录文件不导入。".into());
    let name = directory
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("本地游戏")
        .chars()
        .take(60)
        .collect();
    Ok(Source {
        info: Candidate {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            game_version,
            loader: match loader.as_str() {
                "fabric" => format!("Fabric {loader_version}"),
                "forge" => format!("Forge {loader_version}"),
                "neoforge" => format!("NeoForge {loader_version}"),
                _ => "原版".into(),
            },
            directory: directory.to_string_lossy().into(),
            game_directory: game.to_string_lossy().into(),
            supported: true,
            duplicate: false,
            files: 0,
            bytes: 0,
            content_indexed: false,
            content_roots: content.entries.iter().map(|v| v.path.clone()).collect(),
            worlds: content.worlds,
            source_isolation: game != root,
            issues: vec![],
            warnings,
        },
        key,
        root: root.into(),
        base_json: base_path,
        base_jar: jar_rel,
        game,
        metadata,
        content,
        roots: vec![root.to_path_buf(), directory.to_path_buf()],
        fabric,
        loader,
        loader_version,
        profile,
    })
}
pub fn scan(host: &Host, selected: &Path, cancel: &CancellationToken) -> Result<Scan> {
    let selected = checked_directory(selected)?;
    if selected.join("level.dat").is_file() || selected.join("level.dat_old").is_file() {
        return Err(
            "所选目录是 Minecraft 存档，请选择 .minecraft、versions 或具体版本目录。".into(),
        );
    }
    if selected.starts_with(&host.root) || host.root.starts_with(&selected) {
        return Err(
            "请选择其他启动器的 Minecraft 目录，不能导入 Easy Craft 数据目录或其父目录".into(),
        );
    }
    let (root, versions, only) = if selected.join("versions").is_dir() {
        (selected.clone(), selected.join("versions"), None)
    } else if selected
        .file_name()
        .is_some_and(|s| s.eq_ignore_ascii_case("versions"))
    {
        (
            selected.parent().ok_or("目录无效")?.to_path_buf(),
            selected.clone(),
            None,
        )
    } else if selected.parent().is_some_and(|p| {
        p.file_name()
            .is_some_and(|s| s.eq_ignore_ascii_case("versions"))
    }) {
        let versions = selected.parent().unwrap().to_path_buf();
        (
            versions.parent().ok_or("目录无效")?.to_path_buf(),
            versions,
            Some(selected.clone()),
        )
    } else {
        (selected.clone(), selected.clone(), Some(selected.clone()))
    };
    checked_directory(&root)?;
    checked_directory(&versions)?;
    let mut dirs = vec![];
    let mut warnings = vec![];
    // An independent version needs no sibling ID index. Do not enumerate the
    // whole library just because the user selected one concrete version folder.
    let independent_selection = only.as_ref().is_some_and(|directory| {
        json_file(directory)
            .and_then(|file| relative(&root, &file))
            .and_then(|relative| read_json(&root, &relative))
            .is_ok_and(|value| value.get("inheritsFrom").is_none())
    });
    if only.as_ref() == Some(&versions) || independent_selection {
        dirs.push(only.as_ref().unwrap_or(&versions).clone());
    } else {
        for (entry_index, entry) in fs::read_dir(&versions)
            .map_err(|_| "版本目录不可读")?
            .take(257)
            .enumerate()
        {
            checkpoint(cancel)?;
            if entry_index >= 256 {
                warnings.push("仅扫描前 256 个版本目录，请选择更具体的目录。".into());
                break;
            }
            let entry = entry.map_err(|_| "版本目录条目不可读")?;
            if entry.file_type().map_err(|_| "目录类型不可读")?.is_dir() {
                if let Ok(path) = checked_directory(&entry.path()) {
                    dirs.push(path);
                }
            }
        }
    }
    if let Some(chosen) = &only {
        if !dirs.contains(chosen) {
            dirs.push(chosen.clone());
        }
    }
    dirs.sort();
    let mut catalog = HashMap::new();
    let mut ambiguous = HashSet::new();
    for directory in &dirs {
        checkpoint(cancel)?;
        if let Ok(file) = json_file(directory) {
            if let Ok(rel) = relative(&root, &file) {
                if let Ok(v) = read_json(&root, &rel) {
                    if let Some(id) = v["id"].as_str() {
                        if catalog.contains_key(id) {
                            ambiguous.insert(id.to_string());
                        }
                        catalog.insert(id.to_string(), file);
                    }
                }
            }
        }
    }
    catalog.retain(|id, _| !ambiguous.contains(id));
    let mut sources = vec![];
    let mut candidates = vec![];
    let mut inventories = ScanCache::default();
    let selected_dirs = dirs
        .iter()
        .filter(|p| only.as_ref().is_none_or(|selected| *p == selected))
        .count();
    for (index, directory) in dirs
        .iter()
        .filter(|p| only.as_ref().is_none_or(|selected| *p == selected))
        .enumerate()
    {
        checkpoint(cancel)?;
        host.progress(
            "local-scan",
            "只读检查本地版本和游戏内容",
            index,
            selected_dirs,
        );
        match inspect(&root, directory, &catalog, cancel, &mut inventories) {
            Ok(mut source) => {
                source.info.duplicate = is_imported(host, &source.key);
                if source.info.duplicate {
                    source
                        .info
                        .issues
                        .push("此来源已导入，已阻止重复添加。".into());
                }
                candidates.push(source.info.clone());
                sources.push(source);
            }
            Err(error) => candidates.push(Candidate {
                id: uuid::Uuid::new_v4().to_string(),
                name: directory
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .chars()
                    .take(60)
                    .collect(),
                game_version: "未确认".into(),
                loader: "未确认".into(),
                directory: directory.to_string_lossy().into(),
                game_directory: String::new(),
                supported: false,
                duplicate: false,
                files: 0,
                bytes: 0,
                content_indexed: false,
                content_roots: vec![],
                worlds: 0,
                source_isolation: false,
                issues: vec![error],
                warnings: vec![],
            }),
        }
        host.progress("local-scan", "已识别本地版本", index + 1, selected_dirs);
    }
    checkpoint(cancel)?;
    Ok(Scan {
        preview: Preview {
            token: uuid::Uuid::new_v4().to_string(),
            directory: selected.to_string_lossy().into(),
            candidates,
            warnings,
        },
        sources,
        created: Instant::now(),
    })
}
pub fn selections(scan: &Scan, token: &str, selected: &[Selection]) -> Result<()> {
    if scan.preview.token != token
        || scan.created.elapsed().as_secs() > 600
        || selected.is_empty()
        || selected.len() > 32
    {
        return Err("扫描已过期或选择无效，请重新扫描（每次最多 32 个）".into());
    }
    let mut ids = HashSet::new();
    for selection in selected {
        if !ids.insert(&selection.id)
            || selection.name.trim().is_empty()
            || selection.name.chars().count() > 60
            || selection.name.chars().any(char::is_control)
        {
            return Err("导入名称或选择无效".into());
        }
        if !scan.sources.iter().any(|source| {
            source.info.id == selection.id && !source.info.duplicate && source.info.supported
        }) {
            return Err("选择包含不支持或重复的版本".into());
        }
    }
    Ok(())
}
pub struct Ready {
    pub transaction: modpack::Transaction,
    pub instance: Instance,
}
pub async fn prepare(
    host: &Host,
    scan: &Scan,
    selected: &Selection,
    cancel: &CancellationToken,
) -> Result<Ready> {
    checkpoint(cancel)?;
    let source = scan
        .sources
        .iter()
        .find(|s| s.info.id == selected.id)
        .ok_or("本地版本选择已失效")?;
    if is_imported(host, &source.key) {
        return Err("此本地版本已经导入".into());
    }
    if selected.mode == ImportMode::Reference {
        return reference(host, source, selected, cancel);
    }
    if ["forge", "neoforge"].contains(&source.loader.as_str()) {
        return Err("Forge/NeoForge 请选择直接添加已有版本；独立副本安装处理器尚未接入。".into());
    }
    validate_source(source, cancel)?;
    host.progress("local-index", "确认导入：检查选定版本的游戏内容", 0, 0);
    let files = inventory_progress(&source.game, cancel, Some(host))?;
    host.progress("local-verify", "核对官方版本，复用已校验本地资源", 0, 1);
    let entry = crate::minecraft::version_catalog(host, cancel)
        .await?
        .into_iter()
        .find(|v| {
            v.id == source.info.game_version && ["release", "snapshot"].contains(&v.kind.as_str())
        })
        .ok_or("此基础版本不在受支持的官方版本清单中")?;
    let artifact = net::Artifact {
        url: entry.url.clone(),
        sha1: entry.sha1.clone(),
        size: None,
        path: format!("versions/{}/{}.json", entry.id, entry.sha1),
    };
    net::reuse_local(
        &host.root,
        &artifact,
        &source.root,
        &source.base_json,
        cancel,
    )?;
    let path = net::download(&host.client, &host.root, &artifact, cancel).await?;
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "官方元数据读取失败")?)
        .map_err(|_| "官方元数据无效")?;
    let client = &value["downloads"]["client"];
    net::reuse_local(
        &host.root,
        &net::Artifact {
            url: client["url"].as_str().ok_or("官方客户端地址缺失")?.into(),
            sha1: client["sha1"]
                .as_str()
                .ok_or("官方客户端校验值缺失")?
                .into(),
            size: client["size"].as_u64(),
            path: format!("versions/{}/client.jar", entry.id),
        },
        &source.root,
        &source.base_jar,
        cancel,
    )?;
    let prepared =
        crate::minecraft::prepare_with_sources(host, &entry, cancel, &source.roots).await?;
    let fabric_sha1 = if source.fabric.is_empty() {
        String::new()
    } else {
        crate::fabric::install_with_sources(host, &entry.id, &source.fabric, cancel, &source.roots)
            .await?
    };
    let instance = Instance {
        local: None,
        id: uuid::Uuid::new_v4().to_string(),
        name: unique_name(&selected.name, &host.status().instances),
        version: entry.id,
        manifest_sha1: entry.sha1,
        java_major: prepared.java_major,
        fabric_version: source.fabric.clone(),
        fabric_sha1,
        launch: Default::default(),
    };
    let mut transaction = modpack::begin_instance(
        &host.root,
        &uuid::Uuid::new_v4().to_string(),
        instance.clone(),
    )?;
    let result = (|| -> Result<()> {
        for (index, file) in files.iter().enumerate() {
            checkpoint(cancel)?;
            host.progress(
                "local-copy",
                &format!("复制 {}", file.path),
                index,
                files.len(),
            );
            if snapshot(&source.game, &file.path, cancel, false)? != *file {
                return Err("游戏文件在预览后发生变化，请重新扫描".into());
            }
            let mut guard =
                crate::file_guard::Guard::open(&source.game, &file.path, file.size, false)?;
            let hash = crate::file_guard::digest(&mut guard.file, cancel)?;
            use std::io::Seek;
            guard
                .file
                .rewind()
                .map_err(|_| "无法重读已锁定的游戏文件")?;
            modpack::copy(
                &host.root,
                &mut transaction,
                &format!("game/{}", file.path),
                guard.file,
                Some((file.size, &hash)),
                cancel,
            )?;
            host.progress("local-copy", "已复制游戏文件", index + 1, files.len());
        }
        let provenance = serde_json::to_vec(&json!({"sourceKey":source.key,"gameVersion":instance.version,"loader":source.info.loader,"files":files.len()})).map_err(|_| "来源记录无效")?;
        modpack::copy(
            &host.root,
            &mut transaction,
            "game/.easycraft-local-import.json",
            provenance.as_slice(),
            None,
            cancel,
        )?;
        validate_source(source, cancel)?;
        if inventory_progress(&source.game, cancel, Some(host))? != files {
            return Err("游戏内容在确认导入后发生变化，请重新扫描".into());
        }
        checkpoint(cancel)
    })();
    if let Err(error) = result {
        return Err(match modpack::rollback(&host.root, &transaction) {
            Ok(()) => error,
            Err(cleanup) => format!("{error}；回滚保留供检查：{cleanup}"),
        });
    }
    Ok(Ready {
        transaction,
        instance,
    })
}
fn reference(
    host: &Host,
    source: &Source,
    selected: &Selection,
    cancel: &CancellationToken,
) -> Result<Ready> {
    checkpoint(cancel)?;
    checked_directory(&source.root)?;
    for file in &source.metadata {
        if snapshot(&source.root, &file.path, cancel, !file.hash.is_empty())? != *file {
            return Err("本地版本元数据已变化，请重新扫描".into());
        }
    }
    let bytes = serde_json::to_vec(&source.profile).map_err(|_| "本地启动配置无效")?;
    use sha1::Digest as _;
    let sha = sha1::Sha1::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let relative_directory = if Path::new(&source.info.directory) == source.root {
        String::new()
    } else {
        relative(&source.root, Path::new(&source.info.directory))?
    };
    let game_directory = if source.game == source.root {
        String::new()
    } else {
        relative(&source.root, &source.game)?
    };
    let instance = Instance {
        id: uuid::Uuid::new_v4().to_string(),
        name: unique_name(&selected.name, &host.status().instances),
        version: source.info.game_version.clone(),
        manifest_sha1: sha.clone(),
        java_major: source.profile["javaVersion"]["majorVersion"]
            .as_u64()
            .unwrap_or(8) as u32,
        fabric_version: source.fabric.clone(),
        fabric_sha1: if source.fabric.is_empty() {
            String::new()
        } else {
            sha
        },
        launch: Default::default(),
        local: Some(model::LocalInstallation {
            root: source.root.to_string_lossy().into(),
            version_directory: relative_directory,
            game_directory,
            client_jar: source.base_jar.clone(),
            source_key: source.key.clone(),
            loader: source.loader.clone(),
            loader_version: source.loader_version.clone(),
        }),
    };
    instance.local.as_ref().unwrap().validate()?;
    host.progress(
        "local-reference",
        "登记已有版本，复用原目录；不复制存档或联网",
        0,
        1,
    );
    let mut transaction = modpack::begin_instance(
        &host.root,
        &uuid::Uuid::new_v4().to_string(),
        instance.clone(),
    )?;
    if let Err(error) = modpack::copy(
        &host.root,
        &mut transaction,
        "local-profile.json",
        bytes.as_slice(),
        None,
        cancel,
    ) {
        let cleanup = modpack::rollback(&host.root, &transaction);
        return Err(match cleanup {
            Ok(()) => error,
            Err(e) => format!("{error}；清理失败：{e}"),
        });
    }
    host.progress("local-reference", "本地版本引用已登记", 1, 1);
    Ok(Ready {
        transaction,
        instance,
    })
}
fn validate_source(source: &Source, cancel: &CancellationToken) -> Result<()> {
    checked_directory(&source.root)?;
    checked_directory(&source.game)?;
    for file in &source.metadata {
        if snapshot(&source.root, &file.path, cancel, !file.hash.is_empty())? != *file {
            return Err("版本元数据或 JAR 已变化，请重新扫描".into());
        }
    }
    if discover_content(&source.game, cancel)? != *source.content {
        return Err("游戏内容在预览后发生变化，请重新扫描".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    #[test]
    fn jar_directory_seeks_remain_buffered_and_preserve_zip_contents() {
        use std::{cell::Cell, io::Cursor, rc::Rc};
        struct Counted {
            cursor: Cursor<Vec<u8>>,
            calls: Rc<Cell<usize>>,
        }
        impl Read for Counted {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                self.calls.set(self.calls.get() + 1);
                self.cursor.read(bytes)
            }
        }
        impl Seek for Counted {
            fn seek(&mut self, target: SeekFrom) -> io::Result<u64> {
                self.calls.set(self.calls.get() + 1);
                self.cursor.seek(target)
            }
        }
        let mut writer = zip::ZipWriter::new(Cursor::new(vec![]));
        for i in 0..1024 {
            writer
                .start_file(
                    format!("classes/{i}.class"),
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            writer
                .write_all(b"synthetic ZIP regression payload")
                .unwrap();
        }
        let bytes = writer.finish().unwrap().into_inner();
        let calls = Rc::new(Cell::new(0));
        let mut zip = zip::ZipArchive::new(
            JarReader::new(Counted {
                cursor: Cursor::new(bytes),
                calls: calls.clone(),
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(zip.len(), 1024);
        let mut content = String::new();
        zip.by_name("classes/999.class")
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "synthetic ZIP regression payload");
        assert!(
            calls.get() < 512,
            "Central directory must not issue OS reads/seeks for each entry: {}",
            calls.get()
        );
        let mut reader = JarReader::new(Cursor::new(b"abcdef".to_vec())).unwrap();
        assert_eq!(reader.seek(SeekFrom::Start(4)).unwrap(), 4);
        assert_eq!(reader.seek(SeekFrom::Current(-2)).unwrap(), 2);
        assert_eq!(reader.seek(SeekFrom::End(-1)).unwrap(), 5);
        assert!(reader.seek(SeekFrom::Current(-6)).is_err());
        assert_eq!(reader.stream_position().unwrap(), 5);
        let mut byte = [0];
        reader.read_exact(&mut byte).unwrap();
        assert_eq!(byte, [b'f']);
    }
    #[tokio::test]
    #[ignore = "Explicit real-installation reference import and launch preparation; never starts Minecraft"]
    async fn real_local_references_prepare_vanilla_forge_and_neoforge_without_copying_worlds() {
        let source = PathBuf::from(
            std::env::var("EASYCRAFT_READONLY_SCAN_ROOT").expect("explicit source required"),
        );
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let data = project
            .join(".native/local-reference")
            .join(uuid::Uuid::new_v4().to_string());
        let host = Host::new(data.clone()).unwrap();
        let scanned = Instant::now();
        let scan = scan(&host, &source, &CancellationToken::new()).unwrap();
        let scan_ms = scanned.elapsed().as_millis();
        let mut instances = vec![];
        let mut reports = vec![];
        for name in [
            "1.16.5",
            "1.16.5-forge-36.2.34",
            "1.20.1-forge-47.2.0",
            "neoforge-21.1.139",
        ] {
            let candidate = scan
                .preview
                .candidates
                .iter()
                .find(|v| v.name == name)
                .unwrap();
            assert!(candidate.supported, "{}: {:?}", name, candidate.issues);
            let direct_started = Instant::now();
            let targeted = super::scan(
                &host,
                Path::new(&candidate.directory),
                &CancellationToken::new(),
            )
            .unwrap();
            assert_eq!(targeted.preview.candidates.len(), 1);
            let direct_scan_ms = direct_started.elapsed().as_millis();
            let candidate = &targeted.preview.candidates[0];
            assert!(candidate.supported, "{}: {:?}", name, candidate.issues);
            let started = Instant::now();
            let ready = prepare(
                &host,
                &targeted,
                &Selection {
                    id: candidate.id.clone(),
                    name: name.into(),
                    mode: ImportMode::Reference,
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap();
            instances = modpack::publish(
                &host.root,
                &ready.transaction,
                &instances,
                &CancellationToken::new(),
            )
            .unwrap();
            let registered_ms = started.elapsed().as_millis();
            let prepared =
                crate::local_launch::prepare(&host, &ready.instance, &CancellationToken::new())
                    .unwrap();
            crate::minecraft::extract_natives(
                &prepared.native_archives,
                &host.root,
                &format!("instances/{}/natives", ready.instance.id),
            )
            .unwrap();
            let settings = model::Settings {
                launch_mode: model::LaunchMode::Offline,
                offline_name: "LaunchTest".into(),
                ..Default::default()
            };
            let args = crate::minecraft::command_args(
                &host,
                &ready.instance,
                &prepared,
                &model::offline_profile("LaunchTest").unwrap(),
                "0",
                &settings,
            )
            .unwrap();
            assert!(args.iter().all(|v| !v.contains("${")));
            let (command, _file) =
                crate::local_launch::command_arguments(&host.root, &ready.instance, &args).unwrap();
            if ready.instance.java_major >= 9
                && args.iter().map(|v| v.len() + 3).sum::<usize>() >= 12000
            {
                assert!(command[0].starts_with('@'));
            }
            if ready.instance.java_major == 8 {
                assert!(!command[0].starts_with('@'));
                let java = crate::local_launch::java_for(
                    &ready.instance,
                    &host.status().settings.java_path,
                    &host.root,
                )
                .await
                .unwrap();
                assert_eq!(java.major, 8);
            }
            if ready.instance.local.as_ref().unwrap().loader == "neoforge" {
                let java = crate::local_launch::java_for(
                    &ready.instance,
                    &host.status().settings.java_path,
                    &host.root,
                )
                .await
                .unwrap();
                let output = tokio::process::Command::new(java.path)
                    .arg(&command[0])
                    .args(["--describe-module", "cpw.mods.bootstraplauncher"])
                    .creation_flags(0x08000000)
                    .output()
                    .await
                    .unwrap();
                assert!(
                    output.status.success(),
                    "JVM argument-file/module-path validation failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                assert!(
                    String::from_utf8_lossy(&output.stdout).contains("cpw.mods.bootstraplauncher")
                );
            }
            assert!(prepared.classpath.iter().all(|v| v.is_file()));
            assert_eq!(
                args.windows(2).find(|v| v[0] == "--gameDir").unwrap()[1],
                ready
                    .instance
                    .game_path(&host.root)
                    .unwrap()
                    .to_string_lossy()
            );
            reports.push(json!({"name":name,"singleVersionScanMs":direct_scan_ms,"registeredMs":registered_ms,"totalPrepareMs":started.elapsed().as_millis(),"loader":ready.instance.local.as_ref().unwrap().loader,"javaMajor":ready.instance.java_major,"mainClass":prepared.metadata["mainClass"],"classpath":prepared.classpath.len(),"natives":prepared.native_archives.len(),"argumentCharacters":args.iter().map(|v|v.len()+3).sum::<usize>()}));
        }
        let output = project.join("output/playwright/local-reference");
        fs::create_dir_all(&output).unwrap();
        fs::write(output.join("real-preparation.json"),serde_json::to_vec_pretty(&json!({"source":source,"data":data,"scanMs":scan_ms,"reports":reports,"minecraftStarted":false})).unwrap()).unwrap();
        println!(
            "Reference preparation: {}",
            serde_json::to_string_pretty(&reports).unwrap()
        );
        drop(host);
        let reloaded = Host::new(data).unwrap();
        assert_eq!(reloaded.status().instances.len(), 4);
    }
    #[tokio::test]
    async fn adding_an_existing_version_does_not_walk_or_copy_world_contents() {
        let (temp, host, source) = fixture();
        let mut deep = source.join("saves/World");
        for _ in 0..26 {
            deep = deep.join("nested");
        }
        fs::create_dir_all(&deep).unwrap();
        fs::write(
            deep.join("keep.dat"),
            b"source world is not part of registration",
        )
        .unwrap();
        let scan = scan(&host, &source, &CancellationToken::new()).unwrap();
        let selection = Selection {
            id: scan.preview.candidates[0].id.clone(),
            name: "Fast local reference".into(),
            mode: ImportMode::Reference,
        };
        let ready = prepare(&host, &scan, &selection, &CancellationToken::new())
            .await
            .unwrap_or_else(|error| {
                panic!("adding an existing installation must not fail on world size/depth: {error}")
            });
        assert!(ready.instance.local.is_some());
        assert_eq!(ready.instance.game_path(&host.root).unwrap(), source);
        let directory = host.root.join(format!("instances/{}", ready.instance.id));
        assert_eq!(fs::read_dir(directory).unwrap().count(), 1);
        assert_eq!(
            fs::read(deep.join("keep.dat")).unwrap(),
            b"source world is not part of registration"
        );
        let mut isolated = ready.instance.clone();
        isolated.launch.game_isolation = Some(true);
        assert_eq!(
            isolated.game_path(&host.root).unwrap(),
            source.join(&isolated.local.as_ref().unwrap().version_directory)
        );
        assert!(!ready.instance.isolated());
        assert!(isolated.isolated());
        drop(host);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn scan_discovers_versions_without_recursing_through_world_and_mod_files() {
        let (temp, host, source) = fixture();
        let world = source.join("saves/World/region");
        fs::create_dir_all(&world).unwrap();
        fs::write(world.parent().unwrap().join("level.dat"), b"marker only").unwrap();
        let file = fs::File::create(world.join("large.mca")).unwrap();
        file.set_len(crate::file_picker::MAX_FILE + 1).unwrap();
        drop(file);
        let scan = host.scan_local(&source).unwrap();
        assert!(
            scan.candidates.iter().all(|v| v.supported),
            "version discovery must not recursively index world files: {:?}",
            scan.candidates
                .iter()
                .map(|v| &v.issues)
                .collect::<Vec<_>>()
        );
        assert!(scan.candidates.iter().all(|v| v.worlds == 1));
        assert!(inventory(&source, &CancellationToken::new())
            .unwrap_err()
            .contains("512 MiB"));
        drop(host);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn completed_scan_explains_that_candidates_are_not_yet_imported() {
        let (temp, host, source) = fixture();
        let preview = host.scan_local(&source).unwrap();
        assert_eq!(preview.candidates.len(), 2);
        assert!(host.status().instances.is_empty());
        let task = host.status().task;
        assert!(
            task.message.contains("尚未导入"),
            "misleading scan result: {}",
            task.message
        );
        assert!(
            !task.logs.is_empty(),
            "scan must preserve its result in the task log"
        );
        drop(host);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    #[ignore = "Explicit read-only diagnosis of a user-selected Minecraft directory; never imports or launches games"]
    fn local_directory_scan_diagnostics() {
        let source = PathBuf::from(
            std::env::var("EASYCRAFT_READONLY_SCAN_ROOT").expect("explicit source path required"),
        );
        let data = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".native/scan-diagnostics")
            .join(uuid::Uuid::new_v4().to_string());
        let host = Host::new(data).unwrap();
        let started = Instant::now();
        let result = host.scan_local(&source);
        let record = match result {
            Ok(preview) => {
                json!({"elapsedMs":started.elapsed().as_millis(),"preview":preview,"task":host.status().task,"instances":host.status().instances.len()})
            }
            Err(error) => {
                json!({"elapsedMs":started.elapsed().as_millis(),"error":error,"task":host.status().task})
            }
        };
        let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("output/playwright/local-scan/user-diagnostic.json");
        fs::create_dir_all(output.parent().unwrap()).unwrap();
        fs::write(&output, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
        println!("Read-only diagnostic: {}", output.display());
        assert!(host.status().instances.is_empty());
    }
    #[test]
    #[ignore = "Synthetic scan performance fixture; no Minecraft or network is started"]
    fn local_scan_performance_benchmark() {
        let (temp, host, source) = fixture();
        let payload = vec![0x5au8; 128 * 1024];
        for index in 0..800 {
            fs::write(
                source.join(format!("config/content-{index:04}.bin")),
                &payload,
            )
            .unwrap();
        }
        for index in 0..8 {
            let path = source.join(format!("versions/FabricExtra{index}"));
            fs::create_dir_all(&path).unwrap();
            fs::copy(
                source.join("versions/FabricFriendly/FabricFriendly.json"),
                path.join(format!("FabricExtra{index}.json")),
            )
            .unwrap();
        }
        let started = Instant::now();
        let report = host.scan_local(&source).unwrap();
        let elapsed = started.elapsed().as_millis();
        assert_eq!(report.candidates.iter().filter(|v| v.supported).count(), 10);
        let record = json!({"elapsedMs":elapsed,"versions":report.candidates.len(),"filesPerVersion":report.candidates[0].files,"bytesPerVersion":report.candidates[0].bytes,"fixture":"synthetic 100 MiB common content, ten version configurations"});
        println!("{record}");
        let label = std::env::var("EASYCRAFT_SCAN_BENCH_LABEL").unwrap_or_else(|_| "sample".into());
        assert!(label.chars().all(|v| v.is_ascii_alphanumeric() || v == '-'));
        let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("output/playwright/local-scan");
        fs::create_dir_all(&output).unwrap();
        fs::write(
            output.join(format!("{label}.json")),
            serde_json::to_vec_pretty(&record).unwrap(),
        )
        .unwrap();
        drop(host);
        fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn preview_indexes_game_content_without_hashing_it_and_distinguishes_world_directories() {
        let (temp, host, source) = fixture();
        let report = scan(&host, &source, &CancellationToken::new()).unwrap();
        assert!(
            report
                .sources
                .iter()
                .all(|v| !v.info.content_indexed && v.info.files == 0),
            "preview must not recursively index game content files"
        );
        let world = source.join("saves/任意存档名称");
        fs::create_dir_all(&world).unwrap();
        fs::write(world.join("level.dat"), b"inert world marker").unwrap();
        fs::create_dir_all(source.join("versions/FabricFriendly/mods")).unwrap();
        let report = scan(&host, &source, &CancellationToken::new()).unwrap();
        assert_eq!(report.sources.len(), 2);
        assert!(Arc::ptr_eq(
            &report.sources[0].content,
            &report.sources[1].content
        ));
        assert!(report
            .sources
            .iter()
            .all(|s| !s.info.source_isolation && s.info.worlds == 1));
        assert!(scan(&host, &world, &CancellationToken::new())
            .err()
            .unwrap()
            .contains("存档"));
        drop(host);
        fs::remove_dir_all(temp).unwrap();
    }
    #[tokio::test]
    #[ignore = "Requires the native local-import harness output; prepares commands only, never launches Minecraft"]
    async fn imported_local_versions_prepare_cached_launch_without_starting_game() {
        let data = std::env::var("EASYCRAFT_IMPORT_TEST_DATA").unwrap();
        assert!(data.replace('\\', "/").contains("/.native/local-import/"));
        let host = Host::new(PathBuf::from(data)).unwrap();
        if let Ok(source) = std::env::var("EASYCRAFT_SCAN_SOURCE") {
            assert!(source
                .replace('\\', "/")
                .contains("/.native/fixtures/local-import/"));
            let started = Instant::now();
            let scan = host.scan_local(Path::new(&source)).unwrap();
            let record = json!({"elapsedMs":started.elapsed().as_millis(),"source":source,"candidates":scan.candidates.len(),"supported":scan.candidates.iter().filter(|c|c.supported).count(),"description":"Real 1.21.1 vanilla and Fabric 0.16.14 layouts plus synthetic Forge/corrupt candidates; warm local file cache; no Minecraft launched"});
            let output = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("output/playwright/local-scan/real-source.json");
            fs::create_dir_all(output.parent().unwrap()).unwrap();
            fs::write(output, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
            println!("Real-source scan: {record}");
        }
        let instances = host.status().instances;
        assert_eq!(instances.len(), 2);
        for instance in instances {
            let entry = model::Version {
                id: instance.version.clone(),
                sha1: instance.manifest_sha1.clone(),
                url: format!(
                    "https://piston-meta.mojang.com/v1/packages/{}/{}.json",
                    instance.manifest_sha1, instance.version
                ),
                kind: "release".into(),
                release_time: String::new(),
            };
            let mut prepared = crate::minecraft::prepare(&host, &entry, &CancellationToken::new())
                .await
                .unwrap();
            if !instance.fabric_version.is_empty() {
                crate::fabric::prepare(&host, &instance, &mut prepared, &CancellationToken::new())
                    .await
                    .unwrap();
            }
            assert!(prepared.classpath.iter().all(|p| p.is_file()));
            crate::minecraft::extract_natives(
                &prepared.native_archives,
                &host.root,
                &format!("instances/{}/natives", instance.id),
            )
            .unwrap();
            let settings = model::Settings {
                launch_mode: model::LaunchMode::Offline,
                offline_name: "ImportTest".into(),
                ..Default::default()
            };
            let args = crate::minecraft::command_args(
                &host,
                &instance,
                &prepared,
                &model::offline_profile("ImportTest").unwrap(),
                "0",
                &settings,
            )
            .unwrap();
            let directory = args.windows(2).find(|v| v[0] == "--gameDir").unwrap();
            assert_eq!(
                directory[1],
                instance.game_path(&host.root).unwrap().to_string_lossy()
            );
            let mut shared = instance.clone();
            shared.launch.game_isolation = Some(false);
            let shared_args = crate::minecraft::command_args(
                &host,
                &shared,
                &prepared,
                &model::offline_profile("ImportTest").unwrap(),
                "0",
                &settings,
            )
            .unwrap();
            assert_eq!(
                shared_args
                    .windows(2)
                    .find(|v| v[0] == "--gameDir")
                    .unwrap()[1],
                host.root.join("shared-game").to_string_lossy()
            );
            assert!(args.iter().any(|v| v
                == if instance.fabric_version.is_empty() {
                    "net.minecraft.client.main.Main"
                } else {
                    "net.fabricmc.loader.impl.launch.knot.KnotClient"
                }));
            println!(
                "Prepared {}: {} classpath entries; Minecraft was not started",
                instance.name,
                prepared.classpath.len()
            );
            assert_eq!(
                unique_name(&instance.name, &host.status().instances),
                format!("{} (2)", instance.name)
            );
        }
    }
    fn fixture() -> (PathBuf, std::sync::Arc<Host>, PathBuf) {
        let temp = std::env::temp_dir().join(format!("easycraft-local-{}", uuid::Uuid::new_v4()));
        let source = temp.join("source");
        fs::create_dir_all(source.join("versions/FriendlyName")).unwrap();
        let version = json!({"id":"1.21.1","mainClass":"net.minecraft.client.main.Main","libraries":[],"arguments":{"game":[],"jvm":[]},"javaVersion":{"majorVersion":21}});
        fs::write(
            source.join("versions/FriendlyName/custom.json"),
            serde_json::to_vec(&version).unwrap(),
        )
        .unwrap();
        let mut jar = zip::ZipWriter::new(
            fs::File::create(source.join("versions/FriendlyName/custom.jar")).unwrap(),
        );
        jar.start_file("version.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        jar.write_all(br#"{"id":"1.21.1"}"#).unwrap();
        jar.finish().unwrap();
        fs::create_dir_all(source.join("versions/FabricFriendly")).unwrap();
        fs::write(source.join("versions/FabricFriendly/FabricFriendly.json"), serde_json::to_vec(&json!({"id":"renamed-fabric","inheritsFrom":"1.21.1","mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":"net.fabricmc:fabric-loader:0.16.14"}]})).unwrap()).unwrap();
        fs::create_dir_all(source.join("config")).unwrap();
        fs::write(source.join("config/test.json"), b"game config").unwrap();
        fs::write(source.join("options.txt"), b"music:0.5").unwrap();
        fs::write(source.join("launcher_accounts.json"), b"DO NOT IMPORT").unwrap();
        let host = Host::new(temp.join("host")).unwrap();
        (temp, host, source)
    }
    #[test]
    fn local_scanning_merges_roots_versions_and_specific_directory_without_reading_accounts() {
        let (temp, host, source) = fixture();
        let cancel = CancellationToken::new();
        let full = scan(&host, &source, &cancel).unwrap();
        assert_eq!(full.preview.candidates.len(), 2);
        assert!(full
            .preview
            .candidates
            .iter()
            .all(|v| v.supported && v.game_version == "1.21.1"));
        assert!(full.sources.iter().all(|s| s.content.entries.len() == 2
            && s.content
                .entries
                .iter()
                .all(|f| !f.path.contains("account"))));
        let versions = scan(&host, &source.join("versions"), &cancel).unwrap();
        let specific = scan(&host, &source.join("versions/FabricFriendly"), &cancel).unwrap();
        assert_eq!(specific.sources.len(), 1);
        assert_eq!(
            specific.sources[0].key,
            versions
                .sources
                .iter()
                .find(|s| !s.fabric.is_empty())
                .unwrap()
                .key
        );
        assert_eq!(
            fs::read(source.join("launcher_accounts.json")).unwrap(),
            b"DO NOT IMPORT"
        );
        assert!(host.status().instances.is_empty());
        drop(host);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn ambiguous_inheritance_is_not_guessed_and_explicit_selection_survives_scan_limit() {
        let (temp, host, source) = fixture();
        let cancel = CancellationToken::new();
        fs::create_dir_all(source.join("versions/SecondBase")).unwrap();
        fs::copy(
            source.join("versions/FriendlyName/custom.json"),
            source.join("versions/SecondBase/other.json"),
        )
        .unwrap();
        fs::copy(
            source.join("versions/FriendlyName/custom.jar"),
            source.join("versions/SecondBase/other.jar"),
        )
        .unwrap();
        let plan = scan(&host, &source, &cancel).unwrap();
        assert!(
            !plan
                .preview
                .candidates
                .iter()
                .find(|v| v.name == "FabricFriendly")
                .unwrap()
                .supported
        );
        for index in 0..300 {
            fs::create_dir_all(source.join(format!("versions/000-{index:03}"))).unwrap();
        }
        let explicit = scan(&host, &source.join("versions/FriendlyName"), &cancel).unwrap();
        assert_eq!(explicit.preview.candidates.len(), 1);
        assert!(explicit.preview.candidates[0].supported);
        drop(host);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn unsupported_corrupt_missing_stale_cancelled_and_oversized_local_sources_are_rejected() {
        let (temp, host, source) = fixture();
        let cancel = CancellationToken::new();
        let initial = scan(&host, &source, &cancel).unwrap();
        fs::write(source.join("options.txt"), b"changed").unwrap();
        assert!(validate_source(&initial.sources[0], &cancel).is_err());
        let huge = fs::File::create(source.join("config/oversized.bin")).unwrap();
        huge.set_len(crate::file_picker::MAX_FILE + 1).unwrap();
        drop(huge);
        assert!(inventory(&source, &cancel).unwrap_err().contains("512 MiB"));
        fs::remove_file(source.join("config/oversized.bin")).unwrap();
        fs::create_dir_all(source.join("versions/Forge")).unwrap();
        fs::write(
            source.join("versions/Forge/Forge.json"),
            br#"{"id":"forge","mainClass":"cpw.mods.modlauncher.Launcher","libraries":[]}"#,
        )
        .unwrap();
        fs::create_dir_all(source.join("versions/Broken")).unwrap();
        fs::write(source.join("versions/Broken/Broken.json"), b"bad json").unwrap();
        let report = scan(&host, &source, &cancel).unwrap();
        assert!(report
            .preview
            .candidates
            .iter()
            .any(|v| v.name == "Forge" && !v.supported));
        assert!(report
            .preview
            .candidates
            .iter()
            .any(|v| v.name == "Broken" && !v.supported));
        fs::write(
            source.join("versions/FriendlyName/custom.jar"),
            b"broken jar",
        )
        .unwrap();
        assert!(
            !scan(&host, &source.join("versions/FriendlyName"), &cancel)
                .unwrap()
                .preview
                .candidates[0]
                .supported
        );
        fs::remove_file(source.join("versions/FriendlyName/custom.jar")).unwrap();
        let missing = scan(&host, &source.join("versions/FriendlyName"), &cancel).unwrap();
        assert!(!missing.preview.candidates[0].supported);
        assert!(missing.preview.candidates[0].issues[0].contains("缺失"));
        cancel.cancel();
        assert!(scan(&host, &source, &cancel).is_err());
        assert!(host.status().instances.is_empty());
        drop(host);
        fs::remove_dir_all(temp).unwrap();
    }
    #[test]
    fn frozen_content_copies_with_transaction_rollback_and_duplicate_detection() {
        let (temp, host, source) = fixture();
        let cancel = CancellationToken::new();
        let plan = scan(&host, &source, &cancel).unwrap();
        let selected = &plan.sources[0];
        let instance = Instance {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Copied".into(),
            version: "1.21.1".into(),
            manifest_sha1: "a".repeat(40),
            java_major: 21,
            fabric_version: String::new(),
            fabric_sha1: String::new(),
            launch: Default::default(),
            local: None,
        };
        let mut tx = modpack::begin_instance(
            &host.root,
            &uuid::Uuid::new_v4().to_string(),
            instance.clone(),
        )
        .unwrap();
        let provenance = serde_json::to_vec(&json!({"sourceKey":selected.key})).unwrap();
        modpack::copy(
            &host.root,
            &mut tx,
            "game/.easycraft-local-import.json",
            provenance.as_slice(),
            None,
            &cancel,
        )
        .unwrap();
        let updated = modpack::publish(&host.root, &tx, &[], &cancel).unwrap();
        assert_eq!(updated.len(), 1);
        assert_eq!(unique_name("Copied", &updated), "Copied (2)");
        let mut rollback = modpack::begin_instance(
            &host.root,
            &uuid::Uuid::new_v4().to_string(),
            Instance {
                id: uuid::Uuid::new_v4().to_string(),
                ..instance
            },
        )
        .unwrap();
        modpack::copy(
            &host.root,
            &mut rollback,
            "game/test.txt",
            b"partial".as_slice(),
            None,
            &cancel,
        )
        .unwrap();
        modpack::rollback(&host.root, &rollback).unwrap();
        let root = host.root.clone();
        drop(host);
        let host = Host::new(root).unwrap();
        let duplicate = scan(&host, &source, &cancel).unwrap();
        assert!(duplicate.preview.candidates.iter().any(|v| v.duplicate));
        let selection = Selection {
            id: selected.info.id.clone(),
            name: "Copy".into(),
            mode: ImportMode::Copy,
        };
        assert!(selections(&plan, "foreign-token", &[selection]).is_err());
        drop(host);
        fs::remove_dir_all(temp).unwrap();
    }
}
