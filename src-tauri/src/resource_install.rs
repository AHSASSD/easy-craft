use crate::{
    content,
    host::Host,
    model::{self, Instance, Result},
    net,
    resources::{self, Kind},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Digest as Sha1Digest;
use sha2::{Digest, Sha512};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    os::windows::io::AsRawHandle,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const CATALOG: &str = ".easycraft-resources.json";
const PENDING: &str = ".easycraft-pending";
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub project: String,
    pub version: String,
    pub path: String,
    pub size: u64,
    pub sha512: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    transaction: String,
    files: Vec<Record>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    #[serde(flatten)]
    pub record: Record,
    pub action: String,
    pub sha1: String,
    #[serde(skip)]
    url: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub token: String,
    pub instance_id: String,
    pub game_version: String,
    #[serde(skip)]
    pub(crate) game_isolation: bool,
    pub world_id: Option<String>,
    pub data_format: Option<content::PackVersion>,
    pub files: Vec<Entry>,
    pub warnings: Vec<String>,
    pub preflight: Option<ModCheck>,
    #[serde(skip)]
    approved_issues: bool,
    pub local: bool,
    #[serde(skip)]
    local_paths: Vec<PathBuf>,
    #[serde(skip)]
    snapshot: BTreeMap<String, String>,
    #[serde(skip)]
    kind: Kind,
    #[serde(skip)]
    created: Instant,
    #[serde(skip)]
    pub(crate) java_path: String,
    #[serde(skip)]
    java_major: u32,
    #[serde(skip)]
    fabric_version: String,
    #[serde(skip)]
    bundled: Vec<Value>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    token: String,
    added: Vec<Record>,
}
impl Plan {
    pub(crate) fn approve_issues(&mut self, acknowledged: bool) -> Result<()> {
        if self.kind != Kind::Mod {
            return Ok(());
        }
        let report = self.preflight.as_ref().ok_or("请先完成 Mod 安装预检")?;
        if report.instance_id != self.instance_id {
            return Err("预检报告不属于当前实例".into());
        }
        if !report.issues.is_empty() && !acknowledged {
            return Err("预检发现 Mod 声明问题，请阅读报告并明确选择仍然安装".into());
        }
        self.approved_issues = acknowledged && !report.issues.is_empty();
        Ok(())
    }
}
fn scope(kind: Kind) -> Result<(content::Kind, &'static str)> {
    match kind {
        Kind::Mod => Ok((content::Kind::Mods, "mods")),
        Kind::Resourcepack => Ok((content::Kind::Resourcepacks, "resourcepacks")),
        Kind::Shader => Ok((content::Kind::Shaderpacks, "shaderpacks")),
        Kind::Datapack => Ok((content::Kind::Datapacks, "datapacks")),
        _ => Err("此类资源需要独立的整合包或世界安装流程".into()),
    }
}
pub fn sum(path: &Path) -> Result<String> {
    let mut input = fs::File::open(path).map_err(|_| "无法读取资源校验")?;
    if input.metadata().map_err(|_| "无法读取资源大小")?.len() > 512 * 1024 * 1024 {
        return Err("单个资源超过 512 MiB 上限".into());
    }
    let mut digest = Sha512::new();
    let mut bytes = [0; 65536];
    let mut read_bytes = 0usize;
    loop {
        let count = input.read(&mut bytes).map_err(|_| "资源校验读取失败")?;
        if count == 0 {
            break;
        }
        read_bytes += count;
        if read_bytes > 512 * 1024 * 1024 {
            return Err("资源校验期间文件超出大小上限".into());
        }
        digest.update(&bytes[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}
fn checked_record(root: &Path, record: &Record) -> Result<PathBuf> {
    resources::id(&record.project)?;
    resources::id(&record.version)?;
    let (dir, file) = record.path.split_once('/').ok_or("安装记录路径无效")?;
    if !["mods", "resourcepacks", "shaderpacks", "datapacks"].contains(&dir)
        || file.is_empty()
        || file.len() > 240
        || file.contains(['/', '\\'])
        || record.sha512.len() != 128
        || !record.sha512.bytes().all(|b| b.is_ascii_hexdigit())
        || record.size > 512 * 1024 * 1024
    {
        return Err("安装记录字段无效".into());
    }
    model::safe_path(root, &record.path)
}
fn catalog(root: &Path) -> Result<Catalog> {
    let path = model::safe_path(root, CATALOG)?;
    if path.exists() && fs::metadata(&path).map_err(|_| "无法读取安装记录")?.len() > 2 * 1024 * 1024
    {
        return Err("安装记录过大".into());
    }
    let value: Catalog = model::load_json(root, CATALOG)?;
    if value.files.len() > 1000 {
        return Err("安装记录过多".into());
    }
    for item in &value.files {
        checked_record(root, item)?;
    }
    Ok(value)
}
fn inventory(root: &Path, kind: Kind) -> Result<BTreeMap<String, String>> {
    let (_, dir) = scope(kind)?;
    let path = model::safe_path(root, dir)?;
    let mut result = BTreeMap::new();
    if kind == Kind::Datapack {
        result.insert(
            "level.dat".into(),
            sum(&model::safe_path(root, "level.dat")?)?,
        );
    }
    let mut total = 0u64;
    if path.exists() {
        for (index, item) in fs::read_dir(path)
            .map_err(|_| "无法读取目标目录")?
            .enumerate()
        {
            if index >= 1000 {
                return Err("目标目录超过 1000 项".into());
            }
            let item = item.map_err(|_| "目录读取失败")?;
            let file = item
                .file_name()
                .into_string()
                .map_err(|_| "资源文件名无效")?;
            let relative = format!("{dir}/{file}");
            let path = model::safe_path(root, &relative)?;
            let meta = fs::metadata(&path).map_err(|_| "资源状态读取失败")?;
            total = total.checked_add(meta.len()).ok_or("资源大小溢出")?;
            if total > 2 * 1024 * 1024 * 1024 {
                return Err("目标目录超过 2 GiB 自动校验上限".into());
            }
            result.insert(
                relative,
                if meta.is_file() {
                    sum(&path)?
                } else {
                    "directory".into()
                },
            );
        }
    }
    let records = model::safe_path(root, CATALOG)?;
    result.insert(
        CATALOG.into(),
        if records.exists() {
            sum(&records)?
        } else {
            "missing".into()
        },
    );
    Ok(result)
}
struct Resolver<'a> {
    client: &'a reqwest::Client,
    instance: &'a Instance,
    kind: Kind,
    cancel: &'a CancellationToken,
    selected: BTreeMap<String, String>,
    active: HashSet<String>,
    files: Vec<Entry>,
    warnings: Vec<String>,
    conflicts: Vec<(Option<String>, Option<String>)>,
    installed: Vec<Record>,
}
impl Resolver<'_> {
    async fn version(&self, version: &str) -> Result<Value> {
        resources::id(version)?;
        let value = net::resource_json(
            self.client,
            &format!("https://api.modrinth.com/v2/version/{version}"),
            self.cancel,
        )
        .await?;
        if resources::text(&value, "id", 64)? != version {
            return Err("版本 ID 与响应不符".into());
        }
        Ok(value)
    }
    async fn dependency(&mut self, dep: &Value) -> Result<Value> {
        let project = dep.get("project_id").and_then(Value::as_str);
        if let Some(version) = dep.get("version_id").and_then(Value::as_str) {
            let value = self.version(version).await?;
            if project.is_some_and(|id| value["project_id"].as_str() != Some(id)) {
                return Err("固定依赖版本不属于声明项目".into());
            }
            return Ok(value);
        }
        let project = project.ok_or("必需依赖没有可解析的项目或版本 ID")?;
        resources::id(project)?;
        if let Some(version) = self.selected.get(project).cloned().or_else(|| {
            self.installed
                .iter()
                .find(|r| r.project == project)
                .map(|r| r.version.clone())
        }) {
            return self.version(&version).await;
        }
        let mut url = reqwest::Url::parse(&format!(
            "https://api.modrinth.com/v2/project/{project}/version"
        ))
        .map_err(|_| "依赖地址无效")?;
        url.query_pairs_mut()
            .append_pair("game_versions", &json!([self.instance.version]).to_string())
            .append_pair("loaders", &json!(self.kind.loaders()).to_string())
            .append_pair("include_changelog", "false");
        let values = net::resource_json(self.client, url.as_str(), self.cancel).await?;
        let rows = values
            .as_array()
            .filter(|rows| rows.len() <= 1000)
            .ok_or("依赖版本列表无效")?;
        let value = rows
            .iter()
            .filter(|row| row["version_type"] == "release")
            .max_by_key(|row| row["date_published"].as_str().unwrap_or(""))
            .ok_or("必需依赖没有匹配条件的正式版；请另选资源版本")?
            .clone();
        self.warnings.push(format!(
            "依赖未固定版本；计划选用匹配游戏和加载器的正式版 {}，提交前还会检查 JAR 约束。",
            resources::text(&value, "name", 512)?
        ));
        Ok(value)
    }
    async fn visit(&mut self, value: Value, filename: Option<&str>, depth: usize) -> Result<()> {
        let project = resources::text(&value, "project_id", 64)?;
        resources::id(&project)?;
        let version = resources::text(&value, "id", 64)?;
        resources::id(&version)?;
        if self.active.contains(&project) {
            return Err(format!("依赖形成循环：{project}"));
        }
        if let Some(existing) = self.selected.get(&project) {
            return if existing == &version {
                Ok(())
            } else {
                Err(format!("依赖要求同一项目的不同版本：{project}"))
            };
        }
        if depth > 12 || self.selected.len() >= 64 {
            return Err("依赖超过 12 层或 64 个项目上限".into());
        }
        if resources::parse_versions(
            &json!([value.clone()]),
            &project,
            self.kind,
            &self.instance.version,
        )?
        .is_empty()
        {
            return Err(format!("资源版本不兼容目标游戏/加载器：{version}"));
        }
        if value["environment"] == "dedicated_server_only" {
            return Err("此版本仅适用于独立服务器".into());
        }
        if value["environment"].as_str().is_none_or(|v| v == "unknown") {
            self.warnings.push(format!(
                "版本 {} 未标明运行环境，请核对作者说明。",
                resources::text(&value, "name", 512)?
            ));
        }
        if self
            .installed
            .iter()
            .any(|r| r.project == project && r.version != version)
        {
            return Err(format!(
                "项目 {project} 已有另一版本；请先在本地管理中禁用旧版本，再重新预览"
            ));
        }
        self.active.insert(project.clone());
        self.selected.insert(project.clone(), version.clone());
        let files = value["files"].as_array().ok_or("版本文件无效")?;
        let file = if let Some(name) = filename {
            files
                .iter()
                .find(|f| f["filename"].as_str() == Some(name))
                .ok_or("所选文件不属于固定版本")?
        } else {
            files
                .iter()
                .find(|f| f["primary"] == true)
                .or_else(|| files.first())
                .ok_or("版本没有文件")?
        };
        let name = resources::text(file, "filename", 240)?;
        let (_, dir) = scope(self.kind)?;
        if name.contains(['/', '\\'])
            || !(if self.kind == Kind::Mod {
                name.to_ascii_lowercase().ends_with(".jar")
            } else {
                name.to_ascii_lowercase().ends_with(".zip")
            })
        {
            return Err("资源文件名或扩展名与类别不符".into());
        }
        let hash = file
            .pointer("/hashes/sha512")
            .and_then(Value::as_str)
            .ok_or("资源缺少 SHA-512")?
            .to_ascii_lowercase();
        let record = Record {
            project: project.clone(),
            version,
            path: format!("{dir}/{name}"),
            size: file["size"].as_u64().ok_or("资源大小无效")?,
            sha512: hash,
        };
        checked_record(Path::new("C:/EasyCraftValidation"), &record)?;
        if self
            .files
            .iter()
            .any(|entry| entry.record.path.eq_ignore_ascii_case(&record.path))
        {
            return Err("依赖文件名重复或大小写冲突".into());
        }
        let url = resources::text(file, "url", 2048)?;
        net::resource_download_url(&url)?;
        self.files.push(Entry {
            record,
            action: "add".into(),
            sha1: file["hashes"]["sha1"].as_str().ok_or("缺少 SHA-1")?.into(),
            url,
        });
        for dep in value["dependencies"].as_array().ok_or("依赖格式无效")? {
            match dep["dependency_type"].as_str() {
                Some("required") => {
                    let raw = self.dependency(dep).await?;
                    Box::pin(self.visit(raw, None, depth + 1)).await?;
                }
                Some("incompatible") => self.conflicts.push((
                    dep["project_id"].as_str().map(str::to_string),
                    dep["version_id"].as_str().map(str::to_string),
                )),
                Some("optional" | "embedded") => {}
                _ => return Err("依赖类型无效".into()),
            }
        }
        self.active.remove(&project);
        Ok(())
    }
}
pub async fn prepare(
    host: &Host,
    instance: Instance,
    kind: Kind,
    version: &str,
    filename: &str,
    world_id: Option<String>,
) -> Result<Plan> {
    scope(kind)?;
    if (kind == Kind::Datapack) != world_id.is_some() {
        return Err("数据包必须明确选择目标世界，其他资源不能指定世界".into());
    }
    if kind == Kind::Mod && instance.fabric_version.is_empty() {
        return Err("模组安装需要 Fabric 实例".into());
    }
    let java_path = instance.launch.resolve(&host.status().settings).java_path;
    let java_major = if kind == Kind::Mod {
        crate::minecraft::probe_java(&java_path).await?.major
    } else {
        0
    };
    let (snapshot, records) = host.instance_files(&instance.id, |root| {
        let _locks = crate::worlds::lock_worlds(root)?;
        recover_all(root)?;
        let target = target_root(root, world_id.as_deref())?;
        Ok((inventory(&target, kind)?, catalog(&target)?))
    })?;
    let world_version = if kind == Kind::Datapack {
        Some(crate::minecraft::datapack_version(host, &instance)?)
    } else {
        None
    };
    let world_data = if let Some(world) = &world_id {
        Some(host.instance_files(&instance.id, |root| {
            crate::worlds::data_version(&crate::worlds::selected_world(root, world)?)
        })?)
    } else {
        None
    };
    if world_data
        .zip(world_version.as_ref())
        .is_some_and(|(world, game)| world > game.world)
    {
        return Err("所选世界来自较新游戏版本，请选择匹配的实例；世界未修改".into());
    }
    let installed = records
        .files
        .into_iter()
        .filter(|r| snapshot.get(&r.path) == Some(&r.sha512))
        .collect();
    let cancel = CancellationToken::new();
    let mut resolver = Resolver {
        client: &host.client,
        instance: &instance,
        kind,
        cancel: &cancel,
        selected: BTreeMap::new(),
        active: HashSet::new(),
        files: vec![],
        warnings: vec![],
        conflicts: vec![],
        installed,
    };
    let root = resolver.version(version).await?;
    tokio::time::timeout(
        Duration::from_secs(90),
        resolver.visit(root, Some(filename), 0),
    )
    .await
    .map_err(|_| "依赖解析超时，请重试")??;
    for (project, version) in &resolver.conflicts {
        if project.is_none() && version.is_none() {
            return Err("冲突项未提供身份，无法安全自动安装".into());
        }
        if resolver
            .files
            .iter()
            .map(|f| &f.record)
            .chain(resolver.installed.iter())
            .any(|r| {
                project.as_ref().is_none_or(|p| p == &r.project)
                    && version.as_ref().is_none_or(|v| v == &r.version)
            })
        {
            return Err("计划或已安装资源命中声明的不兼容项目/版本".into());
        }
    }
    let mut total = 0u64;
    for entry in &mut resolver.files {
        total += entry.record.size;
        if total > 1024 * 1024 * 1024 {
            return Err("本次资源超过 1 GiB 上限".into());
        }
        if let Some(hash) = snapshot.get(&entry.record.path) {
            if hash == &entry.record.sha512 {
                entry.action = "keep".into();
            } else {
                return Err(format!(
                    "目标文件已存在且内容不同，未覆盖：{}",
                    entry.record.path
                ));
            }
        }
    }
    resolver.warnings.push(
        "可选依赖不自动安装，内置依赖不重复下载；仅检查声明条件，不保证所有模组组合可运行。".into(),
    );
    if kind == Kind::Shader {
        resolver
            .warnings
            .push("保存光影 ZIP 不等于启用；还需游戏中安装并配置对应 Iris/OptiFine。".into());
    }
    if kind == Kind::Datapack {
        resolver.warnings.push("仅把数据包保存到所选世界；不修改 level.dat 的启用列表，是否启用及运行效果须在游戏内确认。".into());
        if world_data
            .zip(world_version.as_ref())
            .is_some_and(|(world, game)| world < game.world)
        {
            resolver
                .warnings
                .push("世界数据版本早于目标游戏；首次进入可能升级世界，请先备份。".into());
        }
    }
    let mut plan = Plan {
        token: uuid::Uuid::new_v4().to_string(),
        instance_id: instance.id.clone(),
        game_version: instance.version.clone(),
        game_isolation: instance.isolated(),
        world_id,
        data_format: world_version.map(|v| v.format),
        files: resolver.files,
        warnings: resolver.warnings,
        preflight: None,
        approved_issues: false,
        local: false,
        local_paths: vec![],
        snapshot,
        kind,
        created: Instant::now(),
        java_path,
        java_major,
        fabric_version: instance.fabric_version.clone(),
        bundled: if kind == Kind::Mod {
            bundled_metadata(&host.root, &instance)?
        } else {
            vec![]
        },
    };
    if kind == Kind::Mod {
        let cancel = CancellationToken::new();
        let paths = tokio::time::timeout(
            Duration::from_secs(120),
            download_files(host, &plan, &cancel, false),
        )
        .await
        .map_err(|_| "安装预检下载超时，请重试")??;
        plan.preflight = Some(host.instance_files(&instance.id, |root| {
            preflight_install(root, &instance, &plan, &paths)
        })?);
    }
    Ok(plan)
}
pub async fn download(
    host: &Host,
    plan: &Plan,
    cancel: &CancellationToken,
) -> Result<Vec<PathBuf>> {
    download_files(host, plan, cancel, true).await
}
async fn download_files(
    host: &Host,
    plan: &Plan,
    cancel: &CancellationToken,
    progress: bool,
) -> Result<Vec<PathBuf>> {
    if plan.created.elapsed() > Duration::from_secs(600) {
        return Err("安装预览已过期，请重新生成".into());
    }
    if plan.local || !plan.local_paths.is_empty() {
        if plan.local_paths.len() != plan.files.len() {
            return Err("本地预检缓存不完整，请重新预览".into());
        }
        for (entry, path) in plan.files.iter().zip(&plan.local_paths) {
            if cancel.is_cancelled() {
                return Err("安装已取消".into());
            }
            if fs::metadata(path)
                .map_err(|_| "本地预检缓存已清理，请重新选择文件")?
                .len()
                != entry.record.size
                || sum(path)? != entry.record.sha512
            {
                return Err("本地预检缓存已变化，请重新选择文件".into());
            }
        }
        return Ok(plan.local_paths.clone());
    }
    let mut paths = vec![];
    for (index, entry) in plan.files.iter().enumerate() {
        if progress {
            host.progress(
                "resources-download",
                &format!("下载并校验 {}", entry.record.path),
                index,
                plan.files.len(),
            );
        }
        let path = net::resource_download(
            &host.client,
            &host.root,
            &net::Artifact {
                url: entry.url.clone(),
                sha1: entry.sha1.clone(),
                size: Some(entry.record.size),
                path: format!("cache/modrinth/{}.bin", entry.record.sha512),
            },
            cancel,
        )
        .await?;
        if sum(&path)? != entry.record.sha512 {
            return Err("SHA-512 校验失败，未安装".into());
        }
        let input = fs::File::open(&path).map_err(|_| "缓存文件不可读")?;
        if matches!(plan.kind, resources::Kind::Mod) {
            crate::packs::preview_mod_reader(input)?;
        } else {
            crate::packs::preview_resource_reader(input)?;
        }
        let mut zip = zip::ZipArchive::new(fs::File::open(&path).map_err(|_| "缓存读取失败")?)
            .map_err(|_| "资源不是有效 ZIP")?;
        content::validate_archive(scope(plan.kind)?.0, &mut zip)?;
        if let Some(expected) = plan.data_format {
            let entry = zip
                .by_name("pack.mcmeta")
                .map_err(|_| "数据包缺少 pack.mcmeta")?;
            let metadata: Value = serde_json::from_reader(entry.take(512 * 1024 + 1))
                .map_err(|_| "数据包元数据无效")?;
            content::validate_pack_target(&metadata, true, expected)?;
        }
        paths.push(path);
    }
    Ok(paths)
}
pub(crate) fn file_identity(path: &Path) -> Result<(u32, u32, u32)> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|_| "无法读取事务文件标识")?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err("无法核对事务文件身份".into());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}
fn parsed_version(value: &str) -> Result<(semver::Version, bool)> {
    let raw = value.split('+').next().unwrap_or(value);
    let (core, pre) = raw
        .split_once('-')
        .map(|(c, p)| (c, Some(p)))
        .unwrap_or((raw, None));
    let mut parts: Vec<_> = core.split('.').collect();
    while parts.len() < 3 {
        parts.push("0");
    }
    let empty = pre == Some("");
    let suffix = pre
        .map(|p| format!("-{}", if p.is_empty() { "0" } else { p }))
        .unwrap_or_default();
    let parsed = semver::Version::parse(&format!("{}{suffix}", parts.join(".")))
        .map_err(|_| "无法自动比较此 Fabric 版本格式；请核对版本后手动管理")?;
    Ok((parsed, empty))
}
fn satisfies(version: &str, predicate: &Value) -> Result<bool> {
    if let Some(values) = predicate.as_array() {
        if values.len() > 64 {
            return Err("版本条件过多".into());
        }
        let matches: Result<Vec<bool>> = values
            .iter()
            .map(|value| satisfies(version, value))
            .collect();
        return Ok(matches?.into_iter().any(|matched| matched));
    }
    let expression = predicate
        .as_str()
        .filter(|v| v.len() <= 512)
        .ok_or("模组版本条件无效")?;
    if expression == "*" || expression == version {
        return Ok(true);
    }
    let (version, empty) = parsed_version(version)?;
    let mut matched = true;
    for part in expression.split_whitespace() {
        let condition = part.replace(".x", ".*").replace(".X", ".*");
        // Fabric ~ fixes major/minor; ^ fixes major even when major is zero.
        // Unlike npm/semver ranges, an empty prerelease suffix is meaningful.
        if let Some(bound) = condition.strip_prefix(['~', '^']) {
            let (lower, lower_empty) = parsed_version(bound)?;
            let order = version
                .cmp_precedence(&lower)
                .then_with(|| lower_empty.cmp(&empty));
            matched &= !order.is_lt()
                && version.major == lower.major
                && (condition.starts_with('^') || version.minor == lower.minor);
            continue;
        }
        if !condition.contains('*') && !condition.starts_with(['~', '^']) {
            let operator = [">=", "<=", ">", "<", "="]
                .into_iter()
                .find(|op| condition.starts_with(op))
                .unwrap_or("=");
            let bound = condition.trim_start_matches(['>', '<', '=']);
            let (other, other_empty) = parsed_version(bound)?;
            let order = version
                .cmp_precedence(&other)
                .then_with(|| other_empty.cmp(&empty));
            matched &= match operator {
                ">=" => !order.is_lt(),
                "<=" => !order.is_gt(),
                ">" => order.is_gt(),
                "<" => order.is_lt(),
                _ => order.is_eq(),
            };
            continue;
        }
        let requirement = semver::VersionReq::parse(&condition)
            .map_err(|_| format!("暂不能自动解析 Fabric 版本条件：{expression}"))?;
        matched &= requirement.matches(&version);
    }
    if expression.trim().is_empty() {
        return Err("版本条件为空".into());
    }
    Ok(matched)
}
#[derive(Clone)]
pub(crate) struct ModMetadata {
    pub(crate) value: Value,
    pub(crate) nested: bool,
}
pub(crate) fn mod_metadata<R: Read + std::io::Seek>(
    input: R,
    result: &mut Vec<ModMetadata>,
    depth: usize,
    expanded: &mut u64,
) -> Result<()> {
    if depth > 4 || result.len() >= 512 {
        return Err("模组内置依赖超过校验上限".into());
    }
    let mut zip = zip::ZipArchive::new(input).map_err(|_| "模组 ZIP 无效")?;
    if zip.len() > crate::packs::MAX_RESOURCE_ENTRIES {
        return Err("模组归档条目超过检查上限".into());
    }
    let metadata = content::fabric_metadata(&mut zip)?;
    let id = resources::text(&metadata, "id", 128)?;
    if id.is_empty() {
        return Err("模组 ID 为空".into());
    }
    resources::text(&metadata, "version", 128)?;
    if let Some(jars) = metadata.get("jars") {
        for jar in jars
            .as_array()
            .filter(|v| v.len() <= 128)
            .ok_or("内置模组列表无效")?
        {
            let name = resources::text(jar, "file", 256)?;
            model::safe_path(Path::new("C:/EasyCraftJarCheck"), &name)?;
            let entry = zip.by_name(&name).map_err(|_| "声明的内置模组不存在")?;
            *expanded = expanded
                .checked_add(entry.size())
                .ok_or("内置模组大小溢出")?;
            if entry.size() > 64 * 1024 * 1024 || *expanded > 256 * 1024 * 1024 {
                return Err("内置模组解压超过上限".into());
            }
            let mut bytes = vec![];
            entry
                .take(64 * 1024 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "内置模组读取失败")?;
            if bytes.len() > 64 * 1024 * 1024 {
                return Err("内置模组实际大小超过上限".into());
            }
            mod_metadata(std::io::Cursor::new(bytes), result, depth + 1, expanded)?;
        }
    }
    if result.len() >= 512 {
        return Err("模组内置依赖超过校验上限".into());
    }
    result.push(ModMetadata {
        value: metadata,
        nested: depth > 0,
    });
    Ok(())
}
#[cfg(test)]
fn validate_mods(root: &Path, instance: &Instance, plan: &Plan, paths: &[PathBuf]) -> Result<()> {
    validate_mod_files(
        root,
        instance,
        plan.java_major,
        &plan.files,
        paths,
        &plan.bundled,
    )
}
pub(crate) fn bundled_metadata(cache: &Path, instance: &Instance) -> Result<Vec<Value>> {
    let Some(path) = crate::fabric::loader_archive(cache, instance)? else {
        return Ok(vec![]);
    };
    let mut values = vec![];
    mod_metadata(
        fs::File::open(path).map_err(|_| "无法读取加载器归档")?,
        &mut values,
        0,
        &mut 0,
    )?;
    let root = values.pop().ok_or("加载器缺少元数据")?;
    if root.value["id"] != "fabricloader" || root.value["version"] != instance.fabric_version {
        return Err("加载器自身元数据不匹配".into());
    }
    Ok(values.into_iter().map(|metadata| metadata.value).collect())
}
pub(crate) fn validate_pack_mods(
    cache: &Path,
    root: &Path,
    instance: &Instance,
) -> Result<Vec<String>> {
    let directory = model::safe_path(root, "mods")?;
    if directory.exists() {
        for entry in fs::read_dir(directory).map_err(|_| "无法读取整合包模组")? {
            let entry = entry.map_err(|_| "无法读取模组文件")?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "模组文件名无效")?;
            if !name.to_ascii_lowercase().ends_with(".jar") {
                continue;
            }
            let forge = instance
                .local
                .as_ref()
                .is_some_and(|local| ["forge", "neoforge"].contains(&local.loader.as_str()));
            if instance.fabric_version.is_empty() && !forge {
                return Err("整合包包含模组 JAR，但未声明已支持的 Fabric 加载器".into());
            }
            let file = model::safe_path(root, &format!("mods/{name}"))?;
            crate::packs::preview_mod_reader(fs::File::open(&file).map_err(|_| "无法读取模组")?)
                .map_err(|error| format!("mods/{name}：{error}"))?;
            let mut zip = zip::ZipArchive::new(fs::File::open(file).map_err(|_| "无法读取模组")?)
                .map_err(|_| "模组不是有效 JAR")?;
            if !forge {
                content::validate_archive(content::Kind::Mods, &mut zip)
                    .map_err(|error| format!("mods/{name}：{error}"))?;
            }
        }
    }
    if instance
        .local
        .as_ref()
        .is_some_and(|local| ["forge", "neoforge"].contains(&local.loader.as_str()))
    {
        let report = crate::mod_check::Cache::default().check(cache, root, instance, true)?;
        let mut messages = report.issues;
        messages.extend(
            report
                .unchecked
                .into_iter()
                .map(|message| format!("未检查：{message}")),
        );
        return Ok(messages);
    }
    match assess_mod_files_report(
        root,
        instance,
        instance.java_major,
        &[],
        &[],
        &bundled_metadata(cache, instance)?,
    ) {
        Ok(issues) => Ok(issues),
        Err(error) => Ok(vec![format!("模组依赖检查未完成：{}", error.message())]),
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModCheck {
    pub instance_id: String,
    pub issues: Vec<String>,
    pub unchecked: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<crate::mod_check::Details>,
}

pub async fn prepare_curseforge(
    host: &Host,
    instance: Instance,
    project: &str,
    version: &str,
    filename: &str,
) -> Result<Plan> {
    if instance.fabric_version.is_empty() {
        return Err("CurseForge Mod 安装目前需要 Fabric 实例，Forge 实例尚未接入。".into());
    }
    let snapshot = host.instance_files(&instance.id, |root| inventory(root, Kind::Mod))?;
    let downloads = crate::curseforge::resolve(project, version, &instance.version).await?;
    let mut files = vec![];
    let mut paths = vec![];
    let cancel = CancellationToken::new();
    let mut total = 0u64;
    for download in downloads {
        total += download.size;
        if total > 1024 * 1024 * 1024 {
            return Err("CurseForge 安装超过 1 GiB".into());
        }
        if files.iter().any(|f: &Entry| {
            f.record
                .path
                .eq_ignore_ascii_case(&format!("mods/{}", download.name))
        }) {
            return Err("CurseForge 依赖文件名冲突".into());
        }
        let path = net::curseforge_download(
            &host.client,
            &host.root,
            &net::Artifact {
                path: format!("cache/curseforge/{}.jar", download.sha1),
                url: download.url,
                sha1: download.sha1.clone(),
                size: Some(download.size),
            },
            &cancel,
        )
        .await?;
        let sha512 = sum(&path)?;
        let record = Record {
            project: download.project,
            version: download.version,
            path: format!("mods/{}", download.name),
            size: download.size,
            sha512,
        };
        checked_record(&host.root, &record)?;
        let action = match snapshot.get(&record.path) {
            Some(hash) if hash == &record.sha512 => "keep",
            Some(_) => return Err("同名文件内容不同，未覆盖".into()),
            None => "add",
        }
        .into();
        files.push(Entry {
            record,
            action,
            sha1: download.sha1,
            url: String::new(),
        });
        paths.push(path);
    }
    if !files.iter().any(|f| {
        f.record.project == format!("curseforge{project}")
            && f.record.version == format!("curseforge{version}")
            && f.record.path == format!("mods/{filename}")
    }) {
        return Err("所选文件与 CurseForge 固定版本不符".into());
    }
    let java_path = instance.launch.resolve(&host.status().settings).java_path;
    let java_major = crate::minecraft::probe_java(&java_path).await?.major;
    let plan=Plan {token:uuid::Uuid::new_v4().to_string(),instance_id:instance.id.clone(),game_version:instance.version.clone(),game_isolation:instance.isolated(),world_id:None,data_format:None,files,warnings:vec!["来源：CurseForge。SHA-1 来自平台；SHA-512 由已验证缓存计算并固定。仅自动新增必需依赖；可选依赖不自动安装，不更改现有 Mod。".into()],preflight:None,approved_issues:false,local:false,local_paths:paths.clone(),snapshot,kind:Kind::Mod,created:Instant::now(),java_path,java_major,fabric_version:instance.fabric_version.clone(),bundled:bundled_metadata(&host.root,&instance)?};
    let mut report = host.instance_files(&instance.id, |root| {
        preflight_install(root, &instance, &plan, &paths)
    })?;
    report.unchecked.push("CurseForge 平台的不兼容项目关系尚未完整求解；此次校验使用 JAR 声明，详情中的平台关系仍需核对。".into());
    Ok(Plan {
        preflight: Some(report),
        ..plan
    })
}
pub fn prepare_local(
    cache: &Path,
    root: &Path,
    instance: &Instance,
    java_path: String,
    name: &str,
    mut input: impl Read,
    cancel: &CancellationToken,
) -> Result<Plan> {
    if instance.fabric_version.is_empty() {
        return Err("本地模组预检目前支持 Fabric 实例".into());
    }
    if !name.to_ascii_lowercase().ends_with(".jar") || name.contains(['/', '\\']) {
        return Err("请选择有效的本地 JAR 文件".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let staged = model::safe_path(cache, &format!("file-inputs/{token}.part"))?;
    fs::create_dir_all(staged.parent().ok_or("缓存目录无效")?)
        .map_err(|_| "无法创建预检缓存目录")?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staged)
        .map_err(|_| "无法创建预检缓存")?;
    let result = (|| {
        let mut sha1 = sha1::Sha1::new();
        let mut sha512 = Sha512::new();
        let mut size = 0u64;
        let mut buffer = [0; 65536];
        loop {
            if cancel.is_cancelled() {
                return Err("本地 Mod 预检已取消".into());
            }
            let count = input.read(&mut buffer).map_err(|_| "本地 Mod 读取失败")?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > crate::file_picker::MAX_FILE {
                return Err("本地 Mod 超过 512 MiB".into());
            }
            output
                .write_all(&buffer[..count])
                .map_err(|_| "本地预检缓存写入失败")?;
            sha1.update(&buffer[..count]);
            sha512.update(&buffer[..count]);
        }
        output.sync_all().map_err(|_| "本地预检缓存同步失败")?;
        let sha512 = format!("{:x}", sha512.finalize());
        let record = Record {
            project: format!("local{}", &sha512[..12]),
            version: format!("local{}", &sha512[12..24]),
            path: format!("mods/{name}"),
            size,
            sha512,
        };
        checked_record(root, &record)?;
        let snapshot = inventory(root, Kind::Mod)?;
        let action = match snapshot.get(&record.path) {
            Some(hash) if hash == &record.sha512 => "keep",
            Some(_) => return Err("同名本地模组已经存在且内容不同，未覆盖".into()),
            None => "add",
        }
        .into();
        let bundled = bundled_metadata(cache, instance);
        let mut plan = Plan {
            token,
            instance_id: instance.id.clone(),
            game_version: instance.version.clone(),
            game_isolation: instance.isolated(),
            world_id: None,
            data_format: None,
            files: vec![Entry {
                record,
                action,
                sha1: sha1
                    .finalize()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
                url: String::new(),
            }],
            warnings: vec![],
            preflight: None,
            approved_issues: false,
            local: true,
            local_paths: vec![staged.clone()],
            snapshot,
            kind: Kind::Mod,
            created: Instant::now(),
            java_path,
            java_major: instance.java_major,
            fabric_version: instance.fabric_version.clone(),
            bundled: bundled.as_ref().cloned().unwrap_or_default(),
        };
        let mut report = preflight_install(root, instance, &plan, std::slice::from_ref(&staged))?;
        report.unchecked.push(format!(
            "本地文件按实例要求的 Java {} 分析，实际 Java 环境在启动时校验。",
            instance.java_major
        ));
        if let Err(error) = bundled {
            report
                .unchecked
                .push(format!("加载器内置依赖未确认：{error}"));
        }
        plan.preflight = Some(report);
        Ok(plan)
    })();
    drop(output);
    if result.is_err() {
        let _ = fs::remove_file(&staged);
    }
    result
}

pub fn preflight_install(
    root: &Path,
    instance: &Instance,
    plan: &Plan,
    paths: &[PathBuf],
) -> Result<ModCheck> {
    if plan.kind != Kind::Mod
        || plan.instance_id != instance.id
        || plan.game_version != instance.version
        || plan.fabric_version != instance.fabric_version
        || plan.game_isolation != instance.isolated()
        || inventory(root, plan.kind)? != plan.snapshot
    {
        return Err("安装目标或实例内容已变化，请重新预览".into());
    }
    if paths.len() != plan.files.len() {
        return Err("预检文件数量不符".into());
    }
    for (entry, path) in plan.files.iter().zip(paths) {
        if fs::metadata(path).map_err(|_| "预检文件不可读")?.len() != entry.record.size
            || sum(path)? != entry.record.sha512
        {
            return Err("预检文件校验失败，未安装".into());
        }
        crate::packs::preview_mod_reader(fs::File::open(path).map_err(|_| "预检文件不可读")?)?;
        let mut archive = zip::ZipArchive::new(fs::File::open(path).map_err(|_| "预检文件不可读")?)
            .map_err(|_| "预检文件不是有效 JAR")?;
        content::validate_archive(content::Kind::Mods, &mut archive)?;
    }
    let mut report = ModCheck {
        instance_id: instance.id.clone(),
        issues: vec![],
        unchecked: vec!["仅检查模组声明与已配置的 Java 条件，不能预测全部运行时冲突。".into()],
        details: None,
    };
    for entry in content::list(root, content::Kind::Mods)? {
        if entry.enabled && !entry.editable && report.unchecked.len() <= 100 {
            report
                .unchecked
                .push(format!("未识别的已有模组：{}", entry.file));
        }
    }
    match assess_mod_files_report(
        root,
        instance,
        plan.java_major,
        &plan.files,
        paths,
        &plan.bundled,
    ) {
        Ok(issues) => report.issues = issues,
        Err(ModFailure::Declaration(message)) => {
            report.issues.push(message.replace("，未安装", ""));
            report
                .unchecked
                .push("校验器返回首个声明问题，其余条件尚未确认。".into());
        }
        Err(ModFailure::Invalid(message)) => return Err(message),
    }
    Ok(report)
}

#[cfg(test)]
pub fn check_installed_mods(cache: &Path, root: &Path, instance: &Instance) -> Result<ModCheck> {
    crate::mod_check::Cache::default().check(cache, root, instance, false)
}

#[derive(Debug)]
enum ModFailure {
    Declaration(String),
    Invalid(String),
}
impl ModFailure {
    fn message(self) -> String {
        match self {
            Self::Declaration(message) | Self::Invalid(message) => message,
        }
    }
}
impl From<String> for ModFailure {
    fn from(message: String) -> Self {
        Self::Invalid(message)
    }
}
impl From<&str> for ModFailure {
    fn from(message: &str) -> Self {
        Self::Invalid(message.into())
    }
}
#[cfg(test)]
fn validate_mod_files(
    root: &Path,
    instance: &Instance,
    java_major: u32,
    replacing: &[Entry],
    paths: &[PathBuf],
    bundled: &[Value],
) -> Result<()> {
    assess_mod_files(root, instance, java_major, replacing, paths, bundled)
        .map_err(ModFailure::message)
}
fn assess_mod_files(
    root: &Path,
    instance: &Instance,
    java_major: u32,
    replacing: &[Entry],
    paths: &[PathBuf],
    bundled: &[Value],
) -> std::result::Result<(), ModFailure> {
    let issues = assess_mod_files_report(root, instance, java_major, replacing, paths, bundled)?;
    match issues.first() {
        Some(message) => Err(ModFailure::Declaration(message.clone())),
        None => Ok(()),
    }
}
fn assess_mod_files_report(
    root: &Path,
    instance: &Instance,
    java_major: u32,
    replacing: &[Entry],
    paths: &[PathBuf],
    bundled: &[Value],
) -> std::result::Result<Vec<String>, ModFailure> {
    let mut metadata: Vec<_> = bundled
        .iter()
        .map(|value| ModMetadata {
            value: value.clone(),
            nested: true,
        })
        .collect();
    let mut expanded = 0;
    let directory = model::safe_path(root, "mods")?;
    if directory.exists() {
        for item in fs::read_dir(directory).map_err(|_| "无法读取已安装模组")? {
            let item = item.map_err(|_| "模组目录读取失败")?;
            let filename = item
                .file_name()
                .into_string()
                .map_err(|_| "模组文件名无效")?;
            if !filename.to_ascii_lowercase().ends_with(".jar")
                || replacing.iter().any(|file| {
                    file.record
                        .path
                        .eq_ignore_ascii_case(&format!("mods/{filename}"))
                })
            {
                continue;
            }
            let path = model::safe_path(root, &format!("mods/{filename}"))?;
            // Unknown existing files are preserved; only valid Fabric metadata can satisfy dependencies.
            if let Ok(input) = fs::File::open(&path) {
                if let Ok(mut zip) = zip::ZipArchive::new(input) {
                    if zip.by_name("fabric.mod.json").is_ok() {
                        mod_metadata(
                            fs::File::open(path).map_err(|_| "模组读取失败")?,
                            &mut metadata,
                            0,
                            &mut expanded,
                        )?;
                    }
                }
            }
        }
    }
    for path in paths {
        mod_metadata(
            fs::File::open(path).map_err(|_| "新模组读取失败")?,
            &mut metadata,
            0,
            &mut expanded,
        )?;
    }
    evaluate_metadata(instance, java_major, &metadata).map_err(ModFailure::Invalid)
}
pub(crate) fn evaluate_metadata(
    instance: &Instance,
    java_major: u32,
    metadata: &[ModMetadata],
) -> Result<Vec<String>> {
    if metadata.len() > 4096 {
        return Err("模组元数据总量超过检查上限".into());
    }
    let mut duplicates = vec![];
    let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, info) in metadata.iter().enumerate() {
        if info.value.get("environment").and_then(Value::as_str) == Some("server") {
            continue;
        }
        groups
            .entry(resources::text(&info.value, "id", 128)?)
            .or_default()
            .push(index);
    }
    let mut choices = vec![];
    let mut combinations = 1usize;
    for (id, mut group) in groups {
        let roots: Vec<_> = group
            .iter()
            .copied()
            .filter(|i| !metadata[*i].nested)
            .collect();
        if roots.len() > 1 {
            duplicates.push(format!("模组 ID 重复：{id}"));
            group = vec![roots[0]];
        }
        if roots.is_empty() {
            let core = [
                ("minecraft", instance.version.clone()),
                ("fabricloader", instance.fabric_version.clone()),
                ("java", java_major.to_string()),
            ];
            let mut possible = Vec::new();
            for index in group {
                let value = &metadata[index].value;
                let leaf = value
                    .get("jars")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty);
                let mut compatible =
                    value.get("environment").and_then(Value::as_str) != Some("server");
                for (field, required) in [("depends", true), ("breaks", false)] {
                    if let Some(conditions) = value.get(field) {
                        let conditions = conditions.as_object().ok_or("模组依赖条件无效")?;
                        for (id, version) in &core {
                            if let Some(condition) = conditions.get(*id) {
                                if satisfies(version, condition)? != required {
                                    compatible = false;
                                }
                            }
                        }
                    }
                }
                // Fabric's IF_POSSIBLE leaves may be absent; a parent's required dependency still fails below.
                if !leaf || compatible {
                    possible.push(index);
                }
            }
            group = possible;
            if group.is_empty() {
                continue;
            }
            let mut distinct = Vec::new();
            group.retain(|index| {
                let value = &metadata[*index].value;
                let leaf = value
                    .get("jars")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty);
                if leaf
                    && distinct
                        .iter()
                        .any(|previous: &usize| metadata[*previous].value == *value)
                {
                    false
                } else {
                    distinct.push(*index);
                    true
                }
            });
        }
        // shortcut: ambiguous nested parents with their own children need Fabric's full dependency solver.
        if group.len() > 1
            && group.iter().any(|i| {
                metadata[*i]
                    .value
                    .get("jars")
                    .and_then(Value::as_array)
                    .is_some_and(|jars| !jars.is_empty())
            })
        {
            return Err(format!("共享内置模组 {id} 含多级候选，暂不能安全自动选择"));
        }
        if let Some(root) = roots.first() {
            group = vec![*root];
        } else {
            group.sort_by(|a, b| {
                let parse = |index: usize| {
                    semver::Version::parse(metadata[index].value["version"].as_str().unwrap_or(""))
                        .ok()
                        .map(|mut version| {
                            version.build = semver::BuildMetadata::EMPTY;
                            version
                        })
                };
                parse(*b).cmp(&parse(*a)).then_with(|| b.cmp(a))
            });
        }
        combinations = combinations
            .checked_mul(group.len())
            .filter(|count| *count <= 4096)
            .ok_or("共享内置模组候选超过 4096 种组合，请缩小安装范围")?;
        choices.push(group);
    }
    let mut best: Option<Vec<String>> = None;
    let mut evaluated = 0usize;
    for combination in 0..combinations {
        let mut cursor = combination;
        let chosen: Vec<_> = choices
            .iter()
            .map(|group| {
                let index = group[cursor % group.len()];
                cursor /= group.len();
                &metadata[index].value
            })
            .collect();
        let issues = check_mod_constraints(instance, java_major, &chosen, &mut evaluated)?;
        if issues.is_empty() {
            return Ok(duplicates);
        }
        if best
            .as_ref()
            .is_none_or(|previous| issues.len() < previous.len())
        {
            best = Some(issues);
        }
        if evaluated >= 200_000 {
            return Err("模组条件检查超过上限，请缩小安装范围".into());
        }
    }
    duplicates.extend(best.unwrap_or_default());
    Ok(duplicates)
}
fn check_mod_constraints(
    instance: &Instance,
    java_major: u32,
    metadata: &[&Value],
    evaluated: &mut usize,
) -> Result<Vec<String>> {
    let mut issues = vec![];
    let mut versions = BTreeMap::from([
        ("minecraft".to_string(), instance.version.clone()),
        ("fabricloader".into(), instance.fabric_version.clone()),
        ("java".into(), java_major.to_string()),
    ]);
    for info in metadata {
        let id = resources::text(info, "id", 128)?;
        let version = resources::text(info, "version", 128)?;
        if versions.insert(id.clone(), version.clone()).is_some() {
            issues.push(format!("模组 ID 重复：{id}"));
        }
        if let Some(aliases) = info.get("provides") {
            for alias in aliases
                .as_array()
                .filter(|v| v.len() <= 128)
                .ok_or("模组别名无效")?
            {
                let alias = alias
                    .as_str()
                    .filter(|v| !v.is_empty() && v.len() <= 128)
                    .ok_or("模组别名无效")?;
                if versions.insert(alias.into(), version.clone()).is_some() {
                    issues.push(format!("模组提供的别名重复：{alias}"));
                }
            }
        }
    }
    for info in metadata {
        for (key, required) in [("depends", true), ("breaks", false)] {
            if let Some(values) = info.get(key) {
                let values = values
                    .as_object()
                    .filter(|v| v.len() <= 256)
                    .ok_or("模组条件声明无效")?;
                for (id, predicate) in values {
                    *evaluated += 1;
                    if *evaluated >= 200_000 {
                        return Err("模组条件检查超过上限".into());
                    }
                    let matched = match versions.get(id) {
                        Some(version) => satisfies(version, predicate)?,
                        None => false,
                    };
                    if required != matched {
                        issues.push(format!(
                            "模组 {} 的{}条件不满足：{id} {predicate}",
                            info["id"].as_str().unwrap_or("unknown"),
                            if required {
                                "必需依赖"
                            } else {
                                "不兼容"
                            }
                        ));
                    }
                }
            }
        }
    }
    if issues.len() > 1000 {
        return Err("依赖问题超过 1000 项，请分批检查".into());
    }
    Ok(issues)
}
fn transaction_dir(root: &Path, token: &str) -> Result<PathBuf> {
    if uuid::Uuid::parse_str(token).is_err() {
        return Err("资源事务 ID 无效".into());
    }
    model::safe_path(root, &format!("{PENDING}/{token}"))
}
fn cleanup(root: &Path, journal: &Journal) -> Result<()> {
    let dir = transaction_dir(root, &journal.token)?;
    for index in 0..journal.added.len() {
        let file = dir.join(format!("{index}.data"));
        if file.exists() {
            fs::remove_file(file).map_err(|_| "事务缓存清理失败")?;
        }
    }
    fs::remove_file(dir.join("journal.json")).map_err(|_| "事务日志清理失败")?;
    fs::remove_dir(dir).map_err(|_| "事务目录清理失败")?;
    Ok(())
}
fn rollback(root: &Path, journal: &Journal) -> Result<()> {
    let dir = transaction_dir(root, &journal.token)?;
    for (index, entry) in journal.added.iter().enumerate() {
        let target = checked_record(root, entry)?;
        if !target.exists() {
            continue;
        }
        let staged = model::safe_path(&dir, &format!("{index}.data"))?;
        if !staged.exists() {
            return Err("事务缓存丢失，目标文件已保留，请检查实例目录".into());
        }
        if file_identity(&target)? != file_identity(&staged)? {
            continue;
        }
        if sum(&target)? != entry.sha512 {
            return Err(format!(
                "事务目标已被外部改变，保留文件，请检查：{}",
                target.display()
            ));
        }
        fs::remove_file(target).map_err(|_| "事务回滚失败，文件保留")?;
    }
    cleanup(root, journal)
}
pub fn recover(root: &Path) -> Result<()> {
    let pending = model::safe_path(root, PENDING)?;
    if !pending.exists() {
        return Ok(());
    }
    for (index, item) in fs::read_dir(pending)
        .map_err(|_| "无法读取资源事务")?
        .enumerate()
    {
        if index >= 100 {
            return Err("待恢复事务过多，请检查实例目录".into());
        }
        let token = item
            .map_err(|_| "事务目录读取失败")?
            .file_name()
            .into_string()
            .map_err(|_| "事务名称无效")?;
        let dir = transaction_dir(root, &token)?;
        let path = model::safe_path(&dir, "journal.json")?;
        if !path.exists() {
            continue;
        }
        if fs::metadata(&path).map_err(|_| "事务日志不可读")?.len() > 2 * 1024 * 1024 {
            return Err("事务日志过大，原文件保留".into());
        }
        let journal: Journal =
            serde_json::from_slice(&fs::read(path).map_err(|_| "事务日志不可读")?)
                .map_err(|_| "事务日志损坏，原文件保留")?;
        if journal.token != token || journal.added.len() > 64 {
            return Err("事务日志归属或数量无效".into());
        }
        for entry in &journal.added {
            checked_record(root, entry)?;
        }
        if catalog(root)?.transaction == token {
            cleanup(root, &journal)?;
        } else {
            rollback(root, &journal)?;
        }
    }
    Ok(())
}
pub fn recover_all(root: &Path) -> Result<()> {
    recover(root)?;
    for world in crate::worlds::list(root)? {
        recover(&crate::worlds::selected_world(root, &world.id)?)?;
    }
    Ok(())
}
pub fn target_root(root: &Path, world_id: Option<&str>) -> Result<PathBuf> {
    match world_id {
        Some(id) => crate::worlds::selected_world(root, id),
        None => Ok(root.to_path_buf()),
    }
}
pub fn commit(
    root: &Path,
    instance: &Instance,
    plan: &Plan,
    paths: &[PathBuf],
    cancel: &CancellationToken,
) -> Result<()> {
    let _locks = crate::worlds::lock_worlds(root)?;
    if (plan.kind == Kind::Datapack) != plan.world_id.is_some()
        || (plan.kind == Kind::Datapack && plan.data_format.is_none())
    {
        return Err("数据包安装计划必须包含所选世界及包格式".into());
    }
    recover_all(root)?;
    let target = target_root(root, plan.world_id.as_deref())?;
    let root = target.as_path();
    if plan.instance_id != instance.id
        || plan.game_version != instance.version
        || plan.fabric_version != instance.fabric_version
        || plan.game_isolation != instance.isolated()
        || inventory(root, plan.kind)? != plan.snapshot
    {
        return Err("实例内容已变化，未提交；请重新预览".into());
    }
    if cancel.is_cancelled() {
        return Err("操作已取消".into());
    }
    if paths.len() != plan.files.len() {
        return Err("资源缓存数量不符".into());
    }
    if plan.kind == Kind::Mod {
        match assess_mod_files(
            root,
            instance,
            plan.java_major,
            &plan.files,
            paths,
            &plan.bundled,
        ) {
            Ok(()) => (),
            Err(ModFailure::Declaration(message))
                if plan.approved_issues
                    && plan.preflight.as_ref().is_some_and(|report| {
                        report.issues.contains(&message.replace("，未安装", ""))
                    }) => {}
            Err(failure) => return Err(failure.message()),
        }
    }
    let mut next = catalog(root)?;
    let mut added = vec![];
    for (entry, path) in plan.files.iter().zip(paths) {
        if sum(path)? != entry.record.sha512 {
            return Err("提交前缓存校验失败，未安装".into());
        }
        if entry.action == "add" {
            added.push(entry.record.clone());
        }
        next.files.retain(|record| record.path != entry.record.path);
        next.files.push(entry.record.clone());
    }
    if next.files.len() > 1000 {
        return Err("安装记录超过上限".into());
    }
    let journal = Journal {
        token: plan.token.clone(),
        added,
    };
    let dir = transaction_dir(root, &plan.token)?;
    fs::create_dir_all(&dir).map_err(|_| "无法创建事务目录")?;
    model::save_json(&dir, "journal.json", &journal)?;
    let result = (|| {
        let mut index = 0;
        for (entry, path) in plan.files.iter().zip(paths) {
            if entry.action != "add" {
                continue;
            }
            if cancel.is_cancelled() {
                return Err("操作已取消".into());
            }
            let staged = model::safe_path(&dir, &format!("{index}.data"))?;
            let mut source = fs::File::open(path).map_err(|_| "缓存不可读")?;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)
                .map_err(|_| "事务缓存不可写")?;
            std::io::copy(&mut source, &mut output).map_err(|_| "事务缓存写入失败")?;
            output.sync_all().map_err(|_| "事务缓存同步失败")?;
            drop(output);
            if sum(&staged)? != entry.record.sha512 {
                return Err("事务文件校验失败，未提交".into());
            }
            index += 1;
        }
        for (index, entry) in journal.added.iter().enumerate() {
            if cancel.is_cancelled() {
                return Err("操作已取消".into());
            }
            let target = checked_record(root, entry)?;
            fs::create_dir_all(target.parent().ok_or("资源目录无效")?)
                .map_err(|_| "无法创建资源目录")?;
            fs::hard_link(dir.join(format!("{index}.data")), target)
                .map_err(|_| "资源目标已存在或不可写，未覆盖")?;
        }
        let before = model::safe_path(root, CATALOG)?;
        let revision = if before.exists() {
            sum(&before)?
        } else {
            "missing".into()
        };
        if plan.snapshot.get(CATALOG) != Some(&revision) {
            return Err("安装记录已被外部修改，未提交".into());
        }
        next.transaction = plan.token.clone();
        model::save_json(root, CATALOG, &next)
    })();
    if let Err(error) = result {
        rollback(root, &journal)?;
        return Err(error);
    }
    // The catalog is the commit marker; cleanup failure must not report a committed install as cancelled.
    let _ = cleanup(root, &journal);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    fn root() -> PathBuf {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/resource-install-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&path).unwrap();
        path
    }
    fn world(root: &Path, name: &str, data_version: i32) -> PathBuf {
        let path = root.join("saves").join(name);
        fs::create_dir_all(&path).unwrap();
        let mut raw = vec![10, 0, 0, 10, 0, 4];
        raw.extend_from_slice(b"Data");
        raw.extend_from_slice(&[3, 0, 11]);
        raw.extend_from_slice(b"DataVersion");
        raw.extend_from_slice(&data_version.to_be_bytes());
        raw.extend_from_slice(&[0, 0]);
        let mut gzip = flate2::write::GzEncoder::new(vec![], flate2::Compression::default());
        gzip.write_all(&raw).unwrap();
        fs::write(path.join("level.dat"), gzip.finish().unwrap()).unwrap();
        path
    }
    #[test]
    fn datapack_commit_is_world_scoped_preserves_nbt_rejects_stale_and_obeys_session_lock() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = root();
        let instance = instance();
        let target = world(&root, "世界 A", 3955);
        let other = world(&root, "世界 B", 3955);
        let original = fs::read(target.join("level.dat")).unwrap();
        let original_other = fs::read(other.join("level.dat")).unwrap();
        assert_eq!(crate::worlds::data_version(&target).unwrap(), 3955);
        let source = root.join("fixture.zip");
        fs::write(&source, b"transaction fixture, not a gameplay datapack").unwrap();
        let mut prepared = plan(
            &target,
            &instance,
            entry("datapacks/fixture.zip", &source),
            Kind::Datapack,
        );
        prepared.world_id = Some("世界 A".into());
        prepared.data_format = Some((48, 0));
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(target.join("session.lock"))
            .unwrap();
        assert!(commit(
            &root,
            &instance,
            &prepared,
            std::slice::from_ref(&source),
            &CancellationToken::new()
        )
        .is_err());
        drop(lock);
        let mut bad = prepared.clone();
        bad.world_id = Some("../outside".into());
        assert!(commit(
            &root,
            &instance,
            &bad,
            std::slice::from_ref(&source),
            &CancellationToken::new()
        )
        .is_err());
        world(&root, "世界 A", 4000);
        assert!(commit(
            &root,
            &instance,
            &prepared,
            std::slice::from_ref(&source),
            &CancellationToken::new()
        )
        .unwrap_err()
        .contains("变化"));
        fs::write(target.join("level.dat"), &original).unwrap();
        commit(
            &root,
            &instance,
            &prepared,
            std::slice::from_ref(&source),
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(target.join("datapacks/fixture.zip").is_file());
        assert!(!other.join("datapacks").exists());
        assert!(!root.join("datapacks").exists());
        assert_eq!(fs::read(target.join("level.dat")).unwrap(), original);
        assert_eq!(fs::read(other.join("level.dat")).unwrap(), original_other);
        let record = entry("datapacks/partial.zip", &source).record;
        let (_, dir) = journal(&target, record.clone());
        fs::copy(&source, dir.join("0.data")).unwrap();
        fs::hard_link(dir.join("0.data"), target.join(&record.path)).unwrap();
        recover_all(&root).unwrap();
        assert!(!target.join(&record.path).exists());
        assert!(target.join("datapacks/fixture.zip").exists());
    }
    #[tokio::test]
    async fn datapack_prepare_requires_a_world_and_rejects_newer_worlds_before_network() {
        use sha1::Digest as _;
        let root = root();
        let mut instance = instance();
        world(
            &root.join(format!("instances/{}/game", instance.id)),
            "Newer",
            5000,
        );
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file("version.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(br#"{"id":"1.21.1","world_version":3955,"pack_version":{"data":48}}"#)
            .unwrap();
        let client = zip.finish().unwrap().into_inner();
        let client_hash: String = sha1::Sha1::digest(&client)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        let metadata = serde_json::to_vec(
            &json!({"downloads":{"client":{"sha1":client_hash,"size":client.len()}}}),
        )
        .unwrap();
        instance.manifest_sha1 = sha1::Sha1::digest(&metadata)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        model::write_file(&root, "versions/1.21.1/client.jar", &client).unwrap();
        model::write_file(
            &root,
            &format!("versions/1.21.1/{}.json", instance.manifest_sha1),
            &metadata,
        )
        .unwrap();
        model::save_json(&root, "instances.json", &vec![instance.clone()]).unwrap();
        let host = Host::new(root.clone()).unwrap();
        assert_eq!(
            crate::minecraft::datapack_version(&host, &instance)
                .unwrap()
                .format,
            (48, 0)
        );
        assert!(prepare(
            &host,
            instance.clone(),
            Kind::Datapack,
            "Vers1234",
            "pack.zip",
            None
        )
        .await
        .err()
        .unwrap()
        .contains("目标世界"));
        assert!(prepare(
            &host,
            instance.clone(),
            Kind::Datapack,
            "Vers1234",
            "pack.zip",
            Some("Newer".into())
        )
        .await
        .err()
        .unwrap()
        .contains("较新"));
        assert!(prepare(
            &host,
            instance.clone(),
            Kind::Resourcepack,
            "Vers1234",
            "pack.zip",
            Some("Newer".into())
        )
        .await
        .err()
        .unwrap()
        .contains("其他资源"));
        fs::write(root.join("versions/1.21.1/client.jar"), b"tampered").unwrap();
        assert!(crate::minecraft::datapack_version(&host, &instance).is_err());
    }
    fn instance() -> Instance {
        Instance {
            version_folder: None,
            storage_root: None,
            id: uuid::Uuid::new_v4().to_string(),
            name: "Fixture".into(),
            version: "1.21.1".into(),
            manifest_sha1: "a".repeat(40),
            java_major: 21,
            fabric_version: "0.16.14".into(),
            fabric_sha1: "b".repeat(40),
            launch: Default::default(),
            local: None,
        }
    }
    fn entry(path: &str, source: &Path) -> Entry {
        Entry {
            record: Record {
                project: "Proj1234".into(),
                version: "Vers1234".into(),
                path: path.into(),
                size: fs::metadata(source).unwrap().len(),
                sha512: sum(source).unwrap(),
            },
            action: "add".into(),
            sha1: "a".repeat(40),
            url: "https://cdn.modrinth.com/data/fixture.zip".into(),
        }
    }
    fn plan(root: &Path, instance: &Instance, entry: Entry, kind: Kind) -> Plan {
        Plan {
            token: uuid::Uuid::new_v4().to_string(),
            instance_id: instance.id.clone(),
            game_version: instance.version.clone(),
            game_isolation: instance.isolated(),
            world_id: None,
            data_format: None,
            files: vec![entry],
            warnings: vec![],
            snapshot: inventory(root, kind).unwrap(),
            preflight: None,
            approved_issues: false,
            local: false,
            local_paths: vec![],
            kind,
            created: Instant::now(),
            java_path: "fixture".into(),
            java_major: 21,
            fabric_version: instance.fabric_version.clone(),
            bundled: vec![],
        }
    }
    fn journal(root: &Path, entry: Record) -> (Journal, PathBuf) {
        let journal = Journal {
            token: uuid::Uuid::new_v4().to_string(),
            added: vec![entry],
        };
        let directory = transaction_dir(root, &journal.token).unwrap();
        fs::create_dir_all(&directory).unwrap();
        model::save_json(&directory, "journal.json", &journal).unwrap();
        (journal, directory)
    }
    #[test]
    fn commits_frozen_files_catalog_and_rejects_changed_target_tamper_and_cancel() {
        let root = root();
        let instance = instance();
        let source = root.join("download.bin");
        fs::write(&source, b"verified fixture bytes").unwrap();
        let original = plan(
            &root,
            &instance,
            entry("resourcepacks/fixture.zip", &source),
            Kind::Resourcepack,
        );
        let mut switched = instance.clone();
        switched.launch.game_isolation = Some(false);
        assert!(commit(
            &root,
            &switched,
            &original,
            std::slice::from_ref(&source),
            &CancellationToken::new()
        )
        .unwrap_err()
        .contains("变化"));
        assert!(!root.join("resourcepacks/fixture.zip").exists());
        model::write_file(&root, "resourcepacks/external.txt", b"preserve").unwrap();
        assert!(commit(
            &root,
            &instance,
            &original,
            std::slice::from_ref(&source),
            &CancellationToken::new()
        )
        .unwrap_err()
        .contains("变化"));
        let ready = plan(
            &root,
            &instance,
            entry("resourcepacks/fixture.zip", &source),
            Kind::Resourcepack,
        );
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(commit(
            &root,
            &instance,
            &ready,
            std::slice::from_ref(&source),
            &cancel
        )
        .is_err());
        fs::write(&source, b"tampered").unwrap();
        assert!(commit(
            &root,
            &instance,
            &ready,
            std::slice::from_ref(&source),
            &CancellationToken::new()
        )
        .is_err());
        assert!(!root.join("resourcepacks/fixture.zip").exists());
        fs::write(&source, b"verified fixture bytes").unwrap();
        commit(
            &root,
            &instance,
            &ready,
            std::slice::from_ref(&source),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            fs::read(root.join("resourcepacks/fixture.zip")).unwrap(),
            b"verified fixture bytes"
        );
        assert_eq!(catalog(&root).unwrap().files[0].version, "Vers1234");
        assert_eq!(
            fs::read(root.join("resourcepacks/external.txt")).unwrap(),
            b"preserve"
        );
        assert_eq!(fs::read_dir(root.join(PENDING)).unwrap().count(), 0);
    }
    #[test]
    fn crash_recovery_removes_only_its_hardlinks_and_preserves_foreign_replacements() {
        let root = root();
        let source = root.join("download.bin");
        fs::write(&source, b"fixture").unwrap();
        let record = entry("resourcepacks/partial.zip", &source).record;
        let (log, dir) = journal(&root, record.clone());
        fs::copy(&source, dir.join("0.data")).unwrap();
        fs::create_dir_all(root.join("resourcepacks")).unwrap();
        fs::hard_link(dir.join("0.data"), root.join(&record.path)).unwrap();
        recover(&root).unwrap();
        assert!(!root.join(&record.path).exists());
        assert!(!transaction_dir(&root, &log.token).unwrap().exists());
        let (log, dir) = journal(&root, record.clone());
        fs::copy(&source, dir.join("0.data")).unwrap();
        fs::write(root.join(&record.path), b"foreign replacement").unwrap();
        recover(&root).unwrap();
        assert_eq!(
            fs::read(root.join(&record.path)).unwrap(),
            b"foreign replacement"
        );
        assert!(!transaction_dir(&root, &log.token).unwrap().exists());
        fs::remove_file(root.join(&record.path)).unwrap();
        let (log, dir) = journal(&root, record.clone());
        fs::copy(&source, dir.join("0.data")).unwrap();
        fs::hard_link(dir.join("0.data"), root.join(&record.path)).unwrap();
        model::save_json(
            &root,
            CATALOG,
            &Catalog {
                transaction: log.token,
                files: vec![record.clone()],
            },
        )
        .unwrap();
        recover(&root).unwrap();
        assert_eq!(fs::read(root.join(&record.path)).unwrap(), b"fixture");
    }
    #[test]
    fn externally_edited_transaction_and_malformed_journal_are_preserved() {
        let root = root();
        let source = root.join("download.bin");
        fs::write(&source, b"fixture").unwrap();
        let record = entry("mods/partial.jar", &source).record;
        let (_, dir) = journal(&root, record.clone());
        fs::copy(&source, dir.join("0.data")).unwrap();
        fs::create_dir_all(root.join("mods")).unwrap();
        fs::hard_link(dir.join("0.data"), root.join(&record.path)).unwrap();
        fs::write(root.join(&record.path), b"external edit").unwrap();
        assert!(recover(&root).unwrap_err().contains("外部改变"));
        assert_eq!(fs::read(root.join(&record.path)).unwrap(), b"external edit");
        fs::write(dir.join("journal.json"), b"broken JSON").unwrap();
        assert!(recover(&root).is_err());
        assert!(dir.join("0.data").exists());
    }
    #[test]
    fn asset_heavy_mods_use_resource_limits_while_pack_limits_stay_separate() {
        use std::io::Write;
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("fabric.mod.json", options).unwrap();
        zip.write_all(br#"{"id":"asset_heavy","version":"1.0"}"#)
            .unwrap();
        for index in 0..20001 {
            zip.start_file(format!("assets/fixture/{index}.txt"), options)
                .unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        assert!(crate::packs::preview_reader(std::io::Cursor::new(&bytes)).is_err());
        crate::packs::preview_resource_reader(std::io::Cursor::new(&bytes)).unwrap();
        let mut metadata = Vec::new();
        mod_metadata(std::io::Cursor::new(bytes), &mut metadata, 0, &mut 0).unwrap();
        assert_eq!(metadata[0].value["id"], "asset_heavy");
    }
    fn jar(metadata: Value, nested: Option<Vec<u8>>) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file("fabric.mod.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(&serde_json::to_vec(&metadata).unwrap())
            .unwrap();
        if let Some(bytes) = nested {
            zip.start_file("nested.jar", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn install_preflight_reports_missing_dependency_before_writing_instance_files() {
        let root = root();
        let instance = instance();
        let source = root.join("incoming.jar");
        fs::write(
            &source,
            jar(
                json!({"id":"incoming","version":"1.0.0","depends":{"missing_lib":">=2.0.0"}}),
                None,
            ),
        )
        .unwrap();
        let plan = plan(
            &root,
            &instance,
            entry("mods/incoming.jar", &source),
            Kind::Mod,
        );
        let report =
            preflight_install(&root, &instance, &plan, std::slice::from_ref(&source)).unwrap();
        assert_eq!(report.instance_id, instance.id);
        assert!(report
            .issues
            .iter()
            .any(|issue| issue.contains("missing_lib")));
        assert!(!root.join("mods/incoming.jar").exists());
        assert!(!root.join(CATALOG).exists());
    }

    #[test]
    fn installing_with_declared_issues_requires_consent_and_never_ignores_tampered_files() {
        let root = root();
        let instance = instance();
        let source = root.join("incoming.jar");
        let bytes = jar(
            json!({"id":"incoming","version":"1.0.0","depends":{"missing_lib":">=2.0.0"}}),
            None,
        );
        fs::write(&source, &bytes).unwrap();
        let mut reviewed = plan(
            &root,
            &instance,
            entry("mods/incoming.jar", &source),
            Kind::Mod,
        );
        reviewed.preflight = Some(
            preflight_install(&root, &instance, &reviewed, std::slice::from_ref(&source)).unwrap(),
        );
        assert!(reviewed.approve_issues(false).is_err());
        reviewed.approve_issues(true).unwrap();
        fs::write(&source, b"tampered").unwrap();
        assert!(commit(
            &root,
            &instance,
            &reviewed,
            std::slice::from_ref(&source),
            &CancellationToken::new()
        )
        .is_err());
        assert!(!root.join("mods/incoming.jar").exists());
        fs::write(&source, &bytes).unwrap();
        commit(
            &root,
            &instance,
            &reviewed,
            std::slice::from_ref(&source),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(fs::read(root.join("mods/incoming.jar")).unwrap(), bytes);
    }

    #[tokio::test]
    async fn local_mod_upload_returns_a_review_plan_without_importing_the_file() {
        let cache = root();
        let instance = instance();
        model::save_json(&cache, "instances.json", &vec![instance.clone()]).unwrap();
        let game = cache.join(format!("instances/{}/game", instance.id));
        fs::create_dir_all(&game).unwrap();
        let host = Host::new(cache).unwrap();
        let bytes = jar(
            json!({"id":"localexample","version":"1.0.0","depends":{"missing_lib":">=2.0.0"}}),
            None,
        );
        let token = host
            .begin_upload(
                "example.jar".into(),
                bytes.len() as u64,
                crate::file_upload::Target::ModPreview {
                    id: instance.id.clone(),
                },
            )
            .unwrap();
        host.append_upload(&token, 0, &bytes).unwrap();
        let plan = host.finish_mod_upload(&token).unwrap();
        assert!(plan
            .preflight
            .as_ref()
            .unwrap()
            .issues
            .iter()
            .any(|message| message.contains("missing_lib")));
        assert!(!game.join("mods/example.jar").exists());
        assert!(host
            .start_resource_install(plan.token.clone(), false)
            .is_err());
        assert!(!game.join("mods/example.jar").exists());
        host.save_instance_launch(
            instance.id.clone(),
            instance.launch.clone(),
            model::LaunchOverrides {
                game_isolation: Some(false),
                ..instance.launch.clone()
            },
        )
        .await
        .unwrap();
        assert!(host
            .start_resource_install(plan.token.clone(), true)
            .unwrap_err()
            .contains("计划无效"));
        assert!(!host.root.join("shared-game/mods/example.jar").exists());
        assert!(host.finish_mod_upload(&token).is_err());
    }

    #[test]
    fn installed_report_lists_independent_dependency_problems_together() {
        let root = root();
        let instance = instance();
        fs::create_dir_all(root.join("mods")).unwrap();
        fs::write(root.join("mods/a.jar"), jar(json!({"id":"a","version":"1.0.0","depends":{"missing_a":"*","missing_b":">=2"},"breaks":{"minecraft":"*"}}), None)).unwrap();
        let report = check_installed_mods(&root, &root, &instance).unwrap();
        for dependency in ["missing_a", "missing_b", "minecraft"] {
            assert!(
                report
                    .issues
                    .iter()
                    .any(|message| message.contains(dependency)),
                "omitted {dependency}: {:?}",
                report.issues
            );
        }
        let source = root.join("incoming.jar");
        fs::write(
            &source,
            jar(
                json!({"id":"incoming","version":"1.0.0","depends":{"missing_c":"*"}}),
                None,
            ),
        )
        .unwrap();
        let plan = plan(
            &root,
            &instance,
            entry("mods/incoming.jar", &source),
            Kind::Mod,
        );
        let preview = preflight_install(&root, &instance, &plan, &[source]).unwrap();
        for dependency in ["missing_a", "missing_b", "missing_c", "minecraft"] {
            assert!(
                preview
                    .issues
                    .iter()
                    .any(|message| message.contains(dependency)),
                "{dependency}: {:?}",
                preview.issues
            );
        }
    }

    #[test]
    fn preflight_reports_missing_dependencies_without_modifying_installed_files() {
        let root = root();
        let instance = instance();
        fs::create_dir_all(root.join("mods")).unwrap();
        let original = jar(
            json!({"id":"example","version":"1.0.0","depends":{"missing_lib":">=2.0.0"}}),
            None,
        );
        fs::write(root.join("mods/example.jar"), &original).unwrap();
        fs::write(root.join("mods/unknown.jar"), b"not a recognized jar").unwrap();
        let report = check_installed_mods(&root, &root, &instance).unwrap();
        assert_eq!(report.instance_id, instance.id);
        assert!(report
            .issues
            .iter()
            .any(|message| message.contains("missing_lib")));
        assert!(report
            .unchecked
            .iter()
            .any(|message| message.contains("unknown.jar")));
        assert_eq!(fs::read(root.join("mods/example.jar")).unwrap(), original);
        assert_eq!(
            fs::read(root.join("mods/unknown.jar")).unwrap(),
            b"not a recognized jar"
        );
        fs::write(
            root.join("mods/library.jar"),
            jar(json!({"id":"missing_lib","version":"2.0.0"}), None),
        )
        .unwrap();
        assert!(check_installed_mods(&root, &root, &instance)
            .unwrap()
            .issues
            .is_empty());
    }

    #[test]
    fn jar_constraints_include_nested_dependencies_and_reject_duplicate_ids_and_wrong_java() {
        let root = root();
        let instance = instance();
        let source = root.join("main.jar");
        let dependency = jar(json!({"id":"embedded","version":"1.0.0"}), None);
        let metadata = json!({"id":"mainmod","version":"1.0.0","jars":[{"file":"nested.jar"}],"depends":{"embedded":">=1.0.0","minecraft":"~1.21.1","fabricloader":">=0.16.9","java":">=21"}});
        fs::write(&source, jar(metadata.clone(), Some(dependency.clone()))).unwrap();
        let plan = plan(&root, &instance, entry("mods/main.jar", &source), Kind::Mod);
        validate_mods(&root, &instance, &plan, std::slice::from_ref(&source)).unwrap();
        fs::create_dir_all(root.join("mods")).unwrap();
        fs::write(
            root.join("mods/duplicate.jar"),
            jar(json!({"id":"mainmod","version":"1.0.0"}), None),
        )
        .unwrap();
        assert!(
            validate_mods(&root, &instance, &plan, std::slice::from_ref(&source))
                .unwrap_err()
                .contains("重复")
        );
        fs::remove_file(root.join("mods/duplicate.jar")).unwrap();
        let mut wrong = metadata;
        wrong["depends"]["java"] = json!(">=25");
        fs::write(&source, jar(wrong, Some(dependency))).unwrap();
        assert!(
            validate_mods(&root, &instance, &plan, std::slice::from_ref(&source))
                .unwrap_err()
                .contains("java")
        );
        assert!(!satisfies("1.21.2", &json!("1.21.1")).unwrap());
        assert!(!satisfies("1.21.1", &json!("1.21")).unwrap());
        assert!(satisfies("1.21.1", &json!(">=1.21- <1.21.2-")).unwrap());
        assert!(satisfies("1.21.1", &json!("~1.21- <1.21.2-")).unwrap());
        assert!(!satisfies("1.21.2-alpha.1", &json!("~1.21- <1.21.2-")).unwrap());
        assert!(satisfies("0.5.0", &json!("^0.1-")).unwrap());
        assert!(!satisfies("1.0.0", &json!("^0.1-")).unwrap());
        assert!(!satisfies("1.21.2-alpha.1", &json!(">=1.21- <1.21.2-")).unwrap());
        assert!(satisfies("1.21.0-alpha.1", &json!(">1.21- <1.21")).unwrap());
        assert!(satisfies("21", &json!([">=25", ">=21"])).unwrap());
        assert!(satisfies("1.21.1", &json!("unsupported syntax")).is_err());
    }
    #[test]
    fn shared_nested_libraries_choose_a_candidate_that_satisfies_all_parents() {
        let root = root();
        let instance = instance();
        let first = root.join("one.jar");
        let second = root.join("two.jar");
        fs::write(&first,jar(json!({"id":"one","version":"1.0.0","jars":[{"file":"nested.jar"}],"depends":{"shared":"=1.0.0"}}),Some(jar(json!({"id":"shared","version":"1.0.0"}),None)))).unwrap();
        fs::write(&second,jar(json!({"id":"two","version":"1.0.0","jars":[{"file":"nested.jar"}],"depends":{"shared":">=1.0.0"}}),Some(jar(json!({"id":"shared","version":"2.0.0"}),None)))).unwrap();
        let mut plan = plan(&root, &instance, entry("mods/one.jar", &first), Kind::Mod);
        plan.files.push(entry("mods/two.jar", &second));
        validate_mods(&root, &instance, &plan, &[first, second]).unwrap();
    }
    #[test]
    fn repeated_identical_nested_leaves_do_not_expand_the_candidate_product() {
        fn parent(id: &str) -> Vec<u8> {
            let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
            let options = zip::write::SimpleFileOptions::default();
            let jars: Vec<_> = (0..14)
                .map(|index| json!({"file":format!("leaf{index}.jar")}))
                .collect();
            zip.start_file("fabric.mod.json", options).unwrap();
            zip.write_all(
                &serde_json::to_vec(&json!({"id":id,"version":"1.0.0","jars":jars})).unwrap(),
            )
            .unwrap();
            for index in 0..14 {
                zip.start_file(format!("leaf{index}.jar"), options).unwrap();
                zip.write_all(&jar(
                    json!({"id":format!("leaf{index}"),"version":"1.0.0"}),
                    None,
                ))
                .unwrap();
            }
            zip.finish().unwrap().into_inner()
        }
        let root = root();
        let instance = instance();
        let first = root.join("one.jar");
        let second = root.join("two.jar");
        fs::write(&first, parent("one")).unwrap();
        fs::write(&second, parent("two")).unwrap();
        let mut plan = plan(&root, &instance, entry("mods/one.jar", &first), Kind::Mod);
        plan.files.push(entry("mods/two.jar", &second));
        validate_mods(&root, &instance, &plan, &[first, second]).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn core_incompatible_optional_nested_leaf_is_absent_but_required_or_root_mod_is_rejected() {
        let root = root();
        let instance = instance();
        let source = root.join("one.jar");
        let child = jar(
            json!({"id":"java25only","version":"1.0.0","depends":{"java":">=25"}}),
            None,
        );
        let parent = json!({"id":"parent","version":"1.0.0","jars":[{"file":"nested.jar"}]});
        fs::write(&source, jar(parent.clone(), Some(child.clone()))).unwrap();
        let plan = plan(&root, &instance, entry("mods/one.jar", &source), Kind::Mod);
        validate_mods(&root, &instance, &plan, std::slice::from_ref(&source)).unwrap();
        let mut required = parent;
        required["depends"] = json!({"java25only":"*"});
        fs::write(&source, jar(required, Some(child.clone()))).unwrap();
        assert!(
            validate_mods(&root, &instance, &plan, std::slice::from_ref(&source))
                .unwrap_err()
                .contains("java25only")
        );
        fs::write(&source, child).unwrap();
        assert!(
            validate_mods(&root, &instance, &plan, std::slice::from_ref(&source))
                .unwrap_err()
                .contains("java")
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn loader_bundled_mods_require_both_locked_profile_and_library_hashes() {
        use sha1::Digest as _;
        let root = root();
        let mut instance = instance();
        let bytes = jar(
            json!({"id":"fabricloader","version":instance.fabric_version,"jars":[{"file":"nested.jar"}]}),
            Some(jar(json!({"id":"mixinextras","version":"0.5.5"}), None)),
        );
        let name = format!("net.fabricmc:fabric-loader:{}", instance.fabric_version);
        let library_path = format!("libraries/{}", crate::fabric::maven_path(&name).unwrap());
        model::write_file(&root, &library_path, &bytes).unwrap();
        let hash = |bytes: &[u8]| {
            sha1::Sha1::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        };
        let profile = json!({"id":format!("fabric-loader-{}-{}",instance.fabric_version,instance.version),"inheritsFrom":instance.version,"mainClass":"net.fabricmc.loader.impl.launch.knot.KnotClient","libraries":[{"name":name,"url":"https://maven.fabricmc.net/","sha1":hash(&bytes)}]});
        let encoded = serde_json::to_vec(&profile).unwrap();
        instance.fabric_sha1 = hash(&encoded);
        model::write_file(
            &root,
            &format!("loaders/fabric/{}.json", instance.fabric_sha1),
            &encoded,
        )
        .unwrap();
        let values = bundled_metadata(&root, &instance).unwrap();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0]["id"], "mixinextras");
        let required = root.join("required.jar");
        fs::write(
            &required,
            jar(
                json!({"id":"required","version":"1.0.0","depends":{"mixinextras":">=0.3.2"}}),
                None,
            ),
        )
        .unwrap();
        let mut plan = plan(
            &root,
            &instance,
            entry("mods/required.jar", &required),
            Kind::Mod,
        );
        plan.bundled = values;
        validate_mods(&root, &instance, &plan, &[required]).unwrap();
        model::write_file(&root, &library_path, b"tampered").unwrap();
        assert!(bundled_metadata(&root, &instance).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn dependency_graph_rejects_cycles_ambiguous_required_and_cross_version() {
        let client = net::client().unwrap();
        let instance = instance();
        let cancel = CancellationToken::new();
        let mut resolver = Resolver {
            client: &client,
            instance: &instance,
            kind: Kind::Mod,
            cancel: &cancel,
            selected: BTreeMap::new(),
            active: HashSet::new(),
            files: vec![],
            warnings: vec![],
            conflicts: vec![],
            installed: vec![],
        };
        let raw = json!({"project_id":"Proj1234","id":"Vers1234","game_versions":["1.21.1"],"loaders":["fabric"],"name":"Fixture","version_number":"1","environment":"client_or_server","files":[{"filename":"fixture.jar","url":"https://cdn.modrinth.com/data/Proj1234/fixture.jar","size":128,"hashes":{"sha1":"a".repeat(40),"sha512":"b".repeat(128)}}],"dependencies":[]});
        resolver.active.insert("Proj1234".into());
        assert!(resolver
            .visit(raw.clone(), None, 0)
            .await
            .unwrap_err()
            .contains("循环"));
        resolver.active.clear();
        resolver
            .selected
            .insert("Proj1234".into(), "Diff1234".into());
        assert!(resolver
            .visit(raw.clone(), None, 0)
            .await
            .unwrap_err()
            .contains("不同版本"));
        resolver.selected.clear();
        let mut missing = raw;
        missing["dependencies"] =
            json!([{"dependency_type":"required","project_id":null,"version_id":null}]);
        assert!(resolver
            .visit(missing, None, 0)
            .await
            .unwrap_err()
            .contains("可解析"));
        for url in [
            "https://cdn.modrinth.com.evil.test/data/file.jar",
            "http://cdn.modrinth.com/data/file.jar",
            "https://user@cdn.modrinth.com/data/file.jar",
        ] {
            assert!(net::resource_download_url(url).is_err());
        }
        assert!(net::trusted_url("https://cdn.modrinth.com/data/file.jar").is_err());
    }
}
