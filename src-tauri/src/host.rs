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
}
pub struct Host {
    _lock: fs::File,
    pub root: PathBuf,
    pub client: reqwest::Client,
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
        let settings: Settings = model::load_json(&root, "settings.json")?;
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
    pub fn instance_files<T>(
        &self,
        id: &str,
        operation: impl FnOnce(&Path) -> Result<T>,
    ) -> Result<T> {
        let inner = self.inner.lock().map_err(|_| "宿主状态不可用")?;
        if inner.cancel.is_some() {
            return Err("请先结束游戏或当前任务，再编辑配置".into());
        }
        if !inner.instances.iter().any(|item| item.id == id) {
            return Err("本地实例不存在".into());
        }
        let root = model::safe_path(&self.root, &format!("instances/{id}/game"))?;
        if !root.is_dir() {
            return Err("实例游戏目录不存在".into());
        }
        operation(&root)
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
    pub fn progress(&self, phase: &str, message: &str, completed: usize, total: usize) {
        let mut inner = self.inner.lock().expect("host state poisoned");
        inner.task.phase = phase.into();
        inner.task.message = message.into();
        inner.task.completed = completed;
        inner.task.total = total;
    }
    fn log(&self, line: &str, secrets: &[String]) {
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
        launch: model::LaunchOverrides,
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
        item.launch = launch;
        model::save_json(&self.root, "instances.json", &instances)?;
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
        let committed = result.is_ok()
            && ["file-committed", "resources-committed", "pack-committed"]
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
            if inner.task.phase.starts_with("file-") {
                "文件接收或检查已取消，未提交目标文件。"
            } else {
                "任务已取消，已校验缓存保留"
            }
            .into()
        } else {
            result.err().unwrap_or_else(|| {
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
                    let root = model::safe_path(&self.root, &format!("instances/{id}/game"))?;
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
    pub fn start_resource_install(self: &Arc<Self>, token: String) -> Result<()> {
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
            inner.resource_plan.take().ok_or("安装计划不可用")?
        };
        let status = self.status();
        let target = status
            .instances
            .iter()
            .find(|item| item.id == plan.instance_id)
            .ok_or("目标实例不存在")?;
        if plan.java_path != target.launch.resolve(&status.settings).java_path {
            return Err("Java 配置已变化，请重新生成安装计划".into());
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
                let root =
                    model::safe_path(&host.root, &format!("instances/{}/game", instance.id))?;
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
            inner.pack_plan.take().ok_or("整合包计划不可用")?
        };
        let cancel = self.begin_task("准备整合包新实例")?;
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut transaction = None;
            let result = async {
                let (instance, _) = host
                    .prepare_instance(
                        plan.game_version.clone(),
                        name,
                        if plan.fabric_version.is_empty() {
                            None
                        } else {
                            Some(plan.fabric_version.clone())
                        },
                        &cancel,
                    )
                    .await?;
                transaction = Some(crate::modpack::begin(&host.root, &plan, instance)?);
                let transaction = transaction.as_mut().ok_or("整合包事务不可用")?;
                crate::modpack::stage(&host, &plan, transaction, &selected, &cancel).await?;
                let mut inner = host.inner.lock().map_err(|_| "宿主状态不可用")?;
                inner.instances =
                    crate::modpack::publish(&host.root, transaction, &inner.instances, &cancel)?;
                inner.task.phase = "pack-committed".into();
                inner.task.completed = plan.files.len();
                inner.task.total = plan.files.len();
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
    ) -> Result<(Instance, minecraft::Prepared)> {
        let entry = minecraft::versions(self, cancel)
            .await?
            .into_iter()
            .find(|entry| entry.id == version)
            .ok_or("官方清单中找不到该正式版本")?;
        let prepared = minecraft::prepare(self, &entry, cancel).await?;
        let fabric_sha1 = if let Some(loader) = &loader {
            self.progress("fabric", "下载并校验 Fabric 加载器", 0, 1);
            crate::fabric::install(self, &version, loader, cancel).await?
        } else {
            String::new()
        };
        if cancel.is_cancelled() {
            return Err("操作已取消".into());
        }
        let instance = Instance {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.trim().into(),
            version,
            manifest_sha1: entry.sha1,
            java_major: prepared.java_major,
            fabric_version: loader.unwrap_or_default(),
            fabric_sha1,
            launch: Default::default(),
        };
        Ok((instance, prepared))
    }
    async fn install(
        &self,
        version: String,
        name: String,
        loader: Option<String>,
        cancel: &CancellationToken,
    ) -> Result<()> {
        let (instance, prepared) = self.prepare_instance(version, name, loader, cancel).await?;
        minecraft::extract_natives(
            &prepared.native_archives,
            &self.root,
            &format!("instances/{}/natives", instance.id),
        )?;
        let game = model::safe_path(&self.root, &format!("instances/{}/game", instance.id))?;
        fs::create_dir_all(game).map_err(|_| "无法创建隔离实例目录")?;
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
        let java = minecraft::probe_java(&settings.java_path).await?;
        if !java.is_64_bit || java.major != instance.java_major {
            return Err(format!(
                "该实例需要 64 位 Java {}，当前为 Java {}",
                instance.java_major, java.major
            ));
        }
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
        };
        let mut prepared = minecraft::prepare(self, &entry, cancel).await?;
        if !instance.fabric_version.is_empty() {
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
        let mut child = Command::new(&settings.java_path)
            .args(&args)
            .current_dir(model::safe_path(
                &self.root,
                &format!("instances/{}/game", instance.id),
            )?)
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
