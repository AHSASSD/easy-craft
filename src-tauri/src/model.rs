use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, String>;
fn default_isolation() -> bool {
    true
}
#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchMode {
    #[default]
    Microsoft,
    Offline,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryMode {
    Auto,
    #[default]
    Manual,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default = "default_isolation")]
    pub auto_translate_packs: bool,
    pub client_id: String,
    pub java_path: String,
    pub memory_mb: u32,
    #[serde(default)]
    pub memory_mode: MemoryMode,
    #[serde(default)]
    pub optimize_memory: bool,
    #[serde(default)]
    pub launch_mode: LaunchMode,
    #[serde(default)]
    pub offline_name: String,
    #[serde(default = "default_isolation")]
    pub isolate_new_instances: bool,
}
impl Default for Settings {
    fn default() -> Self {
        let java = std::env::var("EASYCRAFT_JAVA").unwrap_or_default();
        Self {
            auto_translate_packs: true,
            client_id: option_env!("EASYCRAFT_MICROSOFT_CLIENT_ID")
                .unwrap_or_default()
                .into(),
            java_path: java,
            memory_mb: 2048,
            memory_mode: MemoryMode::Auto,
            optimize_memory: false,
            launch_mode: LaunchMode::Microsoft,
            offline_name: String::new(),
            isolate_new_instances: true,
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LaunchOverrides {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub java_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub java_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub game_isolation: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_mode: Option<WindowMode>,
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WindowMode {
    #[default]
    Windowed,
    Fullscreen,
    Inherit,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryOverride {
    pub memory_mode: MemoryMode,
    pub memory_mb: u32,
    pub optimize_memory: bool,
}
impl LaunchOverrides {
    pub fn is_empty(&self) -> bool {
        self.java_path.is_none()
            && self.java_version.is_none()
            && self.memory.is_none()
            && self.game_isolation.is_none()
            && self.window_mode.is_none()
    }
    pub fn validate(&self) -> Result<()> {
        if self.java_version.is_some() && self.java_path.is_none() {
            return Err("Java 版本记录需要对应的可执行文件路径".into());
        }
        if self
            .java_path
            .as_ref()
            .is_some_and(|path| path.trim().is_empty() || path.len() > 32768 || path.contains('\0'))
            || self
                .memory
                .as_ref()
                .is_some_and(|memory| !(512..=16384).contains(&memory.memory_mb))
        {
            return Err("实例启动覆盖无效；内存须为 512–16384 MB，继承项应移除覆盖".into());
        }
        Ok(())
    }
    pub fn resolve(&self, global: &Settings) -> Settings {
        let mut result = global.clone();
        if let Some(java) = &self.java_path {
            result.java_path.clone_from(java);
        }
        if let Some(memory) = &self.memory {
            result.memory_mode = memory.memory_mode;
            result.memory_mb = memory.memory_mb;
            result.optimize_memory = memory.optimize_memory;
        }
        result
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instance {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_root: Option<String>,
    pub id: String,
    pub name: String,
    pub version: String,
    pub manifest_sha1: String,
    pub java_major: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local: Option<LocalInstallation>,
    #[serde(default)]
    pub fabric_version: String,
    #[serde(default)]
    pub fabric_sha1: String,
    #[serde(default, skip_serializing_if = "LaunchOverrides::is_empty")]
    pub launch: LaunchOverrides,
}
impl Instance {
    pub fn use_versions_layout(&mut self) {
        let name: String = self
            .name
            .chars()
            .map(|c| {
                if c.is_control() || "\\/:*?\"<>|".contains(c) {
                    '_'
                } else {
                    c
                }
            })
            .take(60)
            .collect();
        self.version_folder = Some(format!(
            "ec-{}-{}",
            name.trim_end_matches(['.', ' ']),
            &self.id[..8]
        ));
    }
    pub fn minecraft_root(&self, root: &Path) -> Result<PathBuf> {
        let base = self.storage_path(root)?;
        if base
            .file_name()
            .is_some_and(|n| n.eq_ignore_ascii_case(".minecraft"))
        {
            Ok(base)
        } else {
            safe_path(&base, ".minecraft")
        }
    }
    pub fn content_relative<'a>(&self, relative: &'a str) -> &'a str {
        if self.version_folder.is_some() {
            relative.strip_prefix("game/").unwrap_or(relative)
        } else {
            relative
        }
    }
    pub fn content_directory(&self, directory: &Path) -> Result<PathBuf> {
        if self.version_folder.is_some() {
            Ok(directory.to_path_buf())
        } else {
            safe_path(directory, "game")
        }
    }
    pub fn storage_path(&self, root: &Path) -> Result<PathBuf> {
        match &self.storage_root {
            Some(selected) => crate::local_import::checked_directory(Path::new(selected)),
            None => Ok(root.to_path_buf()),
        }
    }
    pub fn directory(&self, root: &Path) -> Result<PathBuf> {
        if let Some(folder) = &self.version_folder {
            if !folder.starts_with("ec-") || folder.contains(['/', '\\']) {
                return Err("版本文件夹无效".into());
            }
            return safe_path(&self.minecraft_root(root)?, &format!("versions/{folder}"));
        }
        safe_path(&self.storage_path(root)?, &format!("instances/{}", self.id))
    }
    pub fn isolated(&self) -> bool {
        self.launch.game_isolation.unwrap_or_else(|| {
            self.local
                .as_ref()
                .is_none_or(|v| !v.game_directory.is_empty())
        })
    }
    pub fn game_path(&self, root: &Path) -> Result<PathBuf> {
        if self.version_folder.is_some() {
            return if self.launch.game_isolation == Some(false) {
                self.minecraft_root(root)
            } else {
                self.directory(root)
            };
        }
        if self.storage_root.is_some() {
            return safe_path(
                &self.storage_path(root)?,
                &if self.launch.game_isolation == Some(false) {
                    "shared-game".into()
                } else {
                    format!("instances/{}/game", self.id)
                },
            );
        }
        if let Some(local) = &self.local {
            let source = crate::local_import::checked_directory(Path::new(&local.root))?;
            let relative = match self.launch.game_isolation {
                Some(true) => local.version_directory.as_str(),
                Some(false) => "",
                None => local.game_directory.as_str(),
            };
            return if relative.is_empty() {
                Ok(source)
            } else {
                safe_path(&source, relative)
            };
        }
        safe_path(
            root,
            &if self.launch.game_isolation == Some(false) {
                "shared-game".to_string()
            } else {
                format!("instances/{}/game", self.id)
            },
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalInstallation {
    pub root: String,
    pub version_directory: String,
    pub game_directory: String,
    pub client_jar: String,
    pub source_key: String,
    pub loader: String,
    pub loader_version: String,
}
impl LocalInstallation {
    pub fn validate(&self) -> Result<()> {
        if !Path::new(&self.root).is_absolute()
            || self.root.len() > 32768
            || !["vanilla", "fabric", "forge", "neoforge"].contains(&self.loader.as_str())
            || self.loader_version.len() > 256
            || self.source_key.len() != 64
            || !self.source_key.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("本地版本引用无效".into());
        }
        safe_path(Path::new(&self.root), &self.client_jar)?;
        if !self.version_directory.is_empty() {
            safe_path(Path::new(&self.root), &self.version_directory)?;
        }
        if !self.game_directory.is_empty() {
            safe_path(Path::new(&self.root), &self.game_directory)?;
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub xuid: String,
    #[serde(default, rename = "skinUrl", alias = "skin_url")]
    pub skin_url: String,
}
pub fn valid_offline_name(name: &str) -> bool {
    (3..=16).contains(&name.len()) && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
pub fn offline_profile(name: &str) -> Result<Profile> {
    use windows_sys::Win32::Security::Cryptography::{CryptHashCertificate2, BCRYPT_MD5_ALGORITHM};
    if !valid_offline_name(name) {
        return Err("离线用户名须为 3–16 位英文字母、数字或下划线".into());
    }
    // MD5 only reproduces Java's nameUUIDFromBytes identity; it is not an authentication proof.
    let input = format!("OfflinePlayer:{name}");
    let mut hash = [0u8; 16];
    let mut size = hash.len() as u32;
    let ok = unsafe {
        CryptHashCertificate2(
            BCRYPT_MD5_ALGORITHM,
            0,
            std::ptr::null(),
            input.as_ptr(),
            input.len() as u32,
            hash.as_mut_ptr(),
            &mut size,
        )
    };
    if ok == 0 || size != 16 {
        return Err("无法生成离线玩家 UUID".into());
    }
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    Ok(Profile {
        id: uuid::Uuid::from_bytes(hash).simple().to_string(),
        name: name.into(),
        xuid: String::new(),
        skin_url: String::new(),
    })
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Version {
    pub id: String,
    pub url: String,
    pub sha1: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, rename = "releaseTime")]
    pub release_time: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub planned_stages: Vec<String>,
    pub pending_instance: Option<String>,
    pub steps: Vec<TaskStep>,
    pub status: String,
    pub phase: String,
    pub message: String,
    pub completed: usize,
    pub total: usize,
    pub logs: Vec<String>,
    pub pid: Option<u32>,
}
impl Default for Task {
    fn default() -> Self {
        Self {
            planned_stages: vec![],
            pending_instance: None,
            steps: vec![],
            status: "idle".into(),
            phase: String::new(),
            message: String::new(),
            completed: 0,
            total: 0,
            logs: vec![],
            pid: None,
        }
    }
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 100
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        && id != "."
        && id != ".."
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStep {
    pub outcome: Option<String>,
    pub phase: String,
    pub message: String,
    pub completed: usize,
    pub total: usize,
    pub done: bool,
}
pub fn valid_sha1(hash: &str) -> bool {
    hash.len() == 40 && hash.bytes().all(|c| c.is_ascii_hexdigit())
}
pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    checked_path(root, relative, true)
}
pub fn validate_relative_path(relative: &str) -> Result<()> {
    checked_path(Path::new("C:/EasyCraftPathValidation"), relative, false).map(|_| ())
}
fn checked_path(root: &Path, relative: &str, inspect_links: bool) -> Result<PathBuf> {
    if relative.is_empty()
        || relative.contains(['\\', ':', '<', '>', '"', '|', '?', '*'])
        || relative.chars().any(|c| c < ' ')
    {
        return Err("无效本地资源路径".into());
    }
    let mut path = root.to_path_buf();
    for component in Path::new(relative).components() {
        let Component::Normal(part) = component else {
            return Err("拒绝越界资源路径".into());
        };
        let name = part.to_string_lossy();
        if name.ends_with(['.', ' '])
            || name.split('.').next().is_some_and(|base| {
                [
                    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6",
                    "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7",
                    "LPT8", "LPT9",
                ]
                .contains(&base.to_ascii_uppercase().as_str())
            })
        {
            return Err("拒绝 Windows 保留路径".into());
        }
        path.push(part);
        if inspect_links {
            if let Ok(metadata) = fs::symlink_metadata(&path) {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("Resource path contains a link or reparse point".into());
                }
            }
        }
    }
    Ok(path)
}
pub fn write_file(root: &Path, relative: &str, bytes: &[u8]) -> Result<()> {
    let path = safe_path(root, relative)?;
    let temp = safe_path(root, &format!("{relative}.tmp"))?;
    fs::create_dir_all(path.parent().ok_or("无效目标目录")?).map_err(|_| "无法创建数据目录")?;
    let mut file = fs::File::create(&temp).map_err(|_| "无法写入临时数据")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法同步数据")?;
    drop(file);
    fs::rename(temp, path).map_err(|_| "无法原子保存数据（原文件保留）".into())
}
pub fn save_json<T: Serialize>(root: &Path, name: &str, value: &T) -> Result<()> {
    write_file(
        root,
        name,
        &serde_json::to_vec_pretty(value).map_err(|_| "无法序列化数据")?,
    )
}
pub fn load_json<T: serde::de::DeserializeOwned + Default>(root: &Path, name: &str) -> Result<T> {
    let path = safe_path(root, name)?;
    if !path.exists() {
        return Ok(T::default());
    }
    let raw = fs::read(path).map_err(|_| "无法读取本地数据")?;
    serde_json::from_slice(&raw).map_err(|_| format!("{name} 格式无效，原文件已保留，请备份后修复"))
}
pub fn redact(line: &str, secrets: &[String]) -> String {
    let mut line = line.to_owned();
    for secret in secrets {
        if !secret.is_empty() {
            line = line.replace(secret, "[REDACTED]");
        }
    }
    line.chars().take(8192).collect()
}
