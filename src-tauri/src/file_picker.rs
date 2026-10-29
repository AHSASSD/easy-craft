use crate::model::Result;
use std::{
    fs::{File, OpenOptions},
    os::windows::{ffi::OsStringExt, fs::OpenOptionsExt},
    path::PathBuf,
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{ERROR_CANCELLED, HWND},
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED,
        },
        UI::Shell::{
            Common::COMDLG_FILTERSPEC, FileOpenDialog, IFileOpenDialog, FOS_DONTADDTORECENT,
            FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS,
            SIGDN_FILESYSPATH,
        },
    },
};

pub const MAX_FILE: u64 = 512 * 1024 * 1024;
pub fn pick_directory(owner: isize) -> Result<Option<PathBuf>> {
    pick_directory_named(owner, "选择 Minecraft 根目录、versions 或具体版本目录")
}
pub fn pick_directory_named(owner: isize, title: &str) -> Result<Option<PathBuf>> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|_| "无法初始化文件夹选择器")?;
    let _apartment = Apartment;
    (|| -> windows::core::Result<Option<PathBuf>> {
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            dialog.SetOptions(
                dialog.GetOptions()?
                    | FOS_PICKFOLDERS
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_DONTADDTORECENT,
            )?;
            let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
            dialog.SetTitle(PCWSTR(title.as_ptr()))?;
            if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
                if error.code() == windows::core::HRESULT::from_win32(ERROR_CANCELLED.0) {
                    return Ok(None);
                }
                return Err(error);
            }
            let value = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = PathBuf::from(std::ffi::OsString::from_wide(value.as_wide()));
            CoTaskMemFree(Some(value.as_ptr().cast()));
            Ok(Some(path))
        }
    })()
    .map_err(|_| "系统文件夹选择失败".into())
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

pub fn open(path: PathBuf, extensions: &[&str]) -> Result<(String, File)> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("文件名无效")?;
    if !extensions.iter().any(|extension| {
        path.extension()
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    }) {
        return Err("文件扩展名与所选类别不符".into());
    }
    // Keep the selected bytes stable while inspecting/copying, without trusting a frontend path.
    let file = OpenOptions::new()
        .read(true)
        .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
        .open(&path)
        .map_err(|_| "无法只读打开所选文件，可能正在被其他程序修改")?;
    let metadata = file.metadata().map_err(|_| "无法读取文件状态")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FILE {
        return Err("请选择不超过 512 MiB 的非空文件".into());
    }
    Ok((name.to_owned(), file))
}

pub fn pick(owner: isize, extensions: &[&str]) -> Result<Option<(String, File)>> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|_| "无法初始化系统文件选择器")?;
    let _apartment = Apartment;
    let selected = (|| -> windows::core::Result<Option<PathBuf>> {
        unsafe {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            dialog.SetOptions(
                dialog.GetOptions()?
                    | FOS_FORCEFILESYSTEM
                    | FOS_FILEMUSTEXIST
                    | FOS_PATHMUSTEXIST
                    | FOS_DONTADDTORECENT,
            )?;
            let filter: Vec<u16> = extensions
                .iter()
                .map(|extension| format!("*.{extension}"))
                .collect::<Vec<_>>()
                .join(";")
                .encode_utf16()
                .chain(Some(0))
                .collect();
            dialog.SetFileTypes(&[COMDLG_FILTERSPEC {
                pszName: w!("Minecraft 内容文件"),
                pszSpec: PCWSTR(filter.as_ptr()),
            }])?;
            if let Err(error) = dialog.Show(Some(HWND(owner as *mut _))) {
                if error.code() == windows::core::HRESULT::from_win32(ERROR_CANCELLED.0) {
                    return Ok(None);
                }
                return Err(error);
            }
            let value = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = PathBuf::from(std::ffi::OsString::from_wide(value.as_wide()));
            CoTaskMemFree(Some(value.as_ptr().cast()));
            Ok(Some(path))
        }
    })()
    .map_err(|_| "系统文件选择失败，请重试")?;
    selected.map(|path| open(path, extensions)).transpose()
}
