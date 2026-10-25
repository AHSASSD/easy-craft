use crate::model::{self, Result};
use sha2::{Digest, Sha512};
use std::{
    fs,
    io::Read,
    os::windows::{
        ffi::OsStringExt,
        fs::{MetadataExt, OpenOptionsExt},
        io::AsRawHandle,
    },
    path::Path,
};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, GetFinalPathNameByHandleW, SetFileInformationByHandle, DELETE,
    FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_SHARE_READ,
};

// Callers validate their own ownership and path scope before opening a file.
pub struct Guard {
    pub file: fs::File,
    _directory: fs::File,
}
impl Guard {
    pub fn open(root: &Path, relative: &str, bytes: u64, delete: bool) -> Result<Self> {
        let path = model::safe_path(root, relative)?;
        let directory = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path.parent().ok_or("文件目录无效")?)
            .map_err(|_| "目录被占用或不可读")?;
        if directory
            .metadata()
            .map_err(|_| "目录状态无效")?
            .file_attributes()
            & 0x400
            != 0
        {
            return Err("拒绝目录链接".into());
        }
        let file = fs::OpenOptions::new()
            .access_mode(FILE_GENERIC_READ | if delete { DELETE } else { 0 })
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&path)
            .map_err(|_| "文件被占用或无清理权限，已保留")?;
        let metadata = file.metadata().map_err(|_| "文件状态不可读")?;
        if delete && metadata.permissions().readonly() {
            return Err("文件只读，已保留".into());
        }
        if !metadata.is_file() || metadata.file_attributes() & 0x400 != 0 || metadata.len() != bytes
        {
            return Err("文件类型或大小已变化，已保留".into());
        }
        let mut name = vec![0u16; 32768];
        let len = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                name.as_mut_ptr(),
                name.len() as u32,
                0,
            )
        } as usize;
        if len == 0
            || len >= name.len()
            || std::ffi::OsString::from_wide(&name[..len])
                != path
                    .canonicalize()
                    .map_err(|_| "无法核对文件实际位置")?
                    .as_os_str()
        {
            return Err("文件实际位置不符，已保留".into());
        }
        Ok(Self {
            file,
            _directory: directory,
        })
    }
    pub fn remove(self) -> Result<()> {
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
        if unsafe {
            SetFileInformationByHandle(
                self.file.as_raw_handle(),
                FileDispositionInfo,
                (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        } == 0
        {
            return Err("文件无法移除，已保留".into());
        }
        Ok(())
    }
}
pub fn digest(file: &mut fs::File, cancel: &CancellationToken) -> Result<String> {
    let mut hash = Sha512::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err("文件检查已取消".into());
        }
        let count = file.read(&mut buffer).map_err(|_| "文件校验读取失败")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
