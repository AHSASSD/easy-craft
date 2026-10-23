#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod content;
mod fabric;
mod file_picker;
mod host;
mod memory;
mod minecraft;
mod model;
mod net;
mod packs;
mod resource_install;
mod resources;
mod skins;
#[cfg(test)]
mod tests;
mod worlds;
use host::Host;
use model::Result;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
async fn native_resource_plan(
    host: State<'_, Arc<Host>>,
    id: String,
    kind: resources::Kind,
    version: String,
    filename: String,
    world_id: Option<String>,
) -> Result<resource_install::Plan> {
    host.resource_plan(id, kind, version, filename, world_id)
        .await
}
#[tauri::command]
fn native_resource_install(host: State<'_, Arc<Host>>, token: String) -> Result<()> {
    host.start_resource_install(token)
}
#[tauri::command]
async fn native_world_datapacks(
    host: State<'_, Arc<Host>>,
    id: String,
    world_id: String,
) -> Result<Vec<content::Entry>> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| {
            content::list(
                &worlds::selected_world(root, &world_id)?,
                content::Kind::Datapacks,
            )
        })
    })
    .await
    .map_err(|_| "数据包列表读取失败".to_string())?
}
#[tauri::command]
async fn native_world_datapacks_open(
    host: State<'_, Arc<Host>>,
    id: String,
    world_id: String,
) -> Result<()> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| {
            content::open(
                &worlds::selected_world(root, &world_id)?,
                Some(content::Kind::Datapacks),
            )
        })
    })
    .await
    .map_err(|_| "数据包目录打开失败".to_string())?
}

#[tauri::command]
async fn native_resource_search(
    kind: resources::Kind,
    query: String,
    game_version: String,
    offset: u64,
) -> Result<resources::Search> {
    resources::search(kind, &query, &game_version, offset).await
}
#[tauri::command]
async fn native_resource_detail(
    project: String,
    kind: resources::Kind,
    game_version: String,
) -> Result<resources::Detail> {
    resources::detail(&project, kind, &game_version).await
}

