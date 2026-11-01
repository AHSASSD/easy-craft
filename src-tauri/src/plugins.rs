//! Declarative packages only. No package can supply Rust/JS, paths, CSS or commands.
use crate::{
    host::Host,
    model::{self, Result},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::Path,
};
use tokio_util::sync::CancellationToken;

const MAX_PACKAGE: usize = 131072;
const INDEX: &str = "plugins/registry.json";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub label: String,
    pub capability: String,
    pub position: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub author: String,
    pub version: String,
    pub description: String,
    pub icon: String,
    pub category: String,
    pub capabilities: Vec<String>,
    pub entries: Vec<Entry>,
    pub scope: String,
    pub api_version: String,
    #[serde(default)]
    pub minecraft: Vec<String>,
    #[serde(default)]
    pub loaders: Vec<String>,
    #[serde(default)]
    pub dependencies: BTreeMap<String, String>,
    #[serde(default)]
    pub conflicts: Vec<String>,
    #[serde(default)]
    pub exclusive_slots: Vec<String>,
    pub permissions: Vec<String>,
    pub config_version: u32,
    #[serde(default)]
    pub settings: BTreeMap<String, Value>,
    #[serde(default)]
    pub update_source: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryPreference {
    pub hidden: bool,
    pub pinned: bool,
    pub order: u32,
}
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activation {
    pub enabled: bool,
    #[serde(default)]
    pub instances: Vec<String>,
    #[serde(default)]
    pub config: BTreeMap<String, Value>,
    #[serde(default)]
    pub entries: BTreeMap<String, EntryPreference>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installed {
    pub manifest: Manifest,
    pub file: String,
    pub sha512: String,
    pub source: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Registry {
    #[serde(default)]
    pub packages: Vec<Installed>,
    #[serde(default)]
    pub states: BTreeMap<String, Activation>,
    #[serde(default)]
    pub baseline: BTreeMap<String, Value>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub registry: Registry,
    pub safe_mode: bool,
    pub errors: BTreeMap<String, String>,
    pub appearance: BTreeMap<String, Value>,
    pub warning: String,
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Install {
        raw: String,
        expected: Option<String>,
    },
    Enable {
        id: String,
        enabled: bool,
        instances: Vec<String>,
        baseline: BTreeMap<String, Value>,
    },
    Configure {
        id: String,
        config: BTreeMap<String, Value>,
    },
    Entries {
        id: String,
        entries: BTreeMap<String, EntryPreference>,
    },
    Remove {
        id: String,
        expected: String,
        acknowledge: bool,
    },
    Recovery {
        disabled: bool,
    },
}
fn id(s: &str) -> bool {
    (3..=80).contains(&s.len())
        && !s.starts_with("official.")
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
        && s.as_bytes()[0].is_ascii_alphanumeric()
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max && !s.contains('\0')
}
fn version(s: &str) -> bool {
    semver::Version::parse(s).is_ok_and(|v| v.pre.is_empty() && v.build.is_empty())
}
fn settings(m: &Manifest, values: &BTreeMap<String, Value>) -> Result<()> {
    for (k, v) in values {
        let valid = match k.as_str() {
            "layout" => {
                m.capabilities.iter().any(|c| c == "appearance.layout")
                    && matches!(v.as_str(), Some("default" | "compact"))
            }
            "sidebarWidth" => {
                m.capabilities.iter().any(|c| c == "appearance.layout")
                    && v.as_u64().is_some_and(|n| (240..=420).contains(&n))
            }
            "theme" => {
                m.capabilities.iter().any(|c| c == "appearance.theme")
                    && matches!(v.as_str(), Some("slate" | "grass"))
            }
            "accentColor" => {
                m.capabilities.iter().any(|c| c == "appearance.theme")
                    && v.as_str().is_some_and(|s| {
                        s.len() == 7
                            && s.starts_with('#')
                            && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
                    })
            }
            "indent" => {
                m.capabilities.iter().any(|c| c == "tool.json") && matches!(v.as_u64(), Some(2 | 4))
            }
            _ => false,
        };
        if !valid {
            return Err(format!("不支持的配置：{k}"));
        }
    }
    Ok(())
}
pub fn parse(raw: &str) -> Result<Manifest> {
    if raw.len() > MAX_PACKAGE {
        return Err("插件包超过 128 KiB".into());
    }
    let value: Value = serde_json::from_str(raw).map_err(|_| "插件包不是有效 JSON")?;
    // Migrate the original format without executing it or granting extra permissions.
    let value = if value.get("schemaVersion") == Some(&json!(1)) {
        let obj = value.as_object().ok_or("无效旧版插件")?;
        if obj.keys().any(|k| {
            ![
                "schemaVersion",
                "id",
                "name",
                "version",
                "description",
                "type",
                "settings",
            ]
            .contains(&k.as_str())
        }) {
            return Err("旧版插件含不支持的字段".into());
        }
        let kind = match value["type"].as_str() {
            Some("layout") => "layout",
            Some("theme") => "theme",
            _ => return Err("旧版插件仅支持布局和主题".into()),
        };
        json!({"schemaVersion":2,"id":value["id"],"name":value["name"],"author":"未署名（旧版本地包）","version":value["version"],"description":value.get("description").cloned().unwrap_or(json!("")),"icon":kind,"category":"appearance","capabilities":[format!("appearance.{kind}")],"entries":[{"id":"appearance","label":"外观设置","capability":format!("appearance.{kind}"),"position":"appearance"}],"scope":"global","apiVersion":"1.0.0","exclusiveSlots":[kind],"permissions":["appearance"],"configVersion":1,"settings":value["settings"]})
    } else {
        value
    };
    let m: Manifest =
        serde_json::from_value(value).map_err(|_| "插件声明字段无效或包含未支持内容")?;
    validate(&m)?;
    Ok(m)
}
fn validate(m: &Manifest) -> Result<()> {
    if m.schema_version != 2 || m.api_version != "1.0.0" || m.config_version != 1 {
        return Err("插件声明、接口或配置版本不兼容".into());
    }
    if !id(&m.id)
        || !text(&m.name, 80)
        || !text(&m.author, 80)
        || !version(&m.version)
        || m.description.chars().count() > 1000
        || !matches!(
            m.icon.as_str(),
            "layout" | "theme" | "palette" | "code" | "shield" | "wrench" | "boxes"
        )
    {
        return Err("插件标识、版本或基本信息无效".into());
    }
    if !matches!(m.category.as_str(), "tools" | "instance" | "appearance")
        || !matches!(m.scope.as_str(), "global" | "instance")
        || m.capabilities.is_empty()
        || m.capabilities.len() > 4
        || m.entries.is_empty()
        || m.entries.len() > 8
    {
        return Err("插件分类、作用范围或入口无效".into());
    }
    let mut capabilities = BTreeSet::new();
    let mut slots = BTreeSet::new();
    let mut permissions = BTreeSet::new();
    for c in &m.capabilities {
        if !capabilities.insert(c.as_str()) {
            return Err("插件能力重复".into());
        }
        match c.as_str() {
            "tool.json" if m.scope == "global" => {}
            "instance.mod-check" if m.scope == "instance" => {
                permissions.insert("instances.read");
            }
            "appearance.layout" if m.scope == "global" => {
                slots.insert("layout");
                permissions.insert("appearance");
            }
            "appearance.theme" if m.scope == "global" => {
                slots.insert("theme");
                permissions.insert("appearance");
            }
            _ => return Err(format!("尚未支持的能力或作用范围：{c}；不接受可执行代码")),
        }
    }
    let primary = match m.category.as_str() {
        "tools" => "tool.",
        "instance" => "instance.",
        _ => "appearance.",
    };
    if !m.capabilities.iter().any(|c| c.starts_with(primary))
        || m.exclusive_slots
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>()
            != slots
        || m.exclusive_slots.len() != slots.len()
        || m.permissions
            .iter()
            .map(String::as_str)
            .collect::<BTreeSet<_>>()
            != permissions
        || m.permissions.len() != permissions.len()
    {
        return Err("主要分类、独占位置或权限与实际能力不符".into());
    }
    let mut entries = BTreeSet::new();
    for e in &m.entries {
        if !id(&e.id)
            || !entries.insert(&e.id)
            || !text(&e.label, 40)
            || !m.capabilities.contains(&e.capability)
            || !match e.capability.as_str() {
                "tool.json" => e.position == "tool",
                "instance.mod-check" => {
                    matches!(e.position.as_str(), "instance-overview" | "instance-tab")
                }
                _ => e.position == "appearance",
            }
        {
            return Err("插件入口超出宿主允许的位置或存在重复".into());
        }
    }
    if m.dependencies.len() > 32
        || m.conflicts.len() > 32
        || m.dependencies
            .iter()
            .any(|(k, v)| !id(k) || k == &m.id || !(v == "*" || version(v)))
        || m.conflicts.iter().any(|k| !id(k) || k == &m.id)
        || m.minecraft.len() > 64
        || m.minecraft.iter().any(|s| !text(s, 64))
        || m.loaders
            .iter()
            .any(|s| !["vanilla", "fabric", "forge", "neoforge", "quilt"].contains(&s.as_str()))
    {
        return Err("插件依赖、冲突或游戏条件无效（依赖版本支持精确版本或 *）".into());
    }
    if m.scope != "instance" && (!m.minecraft.is_empty() || !m.loaders.is_empty()) {
        return Err("游戏兼容条件仅适用于实例扩展".into());
    }
    if let Some(url) = &m.update_source {
        let u = reqwest::Url::parse(url).map_err(|_| "更新来源不是有效 HTTPS URL")?;
        if u.scheme() != "https"
            || !u.username().is_empty()
            || u.password().is_some()
            || url.len() > 1024
        {
            return Err("更新来源必须为无凭据的 HTTPS 地址".into());
        }
    }
    settings(m, &m.settings)
}
fn root_available(root: &Path) -> Result<()> {
    if !root.is_dir() {
        Err("插件目录暂不可用，请重新连接数据盘；配置已保留".into())
    } else {
        Ok(())
    }
}
fn read_registry(root: &Path) -> Result<Registry> {
    root_available(root)?;
    let path = model::safe_path(root, INDEX)?;
    if !path.exists() {
        return Ok(Registry::default());
    }
    if fs::metadata(&path).map_err(|_| "插件记录暂不可读")?.len() > 16 * 1024 * 1024 {
        return Err("插件记录过大，已保留；可以进入恢复模式".into());
    }
    let mut r: Registry = model::load_json(root, INDEX)?;
    let pending = model::safe_path(root, "plugins/registry.pending")?;
    if pending.exists() && fs::metadata(&pending).is_ok_and(|m| m.len() <= 16 * 1024 * 1024) {
        if let Ok(next) = model::load_json::<Registry>(root, "plugins/registry.pending") {
            let removed: Vec<_> = r
                .packages
                .iter()
                .filter(|p| !next.packages.iter().any(|n| n.manifest.id == p.manifest.id))
                .collect();
            if removed.len() == 1
                && model::safe_path(root, &removed[0].file).is_ok_and(|p| !p.exists())
                && next.packages.len() + 1 == r.packages.len()
                && next.packages.iter().all(|n| {
                    r.packages.iter().any(|p| {
                        p.file == n.file && p.sha512 == n.sha512 && p.manifest == n.manifest
                    })
                })
            {
                r = next;
            }
        }
    }
    if r.packages.len() > 100
        || r.states.len() > 500
        || r.packages
            .iter()
            .map(|p| &p.manifest.id)
            .collect::<BTreeSet<_>>()
            .len()
            != r.packages.len()
    {
        return Err("插件记录无效，已保留；可以进入恢复模式".into());
    }
    if r.baseline.iter().any(|(k, v)| !match k.as_str() {
        "theme" => matches!(v.as_str(), Some("slate" | "grass")),
        "layout" => matches!(v.as_str(), Some("default" | "compact")),
        "sidebarWidth" => v.as_u64().is_some_and(|n| (240..=420).contains(&n)),
        "accentColor" => v.as_str().is_some_and(|s| {
            s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
        }),
        _ => false,
    }) {
        return Err("原有外观配置记录无效，未应用第三方配置".into());
    }
    for p in &r.packages {
        validate(&p.manifest)?;
        let prefix = format!("plugins/packages/{}/", p.manifest.id);
        if p.source != "local"
            || !p.file.starts_with(&prefix)
            || p.file[prefix.len()..].contains(['/', '\\'])
            || !p.file.ends_with(".json")
            || p.sha512.len() != 128
            || !p.sha512.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("插件安装记录路径或来源无效".into());
        }
        model::safe_path(root, &p.file)?;
        if let Some(s) = r.states.get(&p.manifest.id) {
            settings(&p.manifest, &s.config)?;
            if s.entries
                .keys()
                .any(|id| !p.manifest.entries.iter().any(|e| &e.id == id))
                || s.instances.len() > 1000
            {
                return Err("插件配置记录无效".into());
            }
        }
    }
    Ok(r)
}
fn digest(raw: &[u8]) -> String {
    format!("{:x}", Sha512::digest(raw))
}
fn package_error(root: &Path, p: &Installed) -> Result<()> {
    let path = model::safe_path(root, &p.file)?;
    let mut file = fs::File::open(path).map_err(|_| "插件文件暂不可用，安装记录和设置已保留")?;
    let mut raw = Vec::new();
    file.by_ref()
        .take((MAX_PACKAGE + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|_| "插件文件读取失败")?;
    if raw.len() > MAX_PACKAGE || digest(&raw) != p.sha512 {
        return Err("插件文件校验失败，已隔离停用".into());
    }
    let manifest = parse(std::str::from_utf8(&raw).map_err(|_| "插件文件编码无效")?)?;
    if manifest != p.manifest {
        return Err("插件声明与安装记录不符，已停用".into());
    }
    Ok(())
}
fn active(r: &Registry, id: &str, scope: Option<&str>) -> bool {
    r.states
        .get(id)
        .is_some_and(|s| s.enabled && scope.is_none_or(|i| s.instances.iter().any(|v| v == i)))
}
fn dependency_graph(
    r: &Registry,
    id: &str,
    stack: &mut Vec<String>,
    done: &mut BTreeSet<String>,
) -> Result<()> {
    if done.contains(id) {
        return Ok(());
    }
    if stack.iter().any(|s| s == id) {
        return Err(format!("循环依赖：{} → {id}", stack.join(" → ")));
    }
    let p = r
        .packages
        .iter()
        .find(|p| p.manifest.id == id)
        .ok_or_else(|| format!("缺少依赖：{id}"))?;
    stack.push(id.to_string());
    for (dep, version) in &p.manifest.dependencies {
        let target = r
            .packages
            .iter()
            .find(|p| &p.manifest.id == dep)
            .ok_or_else(|| format!("{} 缺少依赖：{dep}", p.manifest.name))?;
        if version != "*" && &target.manifest.version != version {
            return Err(format!(
                "依赖 {dep} 需要 {version}，当前 {}",
                target.manifest.version
            ));
        }
        dependency_graph(r, dep, stack, done)?;
    }
    stack.pop();
    done.insert(id.into());
    Ok(())
}
fn visit(
    r: &Registry,
    root: &Path,
    id: &str,
    scope: Option<&str>,
    stack: &mut Vec<String>,
    done: &mut BTreeSet<String>,
) -> Result<()> {
    if done.contains(id) {
        return Ok(());
    }
    if stack.iter().any(|x| x == id) {
        return Err(format!("循环依赖：{} → {id}", stack.join(" → ")));
    }
    let p = r
        .packages
        .iter()
        .find(|p| p.manifest.id == id)
        .ok_or_else(|| format!("缺少依赖插件：{id}"))?;
    package_error(root, p)?;
    stack.push(id.to_string());
    for (dep, version) in &p.manifest.dependencies {
        let d = r
            .packages
            .iter()
            .find(|p| &p.manifest.id == dep)
            .ok_or_else(|| format!("{} 缺少依赖：{dep}", p.manifest.name))?;
        if version != "*" && &d.manifest.version != version {
            return Err(format!(
                "依赖 {dep} 需要 {version}，当前 {}",
                d.manifest.version
            ));
        }
        if d.manifest.scope == "instance" && scope.is_none() {
            return Err(format!("全局插件不能依赖按实例启用的插件：{dep}"));
        }
        if !active(
            r,
            dep,
            if d.manifest.scope == "instance" {
                scope
            } else {
                None
            },
        ) {
            return Err(format!("请先在对应范围启用依赖：{dep}"));
        }
        visit(
            r,
            root,
            dep,
            if d.manifest.scope == "instance" {
                scope
            } else {
                None
            },
            stack,
            done,
        )?;
    }
    for other in &r.packages {
        if other.manifest.id == id
            || !active(
                r,
                &other.manifest.id,
                if other.manifest.scope == "instance" {
                    scope
                } else {
                    None
                },
            )
        {
            continue;
        }
        if other.manifest.scope == "instance" && scope.is_none() {
            continue;
        }
        if p.manifest.conflicts.contains(&other.manifest.id)
            || other.manifest.conflicts.iter().any(|c| c == id)
        {
            return Err(format!(
                "{} 与 {} 明确冲突",
                p.manifest.name, other.manifest.name
            ));
        }
        if p.manifest
            .exclusive_slots
            .iter()
            .any(|s| other.manifest.exclusive_slots.contains(s))
        {
            return Err(format!(
                "{} 与 {} 占用同一独占位置",
                p.manifest.name, other.manifest.name
            ));
        }
    }
    stack.pop();
    done.insert(id.into());
    Ok(())
}
fn enabled_errors(r: &Registry, root: &Path) -> BTreeMap<String, String> {
    let mut errors = BTreeMap::new();
    for p in &r.packages {
        let check = (|| -> Result<()> {
            package_error(root, p)?;
            dependency_graph(r, &p.manifest.id, &mut vec![], &mut BTreeSet::new())?;
            if let Some(s) = r.states.get(&p.manifest.id).filter(|s| s.enabled) {
                if p.manifest.scope == "instance" {
                    for i in &s.instances {
                        visit(
                            r,
                            root,
                            &p.manifest.id,
                            Some(i),
                            &mut vec![],
                            &mut BTreeSet::new(),
                        )?;
                    }
                } else {
                    visit(
                        r,
                        root,
                        &p.manifest.id,
                        None,
                        &mut vec![],
                        &mut BTreeSet::new(),
                    )?;
                }
            }
            Ok(())
        })();
        if let Err(e) = check {
            errors.insert(p.manifest.id.clone(), e);
        }
    }
    errors
}
fn safe(root: &Path) -> bool {
    std::env::var("EASYCRAFT_DISABLE_PLUGINS").as_deref() == Ok("1")
        || model::safe_path(root, "plugins/disabled").is_ok_and(|p| p.exists())
}
fn snapshot(root: &Path, r: Registry) -> Snapshot {
    let errors = enabled_errors(&r, root);
    let disabled = safe(root);
    let mut appearance = r.baseline.clone();
    if !disabled {
        for p in &r.packages {
            if active(&r, &p.manifest.id, None) && !errors.contains_key(&p.manifest.id) {
                for (k, v) in p
                    .manifest
                    .settings
                    .iter()
                    .chain(r.states[&p.manifest.id].config.iter())
                {
                    if ["theme", "accentColor", "layout", "sidebarWidth"].contains(&k.as_str()) {
                        appearance.insert(k.clone(), v.clone());
                    }
                }
            }
        }
    }
    Snapshot {
        registry: r,
        safe_mode: disabled,
        errors,
        appearance,
        warning: String::new(),
    }
}
pub fn list(root: &Path) -> Snapshot {
    match read_registry(root) {
        Ok(r) => snapshot(root, r),
        Err(e) => Snapshot {
            registry: Registry::default(),
            safe_mode: safe(root),
            errors: BTreeMap::new(),
            appearance: BTreeMap::new(),
            warning: e,
        },
    }
}
fn checkpoint(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err("插件操作已取消，原状态保留".into())
    } else {
        Ok(())
    }
}
pub fn change(host: &Host, op: Operation, cancel: &CancellationToken) -> Result<Snapshot> {
    change_with_recycler(host, op, cancel, recycle_file)
}
fn change_with_recycler(
    host: &Host,
    op: Operation,
    cancel: &CancellationToken,
    recycler: impl FnOnce(&Path) -> Result<()>,
) -> Result<Snapshot> {
    root_available(&host.root)?;
    checkpoint(cancel)?;
    if let Operation::Recovery { disabled } = op {
        if !disabled && std::env::var("EASYCRAFT_DISABLE_PLUGINS").as_deref() == Ok("1") {
            return Err(
                "恢复模式由 EASYCRAFT_DISABLE_PLUGINS=1 开启，请移除此环境变量后重新打开启动器"
                    .into(),
            );
        }
        let p = model::safe_path(&host.root, "plugins/disabled")?;
        if disabled {
            model::write_file(
                &host.root,
                "plugins/disabled",
                b"Third-party packages disabled",
            )?;
        } else if p.exists() {
            fs::remove_file(p).map_err(|_| "无法退出恢复模式")?;
        }
        host.progress(
            "plugin-committed",
            if disabled {
                "已停用全部第三方插件"
            } else {
                "已退出插件恢复模式"
            },
            1,
            1,
        );
        return Ok(list(&host.root));
    }
    let mut r = read_registry(&host.root)?;
    host.progress("plugin-check", "校验插件包、权限与依赖", 0, 1);
    let old_errors = enabled_errors(&r, &host.root);
    let mut recycle = None;
    let mut staged = None;
    let mut validate_target = None;
    let message = match op {
        Operation::Install { raw, expected } => {
            let m = parse(&raw)?;
            let hash = digest(raw.as_bytes());
            if let Some(old) = r.packages.iter().find(|p| p.manifest.id == m.id) {
                if old.sha512 == hash {
                    return Err("此插件已安装，未重复写入".into());
                }
                if expected.as_deref() != Some(&old.sha512) {
                    return Err("同标识插件已存在，请查看版本、来源及权限变化后确认替换".into());
                }
                if old.manifest.category != m.category || old.manifest.scope != m.scope {
                    return Err("更新不能改变主要分类或作用范围，请保留旧版并联系作者".into());
                }
                if r.states.get(&m.id).is_some_and(|s| s.enabled)
                    && old.manifest.exclusive_slots != m.exclusive_slots
                {
                    return Err("更新改变了独占位置，请先停用旧版再更新；当前状态未改变".into());
                }
                if let Some(s) = r.states.get_mut(&m.id) {
                    settings(&m, &s.config)?;
                    s.entries
                        .retain(|id, _| m.entries.iter().any(|e| &e.id == id));
                }
            } else {
                if expected.is_some() {
                    return Err("安装记录已变化，请重新检查".into());
                }
                if r.packages.len() >= 100 {
                    return Err("插件已达 100 个".into());
                }
                if !r.states.contains_key(&m.id) && r.states.len() >= 500 {
                    return Err("保留的插件配置已达 500 份，请先备份并整理配置记录".into());
                }
            }
            let file = format!("plugins/packages/{}/{}.json", m.id, uuid::Uuid::new_v4());
            if let Some(saved) = r.states.get_mut(&m.id) {
                settings(&m, &saved.config)
                    .map_err(|e| format!("保留的插件配置不兼容：{e}；原配置已保留"))?;
                saved
                    .entries
                    .retain(|id, _| m.entries.iter().any(|e| &e.id == id));
            }
            r.packages.retain(|p| p.manifest.id != m.id);
            r.states.entry(m.id.clone()).or_default();
            r.packages.push(Installed {
                manifest: m.clone(),
                file: file.clone(),
                sha512: hash,
                source: "local".into(),
            });
            staged = Some((file, raw));
            validate_target = Some(m.id.clone());
            format!("{} 已安装", m.name)
        }
        Operation::Enable {
            id,
            enabled,
            instances,
            baseline,
        } => {
            let p = r
                .packages
                .iter()
                .find(|p| p.manifest.id == id)
                .ok_or("插件未安装")?
                .manifest
                .clone();
            if enabled && safe(&host.root) {
                return Err("请先退出第三方插件恢复模式".into());
            }
            if p.scope == "global" && !instances.is_empty()
                || p.scope == "instance" && enabled && instances.is_empty()
            {
                return Err("请选择插件生效的实例".into());
            }
            if instances.len() > 1000
                || instances.iter().collect::<BTreeSet<_>>().len() != instances.len()
            {
                return Err("实例选择无效".into());
            }
            let status = host.status();
            for id in instances.iter().filter(|_| enabled) {
                let i = status
                    .instances
                    .iter()
                    .find(|i| &i.id == id)
                    .ok_or("实例不存在")?;
                let loader = i.local.as_ref().map(|l| l.loader.as_str()).unwrap_or(
                    if i.fabric_version.is_empty() {
                        "vanilla"
                    } else {
                        "fabric"
                    },
                );
                if !p.minecraft.is_empty() && !p.minecraft.contains(&i.version)
                    || !p.loaders.is_empty() && !p.loaders.iter().any(|l| l == loader)
                {
                    return Err(format!(
                        "{} 不兼容实例 {} 的游戏版本或加载器",
                        p.name, i.name
                    ));
                }
            }
            if enabled {
                validate_target = Some(id.clone());
                let occupied: BTreeSet<_> = r
                    .packages
                    .iter()
                    .filter(|other| active(&r, &other.manifest.id, None))
                    .flat_map(|other| other.manifest.exclusive_slots.iter().cloned())
                    .collect();
                for other in &r.packages {
                    if other.manifest.id != id
                        && other
                            .manifest
                            .exclusive_slots
                            .iter()
                            .any(|s| p.exclusive_slots.contains(s))
                    {
                        if let Some(s) = r.states.get_mut(&other.manifest.id) {
                            s.enabled = false;
                        }
                    }
                }
                for slot in &p.exclusive_slots {
                    for k in if slot == "theme" {
                        vec!["theme", "accentColor"]
                    } else {
                        vec!["layout", "sidebarWidth"]
                    } {
                        if !occupied.contains(slot) || !r.baseline.contains_key(k) {
                            let v = baseline.get(k).ok_or("缺少当前外观配置，未切换")?;
                            let mut values = BTreeMap::new();
                            values.insert(k.into(), v.clone());
                            settings(&p, &values)?;
                            r.baseline.insert(k.into(), v.clone());
                        }
                    }
                }
            }
            let s = r.states.entry(id).or_default();
            s.enabled = enabled;
            s.instances = instances;
            format!("{} 已{}", p.name, if enabled { "启用" } else { "停用" })
        }
        Operation::Configure { id, config } => {
            let m = &r
                .packages
                .iter()
                .find(|p| p.manifest.id == id)
                .ok_or("插件未安装")?
                .manifest;
            settings(m, &config)?;
            validate_target = Some(id.clone());
            r.states.entry(id).or_default().config = config;
            "插件配置已保存".into()
        }
        Operation::Entries { id, entries } => {
            let m = &r
                .packages
                .iter()
                .find(|p| p.manifest.id == id)
                .ok_or("插件未安装")?
                .manifest;
            if entries
                .keys()
                .any(|id| !m.entries.iter().any(|e| &e.id == id))
                || entries.values().any(|p| p.order > 1000)
            {
                return Err("入口配置无效".into());
            }
            r.states.entry(id).or_default().entries = entries;
            "入口排列已保存".into()
        }
        Operation::Remove {
            id,
            expected,
            acknowledge,
        } => {
            let p = r
                .packages
                .iter()
                .find(|p| p.manifest.id == id)
                .ok_or("插件未安装")?;
            if p.sha512 != expected {
                return Err("插件已变化，请刷新后重试".into());
            }
            let affected: Vec<_> = r
                .packages
                .iter()
                .filter(|p| p.manifest.dependencies.contains_key(&id))
                .map(|p| p.manifest.name.clone())
                .collect();
            if !affected.is_empty() && !acknowledge {
                return Err(format!(
                    "以下插件依赖它：{}；请确认停用这些插件后再删除",
                    affected.join("、")
                ));
            }
            recycle = Some(p.file.clone());
            let name = p.manifest.name.clone();
            let mut removed = BTreeSet::from([id.clone()]);
            loop {
                let n = removed.len();
                for p in &r.packages {
                    if p.manifest.dependencies.keys().any(|d| removed.contains(d)) {
                        removed.insert(p.manifest.id.clone());
                    }
                }
                if n == removed.len() {
                    break;
                }
            }
            for id in removed {
                if let Some(s) = r.states.get_mut(&id) {
                    s.enabled = false;
                }
            }
            r.packages.retain(|p| p.manifest.id != id);
            format!("{name} 已进入回收站")
        }
        Operation::Recovery { .. } => unreachable!(),
    };
    // Stage the new bytes first; registry replacement is the sole activation commit point.
    if let Some((file, raw)) = &staged {
        checkpoint(cancel)?;
        model::write_file(&host.root, file, raw.as_bytes())?;
    }
    let validate = (|| -> Result<()> {
        for (id, e) in enabled_errors(&r, &host.root) {
            if r.states.get(&id).is_some_and(|s| s.enabled)
                && (validate_target.as_deref() == Some(&id) || !old_errors.contains_key(&id))
            {
                return Err(e);
            }
        }
        checkpoint(cancel)?;
        host.progress("plugin-save", "保存插件安装记录", 0, 1);
        if let Some(file) = &recycle {
            // Validate and persist the disabled state before recycling. If recycling fails,
            // leave the original registry and package in place; never permanently delete.
            let bytes = serde_json::to_vec_pretty(&r).map_err(|_| "无法序列化插件记录")?;
            model::write_file(&host.root, "plugins/registry.pending", &bytes)?;
            recycler(&model::safe_path(&host.root, file)?)?;
            // A durable journal makes post-recycle commit failure recoverable on next read.
            fs::rename(
                model::safe_path(&host.root, "plugins/registry.pending")?,
                model::safe_path(&host.root, INDEX)?,
            )
            .map_err(|_| "插件已进入回收站，安装记录待恢复；请重新打开扩展")?;
        } else {
            model::save_json(&host.root, INDEX, &r)?;
        }
        Ok(())
    })();
    if validate.is_err() {
        if let Some((file, _)) = &staged {
            if let Ok(path) = model::safe_path(&host.root, file) {
                let _ = fs::remove_file(path);
            }
        }
    }
    validate?;
    host.progress("plugin-committed", &message, 1, 1);
    host.log(&message, &[]);
    Ok(snapshot(&host.root, r))
}

pub(crate) fn recycle_file(path: &Path) -> Result<()> {
    use windows::{
        core::PCWSTR,
        Win32::{
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
                COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName,
                FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FOF_NOCONFIRMATION, FOF_NOERRORUI,
                FOF_SILENT,
            },
        },
    };
    let metadata = fs::metadata(path).map_err(|_| "插件包暂不可用，未删除安装记录")?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err("插件包不是文件，已保留".into());
    }
    let canonical = path.canonicalize().map_err(|_| "回收对象暂不可用")?;
    let canonical = canonical.to_string_lossy();
    let normal = if let Some(unc) = canonical.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        canonical
            .strip_prefix("\\\\?\\")
            .unwrap_or(&canonical)
            .to_string()
    };
    let name: Vec<u16> = Path::new(&normal)
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|_| "无法初始化系统回收站")?;
        let result = (|| -> windows::core::Result<()> {
            let operation: IFileOperation =
                CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
            operation.SetOperationFlags(
                FOFX_RECYCLEONDELETE
                    | FOFX_EARLYFAILURE
                    | FOF_NOERRORUI
                    | FOF_NOCONFIRMATION
                    | FOF_SILENT,
            )?;
            let item: IShellItem = SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None)?;
            operation.DeleteItem(&item, None)?;
            operation.PerformOperations()?;
            if operation.GetAnyOperationsAborted()?.as_bool() {
                return Err(windows::core::Error::from_hresult(windows::core::HRESULT(
                    0x800704C7u32 as i32,
                )));
            }
            Ok(())
        })();
        CoUninitialize();
        result.map_err(|_| "系统回收站操作失败，未永久删除插件".to_string())?;
    }
    if path.exists() {
        return Err("插件仍在原位置，回收未完成".into());
    }
    Ok(())
}
pub fn authorize(
    host: &Host,
    id: &str,
    capability: &str,
    instance: Option<&str>,
) -> Result<Manifest> {
    let s = list(&host.root);
    if !s.warning.is_empty() {
        return Err(s.warning);
    }
    if s.safe_mode {
        return Err("第三方插件已全部停用".into());
    }
    let p = s
        .registry
        .packages
        .iter()
        .find(|p| p.manifest.id == id)
        .ok_or("插件未安装")?;
    if !p.manifest.capabilities.iter().any(|c| c == capability)
        || !active(&s.registry, id, instance)
        || s.errors.contains_key(id)
    {
        return Err("插件未在此范围启用，或存在兼容/依赖问题".into());
    }
    if instance.is_some() && p.manifest.scope != "instance" {
        return Err("插件实例作用范围不符".into());
    }
    if let Some(id) = instance {
        let i = host
            .status()
            .instances
            .into_iter()
            .find(|i| i.id == id)
            .ok_or("实例已不存在")?;
        let loader =
            i.local
                .as_ref()
                .map(|l| l.loader.as_str())
                .unwrap_or(if i.fabric_version.is_empty() {
                    "vanilla"
                } else {
                    "fabric"
                });
        if !p.manifest.minecraft.is_empty() && !p.manifest.minecraft.contains(&i.version)
            || !p.manifest.loaders.is_empty() && !p.manifest.loaders.iter().any(|l| l == loader)
        {
            return Err("实例版本或加载器已变化，插件未获准在此环境运行".into());
        }
    }
    Ok(p.manifest.clone())
}
pub fn format_json(
    host: &Host,
    id: &str,
    input: &str,
    cancel: &CancellationToken,
) -> Result<String> {
    authorize(host, id, "tool.json", None)?;
    if input.len() > 1024 * 1024 {
        return Err("JSON 输入超过 1 MiB".into());
    }
    host.progress("plugin-json-parse", "检查 JSON", 0, 2);
    checkpoint(cancel)?;
    let v: Value = serde_json::from_str(input)
        .map_err(|e| format!("JSON 格式错误：第 {} 行，第 {} 列", e.line(), e.column()))?;
    host.progress("plugin-json-format", "格式化 JSON", 1, 2);
    checkpoint(cancel)?;
    let r = read_registry(&host.root)?;
    let m = &r
        .packages
        .iter()
        .find(|p| p.manifest.id == id)
        .ok_or("插件未安装")?
        .manifest;
    let indent = r
        .states
        .get(id)
        .and_then(|s| s.config.get("indent"))
        .or(m.settings.get("indent"))
        .and_then(Value::as_u64)
        .unwrap_or(2);
    let mut result = Vec::new();
    let formatter =
        serde_json::ser::PrettyFormatter::with_indent(if indent == 4 { b"    " } else { b"  " });
    v.serialize(&mut serde_json::Serializer::with_formatter(
        &mut result,
        formatter,
    ))
    .map_err(|_| "格式化失败")?;
    checkpoint(cancel)?;
    host.progress("plugin-committed", "JSON 格式化完成", 2, 2);
    String::from_utf8(result).map_err(|_| "JSON 编码无效".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        host: std::sync::Arc<Host>,
        base: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            Self::with_instances(vec![])
        }
        fn with_instances(instances: Vec<model::Instance>) -> Self {
            let base = std::env::temp_dir().canonicalize().unwrap();
            let path = base.join(format!("easycraft-plugin-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            model::save_json(&path, "instances.json", &instances).unwrap();
            let host = Host::new(path).unwrap();
            let base = host.root.parent().unwrap().to_path_buf();
            Self { host, base }
        }
        fn change(&self, op: Operation) -> Result<Snapshot> {
            self.host
                .plugin_task("Plugin regression", |c| change(&self.host, op, c))
        }
        fn install(&self, value: Value) -> Snapshot {
            self.change(Operation::Install {
                raw: value.to_string(),
                expected: None,
            })
            .unwrap()
        }
        fn enable(&self, id: &str, enabled: bool) -> Result<Snapshot> {
            self.change(Operation::Enable {
                id: id.into(),
                enabled,
                instances: vec![],
                baseline: BTreeMap::from([
                    ("theme".into(), json!("grass")),
                    ("accentColor".into(), json!("#123456")),
                    ("layout".into(), json!("default")),
                    ("sidebarWidth".into(), json!(280)),
                ]),
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let path = self.host.root.clone();
            if path.parent() == Some(self.base.as_path())
                && path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("easycraft-plugin-test-")
            {
                let _ = fs::remove_dir_all(path);
            }
        }
    }
    fn package(id: &str, cap: &str) -> Value {
        let (category, scope, position, slots, permissions, settings) = match cap {
            "appearance.theme" => (
                "appearance",
                "global",
                "appearance",
                vec!["theme"],
                vec!["appearance"],
                json!({"theme":"slate","accentColor":"#abcdef"}),
            ),
            "appearance.layout" => (
                "appearance",
                "global",
                "appearance",
                vec!["layout"],
                vec!["appearance"],
                json!({"layout":"compact","sidebarWidth":260}),
            ),
            "instance.mod-check" => (
                "instance",
                "instance",
                "instance-overview",
                vec![],
                vec!["instances.read"],
                json!({}),
            ),
            _ => (
                "tools",
                "global",
                "tool",
                vec![],
                vec![],
                json!({"indent":2}),
            ),
        };
        json!({"schemaVersion":2,"id":id,"name":id,"author":"Regression","version":"1.0.0","description":"Test package","icon":"code","category":category,"capabilities":[cap],"entries":[{"id":"main","label":"Open","capability":cap,"position":position}],"scope":scope,"apiVersion":"1.0.0","exclusiveSlots":slots,"permissions":permissions,"configVersion":1,"settings":settings})
    }
    #[test]
    fn manifest_boundary_and_legacy_conversion() {
        let valid = package("test.tool", "tool.json");
        assert!(parse(&valid.to_string()).is_ok());
        for (key, value) in [
            ("script", json!("alert(1)")),
            ("apiVersion", json!("2.0.0")),
            ("permissions", json!(["accounts.tokens"])),
            ("capabilities", json!(["tool.shell"])),
            ("icon", json!("file:///secret")),
            (
                "entries",
                json!([{"id":"bad","label":"bad","capability":"tool.json","position":"launch-button"}]),
            ),
        ] {
            let mut p = valid.clone();
            p[key] = value;
            assert!(parse(&p.to_string()).is_err(), "{key}");
        }
        assert!(parse("not-json").is_err());
        assert!(parse(&" ".repeat(MAX_PACKAGE + 1)).is_err());
        let old = json!({"schemaVersion":1,"id":"test.legacy","name":"Legacy","version":"1.0.0","type":"layout","settings":{"layout":"compact"}});
        assert_eq!(
            parse(&old.to_string()).unwrap().exclusive_slots,
            vec!["layout"]
        );
    }
    #[test]
    fn install_exclusivity_coexistence_and_cancel_are_transactional() {
        let f = Fixture::new();
        let original = package("test.theme-a", "appearance.theme");
        f.install(original.clone());
        f.install(package("test.theme-b", "appearance.theme"));
        f.install(package("test.layout", "appearance.layout"));
        assert!(f
            .change(Operation::Install {
                raw: original.to_string(),
                expected: None
            })
            .unwrap_err()
            .contains("已安装"));
        f.enable("test.theme-a", true).unwrap();
        f.enable("test.layout", true).unwrap();
        let next = f.enable("test.theme-b", true).unwrap();
        assert!(!next.registry.states["test.theme-a"].enabled);
        assert!(next.registry.states["test.layout"].enabled);
        assert_eq!(next.appearance["layout"], json!("compact"));
        let cancel = CancellationToken::new();
        cancel.cancel();
        let before = fs::read(f.host.root.join(INDEX)).unwrap();
        assert!(change(
            &f.host,
            Operation::Install {
                raw: package("test.cancel", "tool.json").to_string(),
                expected: None
            },
            &cancel
        )
        .is_err());
        assert_eq!(fs::read(f.host.root.join(INDEX)).unwrap(), before);
        let disabled = f.enable("test.theme-b", false).unwrap();
        assert_eq!(disabled.appearance["theme"], json!("grass"));
    }
    #[test]
    fn dependencies_cycles_conflicts_and_failed_switch_preserve_old_state() {
        let f = Fixture::new();
        f.install(package("test.base", "tool.json"));
        let mut dependent = package("test.consumer", "tool.json");
        dependent["dependencies"] = json!({"test.base":"1.0.0"});
        f.install(dependent);
        assert!(f.enable("test.consumer", true).unwrap_err().contains("先"));
        f.enable("test.base", true).unwrap();
        f.enable("test.consumer", true).unwrap();
        let base = list(&f.host.root)
            .registry
            .packages
            .into_iter()
            .find(|p| p.manifest.id == "test.base")
            .unwrap();
        let mut upgrade = package("test.base", "tool.json");
        upgrade["version"] = json!("2.0.0");
        assert!(f
            .change(Operation::Install {
                raw: upgrade.to_string(),
                expected: Some(base.sha512.clone())
            })
            .unwrap_err()
            .contains("需要 1.0.0"));
        assert!(f
            .change(Operation::Remove {
                id: "test.base".into(),
                expected: base.sha512,
                acknowledge: false
            })
            .unwrap_err()
            .contains("test.consumer"));
        assert!(f.enable("test.base", false).is_err());
        assert!(list(&f.host.root).registry.states["test.base"].enabled);
        let mut conflict = package("test.conflict", "tool.json");
        conflict["conflicts"] = json!(["test.base"]);
        f.install(conflict);
        assert!(f
            .enable("test.conflict", true)
            .unwrap_err()
            .contains("冲突"));
        let mut a = package("test.cycle-a", "tool.json");
        a["dependencies"] = json!({"test.cycle-b":"*"});
        f.install(a);
        let mut b = package("test.cycle-b", "tool.json");
        b["dependencies"] = json!({"test.cycle-a":"*"});
        let s = f.install(b);
        assert!(s.errors["test.cycle-a"].contains("循环"));
    }
    #[test]
    fn local_update_preserves_config_and_rolls_back_on_incompatible_dependencies_or_write_failure()
    {
        let f = Fixture::new();
        f.install(package("test.json", "tool.json"));
        f.enable("test.json", true).unwrap();
        f.change(Operation::Configure {
            id: "test.json".into(),
            config: BTreeMap::from([("indent".into(), json!(4))]),
        })
        .unwrap();
        let s = list(&f.host.root);
        let old = s.registry.packages[0].clone();
        let mut update = package("test.json", "tool.json");
        update["version"] = json!("1.1.0");
        update["dependencies"] = json!({"test.missing":"1.0.0"});
        assert!(f
            .change(Operation::Install {
                raw: update.to_string(),
                expected: Some(old.sha512.clone())
            })
            .is_err());
        assert_eq!(
            list(&f.host.root).registry.packages[0].manifest.version,
            "1.0.0"
        );
        update.as_object_mut().unwrap().remove("dependencies");
        fs::create_dir(f.host.root.join("plugins/registry.json.tmp")).unwrap();
        assert!(f
            .change(Operation::Install {
                raw: update.to_string(),
                expected: Some(old.sha512.clone())
            })
            .is_err());
        fs::remove_dir(f.host.root.join("plugins/registry.json.tmp")).unwrap();
        assert_eq!(list(&f.host.root).registry.packages[0].sha512, old.sha512);
        let s = f
            .change(Operation::Install {
                raw: update.to_string(),
                expected: Some(old.sha512),
            })
            .unwrap();
        assert_eq!(s.registry.states["test.json"].config["indent"], json!(4));
        assert!(f
            .host
            .plugin_task("format", |c| format_json(
                &f.host,
                "test.json",
                "{\"hello\":1}",
                c
            ))
            .unwrap()
            .contains("    \"hello\""));
    }
    #[test]
    fn instance_scope_and_permissions_are_checked_in_native_host() {
        let item = model::Instance {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Test instance".into(),
            version: "1.21.1".into(),
            manifest_sha1: "a".repeat(40),
            java_major: 21,
            fabric_version: String::new(),
            fabric_sha1: String::new(),
            local: None,
            storage_root: None,
            version_folder: None,
            launch: Default::default(),
        };
        let f = Fixture::with_instances(vec![item.clone()]);
        let host = &f.host;
        let mut p = package("test.check", "instance.mod-check");
        p["minecraft"] = json!(["1.21.1"]);
        p["loaders"] = json!(["vanilla"]);
        change(
            &host,
            Operation::Install {
                raw: p.to_string(),
                expected: None,
            },
            &CancellationToken::new(),
        )
        .unwrap();
        change(
            &host,
            Operation::Enable {
                id: "test.check".into(),
                enabled: true,
                instances: vec![item.id.clone()],
                baseline: BTreeMap::new(),
            },
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(authorize(&host, "test.check", "instance.mod-check", Some(&item.id)).is_ok());
        assert!(authorize(
            &host,
            "test.check",
            "instance.mod-check",
            Some("other-instance")
        )
        .is_err());
        assert!(authorize(&host, "test.check", "tool.json", None).is_err());
    }
    #[test]
    fn integrity_unavailable_storage_and_recovery_preserve_records() {
        let f = Fixture::new();
        let s = f.install(package("test.safe", "tool.json"));
        f.enable("test.safe", true).unwrap();
        let path = f.host.root.join(&s.registry.packages[0].file);
        fs::write(&path, b"broken").unwrap();
        let s = list(&f.host.root);
        assert!(s.errors["test.safe"].contains("校验"));
        assert!(s.registry.states["test.safe"].enabled);
        assert!(authorize(&f.host, "test.safe", "tool.json", None).is_err());
        f.change(Operation::Recovery { disabled: true }).unwrap();
        assert!(list(&f.host.root).safe_mode);
        fs::write(f.host.root.join(INDEX), b"broken registry").unwrap();
        assert!(!list(&f.host.root).warning.is_empty());
        assert!(
            f.change(Operation::Recovery { disabled: true })
                .unwrap()
                .safe_mode
        );
        assert!(list(&f.host.root.join("disconnected-disk"))
            .warning
            .contains("暂不可用"));
    }
    #[test]
    fn recycle_failure_never_falls_back_to_deletion() {
        let f = Fixture::new();
        let s = f.install(package("test.trash", "tool.json"));
        let p = &s.registry.packages[0];
        let before = fs::read(f.host.root.join(INDEX)).unwrap();
        let op = Operation::Remove {
            id: p.manifest.id.clone(),
            expected: p.sha512.clone(),
            acknowledge: false,
        };
        assert!(
            change_with_recycler(&f.host, op, &CancellationToken::new(), |_| Err(
                "Recycle Bin unavailable".into()
            ))
            .is_err()
        );
        assert!(f.host.root.join(&p.file).is_file());
        assert_eq!(fs::read(f.host.root.join(INDEX)).unwrap(), before);
        assert_eq!(list(&f.host.root).registry.packages.len(), 1);
    }
    #[test]
    fn journal_recovers_a_completed_recycle_when_registry_commit_is_interrupted() {
        use std::os::windows::fs::OpenOptionsExt;
        let f = Fixture::new();
        let s = f.install(package("test.journal", "tool.json"));
        let p = &s.registry.packages[0];
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ)
            .open(f.host.root.join(INDEX))
            .unwrap();
        let result = change_with_recycler(
            &f.host,
            Operation::Remove {
                id: p.manifest.id.clone(),
                expected: p.sha512.clone(),
                acknowledge: false,
            },
            &CancellationToken::new(),
            |file| {
                fs::rename(file, f.host.root.join("isolated-simulated-recycle.json"))
                    .map_err(|_| "test recycle failed".into())
            },
        );
        assert!(result.unwrap_err().contains("安装记录待恢复"));
        drop(lock);
        let recovered = list(&f.host.root);
        assert!(recovered.registry.packages.is_empty());
        assert!(recovered.registry.states.contains_key("test.journal"));
    }
    #[test]
    #[ignore = "Moves one isolated test package to the Windows Recycle Bin"]
    fn real_windows_recycle_preserves_settings_and_user_outputs() {
        let f = Fixture::new();
        let s = f.install(package("test.recycle", "tool.json"));
        let p = &s.registry.packages[0];
        f.change(Operation::Configure {
            id: p.manifest.id.clone(),
            config: BTreeMap::from([("indent".into(), json!(4))]),
        })
        .unwrap();
        model::write_file(
            &f.host.root,
            "plugins/user-data/test.recycle/report.txt",
            b"user output",
        )
        .unwrap();
        let s = f
            .change(Operation::Remove {
                id: p.manifest.id.clone(),
                expected: p.sha512.clone(),
                acknowledge: false,
            })
            .unwrap();
        assert!(!f.host.root.join(&p.file).exists());
        assert!(s.registry.packages.is_empty());
        assert_eq!(s.registry.states["test.recycle"].config["indent"], json!(4));
        assert_eq!(
            fs::read(
                f.host
                    .root
                    .join("plugins/user-data/test.recycle/report.txt")
            )
            .unwrap(),
            b"user output"
        );
    }
}
