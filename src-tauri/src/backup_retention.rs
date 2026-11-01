use crate::{
    file_guard::{digest, Guard},
    model::{self, Result},
    resource_install,
    worlds::{self, BackupEntry},
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    time::Instant,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub token: String,
    pub instance_id: String,
    pub world_id: Option<String>,
    pub keep: u16,
    pub retained: Vec<BackupEntry>,
    pub remove: Vec<BackupEntry>,
    pub warnings: Vec<String>,
    #[serde(skip)]
    root: PathBuf,
    #[serde(skip)]
    stamps: Vec<Stamp>,
    #[serde(skip)]
    created: Instant,
}
#[derive(Clone, PartialEq, Eq)]
struct Stamp {
    entry: BackupEntry,
    data_id: (u32, u32, u32),
    record_id: (u32, u32, u32),
    record_hash: String,
    extra: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub removed: Vec<String>,
    pub kept: Vec<Kept>,
    pub warnings: Vec<String>,
    pub cancelled: bool,
}
#[derive(Serialize)]
pub struct Kept {
    pub id: String,
    pub reason: String,
}
fn paths(id: &str, target: &str) -> Result<(String, String, String)> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("备份编号无效".into());
    }
    let directory = format!(".easycraft-backups/{id}");
    let filename = if target == "options.txt" {
        "options.txt"
    } else {
        "level.dat"
    };
    Ok((
        format!("{directory}/{filename}"),
        format!("{directory}/record.json"),
        directory,
    ))
}
fn inspect(
    root: &Path,
    entry: &BackupEntry,
    target: &str,
    delete: bool,
    cancel: &CancellationToken,
) -> Result<(Stamp, Guard, Guard)> {
    if cancel.is_cancelled() {
        return Err("备份检查已取消".into());
    }
    let (data_path, record_path, directory) = paths(&entry.id, target)?;
    let record_bytes = fs::metadata(model::safe_path(root, &record_path)?)
        .map_err(|_| "归属记录不可读")?
        .len();
    if record_bytes > 4096 {
        return Err("归属记录过大".into());
    }
    let mut record = Guard::open(root, &record_path, record_bytes, delete)?;
    let data = Guard::open(root, &data_path, entry.bytes, delete)?;
    let (checked, _) = worlds::checked_backup(root, &entry.id, target)?;
    if &checked != entry {
        return Err("备份清单已变化".into());
    }
    let names: Vec<_> = fs::read_dir(model::safe_path(root, &directory)?)
        .map_err(|_| "备份目录不可读")?
        .take(3)
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<_>>()
        .map_err(|_| "备份目录不可读")?;
    let expected = if target == "options.txt" {
        "options.txt"
    } else {
        "level.dat"
    };
    let extra = names.len() != 2
        || !names.iter().any(|name| name == expected)
        || !names.iter().any(|name| name == "record.json");
    let stamp = Stamp {
        entry: entry.clone(),
        data_id: resource_install::file_identity(&model::safe_path(root, &data_path)?)?,
        record_id: resource_install::file_identity(&model::safe_path(root, &record_path)?)?,
        record_hash: digest(&mut record.file, cancel)?,
        extra,
    };
    Ok((stamp, data, record))
}
fn scan(
    root: &Path,
    world: Option<&str>,
    cancel: &CancellationToken,
    progress: impl Fn(usize, usize),
) -> Result<(Vec<Stamp>, Vec<String>)> {
    let target = worlds::backup_target(root, world)?;
    let list = worlds::backups(root, world)?;
    let total = list.entries.len();
    let mut warnings = list.warnings;
    let mut stamps = vec![];
    let mut bytes = 0u64;
    for (index, entry) in list.entries.into_iter().enumerate() {
        bytes += entry.bytes;
        if bytes > 512 * 1024 * 1024 {
            return Err("此目标备份校验超过 512 MiB 上限，请先手动归档；未清理".into());
        }
        match inspect(root, &entry, &target, false, cancel) {
            Ok((stamp, _, _)) => {
                if stamp.extra {
                    warnings.push(format!("{}：目录含额外内容，将保留。", entry.id));
                }
                stamps.push(stamp);
            }
            Err(error) => {
                if cancel.is_cancelled() {
                    return Err(error);
                }
                warnings.push(format!("{}：{error}，将保留。", entry.id));
            }
        }
        progress(index + 1, total);
    }
    Ok((stamps, warnings))
}
pub fn prepare(
    root: &Path,
    instance: &str,
    world: Option<&str>,
    keep: u16,
    cancel: &CancellationToken,
    progress: impl Fn(usize, usize),
) -> Result<Plan> {
    if !(1..=100).contains(&keep) {
        return Err("保留数量须为 1–100；不会删除全部备份".into());
    }
    let _locks = worlds::config_locks(root, world)?;
    let (stamps, warnings) = scan(root, world, cancel, progress)?;
    if cancel.is_cancelled() {
        return Err("备份检查已取消；未生成清理计划".into());
    }
    Ok(Plan {
        token: uuid::Uuid::new_v4().to_string(),
        instance_id: instance.into(),
        world_id: world.map(str::to_owned),
        keep,
        retained: stamps
            .iter()
            .take(usize::from(keep))
            .map(|s| s.entry.clone())
            .collect(),
        remove: stamps
            .iter()
            .skip(usize::from(keep))
            .filter(|s| !s.extra)
            .map(|s| s.entry.clone())
            .collect(),
        warnings,
        root: root.into(),
        stamps,
        created: Instant::now(),
    })
}
pub fn clear(
    plan: Plan,
    cancel: &CancellationToken,
    progress: impl Fn(usize, usize),
) -> Result<Report> {
    if plan.created.elapsed().as_secs() > 600 {
        return Err("备份清理预览已过期，请重新检查；未清理".into());
    }
    let root = &plan.root;
    let world = plan.world_id.as_deref();
    let _locks = worlds::config_locks(root, world)?;
    let target = worlds::backup_target(root, world)?;
    let (current, _) = scan(root, world, cancel, |_, _| {})?;
    if current != plan.stamps {
        return Err("备份清单或内容自预览后发生变化，请重新检查；未清理".into());
    }
    // Hold the newest valid copies open until cleanup finishes, so at least these remain recoverable.
    let mut retained_guards = vec![];
    for expected in current.iter().take(usize::from(plan.keep)) {
        let (stamp, data, record) = inspect(root, &expected.entry, &target, false, cancel)?;
        if &stamp != expected {
            return Err("保留备份已变化，未清理".into());
        }
        retained_guards.push((data, record));
    }
    let mut report = Report {
        removed: vec![],
        kept: vec![],
        warnings: vec![],
        cancelled: false,
    };
    let total = plan.remove.len();
    for (index, entry) in plan.remove.into_iter().enumerate() {
        let result = (|| -> Result<()> {
            if cancel.is_cancelled() {
                return Err("已取消，未处理".into());
            }
            let expected = current
                .iter()
                .find(|stamp| stamp.entry.id == entry.id)
                .ok_or("清理目标不在预览中")?;
            let (stamp, data, record) = inspect(root, &entry, &target, true, cancel)?;
            if stamp != *expected || stamp.extra {
                return Err("备份自预览后发生变化，已保留".into());
            }
            if cancel.is_cancelled() {
                return Err("已取消，未处理".into());
            }
            data.remove()?;
            if let Err(error) = record.remove() {
                report.warnings.push(format!(
                    "{}：备份内容已清理，归属记录保留：{error}",
                    entry.id
                ));
            } else {
                // This only removes an empty directory; newly added or unknown files prevent removal.
                let (_, _, directory) = paths(&entry.id, &target)?;
                if let Ok(path) = model::safe_path(root, &directory) {
                    if fs::remove_dir(path).is_err() {
                        report
                            .warnings
                            .push(format!("{}：内容已清理，非空或被占用目录保留。", entry.id));
                    }
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => report.removed.push(entry.id),
            Err(reason) => report.kept.push(Kept {
                id: entry.id,
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
    use sha1::{Digest, Sha1};
    use std::{os::windows::fs::OpenOptionsExt, time::Duration};
    fn root() -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/backup-retention-tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn backup(root: &Path, target: &str, created: u64) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let bytes = format!("configuration snapshot {created}");
        let (data, record, _) = paths(&id, target).unwrap();
        model::write_file(root, &data, bytes.as_bytes()).unwrap();
        let owner = if root.ends_with("game") {
            root.parent().unwrap()
        } else {
            root
        };
        model::save_json(root, &record, &serde_json::json!({
            "owner": owner.file_name().unwrap().to_str().unwrap(), "target": target,
            "sha1": Sha1::digest(bytes.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect::<String>(), "bytes": bytes.len(), "createdMs": created
        })).unwrap();
        id
    }
    fn prep(root: &Path, keep: u16) -> Plan {
        prepare(
            root,
            "instance",
            None,
            keep,
            &CancellationToken::new(),
            |_, _| {},
        )
        .unwrap()
    }
    #[test]
    fn cleanup_retains_newest_valid_backups_and_preserves_foreign_unknown_and_other_targets() {
        let root = root();
        fs::write(root.join("options.txt"), b"actual current options").unwrap();
        fs::create_dir_all(root.join("saves/WorldA")).unwrap();
        fs::write(root.join("saves/WorldA/level.dat"), b"current world").unwrap();
        let ids: Vec<_> = (1..=6).map(|n| backup(&root, "options.txt", n)).collect();
        let world = backup(&root, "saves/WorldA/level.dat", 10);
        let corrupted = backup(&root, "options.txt", 100);
        fs::write(
            root.join(paths(&corrupted, "options.txt").unwrap().0),
            b"corrupted",
        )
        .unwrap();
        model::write_file(
            &root,
            &format!(".easycraft-backups/{}/notes.txt", ids[0]),
            b"unknown user data",
        )
        .unwrap();
        model::write_file(&root, ".easycraft-backups/legacy/options.txt", b"legacy").unwrap();
        let foreign = backup(&root, "options.txt", 101);
        let foreign_record = root.join(paths(&foreign, "options.txt").unwrap().1);
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&foreign_record).unwrap()).unwrap();
        record["owner"] = serde_json::json!("other-instance");
        fs::write(&foreign_record, serde_json::to_vec(&record).unwrap()).unwrap();
        let plan = prep(&root, 2);
        assert_eq!(
            plan.retained
                .iter()
                .map(|entry| &entry.id)
                .collect::<Vec<_>>(),
            vec![&ids[5], &ids[4]]
        );
        assert_eq!(
            plan.remove
                .iter()
                .map(|entry| &entry.id)
                .collect::<Vec<_>>(),
            vec![&ids[3], &ids[2], &ids[1]]
        );
        assert!(!plan.warnings.is_empty());
        assert!(root.join(paths(&ids[1], "options.txt").unwrap().0).exists());
        let report = clear(plan, &CancellationToken::new(), |_, _| {}).unwrap();
        assert_eq!(report.removed.len(), 3);
        assert!(report.kept.is_empty());
        for id in [&ids[0], &ids[4], &ids[5], &corrupted, &foreign] {
            assert!(root.join(paths(id, "options.txt").unwrap().0).exists());
        }
        assert!(root
            .join(paths(&world, "saves/WorldA/level.dat").unwrap().0)
            .exists());
        assert_eq!(
            fs::read(root.join("options.txt")).unwrap(),
            b"actual current options"
        );
        assert_eq!(
            fs::read(root.join("saves/WorldA/level.dat")).unwrap(),
            b"current world"
        );
        assert_eq!(
            fs::read(root.join(format!(".easycraft-backups/{}/notes.txt", ids[0]))).unwrap(),
            b"unknown user data"
        );
        assert_eq!(
            fs::read(root.join(".easycraft-backups/legacy/options.txt")).unwrap(),
            b"legacy"
        );
        for id in &report.removed {
            assert!(!root.join(format!(".easycraft-backups/{id}")).exists());
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stale_plans_and_content_changes_refuse_cleanup_while_readonly_or_locked_candidates_are_kept()
    {
        let root = root();
        let ids: Vec<_> = (1..=4).map(|n| backup(&root, "options.txt", n)).collect();
        let plan = prep(&root, 1);
        let changed = root.join(paths(&ids[0], "options.txt").unwrap().0);
        let original = fs::read(&changed).unwrap();
        let mut edited = original.clone();
        edited[0] ^= 1;
        fs::write(&changed, &edited).unwrap();
        assert!(clear(plan, &CancellationToken::new(), |_, _| {}).is_err());
        for id in &ids {
            assert!(root.join(paths(id, "options.txt").unwrap().0).exists());
        }
        fs::write(&changed, original).unwrap();
        let mut expired = prep(&root, 1);
        expired.created = Instant::now() - Duration::from_secs(601);
        assert!(clear(expired, &CancellationToken::new(), |_, _| {}).is_err());
        let readonly = root.join(paths(&ids[1], "options.txt").unwrap().0);
        let plan = prep(&root, 1);
        let mut permissions = fs::metadata(&readonly).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&readonly, permissions).unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
            .open(&changed)
            .unwrap();
        let report = clear(plan, &CancellationToken::new(), |_, _| {}).unwrap();
        assert_eq!(report.removed, vec![ids[2].clone()]);
        assert_eq!(report.kept.len(), 2);
        assert!(root.join(paths(&ids[3], "options.txt").unwrap().0).exists());
        drop(locked);
        let mut permissions = fs::metadata(&readonly).unwrap().permissions();
        permissions.set_readonly(false);
        fs::set_permissions(&readonly, permissions).unwrap();
        let plan = prep(&root, 1);
        backup(&root, "options.txt", 9);
        assert!(clear(plan, &CancellationToken::new(), |_, _| {}).is_err());
        assert!(prepare(
            &root,
            "instance",
            None,
            0,
            &CancellationToken::new(),
            |_, _| {}
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_reports_committed_deletions_and_holds_newest_backup_open() {
        let root = root();
        let ids: Vec<_> = (1..=4).map(|n| backup(&root, "options.txt", n)).collect();
        let plan = prep(&root, 1);
        let cancel = CancellationToken::new();
        let latest = root.join(paths(&ids[3], "options.txt").unwrap().0);
        let report = clear(plan, &cancel, |done, _| {
            assert_eq!(done, 1);
            assert!(fs::remove_file(&latest).is_err());
            cancel.cancel();
        })
        .unwrap();
        assert!(report.cancelled);
        assert_eq!(report.removed.len(), 1);
        assert_eq!(report.kept.len(), 2);
        assert!(latest.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn world_session_locks_and_cancelled_checks_never_remove_backups() {
        let root = root();
        fs::create_dir_all(root.join("saves/WorldA")).unwrap();
        fs::write(
            root.join("saves/WorldA/level.dat"),
            b"current world fixture",
        )
        .unwrap();
        let old = backup(&root, "saves/WorldA/level.dat", 1);
        backup(&root, "saves/WorldA/level.dat", 2);
        let cancel = CancellationToken::new();
        let locks = worlds::config_locks(&root, Some("WorldA")).unwrap();
        assert!(prepare(&root, "instance", Some("WorldA"), 1, &cancel, |_, _| {}).is_err());
        drop(locks);
        let plan = prepare(&root, "instance", Some("WorldA"), 1, &cancel, |_, _| {}).unwrap();
        let locks = worlds::config_locks(&root, Some("WorldA")).unwrap();
        assert!(clear(plan, &cancel, |_, _| {}).is_err());
        drop(locks);
        assert!(
            prepare(&root, "instance", Some("WorldA"), 1, &cancel, |_, _| cancel
                .cancel())
            .is_err()
        );
        assert!(root
            .join(paths(&old, "saves/WorldA/level.dat").unwrap().0)
            .exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn host_cleanup_tokens_are_single_use_and_do_not_override_running_tasks() {
        let root = root();
        let instance = uuid::Uuid::new_v4().to_string();
        let game = root.join(format!("instances/{instance}/game"));
        fs::create_dir_all(&game).unwrap();
        backup(&game, "options.txt", 1);
        backup(&game, "options.txt", 2);
        model::save_json(
            &root,
            "instances.json",
            &vec![model::Instance {
                version_folder: None,
                storage_root: None,
                id: instance.clone(),
                name: "Fixture".into(),
                version: "1.21.1".into(),
                manifest_sha1: "a".repeat(40),
                java_major: 21,
                fabric_version: String::new(),
                fabric_sha1: String::new(),
                launch: Default::default(),
                local: None,
            }],
        )
        .unwrap();
        let host = crate::host::Host::new(root.clone()).unwrap();
        let plan = host.prepare_backup_cleanup(&instance, None, 1).unwrap();
        host.begin_upload(
            "in-progress.zip".into(),
            3,
            crate::file_upload::Target::Pack,
        )
        .unwrap();
        assert!(host.prepare_backup_cleanup(&instance, None, 1).is_err());
        assert!(host.clear_backup_cleanup(&plan.token).is_err());
        assert_eq!(host.status().task.status, "running");
        host.cancel();
        assert!(host.clear_backup_cleanup("wrong-token").is_err());
        assert_eq!(
            host.clear_backup_cleanup(&plan.token)
                .unwrap()
                .removed
                .len(),
            1
        );
        assert!(host.clear_backup_cleanup(&plan.token).is_err());
        drop(host);
        fs::remove_dir_all(root).unwrap();
    }
}
