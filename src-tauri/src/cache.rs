use crate::{
    model::{self, Result},
    resource_install,
};
use serde::{Deserialize, Serialize};
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
    time::Instant,
};
use tokio_util::sync::CancellationToken;
use windows_sys::Win32::Storage::FileSystem::{
    FileDispositionInfo, GetFinalPathNameByHandleW, SetFileInformationByHandle, DELETE,
    FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_GENERIC_READ, FILE_SHARE_READ,
};

const BATCH: usize = 2000;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Group {
    Resources,
    PackFiles,
    PackArchives,
    FileInputs,
    PackInputs,
}
impl Group {
    pub const ALL: [Self; 5] = [
        Self::Resources,
        Self::PackFiles,
        Self::PackArchives,
        Self::FileInputs,
        Self::PackInputs,
    ];
    pub fn folder(self) -> &'static str {
        match self {
            Self::Resources => "cache/modrinth",
            Self::PackFiles => "pack-cache",
            Self::PackArchives => "pack-archives",
            Self::FileInputs => "file-inputs",
            Self::PackInputs => "pack-inputs",
        }
    }
    fn expected(self, name: &str) -> Option<Option<String>> {
        let suffix = match self {
            Self::Resources => ".bin",
            Self::PackFiles => ".data",
            Self::PackArchives | Self::PackInputs => ".mrpack",
            Self::FileInputs => ".part",
        };
        let partial =
            !matches!(self, Self::FileInputs | Self::PackInputs) && name.ends_with(".part");
        let name = if partial {
            name.strip_suffix(".part")?
        } else {
            name
        };
        let stem = name.strip_suffix(suffix)?;
        if matches!(self, Self::FileInputs | Self::PackInputs) {
            uuid::Uuid::parse_str(stem).ok()?;
            Some(None)
        } else if stem.len() == 128 && stem.bytes().all(|b| b.is_ascii_hexdigit()) {
            Some(if partial {
                None
            } else {
                Some(stem.to_ascii_lowercase())
            })
        } else {
            None
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub groups: Vec<GroupSummary>,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSummary {
    pub group: Group,
    pub folder: String,
    pub files: usize,
    pub bytes: u64,
    pub skipped: usize,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub group: Group,
    pub path: String,
    pub bytes: u64,
    pub integrity: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub token: String,
    pub files: Vec<Entry>,
    pub bytes: u64,
    pub warnings: Vec<String>,
    #[serde(skip)]
    stamps: Vec<Stamp>,
    #[serde(skip)]
    created: Instant,
}
#[derive(Clone)]
struct Stamp {
    entry: Entry,
    identity: (u32, u32, u32),
    digest: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub removed_files: usize,
    pub removed_bytes: u64,
    pub kept: Vec<Kept>,
    pub cancelled: bool,
}
#[derive(Serialize)]
pub struct Kept {
    pub path: String,
    pub reason: String,
}

fn collect(root: &Path, groups: &[Group]) -> Result<(Summary, Vec<Entry>)> {
    if groups.is_empty()
        || groups.len() > 5
        || groups
            .iter()
            .enumerate()
            .any(|(i, group)| groups[..i].contains(group))
    {
        return Err("缓存分类选择无效".into());
    }
    let mut summary = Summary {
        groups: vec![],
        warnings: vec![],
    };
    let mut files = vec![];
    let mut scanned = 0;
    for &group in groups {
        let mut row = GroupSummary {
            group,
            folder: group.folder().into(),
            files: 0,
            bytes: 0,
            skipped: 0,
        };
        let directory = match model::safe_path(root, group.folder()) {
            Ok(path) => path,
            Err(error) => {
                summary
                    .warnings
                    .push(format!("{}：{error}，未读取", group.folder()));
                summary.groups.push(row);
                continue;
            }
        };
        if directory.exists() {
            for entry in fs::read_dir(&directory).map_err(|_| "缓存目录不可读取")? {
                scanned += 1;
                if scanned > 20000 {
                    return Err("缓存目录超过 20000 项，请先分批归档；未清理".into());
                }
                let entry = entry.map_err(|_| "缓存条目不可读取")?;
                let name = entry.file_name().to_string_lossy().into_owned();
                let relative = format!("{}/{name}", group.folder());
                let metadata = model::safe_path(root, &relative)
                    .and_then(|path| fs::metadata(path).map_err(|_| "缓存状态不可读".into()));
                match metadata {
                    Ok(metadata)
                        if group.expected(&name).is_some()
                            && metadata.is_file()
                            && metadata.len() <= crate::file_picker::MAX_FILE =>
                    {
                        row.files += 1;
                        row.bytes += metadata.len();
                        files.push(Entry {
                            group,
                            path: relative,
                            bytes: metadata.len(),
                            integrity: String::new(),
                        });
                    }
                    _ => row.skipped += 1,
                }
            }
        }
        summary.groups.push(row);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok((summary, files))
}
pub fn summary(root: &Path) -> Result<Summary> {
    collect(root, &Group::ALL).map(|(summary, _)| summary)
}
struct Opened {
    file: fs::File,
    _directory: fs::File,
}
fn open(root: &Path, entry: &Entry, delete: bool) -> Result<Opened> {
    let name = entry
        .path
        .strip_prefix(&format!("{}/", entry.group.folder()))
        .filter(|name| !name.contains('/'))
        .ok_or("缓存路径无效")?;
    if entry.group.expected(name).is_none() {
        return Err("非受控缓存文件".into());
    }
    let path = model::safe_path(root, &entry.path)?;
    let parent = path.parent().ok_or("缓存目录无效")?;
    let directory = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(parent)
        .map_err(|_| "缓存目录被占用或不可读")?;
    if directory
        .metadata()
        .map_err(|_| "缓存目录状态无效")?
        .file_attributes()
        & 0x400
        != 0
    {
        return Err("拒绝缓存目录链接".into());
    }
    let file = fs::OpenOptions::new()
        .access_mode(FILE_GENERIC_READ | if delete { DELETE } else { 0 })
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(&path)
        .map_err(|_| "文件被占用或无清理权限，已保留")?;
    let metadata = file.metadata().map_err(|_| "缓存文件状态不可读")?;
    if !metadata.is_file()
        || metadata.file_attributes() & 0x400 != 0
        || metadata.len() != entry.bytes
    {
        return Err("缓存文件类型或大小已变化，已保留".into());
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
                .map_err(|_| "无法核对缓存实际位置")?
                .as_os_str()
    {
        return Err("缓存实际位置不符，已保留".into());
    }
    Ok(Opened {
        file,
        _directory: directory,
    })
}
fn digest(file: &mut fs::File, cancel: &CancellationToken) -> Result<String> {
    let mut hash = Sha512::new();
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err("缓存检查已取消".into());
        }
        let count = file.read(&mut buffer).map_err(|_| "缓存内容读取失败")?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
pub fn prepare(
    root: &Path,
    groups: &[Group],
    cancel: &CancellationToken,
    progress: impl Fn(usize, usize),
) -> Result<Plan> {
    let (summary, files) = collect(root, groups)?;
    let mut plan = Plan {
        token: uuid::Uuid::new_v4().to_string(),
        files: vec![],
        bytes: 0,
        warnings: summary.warnings,
        stamps: vec![],
        created: Instant::now(),
    };
    let skipped: usize = summary.groups.iter().map(|row| row.skipped).sum();
    if skipped > 0 {
        plan.warnings
            .push(format!("{skipped} 项未识别内容、目录或链接将保留。"));
    }
    let total = files.len().min(BATCH);
    if files.len() > BATCH {
        plan.warnings
            .push("本次最多处理 2000 个候选文件，其余可再次检查；没有自动清理。".into());
    }
    for (index, mut entry) in files.into_iter().take(BATCH).enumerate() {
        if cancel.is_cancelled() {
            return Err("缓存检查已取消".into());
        }
        let checked = (|| -> Result<Stamp> {
            let mut opened = open(root, &entry, false)?;
            let identity = resource_install::file_identity(&model::safe_path(root, &entry.path)?)?;
            let digest = digest(&mut opened.file, cancel)?;
            let name = entry.path.rsplit('/').next().ok_or("缓存文件名无效")?;
            entry.integrity = match entry.group.expected(name).ok_or("缓存名称无效")? {
                Some(expected) if expected == digest => "verified",
                Some(_) => "corrupt",
                None => "temporary",
            }
            .into();
            Ok(Stamp {
                entry: entry.clone(),
                identity,
                digest,
            })
        })();
        match checked {
            Ok(stamp) => {
                plan.bytes += entry.bytes;
                plan.files.push(entry);
                plan.stamps.push(stamp);
            }
            Err(error) => {
                if cancel.is_cancelled() {
                    return Err(error);
                }
                plan.warnings.push(format!("{}：{error}", entry.path));
            }
        }
        if !cancel.is_cancelled() {
            progress(index + 1, total);
        }
    }
    Ok(plan)
}
pub fn clear(
    root: &Path,
    plan: Plan,
    cancel: &CancellationToken,
    progress: impl Fn(usize, usize),
) -> Result<Report> {
    if plan.created.elapsed().as_secs() > 600 {
        return Err("缓存预览已过期，请重新检查；未清理".into());
    }
    let mut report = Report {
        removed_files: 0,
        removed_bytes: 0,
        kept: vec![],
        cancelled: false,
    };
    let total = plan.stamps.len();
    for (index, stamp) in plan.stamps.into_iter().enumerate() {
        let result = (|| -> Result<()> {
            if cancel.is_cancelled() {
                return Err("已取消，未处理".into());
            }
            let mut opened = open(root, &stamp.entry, true)?;
            if resource_install::file_identity(&model::safe_path(root, &stamp.entry.path)?)?
                != stamp.identity
                || digest(&mut opened.file, cancel)? != stamp.digest
            {
                return Err("文件自预览后发生变化，已保留".into());
            }
            if cancel.is_cancelled() {
                return Err("已取消，未处理".into());
            }
            // Delete the verified open link, never resolve a frontend path for deletion.
            let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
            if unsafe {
                SetFileInformationByHandle(
                    opened.file.as_raw_handle(),
                    FileDispositionInfo,
                    (&disposition as *const FILE_DISPOSITION_INFO).cast(),
                    std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
                )
            } == 0
            {
                return Err("文件无法移除，已保留".into());
            }
            drop(opened);
            Ok(())
        })();
        match result {
            Ok(()) => {
                report.removed_files += 1;
                report.removed_bytes += stamp.entry.bytes;
            }
            Err(reason) => report.kept.push(Kept {
                path: stamp.entry.path,
                reason,
            }),
        }
        if !cancel.is_cancelled() {
            progress(index + 1, total);
        }
    }
    report.cancelled = cancel.is_cancelled();
    Ok(report)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, io::Write, path::PathBuf, time::Duration};
    fn root() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/cache-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn fixture(root: &Path, group: Group, bytes: &[u8]) -> PathBuf {
        let name = match group {
            Group::FileInputs => format!("{}.part", uuid::Uuid::new_v4()),
            Group::PackInputs => format!("{}.mrpack", uuid::Uuid::new_v4()),
            _ => format!(
                "{:x}{}",
                Sha512::digest(bytes),
                match group {
                    Group::Resources => ".bin",
                    Group::PackFiles => ".data",
                    _ => ".mrpack",
                }
            ),
        };
        let path = root.join(group.folder()).join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }
    #[test]
    fn cache_clear_removes_only_approved_links_and_keeps_installed_hardlinks_worlds_and_unknown_files(
    ) {
        let root = root();
        let cache = fixture(&root, Group::Resources, b"installed mod fixture");
        let installed = root.join("instances/one/game/mods/installed.jar");
        fs::create_dir_all(installed.parent().unwrap()).unwrap();
        fs::hard_link(&cache, &installed).unwrap();
        let protected = [
            "instances/one/game/saves/World/level.dat",
            "instances/one/game/.easycraft-backups/keep/level.dat",
            "assets/objects/keep",
            "libraries/keep.jar",
            "versions/1/client.jar",
            "skins/keep.png",
            "appearance/background.png",
            "settings.json",
            "instances.json",
            "cache/modrinth/personal-notes.txt",
        ];
        for relative in protected {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"preserve").unwrap();
        }
        for group in [
            Group::PackFiles,
            Group::PackArchives,
            Group::FileInputs,
            Group::PackInputs,
        ] {
            fixture(&root, group, group.folder().as_bytes());
        }
        let corrupt = root.join(format!("cache/modrinth/{}.bin", "a".repeat(128)));
        fs::write(&corrupt, b"corrupt fixture").unwrap();
        let cancel = CancellationToken::new();
        let plan = prepare(&root, &Group::ALL, &cancel, |_, _| {}).unwrap();
        assert_eq!(plan.files.len(), 6);
        assert!(plan.files.iter().any(|entry| entry.integrity == "corrupt"));
        assert!(!plan.warnings.is_empty());
        let report = clear(&root, plan, &cancel, |_, _| {}).unwrap();
        assert_eq!(report.removed_files, 6);
        assert!(report.kept.is_empty());
        assert!(!cache.exists());
        assert_eq!(fs::read(installed).unwrap(), b"installed mod fixture");
        for relative in protected {
            assert_eq!(fs::read(root.join(relative)).unwrap(), b"preserve");
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cache_clear_preserves_changed_replaced_locked_and_readonly_files_and_expires_old_previews() {
        let root = root();
        let cancel = CancellationToken::new();
        let changed = fixture(&root, Group::Resources, b"changed");
        let replaced = fixture(&root, Group::Resources, b"replaced");
        let locked = fixture(&root, Group::Resources, b"locked");
        let readonly = fixture(&root, Group::Resources, b"readonly");
        let plan = prepare(&root, &[Group::Resources], &cancel, |_, _| {}).unwrap();
        assert_eq!(plan.files.len(), 4);
        fs::write(&changed, b"edited!").unwrap();
        fs::rename(&replaced, root.join("original.bin")).unwrap();
        fs::write(&replaced, b"replaced").unwrap();
        let input = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(&locked)
            .unwrap();
        let mut permissions = fs::metadata(&readonly).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&readonly, permissions).unwrap();
        let report = clear(&root, plan, &cancel, |_, _| {}).unwrap();
        assert_eq!(report.removed_files, 0);
        assert_eq!(report.kept.len(), 4);
        assert_eq!(fs::read(&changed).unwrap(), b"edited!");
        assert!(replaced.exists());
        assert!(locked.exists());
        assert!(readonly.exists());
        drop(input);
        let mut permissions = fs::metadata(&readonly).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&readonly, permissions).unwrap();
        let mut plan = prepare(&root, &[Group::Resources], &cancel, |_, _| {}).unwrap();
        plan.created = Instant::now() - Duration::from_secs(601);
        assert!(clear(&root, plan, &cancel, |_, _| {})
            .err()
            .unwrap()
            .contains("过期"));
        assert!(changed.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_reports_partial_results_and_paths_cannot_escape_cache_scope() {
        let root = root();
        let cancel = CancellationToken::new();
        for bytes in [b"one".as_slice(), b"two", b"three"] {
            fixture(&root, Group::Resources, bytes);
        }
        let plan = prepare(&root, &[Group::Resources], &cancel, |_, _| {}).unwrap();
        let completed = Cell::new(0);
        let report = clear(&root, plan, &cancel, |done, _| {
            completed.set(done);
            cancel.cancel();
        })
        .unwrap();
        assert!(report.cancelled);
        assert_eq!(report.removed_files, 1);
        assert_eq!(report.kept.len(), 2);
        assert_eq!(completed.get(), 1);
        let cancel = CancellationToken::new();
        let mut plan = prepare(&root, &[Group::Resources], &cancel, |_, _| {}).unwrap();
        let sentinel = root.join("world.dat");
        fs::write(&sentinel, b"keep").unwrap();
        for stamp in &mut plan.stamps {
            stamp.entry.path = "world.dat".into();
        }
        assert_eq!(
            clear(&root, plan, &cancel, |_, _| {})
                .unwrap()
                .removed_files,
            0
        );
        assert_eq!(fs::read(sentinel).unwrap(), b"keep");
        assert!(prepare(
            &root,
            &[Group::Resources, Group::Resources],
            &cancel,
            |_, _| {}
        )
        .is_err());
        let mut output = fs::File::create(root.join("cache/modrinth/unrecognized.bin")).unwrap();
        output.write_all(b"keep").unwrap();
        drop(output);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn host_cache_tokens_do_not_override_active_tasks_or_allow_replayed_deletions() {
        let root = root();
        let cache = fixture(&root, Group::Resources, b"host fixture");
        let host = crate::host::Host::new(root.clone()).unwrap();
        host.begin_upload(
            "in-progress.zip".into(),
            3,
            crate::file_upload::Target::Pack,
        )
        .unwrap();
        assert!(host.prepare_cache(vec![Group::Resources]).is_err());
        assert!(host.clear_cache("not-a-token").is_err());
        assert_eq!(host.status().task.status, "running");
        host.cancel();
        let plan = host.prepare_cache(vec![Group::Resources]).unwrap();
        assert_eq!(host.status().task.phase, "cache-planned");
        assert!(cache.exists());
        assert!(host.clear_cache("old-token").is_err());
        assert!(cache.exists());
        assert_eq!(host.clear_cache(&plan.token).unwrap().removed_files, 1);
        assert!(!cache.exists());
        assert!(host.clear_cache(&plan.token).is_err());
        drop(host);
        fs::remove_dir_all(root).unwrap();
    }
}
