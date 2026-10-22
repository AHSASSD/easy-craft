use crate::model::Result;
use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInfo {
    pub total_mb: u64,
    pub available_mb: u64,
    pub recommended_mb: u32,
    pub reserve_mb: u64,
}
pub fn recommend(total: u64, available: u64) -> (u32, u64) {
    let reserve = (total / 8).clamp(1024, 4096);
    let target = available
        .min(total)
        .saturating_sub(reserve)
        .min(total / 2)
        .clamp(512, 16384);
    ((target / 256 * 256) as u32, reserve)
}
pub fn status() -> Result<MemoryInfo> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut value = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    if unsafe { GlobalMemoryStatusEx(&mut value) } == 0 {
        return Err("无法读取物理内存状态".into());
    }
    let total = value.ullTotalPhys / 1024 / 1024;
    let available = value.ullAvailPhys / 1024 / 1024;
    let (recommended, reserve) = recommend(total, available);
    Ok(MemoryInfo {
        total_mb: total,
        available_mb: available,
        recommended_mb: recommended,
        reserve_mb: reserve,
    })
}
pub fn optimize() -> Result<MemoryInfo> {
    use windows_sys::Win32::System::{
        ProcessStatus::K32EmptyWorkingSet, Threading::GetCurrentProcess,
    };
    if unsafe { K32EmptyWorkingSet(GetCurrentProcess()) } == 0 {
        return Err("Windows 未能整理启动器工作集".into());
    }
    status()
}
pub fn process_ids() -> Result<Vec<u32>> {
    use windows_sys::Win32::System::ProcessStatus::K32EnumProcesses;
    let mut ids = vec![0u32; 8192];
    let mut needed = 0;
    if unsafe { K32EnumProcesses(ids.as_mut_ptr(), (ids.len() * 4) as u32, &mut needed) } == 0
        || needed as usize >= ids.len() * 4
    {
        return Err("无法完整读取进程列表，未执行系统整理".into());
    }
    ids.truncate(needed as usize / 4);
    Ok(ids)
}
pub fn optimize_system() -> Result<MemoryInfo> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            ProcessStatus::K32EmptyWorkingSet,
            Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_SET_QUOTA},
        },
    };
    let mut trimmed = 0;
    for id in process_ids()? {
        if id <= 4 {
            continue;
        }
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_SET_QUOTA, 0, id) };
        if handle.is_null() {
            continue;
        }
        if unsafe { K32EmptyWorkingSet(handle) } != 0 {
            trimmed += 1;
        }
        unsafe {
            CloseHandle(handle);
        }
    }
    if trimmed == 0 {
        return Err("没有可整理的进程；可能权限不足，未修改系统权限".into());
    }
    status()
}
