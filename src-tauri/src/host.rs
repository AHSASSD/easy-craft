use crate::{
    auth::{self, DeviceCode, Pending, Session, Stored},
    minecraft,
    model::{self, Instance, Profile, Result, Settings, Task, Version},
    net,
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

struct Inner {
    settings: Settings,
    instances: Vec<Instance>,
    account: Option<Stored>,
    session: Option<Session>,
    task: Task,
    cancel: Option<CancellationToken>,
    login: Option<Pending>,
    auth_cancel: Option<CancellationToken>,
    auth_busy: bool,
    resource_plan: Option<crate::resource_install::Plan>,
    pack_plan: Option<crate::modpack::Plan>,
    upload: Option<crate::file_upload::Upload>,
    upload_token: Option<String>,
    cache_plan: Option<crate::cache::Plan>,
    backup_plan: Option<crate::backup_retention::Plan>,
    local_scan: Option<crate::local_import::Scan>,
}
pub struct Host {
    _lock: fs::File,
    pub root: PathBuf,
    pub client: reqwest::Client,
    mod_checks: Mutex<crate::mod_check::Cache>,
    inner: Mutex<Inner>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub data_root: String,
    pub settings: Settings,
    pub account: Option<Profile>,
    pub instances: Vec<Instance>,
    pub task: Task,
    pub login_pending: bool,
    pub login_code: Option<DeviceCode>,
}
impl Host {
    pub async fn prepare_java(&self, id: &str) -> Result<minecraft::JavaInfo> {
        let state = self.status();
        let instance = state
            .instances
            .iter()
            .find(|v| v.id == id)
            .ok_or("实例不存在")?;
        if instance.launch.java_path.is_some() {
            return Err("已指定实例 Java，请手动核对该路径".into());
        }
        let settings = instance.launch.resolve(&state.settings);
        let cancel = self.begin_task("自动准备兼容 Java")?;
        let result =
            crate::java_runtime::ensure(self, instance, &settings.java_path, &cancel).await;
        if let Err(error) = &result {
            self.log(error, &[]);
        }
        self.finish(result.as_ref().map(|_| ()).map_err(Clone::clone), &cancel);
        result
    }
    /// Check the same Java selection used by launch, without creating a game task.
    pub async fn instance_java(&self, id: &str) -> Result<minecraft::JavaInfo> {
        let state = self.status();
        if state.task.status == "running" {
            return Err("请先结束游戏或当前任务".into());
        }
        let instance = state
            .instances
            .iter()
            .find(|v| v.id == id)
            .ok_or("实例不存在")?;
        let settings = instance.launch.resolve(&state.settings);
        resolve_java(instance, &settings.java_path, &self.root).await
    }
    pub async fn install_translation(&self, id: &str) -> Result<crate::translation::Report> {
        let cancel = self.begin_task("匹配并安装当前实例汉化")?;
        let result: Result<crate::translation::Report> = async {
            let instance = self
                .status()
                .instances
                .into_iter()
                .find(|v| v.id == id)
                .ok_or("实例不存在")?;
            let report = crate::translation::install(self, &instance, &cancel).await?;
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            inner.task.phase = "translation-committed".into();
            inner.task.message = format!(
                "汉化已导入并启用：{} 个资源命名空间匹配，{} 个未在 CFPA 中匹配",
                report.matched.len(),
                report.unmatched.len()
            );
            Ok(report)
        }
        .await;
        if let Err(error) = &result {
            self.log(error, &[]);
        }
        self.finish(result.as_ref().map(|_| ()).map_err(Clone::clone), &cancel);
        result
    }
    pub(crate) fn plugin_task<T>(
        &self,
        message: &str,
        action: impl FnOnce(&CancellationToken) -> Result<T>,
    ) -> Result<T> {
        let cancel = self.begin_task(message)?;
        let result = action(&cancel);
        if let Err(error) = &result {
            self.log(error, &[]);
        }
        self.finish(result.as_ref().map(|_| ()).map_err(Clone::clone), &cancel);
        result
    }
    pub async fn save_resource(
        &self,
        directory: &Path,
        project: &str,
        version: &str,
        filename: &str,
    ) -> Result<()> {
        crate::resources::id(project)?;
        crate::resources::id(version)?;
        if filename.contains(['/', '\\'])
            || ![".zip", ".jar", ".mrpack"]
                .iter()
                .any(|suffix| filename.to_ascii_lowercase().ends_with(suffix))
        {
            return Err("不支持的资源文件名".into());
        }
        let target = model::safe_path(directory, filename)?;
        if target.exists() {
            return Err("目标同名文件已存在，未覆盖".into());
        }
        let cancel = self.begin_task("下载选定资源到文件夹")?;
        let result = async {
            self.progress("resource-export", "读取固定资源版本及校验信息", 0, 1);
            let value = net::resource_json(
                &self.client,
                &format!("https://api.modrinth.com/v2/version/{version}"),
                &cancel,
            )
            .await?;
            if value["project_id"] != project || value["id"] != version {
                return Err("资源版本归属不符".into());
            }
            let file = value["files"]
                .as_array()
                .ok_or("缺少文件列表")?
                .iter()
                .find(|file| file["filename"] == filename)
                .ok_or("版本中不存在此文件")?;
            let sha1 = file["hashes"]["sha1"]
                .as_str()
                .filter(|v| model::valid_sha1(v))
                .ok_or("SHA-1 无效")?;
            let sha512 = file["hashes"]["sha512"]
                .as_str()
                .filter(|v| v.len() == 128 && v.bytes().all(|v| v.is_ascii_hexdigit()))
                .ok_or("SHA-512 无效")?;
            let size = file["size"]
                .as_u64()
                .filter(|v| *v <= 512 * 1024 * 1024)
                .ok_or("资源超过 512 MiB")?;
            let observer = |update| {
                let bytes = match update {
                    net::TransferUpdate::Bytes(bytes) => bytes,
                    net::TransferUpdate::Cached | net::TransferUpdate::Verified => size,
                    net::TransferUpdate::Retrying(_) => return,
                };
                self.progress(
                    "resource-export",
                    "下载并校验原始归档（仅保存）",
                    bytes as usize,
                    size as usize,
                );
            };
            let cached = net::resource_download_observed(
                &self.client,
                &self.root,
                &net::Artifact {
                    url: file["url"].as_str().ok_or("文件地址缺失")?.into(),
                    path: format!("cache/resource-export/{sha512}.bin"),
                    sha1: sha1.into(),
                    size: Some(size),
                },
                &cancel,
                &observer,
            )
            .await?;
            if crate::resource_install::sum(&cached)? != sha512 {
                return Err("SHA-512 校验失败".into());
            }
            if cancel.is_cancelled() {
                return Err("保存已取消".into());
            }
            let mut source = fs::File::open(cached).map_err(|_| "缓存不可读")?;
            let mut output = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)
                .map_err(|_| "目标存在或无法写入，未覆盖")?;
            let copied =
                std::io::copy(&mut source, &mut output).and_then(|n| output.sync_all().map(|_| n));
            drop(output);
            if copied.ok() != Some(size) {
                let _ = fs::remove_file(&target);
                return Err("资源保存失败，暂存文件已清理".into());
            }
            self.progress(
                "resource-export-committed",
                "资源已保存；尚未安装或启用",
                1,
                1,
            );
            Ok(())
        }
        .await;
        self.finish(result.clone(), &cancel);
        result
    }
    pub fn new(root: PathBuf) -> Result<Arc<Self>> {
        fs::create_dir_all(&root).map_err(|_| "无法创建 Easy Craft 数据目录")?;
        let root = root
            .canonicalize()
            .map_err(|_| "无法定位 Easy Craft 数据目录")?;
        // Java's classpath cannot open Win32 verbatim paths, even when the file exists.
        let path = root.to_str().ok_or("数据目录包含无效 Unicode")?;
        let root = if let Some(unc) = path.strip_prefix("\\\\?\\UNC\\") {
            PathBuf::from(format!("\\\\{unc}"))
        } else {
            PathBuf::from(path.strip_prefix("\\\\?\\").unwrap_or(path))
        };
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(model::safe_path(&root, "launcher.lock")?)
            .map_err(|_| "无法锁定启动器数据目录")?;
        lock.try_lock()
            .map_err(|_| "此数据目录已由另一个 Easy Craft 使用，请先关闭已有窗口")?;
        let mut settings: Settings = model::load_json(&root, "settings.json")?;
        if settings.client_id.is_empty() {
            settings.client_id = Settings::default().client_id;
        }
        if !(512..=16384).contains(&settings.memory_mb)
            || (!settings.client_id.is_empty() && !auth::valid_client(&settings.client_id))
            || (!settings.offline_name.is_empty()
                && !model::valid_offline_name(&settings.offline_name))
            || (settings.launch_mode == model::LaunchMode::Offline
                && settings.offline_name.is_empty())
        {
            return Err("运行配置值无效，原文件保留".into());
        }
        let instances: Vec<Instance> = model::load_json(&root, "instances.json")?;
        if instances.iter().any(|item| {
            !model::valid_id(&item.id)
                || item.local.as_ref().is_some_and(|v| v.validate().is_err())
                || item.launch.validate().is_err()
                || !model::valid_id(&item.version)
                || !model::valid_sha1(&item.manifest_sha1)
                || (item.fabric_version.is_empty() != item.fabric_sha1.is_empty())
                || (!item.fabric_version.is_empty()
                    && (!crate::fabric::valid_version(&item.fabric_version)
                        || !model::valid_sha1(&item.fabric_sha1)))
        }) {
            return Err("实例清单无效，原文件保留".into());
        }
        let account = auth::load(&root)?;
        let recovery = crate::modpack::recover(&root, &instances)?;
        Ok(Arc::new(Self {
            _lock: lock,
            root,
            client: net::client()?,
            mod_checks: Mutex::new(crate::mod_check::Cache::default()),
            inner: Mutex::new(Inner {
                settings,
                instances,
                account,
                session: None,
                task: Task {
                    status: if recovery.is_empty() {
                        "idle"
                    } else {
                        "failed"
                    }
                    .into(),
                    phase: if recovery.is_empty() {
                        ""
                    } else {
                        "pack-recovery"
                    }
                    .into(),
                    message: if recovery.is_empty() {
                        ""
                    } else {
                        "有未自动恢复的整合包数据，请查看任务日志；不确定内容已保留。"
                    }
                    .into(),
                    logs: recovery,
                    ..Task::default()
                },
                cancel: None,
                login: None,
                auth_cancel: None,
                auth_busy: false,
                resource_plan: None,
                pack_plan: None,
                upload: None,
                upload_token: None,
                cache_plan: None,
                backup_plan: None,
                local_scan: None,
            }),
        }))
    }
    pub fn status(&self) -> Status {
        let inner = self.inner.lock().expect("host state poisoned");
        Status {
            data_root: self.root.to_string_lossy().into_owned(),
            settings: inner.settings.clone(),
            account: inner
                .account
                .as_ref()
                .map(|account| account.profile.clone()),
            instances: inner.instances.clone(),
            task: inner.task.clone(),
            login_pending: inner.auth_cancel.is_some(),
            login_code: inner.login.as_ref().map(Pending::public),
        }
    }
    pub fn scan_local(&self, directory: &Path) -> Result<crate::local_import::Preview> {
        let cancel = self.begin_task("只读扫描本地版本")?;
        let result = crate::local_import::scan(self, directory, &cancel);
        let public = match result {
            Ok(scan) => {
                let preview = scan.preview.clone();
                self.inner.lock().map_err(|_| "宿主状态不可用")?.local_scan = Some(scan);
                Ok(preview)
            }
            Err(error) => Err(error),
        };
        self.finish(public.as_ref().map(|_| ()).map_err(Clone::clone), &cancel);
        if let Ok(preview) = &public {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.task.status == "succeeded" {
                let available = preview
                    .candidates
                    .iter()
                    .filter(|v| v.supported && !v.duplicate)
                    .count();
                let duplicates = preview.candidates.iter().filter(|v| v.duplicate).count();
                let summary = format!("扫描完成：发现 {} 个版本，可导入 {} 个，已导入 {} 个，不支持或异常 {} 个；尚未导入，请查看扫描结果并确认。", preview.candidates.len(),available,duplicates,preview.candidates.len()-available-duplicates);
                inner.task.phase = "local-scan-complete".into();
                inner.task.message = summary.clone();
                inner.task.completed = preview.candidates.len();
                inner.task.total = preview.candidates.len();
                inner
                    .task
                    .logs
                    .push(format!("只读扫描目录：{}", preview.directory));
                inner.task.logs.push(summary);
                for candidate in preview.candidates.iter().take(190) {
                    inner.task.logs.push(format!(
                        "{} · {} · {}",
                        candidate.name,
                        if candidate.supported {
                            if candidate.duplicate {
                                "已导入"
                            } else {
                                "可导入"
                            }
                        } else {
                            "不可导入"
                        },
                        candidate.issues.join("；")
                    ));
                }
                inner
                    .task
                    .logs
                    .extend(preview.warnings.iter().take(7).cloned());
                if preview.candidates.len() > 190 {
                    inner
                        .task
                        .logs
                        .push("其余版本结果请在扫描结果面板查看。".into());
                }
            }
        } else if let Err(error) = &public {
            self.log(error, &[]);
        }
        public
    }
    pub fn start_local_import(
        self: &Arc<Self>,
        token: String,
        selected: Vec<crate::local_import::Selection>,
    ) -> Result<()> {
        let scan = {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.cancel.is_some() || inner.auth_cancel.is_some() {
                return Err("请先结束当前任务或登录".into());
            }
            let scan = inner.local_scan.as_ref().ok_or("请先扫描本地版本")?;
            crate::local_import::selections(scan, &token, &selected)?;
            inner.local_scan.take().ok_or("扫描结果已失效")?
        };
        let cancel = self.begin_task("准备导入本地版本；已完成实例保留，失败实例回滚")?;
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = async {
                for (index, selection) in selected.iter().enumerate() {
                    host.progress(
                        "local-prepare",
                        &format!(
                            "导入第 {}/{} 个：{}",
                            index + 1,
                            selected.len(),
                            selection.name
                        ),
                        index,
                        selected.len(),
                    );
                    let ready =
                        crate::local_import::prepare(&host, &scan, selection, &cancel).await?;
                    let publish = (|| -> Result<()> {
                        let mut inner = host.inner.lock().map_err(|_| "宿主状态不可用")?;
                        inner.instances = crate::modpack::publish(
                            &host.root,
                            &ready.transaction,
                            &inner.instances,
                            &cancel,
                        )?;
                        inner.task.phase = "pack-committed".into();
                        inner.task.logs.push(format!(
                            "已导入 {}（{}），源目录保持不变",
                            ready.instance.name, ready.instance.version
                        ));
                        Ok(())
                    })();
                    if let Err(error) = publish {
                        let cleanup = crate::modpack::rollback(&host.root, &ready.transaction);
                        return Err(match cleanup {
                            Ok(()) => error,
                            Err(e) => format!("{error}；暂存数据保留：{e}"),
                        });
                    }
                }
                Ok(())
            }
            .await;
            if result.is_ok() {
                host.progress(
                    "local-import-committed",
                    &format!(
                        "已成功导入 {} 个本地版本，游戏库已更新；源目录保持不变。",
                        selected.len()
                    ),
                    selected.len(),
                    selected.len(),
                );
            } else if let Err(error) = &result {
                host.log(error, &[]);
            }
            host.finish(result, &cancel);
        });
        Ok(())
    }
    pub fn instance_files<T>(
        &self,
        id: &str,
        operation: impl FnOnce(&Path) -> Result<T>,
    ) -> Result<T> {
        let inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() {
            return Err("请先结束游戏或当前任务，再编辑配置".into());
        }
        let instance = inner
            .instances
            .iter()
            .find(|item| item.id == id)
            .ok_or("本地实例不存在")?;
        let root = instance.game_path(&self.root)?;
        if !root.is_dir() {
            return Err("实例游戏目录不存在".into());
        }
        operation(&root)
    }
    pub fn mod_check(&self, id: &str, force: bool) -> Result<crate::resource_install::ModCheck> {
        // Parsing is read-only. Never hold the task/state mutex while opening JARs.
        let instance = {
            let inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.cancel.is_some() {
                return Err("游戏或任务运行中，检查暂缓；仍可查看旧报告".into());
            }
            inner
                .instances
                .iter()
                .find(|item| item.id == id)
                .cloned()
                .ok_or("实例不存在")?
        };
        self.check_instance_mods(&instance, force)
    }
    pub(crate) fn plugin_mod_check(&self, id: &str) -> Result<crate::resource_install::ModCheck> {
        let instance = self
            .status()
            .instances
            .into_iter()
            .find(|i| i.id == id)
            .ok_or("实例不存在")?;
        self.check_instance_mods(&instance, false)
    }
    fn check_instance_mods(
        &self,
        instance: &Instance,
        force: bool,
    ) -> Result<crate::resource_install::ModCheck> {
        let root = instance.game_path(&self.root)?;
        if !root.is_dir() {
            return Err("实例游戏目录不存在".into());
        }
        self.mod_checks
            .lock()
            .map_err(|_| "检查缓存不可用")?
            .check(&self.root, &root, instance, force)
    }
    pub fn rename_instance(&self, id: &str, name: &str) -> Result<()> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control) {
            return Err("实例名称须为 1–60 个可见字符".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() {
            return Err("请先结束游戏或当前任务".into());
        }
        let mut instances = inner.instances.clone();
        let item = instances
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or("实例不存在")?;
        item.name = name.into();
        model::save_json(&self.root, "instances.json", &instances)?;
        inner.instances = instances;
        Ok(())
    }
    pub fn remove_instance(&self, id: &str, archive: bool) -> Result<Option<String>> {
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() || inner.auth_cancel.is_some() {
            return Err("请先结束游戏、任务或登录".into());
        }
        let instance = inner
            .instances
            .iter()
            .find(|v| v.id == id)
            .ok_or("实例不存在")?;
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("实例 ID 无效".into());
        }
        let directory = if let Some(local) = &instance.local {
            if local.version_directory.starts_with("versions/")
                && local.version_directory.split('/').count() == 2
            {
                model::safe_path(Path::new(&local.root), &local.version_directory)?
            } else {
                instance.directory(&self.root)?
            }
        } else {
            instance.directory(&self.root)?
        };
        let target = if archive {
            if instance.version_folder.is_none()
                && instance.local.as_ref().is_some_and(|v| {
                    Path::new(&v.root) != self.root
                        || v.version_directory != format!("instances/{id}/game")
                })
                && !instance.local.as_ref().is_some_and(|v| {
                    v.version_directory.starts_with("versions/")
                        && v.version_directory.split('/').count() == 2
                })
            {
                return Err("此引用没有独立版本目录，只能移出记录".into());
            }
            let prefix = directory
                .to_string_lossy()
                .replace('\\', "/")
                .to_lowercase();
            if inner.instances.iter().filter(|v| v.id != id).any(|v| {
                let uses_client = v.local.as_ref().is_some_and(|l| {
                    model::safe_path(Path::new(&l.root), &l.client_jar).is_ok_and(|p| {
                        let p = p.to_string_lossy().replace('\\', "/").to_lowercase();
                        p.starts_with(&(prefix.clone() + "/"))
                    })
                });
                if uses_client {
                    return true;
                }
                v.game_path(&self.root).is_ok_and(|p| {
                    let p = p.to_string_lossy().replace('\\', "/").to_lowercase();
                    p == prefix || p.starts_with(&(prefix.clone() + "/"))
                })
            }) {
                return Err("其他实例仍在使用此目录，请先只移出游戏库".into());
            }
            if !directory.is_dir() {
                return Err("实例目录缺失，请取消勾选文件清理后移出游戏库".into());
            }
            Some(directory.clone())
        } else {
            None
        };
        let current: Vec<Instance> = model::load_json(&self.root, "instances.json")?;
        if current != inner.instances {
            return Err("实例清单已被外部修改，请重新打开启动器".into());
        }
        let updated: Vec<_> = inner
            .instances
            .iter()
            .filter(|v| v.id != id)
            .cloned()
            .collect();
        // Commit the catalog first: interruption can leave retained files, never a missing live instance.
        model::save_json(&self.root, "instances.json", &updated)?;
        if let Some(target) = &target {
            if let Err(error) = crate::plugins::recycle_file(target) {
                if model::save_json(&self.root, "instances.json", &current).is_err() {
                    inner.instances = updated;
                    return Err(format!(
                        "实例已移出游戏库，原文件仍在 {}；回收和恢复清单失败：{error}",
                        directory.display()
                    ));
                }
                return Err(format!("无法移入回收区，实例和原文件已保留：{error}"));
            }
        }
        inner.instances = updated;
        Ok(target.map(|p| p.to_string_lossy().into_owned()))
    }
    pub fn progress(&self, phase: &str, message: &str, completed: usize, total: usize) {
        let mut inner = self.inner.lock().expect("host state poisoned");
        if inner
            .task
            .steps
            .last()
            .is_some_and(|step| step.phase != phase)
        {
            if let Some(last) = inner.task.steps.last_mut() {
                last.done = true;
                if phase == "pack-forge-mirror" {
                    last.done = false;
                    last.outcome = Some("fallback".into());
                }
            }
        }
        if inner
            .task
            .steps
            .last()
            .is_none_or(|step| step.phase != phase)
        {
            if inner.task.steps.len() >= 32 {
                inner.task.steps.remove(0);
            }
            inner.task.steps.push(model::TaskStep {
                outcome: None,
                phase: phase.into(),
                message: message.into(),
                completed,
                total,
                done: false,
            });
        }
        if let Some(step) = inner.task.steps.last_mut() {
            step.message = message.into();
            step.completed = completed;
            step.total = total;
        }
        inner.task.phase = phase.into();
        inner.task.message = message.into();
        inner.task.completed = completed;
        inner.task.total = total;
    }
    pub(crate) fn log(&self, line: &str, secrets: &[String]) {
        let mut inner = self.inner.lock().expect("host state poisoned");
        inner.task.logs.push(model::redact(line, secrets));
        if inner.task.logs.len() > 200 {
            inner.task.logs.remove(0);
        }
    }
    pub async fn save_settings(&self, settings: Settings) -> Result<()> {
        if (!settings.offline_name.is_empty() && !model::valid_offline_name(&settings.offline_name))
            || (settings.launch_mode == model::LaunchMode::Offline
                && settings.offline_name.is_empty())
        {
            return Err("离线用户名须为 3–16 位英文字母、数字或下划线".into());
        }
        if !(512..=16384).contains(&settings.memory_mb)
            || (!settings.client_id.is_empty() && !auth::valid_client(&settings.client_id))
        {
            return Err("Client ID 或内存设置无效（512–16384 MB）".into());
        }
        if !settings.java_path.is_empty() && settings.java_path != self.status().settings.java_path
        {
            let java = minecraft::probe_java(&settings.java_path).await?;
            if !java.is_64_bit {
                return Err("请选择 64 位 Java".into());
            }
        }
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() || inner.auth_cancel.is_some() {
            return Err("请先结束当前任务或登录，再修改配置".into());
        }
        if inner
            .account
            .as_ref()
            .is_some_and(|account| account.client_id != settings.client_id)
        {
            return Err("更换 Client ID 前请先退出当前账户".into());
        }
        model::save_json(&self.root, "settings.json", &settings)?;
        inner.settings = settings;
        Ok(())
    }
    pub async fn save_instance_launch(
        &self,
        id: String,
        expected: model::LaunchOverrides,
        mut launch: model::LaunchOverrides,
    ) -> Result<()> {
        launch.validate()?;
        let instance = self
            .status()
            .instances
            .into_iter()
            .find(|item| item.id == id)
            .ok_or("实例不存在")?;
        if let Some(path) = &launch.java_path {
            let java = minecraft::probe_java(path).await?;
            if !java.is_64_bit || java.major != instance.java_major {
                return Err(format!(
                    "该实例需要 64 位 Java {}，当前为 Java {}",
                    instance.java_major, java.major
                ));
            }
            if launch
                .java_version
                .is_some_and(|version| version != java.major)
            {
                return Err("Java 版本记录与实际运行时不符".into());
            }
            launch.java_version = Some(java.major);
        }
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() || inner.auth_cancel.is_some() {
            return Err("请先结束当前任务或登录，再修改实例配置".into());
        }
        let disk: Vec<Instance> = model::load_json(&self.root, "instances.json")?;
        if disk != inner.instances {
            return Err("实例清单已被外部修改，未覆盖；请重新打开启动器".into());
        }
        let mut instances = inner.instances.clone();
        let item = instances
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or("实例不存在")?;
        if item.launch != expected {
            return Err("实例配置已变化，请放弃修改并重新读取后再保存".into());
        }
        let previous_isolated = item.isolated();
        item.launch = launch;
        let directory_changed = previous_isolated != item.isolated();
        if item.version_folder.is_some()
            || item.local.as_ref().is_none_or(|local| {
                Path::new(&local.root) == self.root
                    && local.version_directory == format!("instances/{id}/game")
            })
        {
            fs::create_dir_all(item.game_path(&self.root)?).map_err(|_| "无法创建所选游戏目录")?;
        } else if directory_changed && !item.game_path(&self.root)?.is_dir() {
            return Err("原安装目录不可用，未修改隔离设置".into());
        }
        model::save_json(&self.root, "instances.json", &instances)?;
        if directory_changed {
            inner.resource_plan = None;
            inner.backup_plan = None;
        }
        inner.instances = instances;
        Ok(())
    }
    fn begin_task(&self, message: &str) -> Result<CancellationToken> {
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() || inner.auth_cancel.is_some() {
            return Err("已有任务或登录进行中，请先结束".into());
        }
        let cancel = CancellationToken::new();
        inner.cancel = Some(cancel.clone());
        inner.task = Task {
            status: "running".into(),
            message: message.into(),
            ..Task::default()
        };
        Ok(cancel)
    }
    fn finish(&self, result: Result<()>, cancel: &CancellationToken) {
        let mut inner = self.inner.lock().expect("host state poisoned");
        Self::finish_locked(&mut inner, result, cancel);
    }
    fn finish_locked(inner: &mut Inner, result: Result<()>, cancel: &CancellationToken) {
        if result.is_ok() && !cancel.is_cancelled() {
            if let Some(step) = inner.task.steps.last_mut() {
                step.done = true;
            }
        }
        let committed = result.is_ok()
            && [
                "file-committed",
                "resource-export-committed",
                "resources-committed",
                "pack-committed",
                "local-import-committed",
                "plugin-committed",
                "translation-committed",
                "java-committed",
            ]
            .contains(&inner.task.phase.as_str());
        let cancelled = cancel.is_cancelled() && !committed;
        inner.task.status = if cancelled {
            "cancelled"
        } else if result.is_ok() {
            "succeeded"
        } else {
            "failed"
        }
        .into();
        inner.task.message = if cancelled {
            if inner.task.phase.starts_with("backup-") {
                "备份操作已取消，已完成的清理不会撤销。"
            } else if inner.task.phase.starts_with("file-") {
                "文件接收或检查已取消，未提交目标文件。"
            } else {
                "任务已取消，已校验缓存保留"
            }
            .into()
        } else {
            result.err().unwrap_or_else(|| {
                if [
                    "local-import-committed",
                    "resource-export-committed",
                    "pack-committed",
                    "plugin-committed",
                    "translation-committed",
                    "java-committed",
                ]
                .contains(&inner.task.phase.as_str())
                {
                    return inner.task.message.clone();
                }
                if inner.task.phase == "pack-checked" {
                    "归档检查完成；尚未安装。"
                } else if inner.task.phase == "cache-planned" {
                    "缓存检查完成；尚未清理文件。"
                } else if inner.task.phase == "file-committed" {
                    "文件已导入；是否在游戏中启用需确认。"
                } else {
                    "任务完成"
                }
                .into()
            })
        };
        inner.task.pid = None;
        inner.cancel = None;
        inner.upload = None;
        inner.upload_token = None;
    }
    pub fn background(&self, bytes: Option<Vec<u8>>) -> Result<Option<String>> {
        let _guard = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        crate::appearance::background(&self.root, bytes.as_deref())
    }
    pub fn cache_summary(&self) -> Result<crate::cache::Summary> {
        crate::cache::summary(&self.root)
    }
    pub fn prepare_cache(&self, groups: Vec<crate::cache::Group>) -> Result<crate::cache::Plan> {
        let cancel = self.begin_task("检查可清理的下载缓存")?;
        let result = crate::cache::prepare(&self.root, &groups, &cancel, |completed, total| {
            self.progress("cache-check", "检查下载缓存候选文件", completed, total)
        });
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if let Ok(plan) = &result {
            if !cancel.is_cancelled() {
                inner.cache_plan = Some(plan.clone());
                inner.task.phase = "cache-planned".into();
            }
        }
        Self::finish_locked(
            &mut inner,
            result.as_ref().map(|_| ()).map_err(Clone::clone),
            &cancel,
        );
        if cancel.is_cancelled() {
            return Err("缓存检查已取消；未清理文件".into());
        }
        result
    }
    pub fn clear_cache(&self, token: &str) -> Result<crate::cache::Report> {
        let cancel = self.begin_task("清理已预览的下载缓存")?;
        let plan = {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if !inner
                .cache_plan
                .as_ref()
                .is_some_and(|plan| plan.token == token)
            {
                let error = "缓存预览令牌无效或已被替换，请重新检查".to_string();
                Self::finish_locked(&mut inner, Err(error.clone()), &cancel);
                return Err(error);
            }
            inner.cache_plan.take().ok_or("缓存预览不可用")?
        };
        let mut result = crate::cache::clear(&self.root, plan, &cancel, |completed, total| {
            self.progress("cache-clear", "处理已确认的缓存文件", completed, total)
        });
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if let Ok(report) = &mut result {
            report.cancelled |= cancel.is_cancelled();
        }
        Self::finish_locked(
            &mut inner,
            result.as_ref().map(|_| ()).map_err(Clone::clone),
            &cancel,
        );
        if let Ok(report) = &result {
            inner.task.message = format!(
                "缓存清理{}：移除 {} 项，保留 {} 项",
                if report.cancelled {
                    "已取消"
                } else {
                    "完成"
                },
                report.removed_files,
                report.kept.len()
            );
        }
        result
    }
    pub fn prepare_backup_cleanup(
        &self,
        id: &str,
        world: Option<&str>,
        keep: u16,
    ) -> Result<crate::backup_retention::Plan> {
        let root = self.instance_files(id, |root| Ok(root.to_path_buf()))?;
        let cancel = self.begin_task("检查配置备份保留计划")?;
        self.progress("backup-retention-check", "校验此目标的配置备份", 0, 0);
        let result = crate::backup_retention::prepare(
            &root,
            id,
            world,
            keep,
            &cancel,
            |completed, total| {
                self.progress(
                    "backup-retention-check",
                    "校验此目标的配置备份",
                    completed,
                    total,
                )
            },
        );
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if let Ok(plan) = &result {
            if !cancel.is_cancelled() {
                inner.backup_plan = Some(plan.clone());
            }
        }
        Self::finish_locked(
            &mut inner,
            result.as_ref().map(|_| ()).map_err(Clone::clone),
            &cancel,
        );
        if cancel.is_cancelled() {
            return Err("备份检查已取消；未清理".into());
        }
        if result.is_ok() {
            inner.task.message = "备份检查完成；尚未清理，等待确认。".into();
        }
        result
    }
    pub fn clear_backup_cleanup(&self, token: &str) -> Result<crate::backup_retention::Report> {
        let cancel = self.begin_task("清理已确认的旧配置备份")?;
        self.progress("backup-retention-clear", "重新校验已确认的备份清单", 0, 0);
        let plan = {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if !inner
                .backup_plan
                .as_ref()
                .is_some_and(|plan| plan.token == token)
            {
                let error = "备份清理令牌无效或已使用，请重新检查".to_string();
                Self::finish_locked(&mut inner, Err(error.clone()), &cancel);
                return Err(error);
            }
            inner.backup_plan.take().ok_or("备份清理预览不可用")?
        };
        let mut result = crate::backup_retention::clear(plan, &cancel, |completed, total| {
            self.progress(
                "backup-retention-clear",
                "处理已确认的旧配置备份",
                completed,
                total,
            )
        });
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if let Ok(report) = &mut result {
            report.cancelled |= cancel.is_cancelled();
        }
        Self::finish_locked(
            &mut inner,
            result.as_ref().map(|_| ()).map_err(Clone::clone),
            &cancel,
        );
        if let Ok(report) = &result {
            inner.task.message = format!(
                "备份清理{}：移除 {} 份，保留 {} 份候选。",
                if report.cancelled {
                    "已取消"
                } else {
                    "完成"
                },
                report.removed.len(),
                report.kept.len()
            );
        }
        result
    }
    pub fn cancel(&self) {
        let mut inner = self.inner.lock().expect("host state poisoned");
        if ["resources-committed", "pack-committed", "file-committed"]
            .contains(&inner.task.phase.as_str())
        {
            return;
        }
        if let Some(cancel) = &inner.cancel {
            cancel.cancel();
            if inner.upload.is_some() {
                let cancel = cancel.clone();
                Self::finish_locked(&mut inner, Err("文件接收已取消".into()), &cancel);
            }
        }
    }
    pub fn begin_upload(
        &self,
        name: String,
        size: u64,
        target: crate::file_upload::Target,
    ) -> Result<String> {
        if let crate::file_upload::Target::ModPreview { id } = &target {
            if !self
                .status()
                .instances
                .iter()
                .any(|item| &item.id == id && !item.fabric_version.is_empty())
            {
                return Err("本地模组预检需要 Fabric 实例".into());
            }
            self.instance_files(id, |_| Ok(()))?;
        }
        if let crate::file_upload::Target::Content { id, content_kind } = &target {
            let state = self.status();
            if *content_kind == crate::content::Kind::Mods
                && !state
                    .instances
                    .iter()
                    .any(|item| &item.id == id && !item.fabric_version.is_empty())
            {
                return Err("本轮本地模组导入需要 Fabric 实例".into());
            }
            self.instance_files(id, |_| Ok(()))?;
        }
        let cancel = self.begin_task("接收拖入或选择的本地文件")?;
        let upload =
            match crate::file_upload::Upload::new(&self.root, name, size, target, cancel.clone()) {
                Ok(upload) => upload,
                Err(error) => {
                    self.finish(Err(error.clone()), &cancel);
                    return Err(error);
                }
            };
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if cancel.is_cancelled() {
            Self::finish_locked(&mut inner, Err("文件接收已取消".into()), &cancel);
            return Err("文件接收已取消".into());
        }
        let token = upload.token.clone();
        inner.task.phase = "file-receive".into();
        inner.task.total = size as usize;
        inner.upload_token = Some(token.clone());
        inner.upload = Some(upload);
        Ok(token)
    }
    pub fn append_upload(&self, token: &str, offset: u64, bytes: &[u8]) -> Result<()> {
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        let upload = inner
            .upload
            .as_mut()
            .filter(|upload| upload.token == token)
            .ok_or("文件接收令牌无效或已取消")?;
        let cancel = upload.cancel.clone();
        let result = upload.append(offset, bytes);
        if let Err(error) = &result {
            Self::finish_locked(&mut inner, Err(error.clone()), &cancel);
        } else {
            inner.task.completed = (offset + bytes.len() as u64) as usize;
        }
        result
    }
    pub fn abort_upload(&self, token: &str) {
        let mut inner = self.inner.lock().expect("host state poisoned");
        if inner.upload_token.as_deref() == Some(token) {
            if let Some(cancel) = &inner.cancel {
                let cancel = cancel.clone();
                cancel.cancel();
                if inner.upload.is_some() {
                    Self::finish_locked(&mut inner, Err("文件接收已取消".into()), &cancel);
                }
            }
        }
    }
    pub fn finish_upload(&self, token: &str) -> Result<Option<crate::packs::PackPreview>> {
        let mut upload = {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.upload_token.as_deref() != Some(token) {
                return Err("文件接收令牌无效或已取消".into());
            }
            inner.upload.take().ok_or("文件正在检查或已结束")?
        };
        let cancel = upload.cancel.clone();
        let name = upload.name.clone();
        let target = upload.target.clone();
        self.progress("file-inspect", "接收完成，正在校验本地文件", 0, 0);
        let result = (|| -> Result<Option<crate::packs::PackPreview>> {
            let reader = upload.reader()?;
            match target {
                crate::file_upload::Target::ModPreview { .. } => {
                    Err("本地模组请先生成预检计划".into())
                }
                crate::file_upload::Target::Pack => {
                    let preview = crate::modpack::inspect(&self.root, reader)?;
                    let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
                    if cancel.is_cancelled() {
                        return Err("归档检查已取消".into());
                    }
                    inner.pack_plan = preview.install.clone();
                    inner.task.phase = "pack-checked".into();
                    inner.task.completed = 1;
                    inner.task.total = 1;
                    Ok(Some(preview))
                }
                crate::file_upload::Target::Content { id, content_kind } => {
                    let instance = self
                        .status()
                        .instances
                        .into_iter()
                        .find(|v| v.id == id)
                        .ok_or("实例已变化")?;
                    let root = instance.game_path(&self.root)?;
                    if !root.is_dir() {
                        return Err("实例游戏目录已变化，未导入文件".into());
                    }
                    crate::content::import_reader_cancellable(
                        &root,
                        content_kind,
                        &name,
                        reader,
                        &cancel,
                    )?;
                    self.progress("file-committed", "本地文件已导入", 1, 1);
                    Ok(None)
                }
            }
        })();
        self.finish(result.as_ref().map(|_| ()).map_err(Clone::clone), &cancel);
        if cancel.is_cancelled() && !matches!(result, Ok(None)) {
            return Err("文件接收或检查已取消".into());
        }
        result
    }
    pub fn local_mod_plan(
        &self,
        id: &str,
        name: &str,
        input: impl std::io::Read,
    ) -> Result<crate::resource_install::Plan> {
        let status = self.status();
        let instance = status
            .instances
            .iter()
            .find(|item| item.id == id)
            .ok_or("实例不存在")?;
        let java_path = instance.launch.resolve(&status.settings).java_path;
        let plan = self.instance_files(id, |root| {
            crate::resource_install::prepare_local(
                &self.root,
                root,
                instance,
                java_path.clone(),
                name,
                input,
                &CancellationToken::new(),
            )
        })?;
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() || inner.auth_cancel.is_some() {
            return Err("已有游戏、任务或登录进行中，预检计划未保存".into());
        }
        inner.resource_plan = Some(plan.clone());
        Ok(plan)
    }
    pub fn finish_mod_upload(&self, token: &str) -> Result<crate::resource_install::Plan> {
        let (mut upload, id) = {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.upload_token.as_deref() != Some(token) {
                return Err("文件接收令牌无效或已取消".into());
            }
            let pending = inner.upload.as_ref().ok_or("文件正在检查或已结束")?;
            let crate::file_upload::Target::ModPreview { id } = &pending.target else {
                return Err("此文件不是 Mod 预检请求".into());
            };
            let id = id.clone();
            (inner.upload.take().ok_or("文件已结束")?, id)
        };
        let cancel = upload.cancel.clone();
        let name = upload.name.clone();
        self.progress("file-inspect", "正在进行本地 Mod 安装预检", 0, 0);
        let result = (|| {
            let status = self.status();
            let instance = status
                .instances
                .iter()
                .find(|item| item.id == id)
                .ok_or("实例不存在")?;
            let root = instance.game_path(&self.root)?;
            if !root.is_dir() {
                return Err("实例游戏目录已变化".into());
            }
            let plan = crate::resource_install::prepare_local(
                &self.root,
                &root,
                instance,
                instance.launch.resolve(&status.settings).java_path,
                &name,
                upload.reader()?,
                &cancel,
            )?;
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if cancel.is_cancelled() {
                return Err("Mod 预检已取消".into());
            }
            inner.resource_plan = Some(plan.clone());
            inner.task.phase = "file-checked".into();
            Ok(plan)
        })();
        self.finish(result.as_ref().map(|_| ()).map_err(Clone::clone), &cancel);
        if cancel.is_cancelled() {
            return Err("Mod 预检已取消".into());
        }
        result
    }
    pub async fn resource_plan(
        &self,
        id: String,
        kind: crate::resources::Kind,
        version: String,
        filename: String,
        world_id: Option<String>,
    ) -> Result<crate::resource_install::Plan> {
        let instance = self
            .status()
            .instances
            .into_iter()
            .find(|item| item.id == id)
            .ok_or("安装目标不存在")?;
        let plan =
            crate::resource_install::prepare(self, instance, kind, &version, &filename, world_id)
                .await?;
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() {
            return Err("已有游戏或任务运行，预览未保存".into());
        }
        inner.resource_plan = Some(plan.clone());
        Ok(plan)
    }
    pub async fn curseforge_plan(
        &self,
        id: String,
        project: String,
        version: String,
        filename: String,
    ) -> Result<crate::resource_install::Plan> {
        let instance = self
            .status()
            .instances
            .into_iter()
            .find(|i| i.id == id)
            .ok_or("实例不存在")?;
        let plan = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            crate::resource_install::prepare_curseforge(
                self, instance, &project, &version, &filename,
            ),
        )
        .await
        .map_err(|_| "CurseForge 预检超时")??;
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() || inner.auth_cancel.is_some() {
            return Err("已有任务或登录进行中，请重新预览".into());
        }
        inner.resource_plan = Some(plan.clone());
        Ok(plan)
    }
    pub fn start_forge_download(self: &Arc<Self>, game: String, loader: String) -> Result<()> {
        let cancel = self.begin_task("准备下载 Forge 官方安装器")?;
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = crate::forge::download(&host, &game, &loader, &cancel).await;
            if let Ok(path) = &result {
                host.log(
                    &format!(
                        "Forge 安装器下载并校验完成：{}；未执行、未创建可启动实例。",
                        path.display()
                    ),
                    &[],
                );
                host.progress("forge-downloaded", "Forge 安装器已下载，尚未执行安装", 1, 1);
            }
            host.finish(result.map(|_| ()), &cancel);
        });
        Ok(())
    }
    pub fn start_resource_install(
        self: &Arc<Self>,
        token: String,
        acknowledge_issues: bool,
    ) -> Result<()> {
        let plan = {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.cancel.is_some() || inner.auth_cancel.is_some() {
                return Err("请先结束当前任务或登录".into());
            }
            if !inner
                .resource_plan
                .as_ref()
                .is_some_and(|plan| plan.token == token)
            {
                return Err("安装计划无效或已被替换，请重新预览".into());
            }
            let mut plan = inner
                .resource_plan
                .as_ref()
                .ok_or("安装计划不可用")?
                .clone();
            plan.approve_issues(acknowledge_issues)?;
            inner.resource_plan = None;
            plan
        };
        let status = self.status();
        let target = status
            .instances
            .iter()
            .find(|item| item.id == plan.instance_id)
            .ok_or("目标实例不存在")?;
        if plan.java_path != target.launch.resolve(&status.settings).java_path
            || plan.game_isolation != target.isolated()
        {
            return Err("Java 配置或游戏目录已变化，请重新生成安装计划".into());
        }
        let cancel = self.begin_task("准备资源安装")?;
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            host.log(
                &format!(
                    "资源安装：实例 {}，{} 个固定版本文件",
                    plan.instance_id,
                    plan.files.len()
                ),
                &[],
            );
            let result = async {
                let paths = crate::resource_install::download(&host, &plan, &cancel).await?;
                let mut inner = host.inner.lock().map_err(|_| "宿主状态不可用")?;
                let instance = inner
                    .instances
                    .iter()
                    .find(|item| item.id == plan.instance_id)
                    .ok_or("安装目标已变化")?;
                let root = instance.game_path(&host.root)?;
                crate::resource_install::commit(&root, instance, &plan, &paths, &cancel)?;
                inner.task.phase = "resources-committed".into();
                inner.task.completed = plan.files.len();
                inner.task.total = plan.files.len();
                Ok(())
            }
            .await;
            if let Err(error) = &result {
                host.log(&format!("资源安装未完成：{error}"), &[]);
            }
            host.finish(result, &cancel);
        });
        Ok(())
    }
    pub fn start_install(self: &Arc<Self>, version: String, name: String) -> Result<()> {
        self.start_install_inner(version, name, None)
    }
    pub fn pack_preview(
        &self,
        preview: crate::packs::PackPreview,
    ) -> Result<crate::packs::PackPreview> {
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() {
            return Err("请先结束当前任务，再检查整合包".into());
        }
        inner.pack_plan = preview.install.clone();
        Ok(preview)
    }
    pub async fn online_pack_preview(
        &self,
        project: String,
        version: String,
        filename: String,
    ) -> Result<crate::packs::PackPreview> {
        let cancel = self.begin_task("获取选定的整合包归档")?;
        let result = crate::modpack::online(self, &project, &version, &filename, &cancel)
            .await
            .and_then(|preview| {
                let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
                if cancel.is_cancelled() {
                    return Err("归档检查已取消".into());
                }
                inner.pack_plan = preview.install.clone();
                Ok(preview)
            });
        if result.is_ok() {
            self.progress("pack-checked", "归档检查完成；尚未安装。", 1, 1);
        }
        self.finish(result.as_ref().map(|_| ()).map_err(Clone::clone), &cancel);
        if cancel.is_cancelled() {
            return Err("归档检查已取消".into());
        }
        result
    }
    pub fn start_pack(
        self: &Arc<Self>,
        token: String,
        name: String,
        selected: Vec<String>,
    ) -> Result<()> {
        if name.trim().is_empty() || name.chars().count() > 60 || name.chars().any(char::is_control)
        {
            return Err("实例名称须为 1–60 个可见字符".into());
        }
        let plan = {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.cancel.is_some() || inner.auth_cancel.is_some() {
                return Err("请先结束当前任务或登录".into());
            }
            let plan = inner
                .pack_plan
                .as_ref()
                .filter(|plan| plan.token == token)
                .ok_or("整合包计划无效或已被替换，请重新检查")?;
            crate::modpack::check_selection(plan, &selected)?;
            if let Some(directory) = &plan.storage_root {
                crate::local_import::checked_directory(Path::new(directory))?;
            }
            inner.pack_plan.take().ok_or("整合包计划不可用")?
        };
        let cancel = self.begin_task("准备整合包新实例")?;
        {
            let mut inner = self.inner.lock().map_err(|_| "宿主不可用")?;
            let mut stages = vec![];
            if !plan.curse_files.is_empty() {
                stages.push("resolve");
            }
            stages.push("base");
            if !plan.fabric_version.is_empty()
                || !plan.forge_version.is_empty()
                || !plan.neoforge_version.is_empty()
            {
                stages.push("loader");
            }
            stages.extend(["content", "files", "check", "publish"]);
            inner.task.planned_stages = stages.into_iter().map(String::from).collect();
        }
        self.inner
            .lock()
            .map_err(|_| "宿主不可用")?
            .task
            .pending_instance = Some(name.clone());
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut transaction = None;
            let result = async {
                let mut plan = plan;
                if !plan.curse_files.is_empty() {
                    crate::modpack::resolve_curse(&host, &mut plan, &cancel).await?;
                }
                let (mut instance, prepared) = host
                    .prepare_instance(
                        plan.game_version.clone(),
                        name,
                        if plan.fabric_version.is_empty() {
                            None
                        } else {
                            Some(plan.fabric_version.clone())
                        },
                        &cancel,
                        !plan.forge_version.is_empty() && plan.game_version == "1.12.2",
                    )
                    .await?;
                instance.launch.game_isolation = Some(true);
                instance.storage_root = plan.storage_root.clone();
                let loader_kind = if !plan.neoforge_version.is_empty() {
                    "neoforge"
                } else {
                    "forge"
                };
                let loader_version = if loader_kind == "neoforge" {
                    &plan.neoforge_version
                } else {
                    &plan.forge_version
                };
                let profile = if !loader_version.is_empty() {
                    Some(
                        host.apply_loader(
                            &mut instance,
                            &prepared.metadata,
                            loader_kind,
                            loader_version,
                            &cancel,
                        )
                        .await?,
                    )
                } else {
                    None
                };
                transaction = Some(crate::modpack::begin(&host.root, &plan, instance)?);
                let transaction = transaction.as_mut().ok_or("整合包事务不可用")?;
                if let Some(profile) = profile {
                    crate::modpack::copy(
                        &host.root,
                        transaction,
                        "local-profile.json",
                        profile.as_slice(),
                        None,
                        &cancel,
                    )?;
                }
                crate::modpack::stage(&host, &plan, transaction, &selected, &cancel).await?;
                crate::modpack::initialize_language(&host.root, transaction, &cancel)?;
                host.progress("pack-publish", "提交完整实例到游戏库", 0, 1);
                let previous = host.status().instances;
                let updated = crate::modpack::publish(&host.root, transaction, &previous, &cancel)?;
                let (installed, location) = {
                    let mut inner = host.inner.lock().map_err(|_| "宿主状态不可用")?;
                    inner.instances = updated;
                    inner.task.phase = "pack-committed".into();
                    inner.task.completed = plan.files.len();
                    inner.task.total = plan.files.len();
                    inner.task.pending_instance = None;
                    let installed = inner.instances.last().ok_or("已安装实例记录缺失")?.clone();
                    let location = installed.game_path(&host.root)?;
                    inner
                        .task
                        .logs
                        .push(format!("整合包安装位置：{}", location.display()));
                    inner.task.message = format!("安装完成：{}", location.display());
                    (installed, location)
                };
                let translation =
                    crate::translation::after_pack_install(&host, &installed, &cancel).await;
                let mut inner = host.inner.lock().map_err(|_| "宿主状态不可用")?;
                inner.task.phase = "pack-committed".into();
                inner.task.message = format!("安装完成：{}；{translation}", location.display());
                inner.task.completed = 1;
                inner.task.total = 1;
                Ok(())
            }
            .await;
            let result = if let Err(error) = result {
                let cleanup = transaction
                    .as_ref()
                    .map(|transaction| crate::modpack::rollback(&host.root, transaction))
                    .transpose();
                Err(match cleanup {
                    Ok(_) => error,
                    Err(cleanup) => format!("{error}；暂存数据已保留：{cleanup}"),
                })
            } else {
                Ok(())
            };
            if let Err(error) = &result {
                host.log(error, &[]);
            }
            host.finish(result, &cancel);
        });
        Ok(())
    }
    pub fn pack_destination(
        &self,
        token: &str,
        directory: Option<&Path>,
    ) -> Result<Option<String>> {
        let selected = directory
            .map(crate::local_import::checked_directory)
            .transpose()?;
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() || inner.auth_cancel.is_some() {
            return Err("请先结束当前任务或登录".into());
        }
        let plan = inner
            .pack_plan
            .as_mut()
            .filter(|plan| plan.token == token)
            .ok_or("整合包预览已变化，请重新选择版本")?;
        plan.storage_root = selected.map(|path| path.to_string_lossy().into_owned());
        Ok(plan.storage_root.clone())
    }
    async fn apply_loader(
        &self,
        instance: &mut Instance,
        base: &serde_json::Value,
        kind: &str,
        loader: &str,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>> {
        let profile = if instance.version == "1.12.2" && kind == "forge" {
            crate::pack_download::legacy_forge(self, &instance.version, loader, base, cancel)
                .await?
        } else {
            let java = crate::java_runtime::ensure(
                self,
                instance,
                &self.status().settings.java_path,
                cancel,
            )
            .await?;
            crate::loader_install::install(self, loader, kind, &java.path, base, cancel).await?
        };
        use sha1::Digest;
        let bytes = serde_json::to_vec(&profile).map_err(|_| "加载器配置序列化失败")?;
        instance.manifest_sha1 = sha1::Sha1::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        instance.local = Some(model::LocalInstallation {
            root: self.root.to_string_lossy().into(),
            version_directory: format!("instances/{}/game", instance.id),
            game_directory: format!("instances/{}/game", instance.id),
            client_jar: format!("versions/{}/client.jar", instance.version),
            source_key: uuid::Uuid::new_v4().simple().to_string().repeat(2),
            loader: kind.into(),
            loader_version: loader.into(),
        });
        Ok(bytes)
    }
    pub fn start_install_forge(
        self: &Arc<Self>,
        game: String,
        name: String,
        loader: String,
    ) -> Result<()> {
        if !model::valid_id(&game)
            || !crate::forge::valid_loader(&loader)
            || name.trim().is_empty()
            || name.chars().count() > 60
            || name.chars().any(char::is_control)
        {
            return Err("游戏、加载器版本或实例名称无效".into());
        }
        let cancel = self.begin_task("准备安装 Forge 客户端")?;
        self.inner
            .lock()
            .map_err(|_| "宿主不可用")?
            .task
            .planned_stages = vec!["base".into(), "loader".into(), "publish".into()];
        self.inner
            .lock()
            .map_err(|_| "宿主状态不可用")?
            .task
            .pending_instance = Some(name.clone());
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut transaction = None;
            let result = async {
                let legacy = game == "1.12.2";
                let (mut instance, base) = host
                    .prepare_instance(game, name, None, &cancel, legacy)
                    .await?;
                instance.launch.game_isolation = Some(true);
                let bytes = host
                    .apply_loader(&mut instance, &base.metadata, "forge", &loader, &cancel)
                    .await?;
                transaction = Some(crate::modpack::begin_instance(
                    &host.root,
                    &uuid::Uuid::new_v4().to_string(),
                    instance,
                )?);
                let tx = transaction.as_mut().ok_or("Forge 安装事务缺失")?;
                crate::modpack::copy(
                    &host.root,
                    tx,
                    "local-profile.json",
                    bytes.as_slice(),
                    None,
                    &cancel,
                )?;
                // Even a mod-free Forge instance needs a real isolated game directory.
                crate::modpack::ensure_game(&host.root, tx)?;
                crate::modpack::initialize_language(&host.root, tx, &cancel)?;
                let mut inner = host.inner.lock().map_err(|_| "宿主状态不可用")?;
                inner.instances =
                    crate::modpack::publish(&host.root, tx, &inner.instances, &cancel)?;
                inner.task.phase = "pack-committed".into();
                inner.task.pending_instance = None;
                let location = inner
                    .instances
                    .last()
                    .ok_or("实例提交记录缺失")?
                    .game_path(&host.root)?;
                inner.task.message = format!("Forge 安装完成：{}", location.display());
                let message = inner.task.message.clone();
                inner.task.logs.push(message);
                Ok(())
            }
            .await;
            let result = result.map_err(|error: String| {
                if let Some(tx) = &transaction {
                    if let Err(cleanup) = crate::modpack::rollback(&host.root, tx) {
                        return format!("{error}；暂存数据保留：{cleanup}");
                    }
                }
                error
            });
            if let Err(error) = &result {
                host.log(error, &[]);
            }
            host.finish(result, &cancel);
        });
        Ok(())
    }
    pub fn start_install_fabric(
        self: &Arc<Self>,
        version: String,
        name: String,
        loader: String,
    ) -> Result<()> {
        if !crate::fabric::valid_version(&loader) {
            return Err("无效 Fabric 版本".into());
        }
        self.start_install_inner(version, name, Some(loader))
    }
    fn start_install_inner(
        self: &Arc<Self>,
        version: String,
        name: String,
        loader: Option<String>,
    ) -> Result<()> {
        if !model::valid_id(&version) || name.trim().is_empty() || name.chars().count() > 60 {
            return Err("实例名称或版本无效".into());
        }
        let cancel = self.begin_task("读取官方版本清单")?;
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = host.install(version, name, loader, &cancel).await;
            host.finish(result, &cancel);
        });
        Ok(())
    }
    async fn prepare_instance(
        &self,
        version: String,
        name: String,
        loader: Option<String>,
        cancel: &CancellationToken,
        legacy: bool,
    ) -> Result<(Instance, minecraft::Prepared)> {
        let entry = minecraft::version_catalog(self, cancel)
            .await?
            .into_iter()
            .find(|entry| {
                entry.id == version && ["release", "snapshot"].contains(&entry.kind.as_str())
            })
            .ok_or("找不到可安装的官方版本；远古版本的旧式安装尚未支持")?;
        let prepared = if legacy {
            minecraft::prepare_legacy_pack(self, &entry, cancel).await?
        } else {
            minecraft::prepare(self, &entry, cancel).await?
        };
        let fabric_sha1 = if let Some(loader) = &loader {
            self.progress("fabric", "下载并校验 Fabric 加载器", 0, 1);
            crate::fabric::install(self, &version, loader, cancel).await?
        } else {
            String::new()
        };
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        let mut instance = Instance {
            version_folder: None,
            storage_root: None,
            local: None,
            id: uuid::Uuid::new_v4().to_string(),
            name: name.trim().into(),
            version,
            manifest_sha1: entry.sha1,
            java_major: prepared.java_major,
            fabric_version: loader.unwrap_or_default(),
            fabric_sha1,
            launch: model::LaunchOverrides {
                game_isolation: Some(self.status().settings.isolate_new_instances),
                ..Default::default()
            },
        };
        instance.use_versions_layout();
        Ok((instance, prepared))
    }
    async fn install(
        &self,
        version: String,
        name: String,
        loader: Option<String>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let (instance, prepared) = self
            .prepare_instance(version, name, loader, cancel, false)
            .await?;
        minecraft::extract_natives(
            &prepared.native_archives,
            &self.root,
            &format!("instances/{}/natives", instance.id),
        )?;
        let game = instance.game_path(&self.root)?;
        fs::create_dir_all(instance.directory(&self.root)?).map_err(|_| "无法创建版本目录")?;
        fs::create_dir_all(&game).map_err(|_| "无法创建隔离实例目录")?;
        crate::worlds::initialize_options(&game, &instance.version)?;
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        let mut instances = inner.instances.clone();
        instances.push(instance);
        model::save_json(&self.root, "instances.json", &instances)?;
        inner.instances = instances;
        inner.task.phase = "installed".into();
        Ok(())
    }
    pub fn start_launch(self: &Arc<Self>, id: String) -> Result<()> {
        let instance = {
            let inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.settings.launch_mode == model::LaunchMode::Offline {
                model::offline_profile(&inner.settings.offline_name)?;
            } else if inner.account.is_none() {
                return Err("请先登录拥有 Minecraft Java 档案的 Microsoft 账户".into());
            }
            inner
                .instances
                .iter()
                .find(|instance| instance.id == id)
                .cloned()
                .ok_or("本地实例不存在")?
        };
        self.instance_files(&id, |root| {
            let _locks = crate::worlds::lock_worlds(root)?;
            crate::resource_install::recover_all(root)
        })?;
        let cancel = self.begin_task("检查账户、Java 与已安装资源")?;
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = host.launch(instance, &cancel).await;
            host.finish(result, &cancel);
        });
        Ok(())
    }
    async fn launch(&self, instance: Instance, cancel: &CancellationToken) -> Result<()> {
        let state = self.status();
        let instance = state
            .instances
            .into_iter()
            .find(|item| item.id == instance.id)
            .ok_or("本地实例不存在")?;
        let mut settings = instance.launch.resolve(&state.settings);
        if settings.optimize_memory {
            match crate::memory::optimize_system() {
                Ok(_) => self.log("已请求系统整理可访问进程的工作集", &[]),
                Err(error) => self.log(&format!("内存整理未完成，继续启动：{error}"), &[]),
            }
        }
        if settings.memory_mode == model::MemoryMode::Auto {
            settings.memory_mb = crate::memory::status()?.recommended_mb;
        }
        self.log(
            &format!("本次游戏最大堆内存：{} MB", settings.memory_mb),
            &[],
        );
        let java = if instance.launch.java_path.is_none() {
            crate::java_runtime::ensure(self, &instance, &settings.java_path, cancel).await?
        } else {
            resolve_java(&instance, &settings.java_path, &self.root).await?
        };
        settings.java_path = java.path.clone();
        let (profile, token) = if settings.launch_mode == model::LaunchMode::Offline {
            (model::offline_profile(&settings.offline_name)?, "0".into())
        } else {
            self.access(cancel).await?
        };
        let entry = Version {
            id: instance.version.clone(),
            sha1: instance.manifest_sha1.clone(),
            url: format!(
                "https://piston-meta.mojang.com/v1/packages/{}/{}.json",
                instance.manifest_sha1, instance.version
            ),
            kind: "release".into(),
            release_time: String::new(),
        };
        let mut prepared = if instance.local.is_some() {
            crate::local_launch::repair_downloads(self, &instance, cancel).await?;
            if instance
                .local
                .as_ref()
                .is_some_and(|v| v.loader == "neoforge")
            {
                crate::local_launch::repair_neoforge(self, &instance, &settings.java_path, cancel)
                    .await?;
            }
            crate::local_launch::prepare(self, &instance, cancel)?
        } else {
            minecraft::prepare(self, &entry, cancel).await?
        };
        if instance.local.is_none() && !instance.fabric_version.is_empty() {
            crate::fabric::prepare(self, &instance, &mut prepared, cancel).await?;
        }
        minecraft::extract_natives(
            &prepared.native_archives,
            &self.root,
            &format!("instances/{}/natives", instance.id),
        )?;
        let args =
            minecraft::command_args(self, &instance, &prepared, &profile, &token, &settings)?;
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        let (process_args, _argument_file) =
            crate::local_launch::command_arguments(&self.root, &instance, &args)?;
        let mode = instance.launch.window_mode.unwrap_or_default();
        if let Some(backup) = crate::worlds::prepare_window(&instance.game_path(&self.root)?, mode)?
        {
            self.log(&format!("已在创建游戏窗口前应用 {mode:?} 模式；仅修改 options.txt 全屏项，备份：{backup}"), &[]);
        }
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        let mut child = Command::new(&settings.java_path)
            .args(&process_args)
            .current_dir(instance.game_path(&self.root)?)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "无法创建 Minecraft Java 进程")?;
        {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            inner.task.pid = child.id();
        }
        self.progress(
            "game",
            "Minecraft 进程运行中；结束任务或关闭启动器将结束此进程",
            1,
            1,
        );
        let secrets = if settings.launch_mode == model::LaunchMode::Offline {
            vec![]
        } else {
            vec![token]
        };
        let stdout = child.stdout.take().ok_or("无法读取游戏输出")?;
        let stderr = child.stderr.take().ok_or("无法读取游戏错误输出")?;
        let read_output = async {
            tokio::join!(
                capture(self, stdout, cancel, &secrets),
                capture(self, stderr, cancel, &secrets)
            );
        };
        let wait = async {
            tokio::select! { result = child.wait() => result.map_err(|_| "无法获取游戏退出状态"), _ = cancel.cancelled() => { child.kill().await.map_err(|_| "无法结束游戏进程")?; child.wait().await.map_err(|_| "无法回收游戏进程") } }
        };
        let (_, result) = tokio::join!(read_output, wait);
        let status = result?;
        if !status.success() && !cancel.is_cancelled() {
            return Err(format!(
                "游戏已退出，退出码 {}；请查看脱敏日志",
                status
                    .code()
                    .map(|code| code.to_string())
                    .unwrap_or_else(|| "unknown".into())
            ));
        }
        Ok(())
    }
    async fn access(&self, cancel: &CancellationToken) -> Result<(Profile, String)> {
        let stored = {
            let inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if let Some(session) = &inner.session {
                if session.valid() {
                    return Ok((session.stored.profile.clone(), session.access_token.clone()));
                }
            }
            inner.account.clone().ok_or("请先登录 Microsoft 账户")?
        };
        self.progress("account", "刷新并验证正版账户", 0, 1);
        let session = auth::refresh(&self.client, &stored, cancel).await?;
        auth::save(&self.root, &session.stored)?;
        let result = (session.stored.profile.clone(), session.access_token.clone());
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        inner.account = Some(session.stored.clone());
        inner.session = Some(session);
        Ok(result)
    }
    pub fn login_website(&self) -> Result<String> {
        let inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        auth::verification_uri(
            inner
                .login
                .as_ref()
                .map(|pending| pending.verification_uri.as_str())
                .unwrap_or("https://microsoft.com/link"),
        )
    }
    pub async fn begin_login(&self) -> Result<DeviceCode> {
        let (client_id, cancel) = {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.cancel.is_some() || inner.auth_cancel.is_some() || inner.auth_busy {
                return Err("请先结束当前任务或登录".into());
            }
            let cancel = CancellationToken::new();
            inner.auth_cancel = Some(cancel.clone());
            (inner.settings.client_id.clone(), cancel)
        };
        match auth::begin(&self.client, &client_id, &cancel).await {
            Ok(pending) => {
                let code = pending.public();
                let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
                if cancel.is_cancelled() {
                    return Err("登录已取消".into());
                }
                inner.login = Some(pending);
                Ok(code)
            }
            Err(error) => {
                let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
                if !cancel.is_cancelled() {
                    inner.auth_cancel = None;
                }
                Err(error)
            }
        }
    }
    pub async fn poll_login(&self) -> Result<bool> {
        let (mut pending, client_id, cancel) = {
            let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
            if inner.auth_busy {
                return Ok(false);
            }
            let pending = inner.login.take().ok_or("没有进行中的设备登录")?;
            let cancel = inner.auth_cancel.clone().ok_or("登录已取消")?;
            inner.auth_busy = true;
            (pending, inner.settings.client_id.clone(), cancel)
        };
        let result = auth::poll(&self.client, &client_id, &mut pending, &cancel).await;
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        inner.auth_busy = false;
        if cancel.is_cancelled() {
            return Err("登录已取消".into());
        }
        match result {
            Ok(Some(session)) => {
                inner.auth_cancel = None;
                auth::save(&self.root, &session.stored)?;
                inner.account = Some(session.stored.clone());
                inner.session = Some(session);
                Ok(true)
            }
            Ok(None) => {
                inner.login = Some(pending);
                Ok(false)
            }
            Err(error) => {
                inner.auth_cancel = None;
                Err(error)
            }
        }
    }
    pub fn cancel_login(&self) {
        let mut inner = self.inner.lock().expect("host state poisoned");
        if let Some(cancel) = inner.auth_cancel.take() {
            cancel.cancel();
        }
        inner.login = None;
    }
    pub fn sign_out(&self) -> Result<()> {
        let mut inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() || inner.auth_cancel.is_some() {
            return Err("请先结束当前任务或登录".into());
        }
        let path = model::safe_path(&self.root, "account.dpapi")?;
        if path.exists() {
            fs::remove_file(path).map_err(|_| "无法删除当前账户的加密凭据")?;
        }
        inner.account = None;
        inner.session = None;
        Ok(())
    }
}
async fn capture<R: AsyncRead + Unpin>(
    host: &Host,
    mut reader: R,
    cancel: &CancellationToken,
    secrets: &[String],
) {
    let mut buffer = [0; 4096];
    let mut line = vec![];
    let mut oversized = false;
    loop {
        let count = tokio::select! { _ = cancel.cancelled() => break, value = reader.read(&mut buffer) => match value { Ok(count) => count, Err(_) => break } };
        if count == 0 {
            if !line.is_empty() || oversized {
                let text = String::from_utf8_lossy(&line);
                host.log(
                    if oversized {
                        "[日志行过长，已省略]"
                    } else {
                        &text
                    },
                    secrets,
                );
            }
            break;
        }
        for byte in &buffer[..count] {
            if *byte == b'\n' {
                let text = String::from_utf8_lossy(&line);
                host.log(
                    if oversized {
                        "[日志行过长，已省略]"
                    } else {
                        &text
                    },
                    secrets,
                );
                line.clear();
                oversized = false;
            } else if line.len() < 8192 {
                line.push(*byte);
            } else {
                oversized = true;
            }
        }
    }
}
async fn resolve_java(
    instance: &Instance,
    configured: &str,
    root: &Path,
) -> Result<minecraft::JavaInfo> {
    let java = if instance.launch.java_path.is_none() {
        crate::local_launch::java_for(instance, configured, root).await?
    } else {
        minecraft::probe_java(configured).await?
    };
    if !java.is_64_bit || java.major != instance.java_major {
        return Err(format!(
            "该实例需要 64 位 Java {}，当前为 Java {}",
            instance.java_major, java.major
        ));
    }
    Ok(java)
}