#[tauri::command]
async fn native_content(
    host: State<'_, Arc<Host>>,
    id: String,
    kind: content::Kind,
) -> Result<Vec<content::Entry>> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| content::list(root, kind))
    })
    .await
    .map_err(|_| "内容读取任务失败".to_string())?
}
#[tauri::command]
async fn native_content_toggle(
    host: State<'_, Arc<Host>>,
    id: String,
    file: String,
    revision: String,
    enabled: bool,
) -> Result<()> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| content::toggle(root, &file, &revision, enabled))
    })
    .await
    .map_err(|_| "模组修改任务失败".to_string())?
}
#[tauri::command]
async fn native_content_import(
    host: State<'_, Arc<Host>>,
    id: String,
    kind: content::Kind,
    file: String,
    bytes: Vec<u8>,
) -> Result<()> {
    if kind == content::Kind::Mods
        && !host
            .status()
            .instances
            .iter()
            .any(|item| item.id == id && !item.fabric_version.is_empty())
    {
        return Err("本轮本地模组导入需要 Fabric 实例".into());
    }
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| content::import(root, kind, &file, &bytes))
    })
    .await
    .map_err(|_| "资源导入任务失败".to_string())?
}
#[tauri::command]
async fn native_content_pick(
    window: tauri::WebviewWindow,
    host: State<'_, Arc<Host>>,
    id: String,
    kind: content::Kind,
) -> Result<bool> {
    if kind == content::Kind::Screenshots {
        return Err("截图目录不支持导入".into());
    }
    let owner = window.hwnd().map_err(|_| "无法读取窗口")?.0 as isize;
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some((name, input)) = file_picker::pick(
            owner,
            if kind == content::Kind::Mods {
                &["jar"]
            } else {
                &["zip"]
            },
        )?
        else {
            return Ok(false);
        };
        if kind == content::Kind::Mods
            && !host
                .status()
                .instances
                .iter()
                .any(|item| item.id == id && !item.fabric_version.is_empty())
        {
            return Err("本轮本地模组导入需要 Fabric 实例".into());
        }
        host.instance_files(&id, |root| content::import_reader(root, kind, &name, input))?;
        Ok(true)
    })
    .await
    .map_err(|_| "本地文件导入任务失败".to_string())?
}
#[tauri::command]
async fn native_content_image(
    host: State<'_, Arc<Host>>,
    id: String,
    file: String,
) -> Result<String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| content::image(root, &file))
    })
    .await
    .map_err(|_| "截图读取任务失败".to_string())?
}
#[tauri::command]
async fn native_content_open(
    host: State<'_, Arc<Host>>,
    id: String,
    kind: Option<content::Kind>,
) -> Result<()> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| content::open(root, kind))
    })
    .await
    .map_err(|_| "目录打开任务失败".to_string())?
}
#[tauri::command]
fn native_instance_rename(host: State<'_, Arc<Host>>, id: String, name: String) -> Result<()> {
    host.rename_instance(&id, &name)
}
#[tauri::command]
fn native_status(host: State<'_, Arc<Host>>) -> host::Status {
    host.status()
}
#[tauri::command]
async fn native_worlds(host: State<'_, Arc<Host>>, id: String) -> Result<Vec<worlds::WorldEntry>> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.instance_files(&id, worlds::list))
        .await
        .map_err(|_| "存档列表读取失败".to_string())?
}
#[tauri::command]
async fn native_world(
    host: State<'_, Arc<Host>>,
    id: String,
    world_id: String,
) -> Result<worlds::WorldSettings> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| worlds::load_world(root, &world_id))
    })
    .await
    .map_err(|_| "世界配置读取失败".to_string())?
}
#[tauri::command]
async fn native_world_save(
    host: State<'_, Arc<Host>>,
    id: String,
    world_id: String,
    settings: worlds::WorldSettings,
) -> Result<String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| worlds::save_world(root, &world_id, settings))
    })
    .await
    .map_err(|_| "世界配置保存失败".to_string())?
}
#[tauri::command]
async fn native_options(host: State<'_, Arc<Host>>, id: String) -> Result<worlds::ClientOptions> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.instance_files(&id, worlds::load_options))
        .await
        .map_err(|_| "游戏选项读取失败".to_string())?
}
#[tauri::command]
async fn native_options_save(
    host: State<'_, Arc<Host>>,
    id: String,
    options: worlds::ClientOptions,
) -> Result<String> {
    let host = host.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        host.instance_files(&id, |root| worlds::save_options(root, options))
    })
    .await
    .map_err(|_| "游戏选项保存失败".to_string())?
}
#[tauri::command]
async fn native_avatar(host: State<'_, Arc<Host>>) -> Result<Option<String>> {
    skins::avatar(&host).await
}
#[tauri::command]
fn native_avatar_save(host: State<'_, Arc<Host>>, bytes: Vec<u8>) -> Result<()> {
    skins::save(&host, &bytes)
}
#[tauri::command]
async fn native_pack_preview(bytes: Vec<u8>) -> Result<packs::PackPreview> {
    tauri::async_runtime::spawn_blocking(move || packs::preview(&bytes))
        .await
        .map_err(|_| "压缩包检查任务失败".to_string())?
}
#[tauri::command]
async fn native_pack_pick(window: tauri::WebviewWindow) -> Result<Option<packs::PackPreview>> {
    let owner = window.hwnd().map_err(|_| "无法读取窗口")?.0 as isize;
    tauri::async_runtime::spawn_blocking(move || {
        file_picker::pick(owner, &["zip", "mrpack"])?
            .map(|(_, input)| packs::preview_reader(input))
            .transpose()
    })
    .await
    .map_err(|_| "压缩包检查任务失败".to_string())?
}
#[tauri::command]
async fn native_versions(host: State<'_, Arc<Host>>) -> Result<Vec<model::Version>> {
    minecraft::versions(&host, &tokio_util::sync::CancellationToken::new()).await
}
#[tauri::command]
async fn native_settings(host: State<'_, Arc<Host>>, settings: model::Settings) -> Result<()> {
    host.save_settings(settings).await
}
#[tauri::command]
fn native_memory() -> Result<memory::MemoryInfo> {
    memory::status()
}
#[tauri::command]
async fn native_memory_optimize(
    host: State<'_, Arc<Host>>,
    system: Option<bool>,
) -> Result<memory::MemoryInfo> {
    if host.status().task.status == "running" {
        return Err("请先结束当前游戏或任务，再整理内存".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if system.unwrap_or(false) {
            memory::optimize_system()
        } else {
            memory::optimize()
        }
    })
    .await
    .map_err(|_| "内存整理任务失败".to_string())?
}
#[tauri::command]
async fn native_java(path: String) -> Result<minecraft::JavaInfo> {
    minecraft::probe_java(&path).await
}
#[tauri::command]
fn native_install(
    host: State<'_, Arc<Host>>,
    version: String,
    name: String,
    fabric_version: Option<String>,
) -> Result<()> {
    if let Some(loader) = fabric_version {
        host.start_install_fabric(version, name, loader)
    } else {
        host.start_install(version, name)
    }
}
#[tauri::command]
async fn native_fabric_versions(
    host: State<'_, Arc<Host>>,
    version: String,
) -> Result<Vec<String>> {
    fabric::versions(&host, &version, &tokio_util::sync::CancellationToken::new()).await
}
#[tauri::command]
fn native_launch(host: State<'_, Arc<Host>>, id: String) -> Result<()> {
    host.start_launch(id)
}
#[tauri::command]
fn native_cancel(host: State<'_, Arc<Host>>) {
    host.cancel();
}
#[tauri::command]
async fn native_login_begin(host: State<'_, Arc<Host>>) -> Result<auth::DeviceCode> {
    host.begin_login().await
}
#[tauri::command]
async fn native_login_poll(host: State<'_, Arc<Host>>) -> Result<bool> {
    host.poll_login().await
}
#[tauri::command]
fn native_login_cancel(host: State<'_, Arc<Host>>) {
    host.cancel_login();
}
#[tauri::command]
fn native_sign_out(host: State<'_, Arc<Host>>) -> Result<()> {
    host.sign_out()
}
#[tauri::command]
fn native_open_login() -> Result<()> {
    std::process::Command::new("explorer.exe")
        .arg("https://microsoft.com/link")
        .spawn()
        .map(|_| ())
        .map_err(|_| "无法打开系统浏览器，请手动访问 https://microsoft.com/link".into())
}

