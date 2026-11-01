//! Read-only installed-Mod analysis. Cache declarations, never entire archives or game files.
use crate::{
    model::{self, Instance, Result},
    resource_install::{self, ModCheck, ModMetadata},
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader, Read, Seek},
    os::windows::fs::MetadataExt,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub checked_at: u64,
    pub scope: String,
    pub complete: bool,
    pub scanned_files: usize,
    pub parsed_files: usize,
    pub reused_files: usize,
    pub elapsed_ms: u64,
}
#[derive(Clone, PartialEq)]
struct Stamp {
    size: u64,
    modified: u64,
    created: u64,
}
fn stamp(path: &Path) -> Result<Stamp> {
    let info = fs::symlink_metadata(path).map_err(|_| "文件不可读或已经移除")?;
    if !info.is_file() || info.file_attributes() & 0x400 != 0 {
        return Err("不是普通文件或包含重解析链接".into());
    }
    if info.len() > 512 * 1024 * 1024 {
        return Err("JAR 超过 512 MiB 检查上限".into());
    }
    Ok(Stamp {
        size: info.len(),
        modified: info.last_write_time(),
        created: info.creation_time(),
    })
}
#[derive(Clone)]
enum Parsed {
    Fabric(Vec<ModMetadata>),
    Forge(ForgeFile),
}
struct Cached {
    stamp: Stamp,
    result: Result<Parsed>,
    touched: u64,
    bytes: usize,
}
struct LoaderLock {
    profile: Stamp,
    archive: PathBuf,
    stamp: Stamp,
}
struct CachedReport {
    signature: Vec<(PathBuf, Result<Stamp>)>,
    report: ModCheck,
    touched: u64,
}
#[derive(Default)]
pub struct Cache {
    files: BTreeMap<(PathBuf, String), Cached>,
    reports: BTreeMap<String, CachedReport>,
    loaders: BTreeMap<String, LoaderLock>,
    tick: u64,
    bytes: usize,
}
impl Cache {
    fn loader(
        &mut self,
        cache: &Path,
        instance: &Instance,
        force: bool,
    ) -> Result<Option<PathBuf>> {
        if instance.fabric_version.is_empty() {
            return Ok(None);
        }
        let profile = model::safe_path(
            cache,
            &format!("loaders/fabric/{}.json", instance.fabric_sha1),
        )?;
        let before = stamp(&profile)?;
        let key = format!(
            "{}:{}:{}:{}",
            cache.display(),
            instance.version,
            instance.fabric_version,
            instance.fabric_sha1
        );
        if !force {
            if let Some(entry) = self.loaders.get(&key) {
                if entry.profile == before
                    && stamp(&entry.archive).ok() == Some(entry.stamp.clone())
                {
                    return Ok(Some(entry.archive.clone()));
                }
            }
        }
        let archive = crate::fabric::loader_archive(cache, instance)?;
        if let Some(path) = &archive {
            if self.loaders.len() >= 16 {
                self.loaders.clear();
            }
            self.loaders.insert(
                key,
                LoaderLock {
                    profile: before,
                    archive: path.clone(),
                    stamp: stamp(path)?,
                },
            );
        }
        Ok(archive)
    }
    fn read(
        &mut self,
        path: &Path,
        loader: &str,
        force: bool,
        stats: &mut Details,
    ) -> Result<Parsed> {
        stats.scanned_files += 1;
        self.tick += 1;
        let before = stamp(path)?;
        let key = (path.to_path_buf(), loader.into());
        if !force {
            if let Some(entry) = self
                .files
                .get_mut(&key)
                .filter(|entry| entry.stamp == before)
            {
                stats.reused_files += 1;
                entry.touched = self.tick;
                return entry.result.clone();
            }
        }
        stats.parsed_files += 1;
        let result: Result<Parsed> = (|| {
            let input = fs::File::open(path).map_err(|_| "无法打开 JAR")?;
            if loader == "fabric" {
                let mut values = vec![];
                resource_install::mod_metadata(input, &mut values, 0, &mut 0)?;
                Ok(Parsed::Fabric(values))
            } else {
                let mut value = ForgeFile::default();
                read_forge(input, loader, &mut value, 0, &mut 0)?;
                Ok(Parsed::Forge(value))
            }
        })();
        if stamp(path)? != before {
            return Err("读取期间文件发生变化，请重新检查".into());
        }
        let bytes = match &result {
            Ok(Parsed::Fabric(values)) => values
                .iter()
                .map(|value| value.value.to_string().len())
                .sum(),
            Ok(Parsed::Forge(value)) => serde_json::to_vec(value)
                .map_err(|_| "元数据大小计算失败")?
                .len(),
            Err(message) => message.len(),
        };
        if let Some(old) = self.files.remove(&key) {
            self.bytes -= old.bytes;
        }
        // Bounded metadata-only LRU. Oversized declarations are usable once but not retained.
        if bytes <= 16 * 1024 * 1024 {
            while self.files.len() >= 1024 || self.bytes + bytes > 16 * 1024 * 1024 {
                let Some(oldest) = self
                    .files
                    .iter()
                    .min_by_key(|(_, entry)| entry.touched)
                    .map(|(key, _)| key.clone())
                else {
                    break;
                };
                if let Some(old) = self.files.remove(&oldest) {
                    self.bytes -= old.bytes;
                }
            }
            self.bytes += bytes;
            self.files.insert(
                key,
                Cached {
                    stamp: before,
                    result: result.clone(),
                    touched: self.tick,
                    bytes,
                },
            );
        }
        result
    }
    pub fn check(
        &mut self,
        cache: &Path,
        root: &Path,
        instance: &Instance,
        force: bool,
    ) -> Result<ModCheck> {
        let start = Instant::now();
        let loader = instance
            .local
            .as_ref()
            .map(|local| local.loader.as_str())
            .unwrap_or(if instance.fabric_version.is_empty() {
                "vanilla"
            } else {
                "fabric"
            });
        let mut details = Details {
            checked_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            scope: format!("{loader} · 必需依赖、版本条件、重复 ID、已声明冲突（客户端）"),
            complete: true,
            scanned_files: 0,
            parsed_files: 0,
            reused_files: 0,
            elapsed_ms: 0,
        };
        let mut report = ModCheck {
            instance_id: instance.id.clone(),
            issues: vec![],
            unchecked: vec![],
            details: None,
        };
        if loader == "forge"
            && instance
                .version
                .split('.')
                .nth(1)
                .and_then(|v| v.parse::<u32>().ok())
                .is_some_and(|v| v <= 12)
        {
            details.scope = "旧版 Forge · mcmod.info 模组身份、重复 ID（客户端）".into();
            details.complete = false;
            report.unchecked.push("旧版 Forge 的 @Mod 注解与运行时依赖未检查，现代 mods.toml 不用于此版本的依赖判断。".into());
        }
        let directory = model::safe_path(root, "mods")?;
        let mut inventory = BTreeMap::new();
        if directory.exists() {
            for (index, item) in fs::read_dir(&directory)
                .map_err(|_| "无法读取模组目录")?
                .enumerate()
            {
                if index >= 8192 {
                    return Err("模组目录条目超过 8192 检查上限".into());
                }
                let item = item.map_err(|_| "无法读取模组条目")?;
                let name = item
                    .file_name()
                    .into_string()
                    .map_err(|_| "模组文件名无效")?;
                if !name.to_ascii_lowercase().ends_with(".jar") {
                    continue;
                }
                if inventory.len() >= 2048 {
                    return Err("模组文件超过 2048 检查上限".into());
                }
                let path = model::safe_path(root, &format!("mods/{name}"))?;
                inventory.insert(path, name);
            }
        }
        let mut fabric = vec![];
        let mut forge = ForgeFile::default();
        let snapshots: Vec<_> = inventory
            .keys()
            .map(|path| (path.clone(), stamp(path)))
            .collect();
        let loader_archive = if loader == "fabric" {
            self.loader(cache, instance, force)
        } else {
            Ok(None)
        };
        let mut signature = snapshots.clone();
        if loader == "fabric" {
            let profile = model::safe_path(
                cache,
                &format!("loaders/fabric/{}.json", instance.fabric_sha1),
            )?;
            signature.push((profile.clone(), stamp(&profile)));
            if let Ok(Some(path)) = &loader_archive {
                signature.push((path.clone(), stamp(path)));
            }
        }
        let context = format!(
            "{}:{}:{}:{}:{}:{}:{}",
            instance.id,
            root.display(),
            instance.version,
            loader,
            instance.java_major,
            instance.fabric_sha1,
            instance
                .local
                .as_ref()
                .map(|v| v.loader_version.as_str())
                .unwrap_or(&instance.fabric_version)
        );
        self.tick += 1;
        if !force {
            if let Some(previous) = self.reports.get_mut(&context).filter(|entry| {
                entry.signature == signature && signature.iter().all(|(_, value)| value.is_ok())
            }) {
                let mut report = previous.report.clone();
                let stats = report.details.as_mut().unwrap();
                stats.checked_at = details.checked_at;
                stats.parsed_files = 0;
                stats.reused_files = stats.scanned_files;
                stats.elapsed_ms = start.elapsed().as_millis() as u64;
                previous.touched = self.tick;
                return Ok(report);
            }
        }
        for (path, name) in &inventory {
            if fabric.len() + forge.mods.len() > 4096 {
                details.complete = false;
                report
                    .unchecked
                    .push("元数据总量超过 4096，部分文件未检查。".into());
                break;
            }
            if loader == "vanilla" {
                continue;
            }
            let parse_loader = if loader == "forge"
                && instance
                    .version
                    .split('.')
                    .nth(1)
                    .and_then(|v| v.parse::<u32>().ok())
                    .is_some_and(|v| v <= 12)
            {
                "forge-legacy"
            } else {
                loader
            };
            match self.read(path, parse_loader, force, &mut details) {
                Ok(Parsed::Fabric(values)) => fabric.extend(values),
                Ok(Parsed::Forge(mut value)) => {
                    value.notes = value
                        .notes
                        .into_iter()
                        .map(|note| format!("{name}：{note}"))
                        .collect();
                    forge.extend(value);
                }
                Err(error) => {
                    details.complete = false;
                    report.unchecked.push(format!("{name}：{error}"));
                }
            }
        }
        if loader == "vanilla" {
            details.scanned_files = inventory.len();
            details.scope = "原版 · 检查 mods 目录是否含启用的 JAR".into();
            if !inventory.is_empty() {
                report
                    .issues
                    .push("原版实例的 mods 目录含 JAR；当前未配置加载器，请核对实例类型。".into());
            }
        } else if loader == "fabric" {
            match loader_archive {
                Ok(Some(path)) => match self.read(&path, "fabric", force, &mut details) {
                    Ok(Parsed::Fabric(mut values)) => {
                        let last = values.pop();
                        if last.as_ref().is_none_or(|v| {
                            v.value["id"] != "fabricloader"
                                || v.value["version"] != instance.fabric_version
                        }) {
                            details.complete = false;
                            report.unchecked.push("加载器自身元数据不匹配".into());
                        } else {
                            fabric.extend(values);
                        }
                    }
                    _ => {
                        details.complete = false;
                        report.unchecked.push("加载器内置依赖无法读取".into());
                    }
                },
                Ok(None) => (),
                Err(error) => {
                    details.complete = false;
                    report
                        .unchecked
                        .push(format!("加载器内置依赖未确认：{error}"));
                }
            }
            match resource_install::evaluate_metadata(instance, instance.java_major, &fabric) {
                Ok(issues) => report.issues.extend(issues),
                Err(error) => {
                    details.complete = false;
                    report
                        .unchecked
                        .push(format!("Fabric 声明求解未完成：{error}"));
                }
            }
        } else {
            evaluate_forge(instance, &forge, &mut report, &mut details);
        }
        for (path, before) in snapshots {
            if before.ok() != stamp(&path).ok() {
                details.complete = false;
                report
                    .unchecked
                    .push("检查期间文件清单发生变化，请重试。".into());
                break;
            }
        }
        let now: BTreeSet<_> = if directory.exists() {
            fs::read_dir(&directory)
                .map_err(|_| "无法复核模组目录")?
                .filter_map(|item| item.ok())
                .filter_map(|item| item.file_name().into_string().ok())
                .filter(|name| name.to_ascii_lowercase().ends_with(".jar"))
                .collect()
        } else {
            BTreeSet::new()
        };
        if now != inventory.values().cloned().collect() {
            details.complete = false;
            report
                .unchecked
                .push("检查期间有模组被增加、移除或启停，请重试。".into());
        }
        report.unchecked.push(format!("Java 条件按实例要求的 Java {} 分析；实际 Java 在启动时校验。静态声明不能预测全部运行时冲突，不检查世界区块。", instance.java_major));
        if report.unchecked.len() > 500 {
            report.unchecked.truncate(499);
            report
                .unchecked
                .push("未完成项目过多，后续项目省略；请分批检查。".into());
            details.complete = false;
        }
        details.elapsed_ms = start.elapsed().as_millis() as u64;
        report.details = Some(details);
        if self.reports.len() >= 8 {
            if let Some(oldest) = self
                .reports
                .iter()
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(key, _)| key.clone())
            {
                self.reports.remove(&oldest);
            }
        }
        self.reports.insert(
            context,
            CachedReport {
                signature,
                report: report.clone(),
                touched: self.tick,
            },
        );
        Ok(report)
    }
}

