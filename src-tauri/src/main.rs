#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod fabric;
mod host;
mod memory;
mod minecraft;
mod model;
mod net;
mod packs;
mod skins;
#[cfg(test)]
mod tests;
mod worlds;
use host::Host;
use model::Result;
use std::sync::Arc;
use tauri::State;

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
            native_worlds,
            native_world,
            native_world_save,
            native_options,
            native_options_save,
            native_avatar,
            native_avatar_save,
            native_pack_preview,
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
