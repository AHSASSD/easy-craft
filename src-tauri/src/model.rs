use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchMode {
    #[default]
    Microsoft,
    Offline,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub client_id: String,
    pub java_path: String,
    pub memory_mb: u32,
    #[serde(default)]
    pub launch_mode: LaunchMode,
    #[serde(default)]
    pub offline_name: String,
}
impl Default for Settings {
    fn default() -> Self {
        let java = std::env::var("EASYCRAFT_JAVA").unwrap_or_default();
        Self {
            client_id: String::new(),
            java_path: java,
            memory_mb: 2048,
            launch_mode: LaunchMode::Microsoft,
            offline_name: String::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub version: String,
    pub manifest_sha1: String,
    pub java_major: u32,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub xuid: String,
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
    })
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Version {
    pub id: String,
    pub url: String,
    pub sha1: String,
    #[serde(rename = "type")]
    pub kind: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
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
pub fn valid_sha1(hash: &str) -> bool {
    hash.len() == 40 && hash.bytes().all(|c| c.is_ascii_hexdigit())
}
pub fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
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
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("资源路径包含链接或重解析点".into());
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
