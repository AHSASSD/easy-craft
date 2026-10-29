use crate::{
    content,
    model::{self, Result},
};
use serde::Deserialize;
use std::{
    fs,
    io::{Read, Seek, Write},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

pub const CHUNK: usize = 1024 * 1024;
#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    Pack,
    ModPreview {
        id: String,
    },
    Content {
        id: String,
        #[serde(rename = "contentKind")]
        content_kind: content::Kind,
    },
}
pub struct Upload {
    pub token: String,
    pub name: String,
    pub size: u64,
    pub written: u64,
    pub target: Target,
    pub cancel: CancellationToken,
    path: PathBuf,
    file: Option<fs::File>,
}
impl Drop for Upload {
    fn drop(&mut self) {
        self.file.take();
        let _ = fs::remove_file(&self.path);
    }
}
impl Upload {
    pub fn new(
        root: &Path,
        name: String,
        size: u64,
        target: Target,
        cancel: CancellationToken,
    ) -> Result<Self> {
        if size == 0
            || size > crate::file_picker::MAX_FILE
            || name.is_empty()
            || name.len() > 240
            || name.contains(['/', '\\'])
        {
            return Err("请选择不超过 512 MiB 的非空文件，文件名须在 240 字节内".into());
        }
        model::safe_path(root, &name)?;
        let extension = name.to_ascii_lowercase();
        let valid = match &target {
            Target::Pack => extension.ends_with(".zip") || extension.ends_with(".mrpack"),
            Target::ModPreview { .. } => extension.ends_with(".jar"),
            Target::Content {
                content_kind: content::Kind::Mods,
                ..
            } => extension.ends_with(".jar"),
            Target::Content {
                content_kind: content::Kind::Resourcepacks | content::Kind::Shaderpacks,
                ..
            } => extension.ends_with(".zip"),
            _ => false,
        };
        if !valid {
            return Err("文件扩展名与导入类别不符".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        let path = model::safe_path(root, &format!("file-inputs/{token}.part"))?;
        fs::create_dir_all(path.parent().ok_or("接收目录无效")?).map_err(|_| "无法创建接收目录")?;
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
            .open(&path)
            .map_err(|_| "无法创建临时接收文件")?;
        Ok(Self {
            token,
            name,
            size,
            written: 0,
            target,
            cancel,
            path,
            file: Some(file),
        })
    }
    pub fn append(&mut self, offset: u64, bytes: &[u8]) -> Result<()> {
        if self.cancel.is_cancelled() {
            return Err("文件接收已取消".into());
        }
        if offset != self.written
            || bytes.is_empty()
            || bytes.len() > CHUNK
            || bytes.len() as u64 > self.size - self.written
        {
            return Err("文件分块乱序、重复或超出声明大小".into());
        }
        self.file
            .as_mut()
            .ok_or("文件已关闭")?
            .write_all(bytes)
            .map_err(|_| "临时文件写入失败，未导入")?;
        self.written += bytes.len() as u64;
        Ok(())
    }
    pub fn reader(&mut self) -> Result<impl Read + '_> {
        if self.cancel.is_cancelled() || self.written != self.size {
            return Err("文件接收未完成或已取消".into());
        }
        let file = self.file.as_mut().ok_or("文件已关闭")?;
        file.sync_all().map_err(|_| "临时文件同步失败")?;
        file.rewind().map_err(|_| "临时文件读取失败")?;
        Ok(CancelReader {
            file,
            cancel: self.cancel.clone(),
        })
    }
}
struct CancelReader<'a> {
    file: &'a mut fs::File,
    cancel: CancellationToken,
}
impl Read for CancelReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.is_cancelled() {
            return Err(std::io::Error::other("文件接收已取消"));
        }
        self.file.read(bytes)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_cancelled_reader_fails_without_an_interrupted_retry_loop_and_removes_its_file() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        let cancel = CancellationToken::new();
        let mut upload =
            Upload::new(&root, "fixture.zip".into(), 3, Target::Pack, cancel.clone()).unwrap();
        upload.append(0, b"zip").unwrap();
        let path = upload.path.clone();
        let mut reader = upload.reader().unwrap();
        cancel.cancel();
        assert_eq!(
            reader.read(&mut [0; 3]).unwrap_err().kind(),
            std::io::ErrorKind::Other
        );
        drop(reader);
        drop(upload);
        assert!(!path.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