#[derive(Clone, Default, Serialize)]
struct ForgeFile {
    mods: Vec<ForgeMod>,
    notes: Vec<String>,
}
impl ForgeFile {
    fn extend(&mut self, other: Self) {
        self.mods.extend(other.mods);
        self.notes.extend(other.notes);
    }
}
#[derive(Clone, Serialize)]
struct ForgeMod {
    id: String,
    version: String,
    dependencies: Vec<Dependency>,
    nested: bool,
}
#[derive(Clone, Serialize)]
struct Dependency {
    id: String,
    range: String,
    kind: String,
}
fn text<'a>(value: &'a toml::Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(toml::Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 512)
        .ok_or_else(|| format!("声明缺少有效 {key}"))
}
fn zip_text<R: Read + Seek>(zip: &mut zip::ZipArchive<R>, name: &str) -> Result<Option<String>> {
    let entry = match zip.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(_) => return Err("无法读取归档条目".into()),
    };
    if entry.size() > 512 * 1024 {
        return Err("声明条目超过 512 KiB".into());
    }
    let mut value = String::new();
    entry
        .take(512 * 1024 + 1)
        .read_to_string(&mut value)
        .map_err(|_| "声明条目不可读")?;
    if value.len() > 512 * 1024 {
        return Err("声明条目实际大小超限".into());
    }
    Ok(Some(value))
}
pub(crate) fn jar_version<R: Read + Seek>(zip: &mut zip::ZipArchive<R>) -> Result<Option<String>> {
    let entry = match zip.by_name("META-INF/MANIFEST.MF") {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(_) => return Err("无法读取 JAR 主属性".into()),
    };
    // Signed manifests may have megabytes of per-entry digests. Only the bounded
    // main section contains Implementation-Version; never expand those digests.
    let mut reader = BufReader::new(entry.take(512 * 1024 + 1));
    let mut main = String::new();
    loop {
        let mut line = String::new();
        let count = reader
            .read_line(&mut line)
            .map_err(|_| "JAR 主属性不可读")?;
        if main.len() + count > 512 * 1024 {
            return Err("JAR 主属性超过 512 KiB".into());
        }
        if count == 0 || line.trim_end_matches(['\r', '\n']).is_empty() {
            break;
        }
        main.push_str(&line);
    }
    let unfolded = main.replace("\r\n ", "").replace("\n ", "");
    Ok(unfolded.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case("Implementation-Version")
            .then(|| value.trim().to_string())
    }))
}
fn read_forge<R: Read + Seek>(
    input: R,
    loader: &str,
    result: &mut ForgeFile,
    depth: usize,
    expanded: &mut u64,
) -> Result<()> {
    if depth > 4 || result.mods.len() >= 512 {
        return Err("内置声明超过深度或数量上限".into());
    }
    let mut zip = zip::ZipArchive::new(input).map_err(|_| "不是有效 JAR/ZIP")?;
    if zip.len() > crate::packs::MAX_RESOURCE_ENTRIES {
        return Err("归档条目过多".into());
    }
    if loader == "forge-legacy" {
        if let Some(raw) = zip_text(&mut zip, "mcmod.info")? {
            let value: serde_json::Value =
                serde_json::from_str(&raw).map_err(|_| "mcmod.info 不是有效 JSON")?;
            let rows = value
                .as_array()
                .or_else(|| value["modList"].as_array())
                .ok_or("mcmod.info 缺少 modList")?;
            if rows.len() > 128 {
                return Err("旧版模组声明数量超限".into());
            }
            for row in rows {
                if let (Some(id), Some(version)) = (row["modid"].as_str(), row["version"].as_str())
                {
                    if !id.is_empty() && id.len() <= 256 && version.len() <= 256 {
                        result.mods.push(ForgeMod {
                            id: id.into(),
                            version: version.into(),
                            dependencies: vec![],
                            nested: false,
                        });
                    }
                }
            }
        }
        return Ok(());
    }
    let raw = if loader == "neoforge" {
        zip_text(&mut zip, "META-INF/neoforge.mods.toml")?
            .or(zip_text(&mut zip, "META-INF/mods.toml")?)
    } else {
        zip_text(&mut zip, "META-INF/mods.toml")?
    };
    if let Some(raw) = raw {
        let doc: toml::Value = toml::from_str(&raw).map_err(|_| "mods.toml 不是有效 TOML")?;
        let mods = doc
            .get("mods")
            .and_then(toml::Value::as_array)
            .filter(|v| v.len() <= 128)
            .ok_or("缺少有效 mods 声明")?;
        let manifest_version = if mods.iter().any(|entry| {
            entry.get("version").and_then(toml::Value::as_str) == Some("${file.jarVersion}")
        }) {
            jar_version(&mut zip)?
        } else {
            None
        };
        let mut loader_dependencies = vec![];
        let language = text(&doc, "modLoader")?;
        if language == "javafml" || language == "lowcodefml" {
            if let Some(range) = doc.get("loaderVersion").and_then(toml::Value::as_str) {
                loader_dependencies.push(Dependency {
                    id: "__language".into(),
                    range: range.into(),
                    kind: "required".into(),
                });
            }
        } else {
            result
                .notes
                .push(format!("语言加载器 {language} 的条件尚未验证"));
        }
        for entry in mods {
            let id = text(entry, "modId")?.to_string();
            let mut version = text(entry, "version")?.to_string();
            if version == "${file.jarVersion}" {
                version = manifest_version
                    .as_deref()
                    .unwrap_or("${file.jarVersion}")
                    .trim()
                    .to_string();
            }
            let mut dependencies = loader_dependencies.clone();
            if let Some(rows) = doc.get("dependencies").and_then(|v| v.get(&id)) {
                for dep in rows
                    .as_array()
                    .filter(|v| v.len() <= 256)
                    .ok_or("依赖列表无效")?
                {
                    let side = dep
                        .get("side")
                        .and_then(toml::Value::as_str)
                        .unwrap_or("BOTH");
                    if side == "SERVER" {
                        continue;
                    }
                    if !["BOTH", "CLIENT"].contains(&side) {
                        return Err("依赖 side 声明无效".into());
                    }
                    let kind = dep.get("type").and_then(toml::Value::as_str).unwrap_or(
                        if dep.get("mandatory").and_then(toml::Value::as_bool) == Some(false) {
                            "optional"
                        } else {
                            "required"
                        },
                    );
                    if !["required", "optional", "incompatible", "discouraged"].contains(&kind) {
                        return Err("依赖 type 声明暂不支持".into());
                    }
                    dependencies.push(Dependency {
                        id: text(dep, "modId")?.into(),
                        range: dep
                            .get("versionRange")
                            .and_then(toml::Value::as_str)
                            .unwrap_or("")
                            .into(),
                        kind: kind.into(),
                    });
                }
            }
            result.mods.push(ForgeMod {
                id,
                version,
                dependencies,
                nested: depth > 0,
            });
        }
    } else if depth == 0 {
        result.notes.push(
            "无可识别的顶层 mods.toml；仅核对声明的内嵌模组，兼容桥接与运行时服务身份未验证".into(),
        );
    }
    if let Some(raw) = zip_text(&mut zip, "META-INF/jarjar/metadata.json")? {
        let value: serde_json::Value =
            serde_json::from_str(&raw).map_err(|_| "Jar-in-Jar 清单无效")?;
        let jars = value["jars"]
            .as_array()
            .filter(|v| v.len() <= 128)
            .ok_or("Jar-in-Jar 列表无效")?;
        for jar in jars {
            let path = jar["path"]
                .as_str()
                .filter(|v| v.len() <= 512)
                .ok_or("内嵌路径无效")?;
            model::safe_path(Path::new("C:/EasyCraftJarCheck"), path)?;
            let entry = zip.by_name(path).map_err(|_| "缺少声明的内嵌 JAR")?;
            *expanded += entry.size();
            if entry.size() > 64 * 1024 * 1024 || *expanded > 256 * 1024 * 1024 {
                return Err("内嵌 JAR 解压超过上限".into());
            }
            let mut bytes = vec![];
            entry
                .take(64 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "内嵌 JAR 无法读取")?;
            if bytes.len() > 64 * 1024 * 1024 {
                return Err("内嵌 JAR 实际大小超限".into());
            }
            read_forge(
                std::io::Cursor::new(bytes),
                loader,
                result,
                depth + 1,
                expanded,
            )?;
        }
    }
    Ok(())
}
// Only numeric Maven versions are compared. Qualifier/dynamic versions stay explicitly unchecked.
fn numeric(version: &str) -> Result<Vec<u64>> {
    if version.len() > 128 {
        return Err("版本号过长".into());
    }
    let parts: std::result::Result<Vec<_>, _> = version.split('.').map(str::parse::<u64>).collect();
    let mut parts = parts.map_err(|_| format!("暂不能可靠比较 Maven 版本：{version}"))?;
    if parts.len() > 16 {
        return Err("版本字段过多".into());
    }
    while parts.last() == Some(&0) {
        parts.pop();
    }
    Ok(parts)
}
fn maven_matches(version: &str, range: &str) -> Result<bool> {
    let range = range.trim();
    if range.len() > 512 {
        return Err("Maven 范围过长".into());
    }
    if range.is_empty() || range == "*" {
        return Ok(true);
    }
    // A bare Maven version is a recommendation rather than a hard bound.
    if !range.starts_with(['[', '(']) {
        return Ok(true);
    }
    let value = numeric(version)?;
    let mut rest = range;
    while !rest.is_empty() {
        let end = rest.find([']', ')']).ok_or("Maven 范围缺少结束符")?;
        let part = &rest[..=end];
        let body = &part[1..part.len() - 1];
        let matched = if let Some((lower, upper)) = body.split_once(',') {
            let low = lower.trim();
            let high = upper.trim();
            (low.is_empty()
                || if part.starts_with('[') {
                    value >= numeric(low)?
                } else {
                    value > numeric(low)?
                })
                && (high.is_empty()
                    || if part.ends_with(']') {
                        value <= numeric(high)?
                    } else {
                        value < numeric(high)?
                    })
        } else {
            part.starts_with('[') && part.ends_with(']') && value == numeric(body.trim())?
        };
        if matched {
            return Ok(true);
        }
        rest = rest[end + 1..].trim_start_matches(',').trim();
        if !rest.is_empty() && !rest.starts_with(['[', '(']) {
            return Err("Maven 范围格式暂不支持".into());
        }
    }
    Ok(false)
}
fn loader_matches(instance: &Instance, dependency: &Dependency, version: &str) -> Result<bool> {
    let matched = maven_matches(version, &dependency.range)?;
    if matched
        || instance.version != "1.21.1"
        || !instance
            .local
            .as_ref()
            .is_some_and(|local| local.loader == "neoforge")
    {
        return Ok(matched);
    }
    // FancyModLoader's 1.21.1 VersionSupportMatrix explicitly accepts these
    // fallback identities after the installed version fails the declared range.
    // https://github.com/neoforged/FancyModLoader/blob/1.21.1/loader/src/main/java/net/neoforged/fml/loading/VersionSupportMatrix.java
    match dependency.id.as_str() {
        "minecraft" => maven_matches("1.21", &dependency.range),
        "neoforge" => maven_matches("21.0.166", &dependency.range),
        _ => Ok(false),
    }
}
fn evaluate_forge(
    instance: &Instance,
    data: &ForgeFile,
    report: &mut ModCheck,
    details: &mut Details,
) {
    let Some(local) = &instance.local else {
        details.complete = false;
        report.unchecked.push("缺少加载器条件".into());
        return;
    };
    report.unchecked.extend(data.notes.iter().cloned());
    if !data.notes.is_empty() {
        details.complete = false;
    }
    let mut versions: BTreeMap<String, Vec<String>> = BTreeMap::from([
        ("minecraft".into(), vec![instance.version.clone()]),
        (local.loader.clone(), vec![local.loader_version.clone()]),
        (
            "__language".into(),
            vec![local.loader_version.split('.').next().unwrap_or("").into()],
        ),
    ]);
    let mut roots = BTreeSet::new();
    for info in &data.mods {
        if !info.nested && !roots.insert(info.id.clone()) {
            report.issues.push(format!("模组 ID 重复：{}", info.id));
        }
        let values = versions.entry(info.id.clone()).or_default();
        if !values.contains(&info.version) {
            values.push(info.version.clone());
        }
    }
    for info in &data.mods {
        for dep in &info.dependencies {
            if dep.id == "__language" && local.loader == "neoforge" {
                details.complete = false;
                report
                    .unchecked
                    .push("NeoForge 语言加载器版本尚未独立解析，不能用发行版本代替。".into());
                continue;
            }
            let values = versions.get(&dep.id);
            let subject = if dep.id == "__language" {
                "语言加载器"
            } else {
                &dep.id
            };
            if values.is_none() {
                if dep.kind == "required" {
                    report.issues.push(format!(
                        "模组 {} 缺少必需依赖：{} {}",
                        info.id, subject, dep.range
                    ));
                }
                continue;
            }
            let values = values.unwrap();
            if values.len() > 1 {
                details.complete = false;
                report.unchecked.push(format!(
                    "依赖 {} 存在多个内嵌版本候选，未模拟完整 Jar-in-Jar 选择",
                    dep.id
                ));
                continue;
            }
            match loader_matches(instance, dep, &values[0]) {
                Ok(matched)
                    if (dep.kind == "incompatible" || dep.kind == "discouraged") && matched =>
                {
                    report.issues.push(format!(
                        "模组 {} 声明{}：{} {}（当前 {}）",
                        info.id,
                        if dep.kind == "discouraged" {
                            "不建议共存"
                        } else {
                            "不兼容"
                        },
                        subject,
                        dep.range,
                        values[0]
                    ))
                }
                Ok(false) if dep.kind == "required" || dep.kind == "optional" => {
                    report.issues.push(format!(
                        "模组 {} 的依赖版本不满足：{} {}（当前 {}）",
                        info.id, subject, dep.range, values[0]
                    ))
                }
                Err(error) => {
                    details.complete = false;
                    report
                        .unchecked
                        .push(format!("模组 {} → {}：{}", info.id, subject, error));
                }
                _ => (),
            }
        }
    }
    report.issues.sort();
    report.issues.dedup();
    report.unchecked.sort();
    report.unchecked.dedup();
    if report.issues.len() > 1000 {
        report.issues.truncate(1000);
        details.complete = false;
        report.unchecked.push("问题超过 1000 项，部分省略".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    fn root() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/mod-check-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(root.join("mods")).unwrap();
        root
    }
    #[test]
    fn legacy_forge_does_not_read_modern_toml_from_multi_version_jars() {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file("mcmod.info", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(br#"[{"modid":"entityculling","version":"1.6"}]"#)
            .unwrap();
        zip.start_file(
            "META-INF/mods.toml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"broken modern metadata must not affect legacy Forge")
            .unwrap();
        let mut result = ForgeFile::default();
        read_forge(
            Cursor::new(zip.finish().unwrap().into_inner()),
            "forge-legacy",
            &mut result,
            0,
            &mut 0,
        )
        .unwrap();
        assert_eq!(result.mods[0].id, "entityculling");
        assert!(result.mods[0].dependencies.is_empty());
        assert!(result.notes.is_empty());
    }
    fn jar(metadata: &str, nested: Option<Vec<u8>>) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file(
            "META-INF/mods.toml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(metadata.as_bytes()).unwrap();
        if let Some(bytes) = nested {
            zip.start_file(
                "META-INF/jarjar/metadata.json",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(br#"{"jars":[{"path":"META-INF/jarjar/lib.jar"}]}"#)
                .unwrap();
            zip.start_file(
                "META-INF/jarjar/lib.jar",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    fn instance(root: &Path, loader: &str) -> Instance {
        serde_json::from_value(serde_json::json!({"id":"check-test","name":"Check fixture","version":"1.20.1","manifestSha1":"a".repeat(40),"javaMajor":17,"fabricVersion":"","fabricSha1":"","local":{"root":root.to_string_lossy(),"versionDirectory":"","gameDirectory":"","clientJar":"test.jar","sourceKey":"a".repeat(64),"loader":loader,"loaderVersion":"47.4.10"}})).unwrap()
    }
    const MAIN: &str = "modLoader='javafml'\nloaderVersion='[47,)'\n[[mods]]\nmodId='main'\nversion='1.0'\n[[dependencies.main]]\nmodId='library'\nmandatory=true\nversionRange='[2,3)'\nside='BOTH'\n[[dependencies.main]]\nmodId='server_only'\nmandatory=true\nversionRange='[1,)'\nside='SERVER'";
    const LIB: &str = "modLoader='javafml'\n[[mods]]\nmodId='library'\nversion='2.0'";
    #[test]
    fn signed_manifest_does_not_hide_mods_or_required_dependencies() {
        for version in ["2.0", "${file.jarVersion}"] {
            let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
            zip.start_file(
                "META-INF/mods.toml",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(LIB.replace("2.0", version).as_bytes())
                .unwrap();
            zip.start_file(
                "META-INF/MANIFEST.MF",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            zip.write_all(b"Manifest-Version: 1.0\r\nImplementation-Version: 2.0\r\n\r\n")
                .unwrap();
            zip.write_all(
                "Name: signed/class.class\r\nSHA-256-Digest: abc\r\n\r\n"
                    .repeat(20000)
                    .as_bytes(),
            )
            .unwrap();
            let bytes = zip.finish().unwrap().into_inner();
            let mut data = ForgeFile::default();
            read_forge(Cursor::new(bytes), "forge", &mut data, 0, &mut 0).unwrap();
            assert_eq!(data.mods[0].version, "2.0");
            let mut root_mod = ForgeFile::default();
            read_forge(
                Cursor::new(jar(MAIN, None)),
                "forge",
                &mut root_mod,
                0,
                &mut 0,
            )
            .unwrap();
            data.mods.extend(root_mod.mods);
            let mut report = ModCheck {
                instance_id: "fixture".into(),
                issues: vec![],
                unchecked: vec![],
                details: None,
            };
            let mut details = Details {
                checked_at: 0,
                scope: String::new(),
                complete: true,
                scanned_files: 0,
                parsed_files: 0,
                reused_files: 0,
                elapsed_ms: 0,
            };
            evaluate_forge(
                &instance(Path::new("C:/fixture"), "forge"),
                &data,
                &mut report,
                &mut details,
            );
            assert!(!report.issues.iter().any(|issue| issue.contains("library")));
        }
    }
    #[test]
    fn neoforge_1211_uses_loader_compatibility_matrix_without_hiding_real_errors() {
        let mut item = instance(Path::new("C:/fixture"), "neoforge");
        item.version = "1.21.1".into();
        item.local.as_mut().unwrap().loader_version = "21.1.265".into();
        let metadata = "modLoader='javafml'\n[[mods]]\nmodId='example'\nversion='1.0'\n[[dependencies.example]]\nmodId='minecraft'\ntype='required'\nversionRange='[1.21,1.21.1)'\n[[dependencies.example]]\nmodId='neoforge'\ntype='required'\nversionRange='[21.0.100,21.1)'";
        let mut data = ForgeFile::default();
        read_forge(
            Cursor::new(jar(metadata, None)),
            "neoforge",
            &mut data,
            0,
            &mut 0,
        )
        .unwrap();
        let check = |item: &Instance, data: &ForgeFile| {
            let mut report = ModCheck {
                instance_id: item.id.clone(),
                issues: vec![],
                unchecked: vec![],
                details: None,
            };
            let mut details = Details {
                checked_at: 0,
                scope: String::new(),
                complete: true,
                scanned_files: 0,
                parsed_files: 0,
                reused_files: 0,
                elapsed_ms: 0,
            };
            evaluate_forge(item, data, &mut report, &mut details);
            report
        };
        assert!(check(&item, &data).issues.is_empty());
        data.mods[0].dependencies[0].range = "[1.22,)".into();
        assert!(check(&item, &data)
            .issues
            .iter()
            .any(|issue| issue.contains("minecraft")));
        data.mods[0].dependencies[0].range = "[1.21,1.21.1)".into();
        item.local.as_mut().unwrap().loader = "forge".into();
        assert!(check(&item, &data)
            .issues
            .iter()
            .any(|issue| issue.contains("minecraft")));
        item.local.as_mut().unwrap().loader = "neoforge".into();
        item.version = "1.21.2".into();
        assert!(check(&item, &data)
            .issues
            .iter()
            .any(|issue| issue.contains("minecraft")));
    }
    #[test]
    fn forge_cache_detects_add_change_remove_enable_and_force_without_touching_sources() {
        let root = root();
        let instance = instance(&root, "forge");
        let mut cache = Cache::default();
        fs::write(root.join("mods/main.jar"), jar(MAIN, None)).unwrap();
        let first = cache.check(&root, &root, &instance, false).unwrap();
        assert_eq!(first.details.unwrap().parsed_files, 1);
        assert!(first.issues.iter().any(|v| v.contains("library")));
        assert!(!first.issues.iter().any(|v| v.contains("server_only")));
        let warm = cache.check(&root, &root, &instance, false).unwrap();
        let stats = warm.details.unwrap();
        assert_eq!((stats.parsed_files, stats.reused_files), (0, 1));
        fs::write(root.join("mods/lib.jar"), jar(LIB, None)).unwrap();
        let added = cache.check(&root, &root, &instance, false).unwrap();
        assert!(added.issues.is_empty());
        assert_eq!(added.details.unwrap().parsed_files, 1);
        fs::write(
            root.join("mods/lib.jar"),
            jar(&LIB.replace("2.0", "3.1.0"), None),
        )
        .unwrap();
        let changed = cache.check(&root, &root, &instance, false).unwrap();
        assert!(changed.issues.iter().any(|v| v.contains("版本不满足")));
        assert_eq!(changed.details.unwrap().parsed_files, 1);
        fs::rename(
            root.join("mods/lib.jar"),
            root.join("mods/lib.jar.disabled"),
        )
        .unwrap();
        assert!(cache
            .check(&root, &root, &instance, false)
            .unwrap()
            .issues
            .iter()
            .any(|v| v.contains("缺少必需依赖")));
        fs::rename(
            root.join("mods/lib.jar.disabled"),
            root.join("mods/lib.jar"),
        )
        .unwrap();
        let forced = cache.check(&root, &root, &instance, true).unwrap();
        assert_eq!(forced.details.unwrap().parsed_files, 2);
        fs::remove_file(root.join("mods/lib.jar")).unwrap();
        assert!(cache
            .check(&root, &root, &instance, false)
            .unwrap()
            .issues
            .iter()
            .any(|v| v.contains("缺少必需依赖")));
    }
    #[test]
    fn forge_nested_mods_multi_errors_corrupt_files_and_unknown_versions_are_honest() {
        let root = root();
        let instance = instance(&root, "forge");
        let mut cache = Cache::default();
        fs::write(root.join("mods/main.jar"), jar(MAIN, Some(jar(LIB, None)))).unwrap();
        assert!(cache
            .check(&root, &root, &instance, false)
            .unwrap()
            .issues
            .is_empty());
        fs::write(root.join("mods/bad.jar"), b"broken").unwrap();
        let partial = cache.check(&root, &root, &instance, false).unwrap();
        assert!(!partial.details.unwrap().complete);
        assert!(partial.unchecked.iter().any(|v| v.contains("bad.jar")));
        fs::write(root.join("mods/other.jar"),jar("modLoader='javafml'\n[[mods]]\nmodId='other'\nversion='1'\n[[dependencies.other]]\nmodId='missing'\nmandatory=true\n[[dependencies.other]]\nmodId='library'\ntype='incompatible'\nversionRange='[2,3)'",None)).unwrap();
        let report = cache.check(&root, &root, &instance, false).unwrap();
        assert!(report.issues.iter().any(|v| v.contains("missing")));
        assert!(report.issues.iter().any(|v| v.contains("不兼容")));
        assert!(maven_matches("1.20.1", "[1.19,1.21)").unwrap());
        assert!(!maven_matches("3.0", "[2,3)").unwrap());
        assert!(maven_matches("1.0", "(,1.0],[2.0,)").unwrap());
        assert!(maven_matches("1-beta", "[1,2)").is_err());
    }
    #[test]
    fn neoforge_metadata_checks_types_and_does_not_infer_language_version() {
        let root = root();
        let mut instance = instance(&root, "neoforge");
        instance.local.as_mut().unwrap().loader_version = "21.1.139".into();
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file(
            "META-INF/neoforge.mods.toml",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(b"modLoader='javafml'\nloaderVersion='[4,5)'\n[[mods]]\nmodId='test'\nversion='1'\n[[dependencies.test]]\nmodId='required_lib'\ntype='required'\nversionRange='[1,)'\n[[dependencies.test]]\nmodId='optional_lib'\ntype='optional'\nversionRange='[1,)'").unwrap();
        fs::write(
            root.join("mods/test.jar"),
            zip.finish().unwrap().into_inner(),
        )
        .unwrap();
        let report = Cache::default()
            .check(&root, &root, &instance, false)
            .unwrap();
        assert!(report.issues.iter().any(|v| v.contains("required_lib")));
        assert!(!report
            .issues
            .iter()
            .any(|v| v.contains("optional_lib") || v.contains("语言加载器")));
        assert!(!report.details.unwrap().complete);
        assert!(report.unchecked.iter().any(|v| v.contains("语言加载器")));
    }
    #[test]
    fn folder_shortcuts_do_not_create_missing_directories_or_accept_paths() {
        let root = root();
        assert_eq!(
            crate::content::folder_path(&root, "mods").unwrap(),
            root.join("mods")
        );
        assert!(crate::content::folder_path(&root, "saves").is_err());
        assert!(!root.join("saves").exists());
        assert!(crate::content::folder_path(&root, "../private").is_err());
        assert_eq!(crate::content::folder_path(&root, "game").unwrap(), root);
    }
    #[test]
    #[ignore = "Uses the user-authorized real modpack; read-only source, isolated hard-link mirror"]
    fn real_fear_nightfall_dependency_removal_and_incremental_benchmark() {
        let source = PathBuf::from(
            std::env::var("EASYCRAFT_MOD_CHECK_SOURCE").expect("Set the authorized game directory"),
        );
        let original = source.join("mods");
        let source_before: BTreeMap<_, _> = fs::read_dir(&original)
            .unwrap()
            .map(|item| {
                let item = item.unwrap();
                (item.file_name(), stamp(&item.path()))
            })
            .collect();
        let mirror = PathBuf::from(std::env::var("LOCALAPPDATA").unwrap())
            .join("Temp/EasyCraft-mod-check")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(mirror.join("mods")).unwrap();
        let profile: serde_json::Value = serde_json::from_slice(
            &fs::read(source.join("Fear_Nightfall_Remains_of_Chaos.json")).unwrap(),
        )
        .unwrap();
        let (loader, version) = crate::local_launch::loader(&profile);
        assert_eq!(loader, "forge");
        let mut instance = instance(&source, &loader);
        instance.local.as_mut().unwrap().loader_version = version;
        let mut count = 0;
        for item in fs::read_dir(&original).unwrap() {
            let item = item.unwrap();
            if item.path().is_file() && item.file_name().to_string_lossy().ends_with(".jar") {
                fs::hard_link(item.path(), mirror.join("mods").join(item.file_name())).unwrap();
                count += 1;
            }
        }
        let mut cache = Cache::default();
        let cold = cache.check(&source, &mirror, &instance, false).unwrap();
        let warm = cache.check(&source, &mirror, &instance, false).unwrap();
        assert_eq!(warm.details.as_ref().unwrap().parsed_files, 0);
        let target = "PuzzlesLib-v8.1.33-1.20.1-Forge.jar";
        let original_hash = resource_install::sum(&original.join(target)).unwrap();
        assert!(mirror.join("mods").join(target).exists());
        // Remove only a mirror link. The original is never renamed, removed or opened for writing.
        fs::remove_file(mirror.join("mods").join(target)).unwrap();
        let missing = cache.check(&source, &mirror, &instance, false).unwrap();
        assert!(
            missing
                .issues
                .iter()
                .any(|v| v.contains("缺少必需依赖：puzzleslib")),
            "{:?}",
            missing.issues
        );
        fs::hard_link(original.join(target), mirror.join("mods").join(target)).unwrap();
        let restored = cache.check(&source, &mirror, &instance, false).unwrap();
        assert_eq!(cold.issues, restored.issues);
        assert_eq!(cold.unchecked, restored.unchecked);
        // A same-content replacement is a real single-file fingerprint change.
        fs::remove_file(mirror.join("mods").join(target)).unwrap();
        fs::copy(original.join(target), mirror.join("mods").join(target)).unwrap();
        fs::File::options()
            .write(true)
            .open(mirror.join("mods").join(target))
            .unwrap()
            .set_modified(SystemTime::now())
            .unwrap();
        let replaced = cache.check(&source, &mirror, &instance, false).unwrap();
        assert_eq!(replaced.details.as_ref().unwrap().parsed_files, 1);
        assert_eq!(replaced.issues, cold.issues);
        let forced = cache.check(&source, &mirror, &instance, true).unwrap();
        assert_eq!(forced.details.as_ref().unwrap().parsed_files, count);
        assert_eq!(
            original_hash,
            resource_install::sum(&original.join(target)).unwrap()
        );
        assert_eq!(
            original_hash,
            resource_install::sum(&mirror.join("mods").join(target)).unwrap()
        );
        let source_after: BTreeMap<_, _> = fs::read_dir(&original)
            .unwrap()
            .map(|item| {
                let item = item.unwrap();
                (item.file_name(), stamp(&item.path()))
            })
            .collect();
        assert!(source_before == source_after);
        let output = serde_json::json!({"source":source,"mirror":mirror,"loaderVersion":instance.local.as_ref().unwrap().loader_version,"removedFile":target,"originalSha512":original_hash,"count":count,"cold":cold,"warm":warm,"missingRequired":missing,"restored":restored,"singleFileReplacement":replaced,"forced":forced,"sourceUntouched":true});
        let file =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../.native/mod-check-real-report.json");
        fs::write(&file, serde_json::to_vec_pretty(&output).unwrap()).unwrap();
        println!("REAL_MOD_CHECK_REPORT={}", file.display());
    }
}
