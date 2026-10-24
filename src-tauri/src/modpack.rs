use crate::{
    host::Host,
    model::{self, Instance, Result},
    net, packs, resource_install,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha512};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Seek, Write},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const LIMIT: u64 = 1024 * 1024 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub size: u64,
    pub sha512: String,
    pub optional: bool,
    pub source: String,
    #[serde(skip)]
    data: Source,
}
#[derive(Clone)]
enum Source {
    Download { url: String, sha1: String },
    Archive(usize),
}
struct Input {
    file: Mutex<Option<File>>,
    path: PathBuf,
}
impl Drop for Input {
    fn drop(&mut self) {
        if let Ok(file) = self.file.get_mut() {
            drop(file.take());
        }
        let _ = fs::remove_file(&self.path);
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    pub project: String,
    pub version: String,
    pub filename: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub token: String,
    pub name: String,
    pub pack_version: String,
    pub game_version: String,
    pub fabric_version: String,
    pub archive_sha512: String,
    pub files: Vec<Entry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<Origin>,
    #[serde(skip)]
    input: Arc<Input>,
    #[serde(skip)]
    created: Instant,
}
fn path(value: &str) -> Result<()> {
    if value.len() > 512
        || value.split('/').any(|part| {
            part.is_empty()
                || part == "."
                || part == ".."
                || part.to_ascii_lowercase().starts_with(".easycraft")
                || part.eq_ignore_ascii_case("session.lock")
        })
    {
        return Err("整合包路径无效或使用了保留的启动器/世界锁文件名".into());
    }
    model::safe_path(Path::new("C:/EasyCraftPackValidation"), value).map(|_| ())
}
fn text(value: &Value, key: &str, max: usize) -> Result<String> {
    value[key]
        .as_str()
        .filter(|v| {
            !v.trim().is_empty() && v.chars().count() <= max && !v.chars().any(char::is_control)
        })
        .map(String::from)
        .ok_or_else(|| format!("整合包字段 {key} 无效"))
}
fn hash(value: &Value, key: &str, len: usize) -> Result<String> {
    value[key]
        .as_str()
        .filter(|v| v.len() == len && v.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| format!("整合包 {key} 校验值无效"))
}
fn insert(files: &mut BTreeMap<String, Entry>, entry: Entry, replace: bool) -> Result<()> {
    path(&entry.path)?;
    let key = entry.path.to_ascii_lowercase();
    if let Some(old) = files.get(&key) {
        if !replace || old.path != entry.path {
            return Err("整合包目标重复或大小写冲突".into());
        }
    }
    files.insert(key, entry);
    Ok(())
}
fn parse(input: Arc<Input>, preview: &mut packs::PackPreview) -> Result<Plan> {
    let mut guard = input.file.lock().map_err(|_| "整合包快照不可用")?;
    let file = guard.as_mut().ok_or("整合包快照已释放")?;
    file.rewind().map_err(|_| "无法读取整合包快照")?;
    let archive_sha512 = resource_install::sum(&input.path)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "整合包快照无效")?;
    let index = zip
        .by_name("modrinth.index.json")
        .map_err(|_| "缺少 Modrinth 清单")?;
    let value: Value =
        serde_json::from_reader(index.take(2 * 1024 * 1024 + 1)).map_err(|_| "整合包清单无效")?;
    if value["formatVersion"] != 1 || value["game"] != "minecraft" {
        return Err("不支持的整合包格式".into());
    }
    let name = text(&value, "name", 100)?;
    let pack_version = text(&value, "versionId", 128)?;
    let dependencies = value["dependencies"].as_object().ok_or("缺少运行依赖")?;
    if dependencies
        .keys()
        .any(|key| !["minecraft", "fabric-loader"].contains(&key.as_str()))
    {
        return Err("当前仅支持原版或 Fabric 整合包；其他加载器依赖尚未接入".into());
    }
    let game_version = text(&value["dependencies"], "minecraft", 99)?;
    if !model::valid_id(&game_version) {
        return Err("游戏版本无效".into());
    }
    let fabric_version = if dependencies.contains_key("fabric-loader") {
        let version = text(&value["dependencies"], "fabric-loader", 100)?;
        if !crate::fabric::valid_version(&version) {
            return Err("Fabric 版本无效".into());
        }
        version
    } else {
        String::new()
    };
    let mut files = BTreeMap::new();
    let mut skipped = 0;
    for entry in value["files"].as_array().ok_or("缺少文件清单")? {
        let target = text(entry, "path", 512)?;
        path(&target)?;
        let mut client = "required";
        if let Some(env) = entry.get("env") {
            let env = env.as_object().ok_or("文件运行环境格式无效")?;
            for (key, value) in env {
                if !["client", "server"].contains(&key.as_str())
                    || !value
                        .as_str()
                        .is_some_and(|v| ["required", "optional", "unsupported"].contains(&v))
                {
                    return Err("文件运行环境条件无效".into());
                }
            }
            if let Some(value) = env.get("client") {
                client = value.as_str().ok_or("客户端条件无效")?;
            }
        }
        if client == "unsupported" {
            skipped += 1;
            continue;
        }
        let urls = entry["downloads"]
            .as_array()
            .filter(|v| !v.is_empty() && v.len() <= 10)
            .ok_or("下载来源无效")?;
        let url = urls
            .iter()
            .filter_map(Value::as_str)
            .find(|url| net::resource_download_url(url).is_ok())
            .ok_or("此整合包含尚未支持的文件来源；当前只下载 Modrinth CDN 文件")?
            .to_owned();
        let size = entry["fileSize"]
            .as_u64()
            .filter(|size| *size <= crate::file_picker::MAX_FILE)
            .ok_or("文件大小超限")?;
        insert(
            &mut files,
            Entry {
                path: target,
                size,
                sha512: hash(&entry["hashes"], "sha512", 128)?,
                optional: client == "optional",
                source: "download".into(),
                data: Source::Download {
                    url,
                    sha1: hash(&entry["hashes"], "sha1", 40)?,
                },
            },
            false,
        )?;
    }
    for (prefix, source) in [
        ("overrides/", "override"),
        ("client-overrides/", "client-override"),
    ] {
        for index in 0..zip.len() {
            let mut entry = zip.by_index(index).map_err(|_| "覆盖文件无效")?;
            let name = entry.name().map_err(|_| "覆盖文件名称无效")?.to_string();
            let Some(target) = name.strip_prefix(prefix) else {
                continue;
            };
            if entry.is_dir() {
                continue;
            }
            path(target)?;
            let size = entry.size();
            let mut digest = Sha512::new();
            let mut buffer = [0; 65536];
            let mut total = 0;
            loop {
                let read = entry
                    .read(&mut buffer)
                    .map_err(|_| "覆盖文件读取或 CRC 校验失败")?;
                if read == 0 {
                    break;
                }
                total += read as u64;
                if total > size || total > crate::file_picker::MAX_FILE {
                    return Err("覆盖文件大小超限".into());
                }
                digest.update(&buffer[..read]);
            }
            if total != size {
                return Err("覆盖文件大小与目录不符".into());
            }
            insert(
                &mut files,
                Entry {
                    path: target.into(),
                    size,
                    sha512: format!("{:x}", digest.finalize()),
                    optional: false,
                    source: source.into(),
                    data: Source::Archive(index),
                },
                true,
            )?;
        }
    }
    let mut total = 0u64;
    for (key, entry) in &files {
        total = total.checked_add(entry.size).ok_or("整合包大小溢出")?;
        for (index, _) in key.match_indices('/') {
            if files.contains_key(&key[..index]) {
                return Err("整合包文件与目录目标冲突".into());
            }
        }
    }
    if total > LIMIT
        || files.len() > 10000
        || files.values().filter(|entry| entry.optional).count() > 200
    {
        return Err("整合包超出 1 GiB/10000 文件/200 可选文件边界".into());
    }
    if skipped > 0 {
        preview.warnings.push(format!(
            "客户端不支持的 {skipped} 个文件不会安装；server-overrides 不用于客户端。"
        ));
    }
    preview.warnings.push(
        "仅新建隔离实例；不执行归档内脚本。可选文件默认不安装，覆盖目录按客户端层级合并。".into(),
    );
    drop(zip);
    drop(guard);
    Ok(Plan {
        token: uuid::Uuid::new_v4().to_string(),
        name,
        pack_version,
        game_version,
        fabric_version,
        archive_sha512,
        files: files.into_values().collect(),
        origin: None,
        input,
        created: Instant::now(),
    })
}
pub fn inspect(root: &Path, reader: impl Read) -> Result<packs::PackPreview> {
    let directory = model::safe_path(root, "pack-inputs")?;
    fs::create_dir_all(&directory).map_err(|_| "无法创建整合包快照目录")?;
    let path = model::safe_path(&directory, &format!("{}.mrpack", uuid::Uuid::new_v4()))?;
    let file = fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .open(&path)
        .map_err(|_| "无法创建整合包快照")?;
    let input = Arc::new(Input {
        file: Mutex::new(Some(file)),
        path,
    });
    let mut guard = input.file.lock().map_err(|_| "快照不可用")?;
    let file = guard.as_mut().ok_or("快照不可用")?;
    let copied = std::io::copy(&mut reader.take(crate::file_picker::MAX_FILE + 1), file)
        .map_err(|_| "整合包快照复制失败")?;
    if copied == 0 || copied > crate::file_picker::MAX_FILE {
        return Err("整合包须为 512 MiB 以内的非空文件".into());
    }
    file.sync_all().map_err(|_| "整合包快照同步失败")?;
    file.rewind().map_err(|_| "整合包快照读取失败")?;
    let mut preview = packs::preview_reader(file)?;
    drop(guard);
    if preview.kind == "MRPACK" {
        match parse(input, &mut preview) {
            Ok(plan) => preview.install = Some(plan),
            Err(error) => preview.warnings.push(format!("不可安装：{error}")),
        }
    }
    Ok(preview)
}
fn online_artifact(
    project: &str,
    version: &str,
    filename: &str,
    value: &Value,
) -> Result<(net::Artifact, String)> {
    crate::resources::id(project)?;
    crate::resources::id(version)?;
    if value["id"] != version || value["project_id"] != project {
        return Err("整合包版本归属不符，请重新选择项目和版本".into());
    }
    if filename.len() > 512
        || filename.contains(['/', '\\'])
        || ![".mrpack", ".zip"]
            .iter()
            .any(|suffix| filename.to_ascii_lowercase().ends_with(suffix))
    {
        return Err("请选择明确的 MRPACK / ZIP 归档文件".into());
    }
    let files = value["files"]
        .as_array()
        .filter(|files| !files.is_empty() && files.len() <= 64)
        .ok_or("整合包版本文件列表无效")?;
    let matching: Vec<_> = files
        .iter()
        .filter(|file| file["filename"] == filename)
        .collect();
    if matching.len() != 1 {
        return Err("归档文件不存在或名称重复，请重新读取版本".into());
    }
    let file = matching[0];
    let sha512 = hash(&file["hashes"], "sha512", 128)?;
    let sha1 = hash(&file["hashes"], "sha1", 40)?;
    let url = crate::resources::text(file, "url", 2048)?;
    net::resource_download_url(&url)?;
    let size = file["size"]
        .as_u64()
        .filter(|size| *size > 0 && *size <= crate::file_picker::MAX_FILE)
        .ok_or("在线归档超过 512 MiB 或为空")?;
    Ok((
        net::Artifact {
            url,
            sha1,
            size: Some(size),
            path: format!("pack-archives/{sha512}.mrpack"),
        },
        sha512,
    ))
}
pub async fn online(
    host: &Host,
    project: &str,
    version: &str,
    filename: &str,
    cancel: &CancellationToken,
) -> Result<packs::PackPreview> {
    crate::resources::id(project)?;
    crate::resources::id(version)?;
    let value = net::resource_json(
        &host.client,
        &format!("https://api.modrinth.com/v2/version/{version}"),
        cancel,
    )
    .await?;
    let (artifact, expected) = online_artifact(project, version, filename, &value)?;
    host.progress("pack-archive", "下载并校验选定的整合包归档", 0, 1);
    let cached = net::resource_download(&host.client, &host.root, &artifact, cancel).await?;
    if cancel.is_cancelled() {
        return Err("归档检查已取消".into());
    }
    host.progress("pack-inspect", "检查整合包归档与安装变更", 0, 1);
    let root = host.root.clone();
    let source = Origin {
        project: project.into(),
        version: version.into(),
        filename: filename.into(),
    };
    let preview = tauri::async_runtime::spawn_blocking(move || {
        let (_, input) = crate::file_picker::open(cached.clone(), &["mrpack"])?;
        if !net::matches(&cached, &artifact.sha1, artifact.size)?
            || resource_install::sum(&cached)? != expected
        {
            return Err("在线归档缓存的大小或哈希不一致，未生成安装计划".into());
        }
        let mut preview = inspect(&root, input)?;
        if preview.kind != "MRPACK" {
            return Err("选定归档不包含受支持的 MRPACK 清单；未创建实例".into());
        }
        if let Some(plan) = &mut preview.install {
            plan.origin = Some(source);
        }
        Ok(preview)
    })
    .await
    .map_err(|_| "归档检查任务失败".to_string())?;
    if cancel.is_cancelled() {
        return Err("归档检查已取消".into());
    }
    preview
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Stamp {
    size: u64,
    sha512: String,
    identity: (u32, u32, u32),
}
fn stamp(file: &Path) -> Result<Stamp> {
    Ok(Stamp {
        size: fs::metadata(file).map_err(|_| "无法读取暂存文件")?.len(),
        sha512: resource_install::sum(file)?,
        identity: resource_install::file_identity(file)?,
    })
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transaction {
    token: String,
    instance: Instance,
    identity: (u32, u32, u32),
    files: BTreeMap<String, Stamp>,
    #[serde(default)]
    in_place: bool,
}
fn uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value)
}
impl Transaction {
    fn journal(&self) -> String {
        format!("pack-journals/{}.json", self.token)
    }
    fn directory(&self, root: &Path, published: bool) -> Result<PathBuf> {
        if !uuid(&self.token) || !uuid(&self.instance.id) {
            return Err("整合包事务标识无效".into());
        }
        model::safe_path(
            root,
            &if published || self.in_place {
                format!("instances/{}", self.instance.id)
            } else {
                format!("pack-staging/{}", self.token)
            },
        )
    }
    fn save(&self, root: &Path) -> Result<()> {
        model::save_json(root, &self.journal(), self)
    }
}
fn inventory(root: &Path) -> Result<(BTreeMap<String, Stamp>, Vec<String>)> {
    fn visit(
        root: &Path,
        relative: &str,
        result: &mut BTreeMap<String, Stamp>,
        dirs: &mut Vec<String>,
        total: &mut u64,
    ) -> Result<()> {
        if relative.split('/').count() > 32 || result.len() + dirs.len() > 20000 {
            return Err("暂存目录超过校验边界".into());
        }
        let directory = if relative.is_empty() {
            root.to_path_buf()
        } else {
            model::safe_path(root, relative)?
        };
        for item in fs::read_dir(directory).map_err(|_| "无法读取事务目录")? {
            let item = item.map_err(|_| "无法读取事务条目")?;
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| "事务文件名无效")?;
            let name = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            let target = model::safe_path(root, &name)?;
            if item
                .file_type()
                .map_err(|_| "无法读取事务文件类型")?
                .is_dir()
            {
                dirs.push(name.clone());
                visit(root, &name, result, dirs, total)?;
            } else {
                let entry = stamp(&target)?;
                *total = total.checked_add(entry.size).ok_or("事务大小溢出")?;
                if *total > 2 * LIMIT {
                    return Err("事务文件超过 2 GiB 校验上限".into());
                }
                result.insert(name, entry);
            }
        }
        Ok(())
    }
    let mut files = BTreeMap::new();
    let mut dirs = vec![];
    visit(root, "", &mut files, &mut dirs, &mut 0)?;
    Ok((files, dirs))
}
pub fn rollback(root: &Path, transaction: &Transaction) -> Result<()> {
    let stage = transaction.directory(root, false)?;
    let target = transaction.directory(root, true)?;
    if stage != target && stage.exists() && target.exists() {
        return Err("事务的两个位置同时存在，已保留供检查".into());
    }
    let directory = if stage.exists() { stage } else { target };
    if directory.exists() {
        if resource_install::file_identity(&directory)? != transaction.identity {
            return Err("事务目录身份已改变，未删除".into());
        }
        let (actual, mut dirs) = inventory(&directory)?;
        if actual != transaction.files {
            return Err("事务中存在外部改动或未记录文件，已全部保留".into());
        }
        for file in actual.keys() {
            fs::remove_file(model::safe_path(&directory, file)?)
                .map_err(|_| "无法清理已核对的暂存文件")?;
        }
        dirs.sort_by_key(|path| std::cmp::Reverse(path.len()));
        for dir in dirs {
            fs::remove_dir(model::safe_path(&directory, &dir)?)
                .map_err(|_| "暂存目录不为空，剩余内容保留")?;
        }
        fs::remove_dir(&directory).map_err(|_| "无法清理暂存目录")?;
    }
    fs::remove_file(model::safe_path(root, &transaction.journal())?)
        .map_err(|_| "无法清理整合包事务日志")?;
    Ok(())
}
pub fn recover(root: &Path, instances: &[Instance]) -> Result<Vec<String>> {
    let directory = model::safe_path(root, "pack-journals")?;
    let mut warnings = vec![];
    if !directory.exists() {
        return Ok(warnings);
    }
    for (index, entry) in fs::read_dir(directory)
        .map_err(|_| "无法读取整合包恢复记录")?
        .enumerate()
    {
        if index >= 100 {
            return Err("整合包待恢复事务超过 100 项，请检查数据目录".into());
        }
        let entry = entry.map_err(|_| "无法读取整合包恢复条目")?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "恢复日志文件名无效")?;
        let Some(token) = name.strip_suffix(".json").filter(|token| uuid(token)) else {
            warnings.push(format!("未识别的整合包日志 {name} 已保留"));
            continue;
        };
        let result = (|| -> Result<()> {
            let path = model::safe_path(root, &format!("pack-journals/{name}"))?;
            if fs::metadata(&path).map_err(|_| "恢复日志状态无效")?.len() > 8 * 1024 * 1024
            {
                return Err("恢复日志过大".into());
            }
            let transaction: Transaction =
                serde_json::from_reader(File::open(&path).map_err(|_| "恢复日志读取失败")?)
                    .map_err(|_| "恢复日志格式损坏")?;
            if transaction.token != token
                || !uuid(&transaction.instance.id)
                || transaction.files.len() > 20000
            {
                return Err("恢复日志内容无效".into());
            }
            if instances
                .iter()
                .any(|instance| instance.id == transaction.instance.id)
            {
                fs::remove_file(path).map_err(|_| "已提交事务日志清理失败")?;
                return Ok(());
            }
            rollback(root, &transaction)
        })();
        if let Err(error) = result {
            warnings.push(format!("整合包事务 {token}：{error}；请检查 pack-journals 与 pack-staging/instances，未删除不确定内容。"));
        }
    }
    Ok(warnings)
}
pub fn begin(root: &Path, plan: &Plan, instance: Instance) -> Result<Transaction> {
    if !uuid(&plan.token) || !uuid(&instance.id) {
        return Err("整合包事务标识无效".into());
    }
    let directory = model::safe_path(root, &format!("instances/{}", instance.id))?;
    fs::create_dir_all(directory.parent().ok_or("暂存父目录无效")?)
        .map_err(|_| "无法创建暂存父目录")?;
    fs::create_dir(&directory).map_err(|_| "暂存目录已存在，未覆盖")?;
    let transaction = Transaction {
        token: plan.token.clone(),
        instance,
        identity: resource_install::file_identity(&directory)?,
        files: BTreeMap::new(),
        in_place: true,
    };
    if let Err(error) = transaction.save(root) {
        let _ = fs::remove_dir(directory);
        return Err(error);
    }
    Ok(transaction)
}
fn copy(
    root: &Path,
    transaction: &mut Transaction,
    relative: &str,
    reader: impl Read,
    expected: Option<&Entry>,
    cancel: &CancellationToken,
) -> Result<()> {
    let directory = transaction.directory(root, false)?;
    let target = model::safe_path(&directory, relative)?;
    fs::create_dir_all(target.parent().ok_or("暂存文件目录无效")?)
        .map_err(|_| "无法创建暂存文件目录")?;
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .open(&target)
        .map_err(|_| "暂存目标已存在或不可写，未覆盖")?;
    let result = (|| -> Result<()> {
        let mut reader = reader.take(crate::file_picker::MAX_FILE + 1);
        let mut bytes = [0; 65536];
        let mut size = 0u64;
        let mut digest = Sha512::new();
        loop {
            if cancel.is_cancelled() {
                return Err("整合包安装已取消".into());
            }
            let count = reader.read(&mut bytes).map_err(|_| "整合包文件读取失败")?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > crate::file_picker::MAX_FILE
                || expected.is_some_and(|entry| size > entry.size)
            {
                return Err("暂存文件大小超过声明".into());
            }
            output
                .write_all(&bytes[..count])
                .map_err(|_| "暂存文件保存失败，可能磁盘空间不足")?;
            digest.update(&bytes[..count]);
        }
        let sum = format!("{:x}", digest.finalize());
        if expected.is_some_and(|entry| entry.size != size || entry.sha512 != sum) {
            return Err("整合包文件大小或 SHA-512 不一致".into());
        }
        output.sync_all().map_err(|_| "暂存文件同步失败")?;
        Ok(())
    })();
    transaction.files.insert(relative.into(), stamp(&target)?);
    transaction.save(root)?;
    drop(output);
    result
}
pub fn check_selection(plan: &Plan, selected: &[String]) -> Result<()> {
    if plan.created.elapsed() > Duration::from_secs(600) {
        return Err("整合包预览已过期，请重新检查".into());
    }
    let mut seen = HashSet::new();
    if selected.len() > 200
        || selected.iter().any(|path| {
            !seen.insert(path)
                || !plan
                    .files
                    .iter()
                    .any(|entry| entry.optional && entry.path == *path)
        })
    {
        return Err("可选文件选择不属于当前固定计划".into());
    }
    Ok(())
}
pub async fn stage(
    host: &Host,
    plan: &Plan,
    transaction: &mut Transaction,
    selected: &[String],
    cancel: &CancellationToken,
) -> Result<()> {
    check_selection(plan, selected)?;
    for (index, entry) in plan.files.iter().enumerate() {
        if entry.optional && !selected.contains(&entry.path) {
            continue;
        }
        if cancel.is_cancelled() {
            return Err("整合包安装已取消".into());
        }
        host.progress(
            "pack-files",
            &format!("准备 {}", entry.path),
            index,
            plan.files.len(),
        );
        let relative = format!("game/{}", entry.path);
        match &entry.data {
            Source::Download { url, sha1 } => {
                let cached = net::resource_download(
                    &host.client,
                    &host.root,
                    &net::Artifact {
                        url: url.clone(),
                        sha1: sha1.clone(),
                        size: Some(entry.size),
                        path: format!("pack-cache/{}.data", entry.sha512),
                    },
                    cancel,
                )
                .await?;
                copy(
                    &host.root,
                    transaction,
                    &relative,
                    File::open(cached).map_err(|_| "无法读取整合包缓存")?,
                    Some(entry),
                    cancel,
                )?;
            }
            Source::Archive(index) => {
                let mut guard = plan.input.file.lock().map_err(|_| "整合包快照不可用")?;
                let file = guard.as_mut().ok_or("整合包快照已释放")?;
                file.rewind().map_err(|_| "整合包快照读取失败")?;
                let mut zip = zip::ZipArchive::new(file).map_err(|_| "整合包快照损坏")?;
                let file = zip.by_index(*index).map_err(|_| "覆盖条目已变化")?;
                copy(
                    &host.root,
                    transaction,
                    &relative,
                    file,
                    Some(entry),
                    cancel,
                )?;
            }
        }
    }
    let directory = transaction.directory(&host.root, false)?;
    fs::create_dir_all(model::safe_path(&directory, "game")?).map_err(|_| "无法创建游戏目录")?;
    let provenance = serde_json::to_vec_pretty(&serde_json::json!({"pack":plan.name,"version":plan.pack_version,"archiveSha512":plan.archive_sha512,"origin":plan.origin,"files":plan.files.iter().filter(|entry| !entry.optional || selected.contains(&entry.path)).map(|entry| serde_json::json!({"path":entry.path,"sha512":entry.sha512,"source":entry.source})).collect::<Vec<_>>()})).map_err(|_| "来源记录编码失败")?;
    copy(
        &host.root,
        transaction,
        "game/.easycraft-pack.json",
        provenance.as_slice(),
        None,
        cancel,
    )?;
    resource_install::validate_pack_mods(
        &host.root,
        &model::safe_path(&directory, "game")?,
        &transaction.instance,
    )?;
    Ok(())
}
pub fn publish(
    root: &Path,
    transaction: &Transaction,
    instances: &[Instance],
    cancel: &CancellationToken,
) -> Result<Vec<Instance>> {
    if cancel.is_cancelled() {
        return Err("整合包安装已取消".into());
    }
    let current: Vec<Instance> = model::load_json(root, "instances.json")?;
    if current != instances {
        return Err("实例清单已被外部修改，未覆盖；请重新打开启动器检查".into());
    }
    let directory = transaction.directory(root, false)?;
    if resource_install::file_identity(&directory)? != transaction.identity
        || inventory(&directory)?.0 != transaction.files
    {
        return Err("暂存内容发生变化，未提交到游戏库".into());
    }
    let target = transaction.directory(root, true)?;
    fs::create_dir_all(target.parent().ok_or("实例父目录无效")?)
        .map_err(|_| "无法创建实例父目录")?;
    if directory != target {
        crate::content::move_no_replace(&directory, &target)?;
    }
    if resource_install::file_identity(&target)? != transaction.identity
        || inventory(&target)?.0 != transaction.files
    {
        return Err("提交期间暂存文件发生变化，未加入游戏库".into());
    }
    let mut updated = instances.to_vec();
    updated.push(transaction.instance.clone());
    model::save_json(root, "instances.json", &updated)?;
    // The atomic instance catalog is the commit marker; a retained journal is safe after this point.
    let _ = fs::remove_file(model::safe_path(root, &transaction.journal())?);
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    #[test]
    fn online_archive_is_bound_to_project_version_file_and_verified_metadata() {
        let file = json!({
            "filename":"fixture.mrpack", "size":12,
            "url":"https://cdn.modrinth.com/data/Proj1234/versions/Vers1234/fixture.mrpack",
            "hashes":{"sha1":"a".repeat(40),"sha512":"b".repeat(128)}
        });
        let metadata = json!({"id":"Vers1234","project_id":"Proj1234","files":[file]});
        let resolve =
            |value: &Value| online_artifact("Proj1234", "Vers1234", "fixture.mrpack", value);
        let (artifact, sha512) = resolve(&metadata).unwrap();
        assert_eq!(sha512, "b".repeat(128));
        assert_eq!(artifact.path, format!("pack-archives/{sha512}.mrpack"));
        assert_eq!(artifact.size, Some(12));
        assert_eq!(artifact.sha1, "a".repeat(40));
        for (field, value) in [("id", "Other123"), ("project_id", "Other123")] {
            let mut invalid = metadata.clone();
            invalid[field] = json!(value);
            assert!(resolve(&invalid).is_err());
        }
        let mut duplicate = metadata.clone();
        duplicate["files"]
            .as_array_mut()
            .unwrap()
            .push(metadata["files"][0].clone());
        assert!(resolve(&duplicate).is_err());
        for (field, value) in [
            ("size", json!(0)),
            ("size", json!(crate::file_picker::MAX_FILE + 1)),
            (
                "url",
                json!("https://cdn.modrinth.com.evil.example/data/fixture.mrpack"),
            ),
            (
                "hashes",
                json!({"sha1":"a".repeat(40),"sha512":"../unsafe"}),
            ),
        ] {
            let mut invalid = metadata.clone();
            invalid["files"][0][field] = value;
            assert!(resolve(&invalid).is_err());
        }
        for name in ["readme.txt", "../fixture.mrpack", "folder\\fixture.mrpack"] {
            assert!(online_artifact("Proj1234", "Vers1234", name, &metadata).is_err());
        }
    }
    #[tokio::test]
    async fn invalid_online_request_releases_task_without_creating_instance() {
        let root = root();
        let host = Host::new(root.clone()).unwrap();
        assert!(host
            .online_pack_preview(
                "../invalid".into(),
                "Vers1234".into(),
                "fixture.mrpack".into()
            )
            .await
            .is_err());
        assert_eq!(host.status().task.status, "failed");
        assert!(host.status().instances.is_empty());
        assert!(!root.join("instances.json").exists());
        let bytes = archive(&manifest(), &[]);
        assert!(host
            .pack_preview(inspect(&root, bytes.as_slice()).unwrap())
            .is_ok());
        drop(host);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "Requires the verified public Adrenaline archive and cached .native/integration resources"]
    async fn public_pack_stage_and_rollback_integration() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.native/integration");
        let host = Host::new(root).unwrap();
        let mut instance = host
            .status()
            .instances
            .iter()
            .find(|instance| instance.version == "1.21.1")
            .unwrap()
            .clone();
        instance.id = uuid::Uuid::new_v4().to_string();
        instance.fabric_version = "0.19.5".into();
        let directory = host.root.join("loaders/fabric");
        instance.fabric_sha1 = fs::read_dir(directory)
            .unwrap()
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                let value: Value = serde_json::from_reader(File::open(&path).ok()?).ok()?;
                if value["id"] == "fabric-loader-0.19.5-1.21.1" {
                    Some(path.file_stem()?.to_str()?.to_string())
                } else {
                    None
                }
            })
            .next()
            .unwrap();
        let bytes = fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../.native/fixtures/adrenaline-1.21.1.mrpack"),
        )
        .unwrap();
        let plan = inspect(&host.root, bytes.as_slice())
            .unwrap()
            .install
            .unwrap();
        let mut tx = begin(&host.root, &plan, instance).unwrap();
        let cancel = CancellationToken::new();
        stage(&host, &plan, &mut tx, &[], &cancel).await.unwrap();
        let directory = tx.directory(&host.root, false).unwrap();
        assert_eq!(inventory(&directory).unwrap().0, tx.files);
        rollback(&host.root, &tx).unwrap();
        assert!(!directory.exists());
    }
    fn root() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/modpack-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn manifest() -> Value {
        json!({"formatVersion":1,"game":"minecraft","name":"EC transaction fixture","versionId":"1.0.0","dependencies":{"minecraft":"1.21.1"},"files":[]})
    }
    fn archive(manifest: &Value, files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("modrinth.index.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(manifest).unwrap())
            .unwrap();
        for (path, bytes) in files {
            zip.start_file(*path, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    fn instance() -> Instance {
        Instance {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Pack fixture".into(),
            version: "1.21.1".into(),
            manifest_sha1: "1".repeat(40),
            java_major: 21,
            fabric_version: String::new(),
            fabric_sha1: String::new(),
            launch: Default::default(),
        }
    }
    fn download(path: &str, env: Value) -> Value {
        json!({"path":path,"hashes":{"sha1":"1".repeat(40),"sha512":"2".repeat(128)},"fileSize":12,"downloads":["https://cdn.modrinth.com/data/fixture/file.jar"],"env":env})
    }
    #[test]
    fn parser_merges_client_layers_and_rejects_ambiguous_or_unsupported_inputs() {
        let root = root();
        let mut value = manifest();
        value["files"] = json!([
            download("config/test.json", json!({"client":"required"})),
            download("mods/optional.jar", json!({"client":"optional"})),
            download(
                "mods/server.jar",
                json!({"client":"unsupported","server":"required"})
            )
        ]);
        let bytes = archive(
            &value,
            &[
                ("overrides/config/test.json", b"common"),
                ("client-overrides/config/test.json", b"client"),
                ("server-overrides/server-only.txt", b"never"),
            ],
        );
        let preview = inspect(&root, bytes.as_slice()).unwrap();
        let plan = preview.install.unwrap();
        assert_eq!(plan.files.len(), 2);
        assert_eq!(plan.files[0].source, "client-override");
        assert_eq!(
            plan.files[0].sha512,
            format!("{:x}", Sha512::digest(b"client"))
        );
        assert!(plan.files[1].optional);
        check_selection(&plan, &["mods/optional.jar".into()]).unwrap();
        assert!(check_selection(&plan, &["mods/server.jar".into()]).is_err());
        assert!(check_selection(
            &plan,
            &["mods/optional.jar".into(), "mods/optional.jar".into()]
        )
        .is_err());
        assert!(fs::write(&plan.input.path, b"tamper").is_err());
        drop(plan);
        assert_eq!(fs::read_dir(root.join("pack-inputs")).unwrap().count(), 0);
        for (files, expected) in [
            (
                vec![
                    ("overrides/config/a", b"x".as_slice()),
                    ("client-overrides/CONFIG/a", b"y".as_slice()),
                ],
                "大小写",
            ),
            (
                vec![
                    ("overrides/config", b"x".as_slice()),
                    ("overrides/config/a", b"y".as_slice()),
                ],
                "目录目标冲突",
            ),
            (
                vec![("overrides/.easycraft-resources.json", b"{}".as_slice())],
                "保留",
            ),
        ] {
            let bytes = archive(&manifest(), &files);
            let preview = inspect(&root, bytes.as_slice()).unwrap();
            assert!(preview.install.is_none());
            assert!(preview
                .warnings
                .iter()
                .any(|warning| warning.contains(expected)));
        }
        let mut unsupported = manifest();
        unsupported["dependencies"]["forge"] = json!("47.0.0");
        let preview = inspect(&root, archive(&unsupported, &[]).as_slice()).unwrap();
        assert!(preview.install.is_none());
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("其他加载器")));
        let mut invalid = manifest();
        invalid["files"] = json!([download("a.txt", json!({"client":"unknown"}))]);
        assert!(inspect(&root, archive(&invalid, &[]).as_slice())
            .unwrap()
            .install
            .is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn staged_pack_publish_cancel_recovery_and_foreign_changes_preserve_existing_instances() {
        let root = root();
        let host = Host::new(root.clone()).unwrap();
        let bytes = archive(
            &manifest(),
            &[
                ("overrides/config/example.json", b"common"),
                ("client-overrides/config/example.json", b"client"),
                ("overrides/options.txt", b"soundCategory_master:0.5\n"),
            ],
        );
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.native/fixtures");
        fs::create_dir_all(&fixture).unwrap();
        fs::write(fixture.join("installable.mrpack"), &bytes).unwrap();
        let preview = inspect(&root, bytes.as_slice()).unwrap();
        let plan = preview.install.unwrap();
        let item = instance();
        let cancel = CancellationToken::new();
        let mut tx = begin(&root, &plan, item.clone()).unwrap();
        stage(&host, &plan, &mut tx, &[], &cancel).await.unwrap();
        let stage_root = tx.directory(&root, false).unwrap();
        assert_eq!(
            fs::read(stage_root.join("game/config/example.json")).unwrap(),
            b"client"
        );
        assert!(!root.join("instances.json").exists());
        let updated = publish(&root, &tx, &[], &cancel).unwrap();
        assert_eq!(updated, vec![item.clone()]);
        assert_eq!(
            model::load_json::<Vec<Instance>>(&root, "instances.json").unwrap(),
            updated
        );
        let committed = root.join(format!("instances/{}/game/config/example.json", item.id));
        assert_eq!(fs::read(&committed).unwrap(), b"client");
        // A journal left after the catalog commit may never roll the instance back.
        tx.save(&root).unwrap();
        assert!(recover(&root, &updated).unwrap().is_empty());
        assert!(committed.exists());
        drop(plan);
        for foreign in [false, true] {
            let plan = inspect(&root, bytes.as_slice()).unwrap().install.unwrap();
            let mut tx = begin(&root, &plan, instance()).unwrap();
            stage(&host, &plan, &mut tx, &[], &cancel).await.unwrap();
            let staged = tx.directory(&root, false).unwrap();
            let final_dir = tx.directory(&root, true).unwrap();
            if staged != final_dir {
                crate::content::move_no_replace(&staged, &final_dir).unwrap();
            }
            if foreign {
                fs::write(
                    final_dir.join("game/config/example.json"),
                    b"external change",
                )
                .unwrap();
            }
            let warnings = recover(&root, &updated).unwrap();
            assert_eq!(warnings.is_empty(), !foreign);
            assert_eq!(final_dir.exists(), foreign);
            if foreign {
                assert_eq!(
                    fs::read(final_dir.join("game/config/example.json")).unwrap(),
                    b"external change"
                );
            }
        }
        let plan = inspect(&root, bytes.as_slice()).unwrap().install.unwrap();
        let mut tx = begin(&root, &plan, instance()).unwrap();
        stage(&host, &plan, &mut tx, &[], &cancel).await.unwrap();
        assert!(publish(&root, &tx, &[], &cancel)
            .unwrap_err()
            .contains("外部修改"));
        rollback(&root, &tx).unwrap();
        drop(plan);
        let plan = inspect(&root, bytes.as_slice()).unwrap().install.unwrap();
        let mut tx = begin(&root, &plan, instance()).unwrap();
        struct CancelRead(CancellationToken);
        impl Read for CancelRead {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                bytes[0] = 42;
                self.0.cancel();
                Ok(1)
            }
        }
        let cancelled = CancellationToken::new();
        assert!(copy(
            &root,
            &mut tx,
            "game/partial.txt",
            CancelRead(cancelled.clone()),
            None,
            &cancelled
        )
        .is_err());
        let temp = tx.directory(&root, false).unwrap();
        assert!(temp.join("game/partial.txt").exists());
        rollback(&root, &tx).unwrap();
        assert!(!temp.exists());
        assert_eq!(fs::read(committed).unwrap(), b"client");
        drop(plan);
        drop(host);
        let reopened = Host::new(root.clone()).unwrap();
        assert_eq!(reopened.status().task.phase, "pack-recovery");
        assert!(reopened
            .status()
            .task
            .logs
            .iter()
            .any(|line| line.contains("外部改动")));
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }
}