pub fn default_root() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("EASYCRAFT_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    let executable = std::env::current_exe().map_err(|_| "无法定位应用目录")?;
    Ok(executable.parent().ok_or("无法定位应用目录")?.join("data"))
}
pub fn find_java() -> Option<String> {
    let executable = std::env::current_exe().ok()?;
    for parent in executable.ancestors() {
        let directory = parent.join("build-tools/easycraft/java21");
        if let Ok(entries) = fs::read_dir(directory) {
            for entry in entries.flatten() {
                let java = entry.path().join("bin/java.exe");
                if java.is_file() {
                    return Some(java.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod capture_tests {
    use super::*;
    #[tokio::test]
    async fn java_preflight_is_read_only_and_honors_explicit_paths() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        let id = uuid::Uuid::new_v4().to_string();
        let item: Instance = serde_json::from_value(serde_json::json!({"id":id,"name":"Java preflight","version":"1.21.1","manifestSha1":"a".repeat(40),"javaMajor":21,"launch":{"javaPath":"Z:/missing-easycraft-fixture/java.exe"}})).unwrap();
        model::save_json(&root, "instances.json", &vec![item]).unwrap();
        let host = Host::new(root.clone()).unwrap();
        let before = fs::read(root.join("instances.json")).unwrap();
        assert!(host.instance_java("missing").await.is_err());
        assert!(host
            .instance_java(&id)
            .await
            .err()
            .unwrap()
            .contains("java.exe"));
        assert_eq!(host.status().task.status, "idle");
        assert_eq!(fs::read(root.join("instances.json")).unwrap(), before);
    }
    #[test]
    fn custom_library_removal_uses_its_own_archive_and_preserves_other_files() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        let selected = root.join("selected");
        fs::create_dir_all(&selected).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let item: Instance = serde_json::from_value(serde_json::json!({"id":id,"name":"Selected location","version":"1.21.1","manifestSha1":"a".repeat(40),"javaMajor":21,"storageRoot":selected.to_string_lossy()})).unwrap();
        model::write_file(
            &selected,
            &format!("instances/{id}/game/options.txt"),
            b"game settings",
        )
        .unwrap();
        fs::write(selected.join("keep.txt"), b"unrelated").unwrap();
        model::save_json(&root, "instances.json", &vec![item]).unwrap();
        let host = Host::new(root.clone()).unwrap();
        let archived = host.remove_instance(&id, true).unwrap().unwrap();
        let archive = PathBuf::from(archived);
        assert!(!archive.exists());
        assert_eq!(fs::read(selected.join("keep.txt")).unwrap(), b"unrelated");
        assert!(host.status().instances.is_empty());
    }
    #[test]
    fn pack_destination_is_bound_to_current_preview_and_can_reset_without_writing_content() {
        use std::io::Write;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        let selected = root.join("chosen");
        fs::create_dir_all(&selected).unwrap();
        let host = Host::new(root.clone()).unwrap();
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
        zip.start_file(
            "modrinth.index.json",
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        zip.write_all(br#"{"formatVersion":1,"game":"minecraft","name":"Destination test","versionId":"1","dependencies":{"minecraft":"1.21.1"},"files":[]}"#).unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let preview = host
            .pack_preview(crate::modpack::inspect(&root, bytes.as_slice()).unwrap())
            .unwrap();
        let token = preview.install.unwrap().token;
        assert!(host
            .pack_destination("stale-token", Some(&selected))
            .is_err());
        let chosen = host
            .pack_destination(&token, Some(&selected))
            .unwrap()
            .unwrap();
        assert_eq!(
            PathBuf::from(chosen).canonicalize().unwrap(),
            selected.canonicalize().unwrap()
        );
        assert_eq!(fs::read_dir(&selected).unwrap().count(), 0);
        assert!(host.pack_destination(&token, None).unwrap().is_none());
        let cancel = host.begin_task("Busy fixture").unwrap();
        assert!(host.pack_destination(&token, Some(&selected)).is_err());
        host.finish(Ok(()), &cancel);
    }
    #[test]
    fn instance_removal_archives_owned_data_and_preserves_references_and_busy_instances() {
        use std::os::windows::fs::OpenOptionsExt;
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let item = Instance {
            version_folder: None,
            storage_root: None,
            id: id.clone(),
            name: "Owned".into(),
            version: "1.21.1".into(),
            manifest_sha1: "a".repeat(40),
            java_major: 21,
            fabric_version: String::new(),
            fabric_sha1: String::new(),
            launch: Default::default(),
            local: None,
        };
        model::save_json(&root, "instances.json", &vec![item.clone()]).unwrap();
        model::write_file(
            &root,
            &format!("instances/{id}/game/saves/keep.txt"),
            b"world bytes",
        )
        .unwrap();
        model::write_file(&root, "libraries/keep.jar", b"shared bytes").unwrap();
        let host = Host::new(root.clone()).unwrap();
        let cancel = host.begin_task("busy test").unwrap();
        assert!(host.remove_instance(&id, true).is_err());
        host.finish(Ok(()), &cancel);
        let lock = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000)
            .share_mode(1)
            .open(root.join(format!("instances/{id}")))
            .unwrap();
        assert!(host.remove_instance(&id, true).is_err());
        assert_eq!(host.status().instances.len(), 1);
        drop(lock);
        let archived = host.remove_instance(&id, true).unwrap().unwrap();
        assert!(!Path::new(&archived).exists());
        assert_eq!(
            fs::read(root.join("libraries/keep.jar")).unwrap(),
            b"shared bytes"
        );
        assert!(host.status().instances.is_empty());
        assert!(host.remove_instance(&id, false).is_err());
        drop(host);
        let mut reference = item;
        let outside = root.join("reference-source");
        fs::create_dir_all(outside.join("versions/ref")).unwrap();
        fs::write(outside.join("versions/ref/keep.txt"), b"external bytes").unwrap();
        reference.local = Some(model::LocalInstallation {
            root: outside.to_string_lossy().into(),
            version_directory: "versions/ref".into(),
            game_directory: "versions/ref".into(),
            client_jar: "versions/ref/ref.jar".into(),
            source_key: "a".repeat(64),
            loader: "vanilla".into(),
            loader_version: String::new(),
        });
        model::save_json(&root, "instances.json", &vec![reference]).unwrap();
        let host = Host::new(root.clone()).unwrap();
        assert!(host.remove_instance(&id, false).unwrap().is_none());
        assert_eq!(
            fs::read(outside.join("versions/ref/keep.txt")).unwrap(),
            b"external bytes"
        );
        drop(host);
        model::save_json(
            &root,
            "instances.json",
            &vec![{
                let mut v: Instance = model::load_json::<Vec<Instance>>(&root, "instances.json")
                    .unwrap()
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| Instance {
                        id: id.clone(),
                        name: "ref".into(),
                        version: "1.21.1".into(),
                        manifest_sha1: "a".repeat(40),
                        java_major: 21,
                        fabric_version: String::new(),
                        fabric_sha1: String::new(),
                        local: None,
                        storage_root: None,
                        version_folder: None,
                        launch: Default::default(),
                    });
                v.local = Some(model::LocalInstallation {
                    root: outside.to_string_lossy().into(),
                    version_directory: "versions/ref".into(),
                    game_directory: "versions/ref".into(),
                    client_jar: "versions/ref/ref.jar".into(),
                    source_key: "a".repeat(64),
                    loader: "vanilla".into(),
                    loader_version: String::new(),
                });
                v
            }],
        )
        .unwrap();
        let host = Host::new(root.clone()).unwrap();
        host.remove_instance(&id, true).unwrap();
        assert!(!outside.join("versions/ref").exists());
        drop(host);
        assert!(Host::new(root).unwrap().status().instances.is_empty());
    }
    #[test]
    fn cancellation_after_commit_does_not_report_a_committed_file_as_unwritten() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        let host = Host::new(root.clone()).unwrap();
        for phase in [
            "file-committed",
            "resources-committed",
            "pack-committed",
            "file-inspect",
        ] {
            let cancel = host.begin_task("fixture").unwrap();
            host.progress(phase, "fixture", 1, 1);
            cancel.cancel();
            host.finish(Ok(()), &cancel);
            assert_eq!(
                host.status().task.status,
                if phase == "file-inspect" {
                    "cancelled"
                } else {
                    "succeeded"
                }
            );
        }
        drop(host);
        fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn output_capture_bounds_lines_and_redacts_before_publication() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        let host = Host::new(root).unwrap();
        let data = format!("token secret-value\n{}\nlast-line", "x".repeat(20000));
        capture(
            &host,
            data.as_bytes(),
            &CancellationToken::new(),
            &["secret-value".into()],
        )
        .await;
        let logs = host.status().task.logs;
        assert_eq!(logs.len(), 3);
        assert_eq!(logs[0], "token [REDACTED]");
        assert_eq!(logs[1], "[日志行过长，已省略]");
        assert_eq!(logs[2], "last-line");
    }
}