fn main() {
    let state = host::default_root()
        .and_then(Host::new)
        .unwrap_or_else(|error| startup_error(&error));
    if state.status().settings.java_path.is_empty() {
        if let Some(path) = host::find_java() {
            let mut settings = state.status().settings;
            settings.java_path = path;
            if let Err(error) = tauri::async_runtime::block_on(state.save_settings(settings)) {
                startup_error(&error);
            }
        }
    }
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            native_status,
            native_instance_rename,
            native_content,
            native_content_toggle,
            native_content_import,
            native_content_pick,
            native_content_image,
            native_content_open,
            native_worlds,
            native_world,
            native_world_save,
            native_options,
            native_options_save,
            native_avatar,
            native_avatar_save,
            native_pack_preview,
            native_pack_pick,
            native_resource_search,
            native_resource_detail,
            native_resource_plan,
            native_resource_install,
            native_world_datapacks,
            native_world_datapacks_open,
            native_versions,
            native_settings,
            native_memory,
            native_memory_optimize,
            native_java,
            native_install,
            native_fabric_versions,
            native_launch,
            native_cancel,
            native_login_begin,
            native_login_poll,
            native_login_cancel,
            native_sign_out,
            native_open_login
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|error| startup_error(&format!("无法创建 Easy Craft 窗口：{error}")));
}

fn startup_error(message: &str) -> ! {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let text: Vec<u16> =
        format!("{message}\n\n原始数据未删除。请关闭重复窗口，或备份并检查配置后重试。")
            .encode_utf16()
            .chain(Some(0))
            .collect();
    let title: Vec<u16> = "Easy Craft 启动失败"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
    std::process::exit(1)
}
