use crate::model::{self, Result};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

const MAX_FILE: u64 = 16 * 1024 * 1024;
fn hash(bytes: &[u8]) -> String {
    Sha1::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn read(path: &Path) -> Result<Vec<u8>> {
    let file = fs::File::open(path).map_err(|_| "无法读取配置文件")?;
    if file.metadata().map_err(|_| "无法读取文件信息")?.len() > MAX_FILE {
        return Err("配置文件超过 16 MB 上限".into());
    }
    let mut bytes = vec![];
    file.take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "配置文件读取失败")?;
    if bytes.len() as u64 > MAX_FILE {
        return Err("配置文件过大".into());
    }
    Ok(bytes)
}
fn component(value: &str) -> Result<()> {
    if value.is_empty()
        || value.chars().count() > 255
        || value.contains(['/', '\\'])
        || value == "."
        || value == ".."
    {
        return Err("无效存档目录".into());
    }
    Ok(())
}
pub fn selected_world(root: &Path, id: &str) -> Result<PathBuf> {
    let path = world_dir(root, id)?;
    if !model::safe_path(&path, "level.dat")?.is_file() {
        return Err("所选世界不存在或缺少 level.dat".into());
    }
    Ok(path)
}
pub fn data_version(world: &Path) -> Result<u32> {
    let (raw, fields) = decode(&read(&model::safe_path(world, "level.dat")?)?)?;
    scalar(&raw, &fields, "DataVersion", 3)?
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| "世界缺少有效 DataVersion，不能自动判断数据包兼容性".into())
}
fn world_dir(root: &Path, id: &str) -> Result<PathBuf> {
    component(id)?;
    model::safe_path(root, &format!("saves/{id}"))
}
fn session_lock(dir: &Path) -> Result<fs::File> {
    let path = model::safe_path(dir, "session.lock")?;
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(path)
        .map_err(|_| "该世界正在使用中，请先退出游戏")?;
    file.try_lock()
        .map_err(|_| "无法锁定世界，请先退出使用此存档的游戏")?;
    Ok(file)
}
pub fn lock_worlds(root: &Path) -> Result<Vec<fs::File>> {
    list(root)?
        .into_iter()
        .map(|world| session_lock(&world_dir(root, &world.id)?))
        .collect()
}
#[derive(Serialize)]
pub struct WorldEntry {
    pub id: String,
    pub name: String,
}
pub fn list(root: &Path) -> Result<Vec<WorldEntry>> {
    let saves = model::safe_path(root, "saves")?;
    if !saves.exists() {
        return Ok(vec![]);
    }
    let mut worlds = vec![];
    for item in fs::read_dir(saves).map_err(|_| "无法读取存档目录")? {
        let item = item.map_err(|_| "存档目录读取失败")?;
        if worlds.len() >= 1000 {
            return Err("存档数量超过 1000 项，请缩小目录后重试".into());
        }
        let id = item
            .file_name()
            .into_string()
            .map_err(|_| "存档目录包含无效 Unicode")?;
        let dir = world_dir(root, &id)?;
        if dir.is_dir() && model::safe_path(&dir, "level.dat")?.is_file() {
            worlds.push(WorldEntry {
                name: id.clone(),
                id,
            });
        }
    }
    worlds.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(worlds)
}

// Walk the bounded NBT once and patch only existing scalar bytes, preserving all unknown tags verbatim.
type Fields = HashMap<String, (u8, usize)>;
struct Nbt<'a> {
    bytes: &'a [u8],
    pos: usize,
    nodes: usize,
    fields: Fields,
}
impl Nbt<'_> {
    fn take(&mut self, len: usize) -> Result<&[u8]> {
        let end = self
            .pos
            .checked_add(len)
            .filter(|end| *end <= self.bytes.len())
            .ok_or("NBT 长度越界")?;
        let bytes = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(bytes)
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn string(&mut self) -> Result<Vec<u8>> {
        let size = u16::from_be_bytes(self.take(2)?.try_into().unwrap()) as usize;
        Ok(self.take(size)?.to_vec())
    }
    fn count(&mut self) -> Result<usize> {
        let count = i32::from_be_bytes(self.take(4)?.try_into().unwrap());
        if !(0..=1_000_000).contains(&count) {
            return Err("NBT 数组或列表长度异常".into());
        }
        Ok(count as usize)
    }
    fn payload(&mut self, tag: u8, depth: usize, location: u8) -> Result<()> {
        self.nodes += 1;
        if depth > 64 || self.nodes > 1_000_000 {
            return Err("NBT 嵌套或节点数量超过安全上限".into());
        }
        match tag {
            1 => {
                self.take(1)?;
            }
            2 => {
                self.take(2)?;
            }
            3 | 5 => {
                self.take(4)?;
            }
            4 | 6 => {
                self.take(8)?;
            }
            7 | 11 | 12 => {
                let count = self.count()?;
                let width = match tag {
                    11 => 4,
                    12 => 8,
                    _ => 1,
                };
                self.take(count.checked_mul(width).ok_or("NBT 长度溢出")?)?;
            }
            8 => {
                self.string()?;
            }
            9 => {
                let kind = self.byte()?;
                let count = self.count()?;
                if kind > 12 || (count > 0 && kind == 0) {
                    return Err("NBT 列表类型无效".into());
                }
                for _ in 0..count {
                    self.payload(kind, depth + 1, 0)?;
                }
            }
            10 => loop {
                let kind = self.byte()?;
                if kind == 0 {
                    break;
                }
                let name = self.string()?;
                let scalar = location == 1
                    && [
                        b"Difficulty".as_slice(),
                        b"DifficultyLocked",
                        b"DataVersion",
                        b"allowCommands",
                        b"hardcore",
                        b"GameType",
                        b"DayTime",
                        b"raining",
                        b"thundering",
                        b"rainTime",
                        b"thunderTime",
                        b"clearWeatherTime",
                    ]
                    .contains(&name.as_slice());
                let rule = location == 2
                    && kind == 8
                    && name.len() <= 128
                    && name
                        .iter()
                        .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(c));
                if scalar || rule {
                    let key = format!(
                        "{}{}",
                        if rule { "GameRules/" } else { "" },
                        String::from_utf8_lossy(&name)
                    );
                    if self.fields.len() > 1024
                        || self.fields.insert(key, (kind, self.pos)).is_some()
                    {
                        return Err("NBT 设置字段重复或过多".into());
                    }
                }
                let next = if depth == 0 && name == b"Data" {
                    1
                } else if location == 1 && name == b"GameRules" {
                    2
                } else {
                    0
                };
                self.payload(kind, depth + 1, next)?;
            },
            _ => return Err("NBT 标签类型无效".into()),
        }
        Ok(())
    }
}
fn decode(bytes: &[u8]) -> Result<(Vec<u8>, Fields)> {
    let mut raw = vec![];
    GzDecoder::new(bytes)
        .take(MAX_FILE + 1)
        .read_to_end(&mut raw)
        .map_err(|_| "level.dat GZip 解压或校验失败")?;
    if raw.len() as u64 > MAX_FILE {
        return Err("存档元数据解压后超过 16 MB".into());
    }
    let mut reader = Nbt {
        bytes: &raw,
        pos: 0,
        nodes: 0,
        fields: HashMap::new(),
    };
    if reader.byte()? != 10 {
        return Err("仅支持 Java 版 Compound NBT 存档".into());
    }
    reader.string()?;
    reader.payload(10, 0, 0)?;
    if reader.pos != raw.len() {
        return Err("NBT 包含未识别的尾随内容".into());
    }
    let fields = reader.fields;
    Ok((raw, fields))
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldSettings {
    pub revision: String,
    pub difficulty: u8,
    pub difficulty_locked: bool,
    pub allow_commands: Option<bool>,
    pub hardcore: bool,
    pub game_mode: Option<u8>,
    pub day_time: Option<String>,
    pub weather: Option<String>,
    pub game_rules: Vec<GameRule>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GameRule {
    pub key: String,
    pub value: String,
    pub kind: String,
}
fn scalar(raw: &[u8], fields: &Fields, key: &str, expected: u8) -> Result<Option<i64>> {
    let Some(&(kind, offset)) = fields.get(key) else {
        return Ok(None);
    };
    if kind != expected {
        return Err(format!("{key} 的 NBT 类型不受支持，未修改存档"));
    }
    Ok(Some(match kind {
        1 => raw[offset] as i8 as i64,
        3 => i32::from_be_bytes(raw[offset..offset + 4].try_into().unwrap()) as i64,
        4 => i64::from_be_bytes(raw[offset..offset + 8].try_into().unwrap()),
        _ => return Err("不支持的 NBT 标量".into()),
    }))
}
fn rule_string(raw: &[u8], offset: usize) -> Result<String> {
    let len = u16::from_be_bytes(raw[offset..offset + 2].try_into().unwrap()) as usize;
    String::from_utf8(raw[offset + 2..offset + 2 + len].to_vec())
        .map_err(|_| "游戏规则不是可编辑的 UTF-8 文本".into())
}
fn world_settings(bytes: &[u8]) -> Result<WorldSettings> {
    let (raw, fields) = decode(bytes)?;
    let difficulty = scalar(&raw, &fields, "Difficulty", 1)?
        .ok_or("此存档的难度布局暂不支持，原文件未修改（含 26.1 新格式）")?;
    if !(0..=3).contains(&difficulty) {
        return Err("存档难度值无效".into());
    }
    let game_mode = scalar(&raw, &fields, "GameType", 3)?;
    if game_mode.is_some_and(|value| !(0..=3).contains(&value)) {
        return Err("默认游戏模式无效".into());
    }
    let raining = scalar(&raw, &fields, "raining", 1)?;
    let thundering = scalar(&raw, &fields, "thundering", 1)?;
    let weather = raining.zip(thundering).map(|(rain, thunder)| {
        if thunder != 0 {
            "thunder"
        } else if rain != 0 {
            "rain"
        } else {
            "clear"
        }
        .to_string()
    });
    let mut game_rules = vec![];
    for (key, (_, offset)) in &fields {
        if let Some(key) = key.strip_prefix("GameRules/") {
            let value = rule_string(&raw, *offset)?;
            let kind = if ["true", "false"].contains(&value.as_str()) {
                "boolean"
            } else if value.parse::<i32>().is_ok() {
                "integer"
            } else {
                "text"
            };
            if value.len() <= 128 {
                game_rules.push(GameRule {
                    key: key.into(),
                    value,
                    kind: kind.into(),
                });
            }
        }
    }
    game_rules.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(WorldSettings {
        revision: hash(bytes),
        difficulty: difficulty as u8,
        difficulty_locked: scalar(&raw, &fields, "DifficultyLocked", 1)?
            .is_some_and(|value| value != 0),
        allow_commands: scalar(&raw, &fields, "allowCommands", 1)?.map(|value| value != 0),
        hardcore: scalar(&raw, &fields, "hardcore", 1)?.is_some_and(|value| value != 0),
        game_mode: game_mode.map(|value| value as u8),
        day_time: scalar(&raw, &fields, "DayTime", 4)?.map(|value| value.to_string()),
        weather,
        game_rules,
    })
}
pub fn load_world(root: &Path, id: &str) -> Result<WorldSettings> {
    let dir = world_dir(root, id)?;
    world_settings(&read(&model::safe_path(&dir, "level.dat")?)?)
}
fn backed_write(
    root: &Path,
    relative: &str,
    original: Option<&[u8]>,
    replacement: &[u8],
) -> Result<String> {
    let path = model::safe_path(root, relative)?;
    let backup = format!(
        ".easycraft-backups/{}/{}",
        uuid::Uuid::new_v4(),
        if relative.ends_with("level.dat") {
            "level.dat"
        } else {
            "options.txt"
        }
    );
    if let Some(bytes) = original {
        if read(&path)? != bytes {
            return Err("配置已被其他程序修改，请重新读取后再保存".into());
        }
        model::write_file(root, &backup, bytes)?;
        if read(&model::safe_path(root, &backup)?)? != bytes {
            return Err("备份校验失败，未修改原文件".into());
        }
        let record = BackupRecord {
            owner: backup_owner(root)?,
            target: relative.into(),
            sha1: hash(bytes),
            bytes: bytes.len() as u64,
            created_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "系统时间无效")?
                .as_millis()
                .try_into()
                .map_err(|_| "系统时间无效")?,
        };
        model::save_json(
            root,
            &format!(
                "{}/record.json",
                backup.rsplit_once('/').ok_or("备份路径无效")?.0
            ),
            &record,
        )?;
    } else if path.exists() {
        return Err("配置文件刚被创建，请重新读取后保存".into());
    }
    if let Some(bytes) = original {
        if read(&path)? != bytes {
            return Err("配置在备份期间发生变化，原文件未覆盖".into());
        }
    } else if path.exists() {
        return Err("配置文件刚被创建，未覆盖".into());
    }
    model::write_file(root, relative, replacement)?;
    if read(&path)? != replacement {
        return Err("配置写入后回读不一致；原配置备份保留，请重新读取检查".into());
    }
    Ok(if original.is_some() {
        model::safe_path(root, &backup)?.to_string_lossy().into()
    } else {
        String::new()
    })
}
pub fn save_world(root: &Path, id: &str, settings: WorldSettings) -> Result<String> {
    let dir = world_dir(root, id)?;
    if !dir.is_dir() {
        return Err("存档目录不存在".into());
    }
    let _lock = session_lock(&dir)?;
    let relative = format!("saves/{id}/level.dat");
    let original = read(&model::safe_path(root, &relative)?)?;
    let replacement = world_replacement(&original, settings)?;
    backed_write(root, &relative, Some(&original), &replacement)
}
fn world_replacement(original: &[u8], settings: WorldSettings) -> Result<Vec<u8>> {
    if hash(original) != settings.revision {
        return Err("世界配置已变化，请重新读取后保存".into());
    }
    let current = world_settings(original)?;
    if current.difficulty_locked
        && settings.difficulty_locked
        && current.difficulty != settings.difficulty
    {
        return Err("请先取消难度锁定，再修改难度".into());
    }
    if current.hardcore {
        return Err("极限模式世界仅允许查看，本轮不修改其设置".into());
    }
    if settings.difficulty > 3
        || settings.hardcore != current.hardcore
        || settings.allow_commands.is_some() != current.allow_commands.is_some()
    {
        return Err("世界设置无效或包含不支持的字段".into());
    }
    let (mut raw, fields) = decode(original)?;
    raw[fields["Difficulty"].1] = settings.difficulty;
    if let Some((_, offset)) = fields.get("DifficultyLocked") {
        raw[*offset] = u8::from(settings.difficulty_locked);
    } else if settings.difficulty_locked {
        return Err("此世界不支持锁定难度字段".into());
    }
    if let Some(value) = settings.allow_commands {
        raw[fields["allowCommands"].1] = u8::from(value);
    }
    if current.game_mode.is_some() != settings.game_mode.is_some()
        || current.day_time.is_some() != settings.day_time.is_some()
        || current.weather.is_some() != settings.weather.is_some()
    {
        return Err("不能添加或移除存档中不存在的设置".into());
    }
    if let Some(mode) = settings.game_mode {
        if mode > 3 {
            return Err("游戏模式无效".into());
        }
        let offset = fields["GameType"].1;
        raw[offset..offset + 4].copy_from_slice(&(mode as i32).to_be_bytes());
    }
    if let Some(day) = settings.day_time {
        let ticks = day.parse::<i64>().map_err(|_| "时间必须是 64 位整数刻数")?;
        if ticks < 0 {
            return Err("时间不能为负数".into());
        }
        let offset = fields["DayTime"].1;
        raw[offset..offset + 8].copy_from_slice(&ticks.to_be_bytes());
    }
    if let Some(weather) = &settings.weather {
        if !["clear", "rain", "thunder"].contains(&weather.as_str()) {
            return Err("天气无效".into());
        }
        if settings.weather != current.weather {
            raw[fields["raining"].1] = u8::from(weather != "clear");
            raw[fields["thundering"].1] = u8::from(weather == "thunder");
            for key in ["rainTime", "thunderTime", "clearWeatherTime"] {
                if let Some(&(kind, offset)) = fields.get(key) {
                    if kind != 3 {
                        return Err("天气计时器格式不受支持".into());
                    }
                    let value: i32 = if key == "clearWeatherTime" && weather != "clear" {
                        0
                    } else {
                        12000
                    };
                    raw[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
                }
            }
        }
    }
    if settings.game_rules.len() != current.game_rules.len() {
        return Err("游戏规则列表已变化或不完整".into());
    }
    let mut patches = vec![];
    let mut seen = std::collections::HashSet::new();
    for rule in &settings.game_rules {
        let old = current
            .game_rules
            .iter()
            .find(|old| old.key == rule.key)
            .ok_or("不能添加存档中不存在的规则")?;
        if !seen.insert(&rule.key)
            || rule.kind != old.kind
            || (rule.kind == "boolean" && !["true", "false"].contains(&rule.value.as_str()))
            || (rule.kind == "integer" && rule.value.parse::<i32>().is_err())
            || (rule.kind == "text" && rule.value != old.value)
        {
            return Err("游戏规则值或类型无效".into());
        }
        if rule.value != old.value {
            let offset = fields[&format!("GameRules/{}", rule.key)].1;
            let old_len = u16::from_be_bytes(raw[offset..offset + 2].try_into().unwrap()) as usize;
            let mut replacement = (rule.value.len() as u16).to_be_bytes().to_vec();
            replacement.extend_from_slice(rule.value.as_bytes());
            patches.push((offset, old_len + 2, replacement));
        }
    }
    patches.sort_by_key(|patch| std::cmp::Reverse(patch.0));
    for (offset, len, value) in patches {
        raw.splice(offset..offset + len, value);
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(&raw).map_err(|_| "无法编码存档")?;
    let replacement = encoder.finish().map_err(|_| "存档压缩失败")?;
    world_settings(&replacement)?;
    Ok(replacement)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientOptions {
    pub revision: String,
    #[serde(default = "default_language")]
    pub language: String,
    pub master_volume: f64,
    pub music_volume: f64,
    pub render_distance: u32,
    pub fullscreen: bool,
}
fn default_language() -> String {
    "zh_cn".into()
}
fn valid_language(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
pub fn language_for_version(language: &str, version: &str) -> String {
    let legacy = version
        .strip_prefix("1.")
        .and_then(|v| v.split('.').next())
        .and_then(|v| v.parse::<u32>().ok())
        .is_some_and(|minor| minor < 11);
    let lower = language.to_ascii_lowercase();
    if legacy {
        if let Some((base, region)) = lower.split_once('_') {
            return format!("{base}_{}", region.to_ascii_uppercase());
        }
    }
    lower
}
// Only new installations call this. Existing and referenced game directories
// retain their language; their options are changed only through the editor.
pub fn initial_options(bytes: Option<&[u8]>, version: &str) -> Result<Vec<u8>> {
    let text = std::str::from_utf8(bytes.unwrap_or_default()).map_err(|_| "游戏选项编码无效")?;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<_> = text
        .lines()
        .filter(|line| !line.trim_start_matches('\u{feff}').starts_with("lang:"))
        .map(str::to_owned)
        .collect();
    lines.push(format!("lang:{}", language_for_version("zh_cn", version)));
    Ok(format!("{}{newline}", lines.join(newline)).into_bytes())
}
pub fn initialize_options(root: &Path, version: &str) -> Result<()> {
    // Called only when publishing a newly created standalone game instance.
    let path = model::safe_path(root, "options.txt")?;
    if !path.exists() {
        model::write_file(root, "options.txt", &initial_options(None, version)?)?;
    }
    Ok(())
}
fn options_bytes(root: &Path) -> Result<Option<Vec<u8>>> {
    let path = model::safe_path(root, "options.txt")?;
    if !path.exists() {
        return Ok(None);
    }
    read(&path).map(Some)
}
fn parse_options(bytes: Option<&[u8]>) -> Result<ClientOptions> {
    let text = std::str::from_utf8(bytes.unwrap_or_default())
        .map_err(|_| "options.txt 不是有效 UTF-8，未修改")?;
    let map: HashMap<_, _> = text
        .trim_start_matches('\u{feff}')
        .lines()
        .filter_map(|line| line.split_once(':'))
        .collect();
    if map.get("lang").is_some_and(|v| !valid_language(v)) {
        return Err("现有游戏语言代码无效，未修改".into());
    }
    let number = |key: &str, default: f64| -> Result<f64> {
        let value = match map.get(key) {
            Some(value) => value.parse::<f64>().map_err(|_| "现有游戏选项数值无效")?,
            None => default,
        };
        if !value.is_finite() {
            return Err("游戏选项包含非有限数值".into());
        }
        Ok(value)
    };
    let master = number("soundCategory_master", 1.0)?;
    let music = number("soundCategory_music", 1.0)?;
    let distance = number("renderDistance", 12.0)?;
    if !(0.0..=1.0).contains(&master)
        || !(0.0..=1.0).contains(&music)
        || !(2.0..=64.0).contains(&distance)
        || distance.fract() != 0.0
    {
        return Err("现有音量或视距超出支持范围，未修改".into());
    }
    let fullscreen = match map.get("fullscreen") {
        Some(&"true") => true,
        Some(&"false") | None => false,
        _ => return Err("现有全屏选项无效".into()),
    };
    Ok(ClientOptions {
        revision: bytes.map(hash).unwrap_or_else(|| "missing".into()),
        language: map
            .get("lang")
            .filter(|v| valid_language(v))
            .map(|v| v.to_string())
            .unwrap_or_else(default_language),
        master_volume: master,
        music_volume: music,
        render_distance: distance as u32,
        fullscreen,
    })
}
pub fn load_options(root: &Path) -> Result<ClientOptions> {
    parse_options(options_bytes(root)?.as_deref())
}
pub fn save_options(root: &Path, options: ClientOptions) -> Result<String> {
    let _locks = lock_worlds(root)?;
    let original = options_bytes(root)?;
    let result = options_replacement(original.as_deref(), options)?;
    backed_write(root, "options.txt", original.as_deref(), &result)
}
pub(crate) fn activate_translation(
    root: &Path,
    file: &str,
    version: &str,
    revision: &str,
) -> Result<()> {
    if file.len() > 128
        || file.contains(['/', '\\', '\n', '\r'])
        || !file.starts_with("EasyCraft-CFPA-")
        || !file.ends_with(".zip")
    {
        return Err("汉化资源文件名无效".into());
    }
    let _locks = lock_worlds(root)?;
    let original = options_bytes(root)?;
    if original
        .as_deref()
        .map(hash)
        .unwrap_or_else(|| "missing".into())
        != revision
    {
        return Err("游戏设置已变化，未覆盖；请重新读取后重试".into());
    }
    let text = std::str::from_utf8(original.as_deref().unwrap_or_default())
        .map_err(|_| "游戏设置不是有效 UTF-8，未自动启用汉化")?;
    let raw = text
        .trim_start_matches('\u{feff}')
        .lines()
        .filter_map(|line| line.strip_prefix("resourcePacks:"))
        .next_back();
    let mut packs: Vec<String> = match raw {
        Some(raw) => serde_json::from_str(raw).map_err(|_| "现有资源包列表格式无效，未覆盖")?,
        None => vec![],
    };
    if packs.len() > 512 || packs.iter().any(|v| v.len() > 1024) {
        return Err("现有资源包列表过大，未覆盖".into());
    }
    packs.retain(|v| {
        let name = v.strip_prefix("file/").unwrap_or(v);
        !name
            .strip_prefix("EasyCraft-CFPA-")
            .and_then(|v| v.strip_suffix(".zip"))
            .is_some_and(|v| v.len() == 16 && v.bytes().all(|b| b.is_ascii_hexdigit()))
    });
    let legacy = version
        .strip_prefix("1.")
        .and_then(|v| v.split('.').next())
        .and_then(|v| v.parse::<u32>().ok())
        .is_some_and(|v| v <= 12);
    let position = packs
        .iter()
        .position(|v| v == "vanilla")
        .map(|i| i + 1)
        .unwrap_or(0);
    // Lowest external priority: the pack author's and player's translations win.
    packs.insert(
        position,
        format!("{}{file}", if legacy { "" } else { "file/" }),
    );
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<_> = text
        .lines()
        .filter(|line| {
            let plain = line.trim_start_matches('\u{feff}');
            !plain.starts_with("lang:") && !plain.starts_with("resourcePacks:")
        })
        .map(str::to_owned)
        .collect();
    lines.push(format!("lang:{}", language_for_version("zh_cn", version)));
    lines.push(format!(
        "resourcePacks:{}",
        serde_json::to_string(&packs).map_err(|_| "资源包设置编码失败")?
    ));
    let bytes = format!("{}{newline}", lines.join(newline));
    if original.as_deref() != Some(bytes.as_bytes()) {
        backed_write(root, "options.txt", original.as_deref(), bytes.as_bytes())?;
    }
    Ok(())
}
// Apply before Java creates its window; avoid enumerating worlds or rewriting
// unrelated sound, video and Mod settings when choosing the launch window mode.
pub fn prepare_window(root: &Path, mode: model::WindowMode) -> Result<Option<String>> {
    let fullscreen = match mode {
        model::WindowMode::Windowed => false,
        model::WindowMode::Fullscreen => true,
        model::WindowMode::Inherit => return Ok(None),
    };
    let original = options_bytes(root)?;
    let text = std::str::from_utf8(original.as_deref().unwrap_or_default()).map_err(|_| {
        "窗口设置无法读取 options.txt 的 UTF-8 编码；原文件未修改，可选择跟随游戏设置"
    })?;
    let mut found = false;
    let mut result = String::with_capacity(text.len() + 20);
    for line in text.split_inclusive('\n') {
        let plain = line.trim_end_matches(['\r', '\n']);
        let prefix = if result.is_empty() && plain.starts_with('\u{feff}') {
            "\u{feff}"
        } else {
            ""
        };
        if let Some(value) = plain
            .strip_prefix(prefix)
            .and_then(|v| v.strip_prefix("fullscreen:"))
        {
            if !["true", "false"].contains(&value) {
                return Err(
                    "现有全屏设置无效，原文件未修改；请检查 options.txt 或选择跟随游戏设置".into(),
                );
            }
            found = true;
            result.push_str(prefix);
            result.push_str(if fullscreen {
                "fullscreen:true"
            } else {
                "fullscreen:false"
            });
            result.push_str(&line[plain.len()..]);
        } else {
            result.push_str(line);
        }
    }
    if !found && fullscreen {
        let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
        if !result.is_empty() && !result.ends_with('\n') {
            result.push_str(newline);
        }
        result.push_str(&format!("fullscreen:true{newline}"));
    }
    if result.as_bytes() == original.as_deref().unwrap_or_default() {
        return Ok(None);
    }
    backed_write(root, "options.txt", original.as_deref(), result.as_bytes()).map(Some)
}
fn options_replacement(original: Option<&[u8]>, options: ClientOptions) -> Result<Vec<u8>> {
    if !valid_language(&options.language) {
        return Err("游戏语言代码无效".into());
    }
    if !options.master_volume.is_finite()
        || !options.music_volume.is_finite()
        || !(0.0..=1.0).contains(&options.master_volume)
        || !(0.0..=1.0).contains(&options.music_volume)
        || !(2..=64).contains(&options.render_distance)
    {
        return Err("游戏音量或视距无效".into());
    }
    if parse_options(original)?.revision != options.revision {
        return Err("游戏选项已变化，请重新读取后保存".into());
    }
    let text = std::str::from_utf8(original.unwrap_or_default()).map_err(|_| "配置编码无效")?;
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let replacements = [
        ("lang", options.language),
        ("soundCategory_master", options.master_volume.to_string()),
        ("soundCategory_music", options.music_volume.to_string()),
        ("renderDistance", options.render_distance.to_string()),
        ("fullscreen", options.fullscreen.to_string()),
    ];
    let mut lines: Vec<String> = text
        .lines()
        .filter(|line| {
            !replacements.iter().any(|(key, _)| {
                line.trim_start_matches('\u{feff}')
                    .split_once(':')
                    .is_some_and(|(old, _)| old == *key)
            })
        })
        .map(str::to_owned)
        .collect();
    for (key, value) in replacements {
        lines.push(format!("{key}:{value}"));
    }
    let result = format!("{}{newline}", lines.join(newline));
    Ok(result.into_bytes())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BackupRecord {
    owner: String,
    target: String,
    sha1: String,
    bytes: u64,
    created_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub id: String,
    pub sha1: String,
    pub bytes: u64,
    pub created_ms: u64,
}
#[derive(Serialize)]
pub struct BackupList {
    pub entries: Vec<BackupEntry>,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
pub struct ConfigChange {
    key: String,
    before: String,
    after: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub backup: BackupEntry,
    pub world_id: Option<String>,
    pub revision: String,
    pub changes: Vec<ConfigChange>,
}

fn backup_owner(root: &Path) -> Result<String> {
    let owner = if root.file_name().is_some_and(|name| name == "game") {
        root.parent().ok_or("实例路径无效")?
    } else {
        root
    };
    owner
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| "实例归属无效".into())
}
fn backup_record(root: &Path, id: &str) -> Result<BackupRecord> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err("备份编号无效".into());
    }
    let path = model::safe_path(root, &format!(".easycraft-backups/{id}/record.json"))?;
    let file = fs::File::open(path).map_err(|_| "备份缺少归属记录")?;
    let mut bytes = vec![];
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "备份记录读取失败")?;
    if bytes.len() > 4096 {
        return Err("备份记录过大".into());
    }
    let record: BackupRecord = serde_json::from_slice(&bytes).map_err(|_| "备份记录损坏")?;
    if record.owner != backup_owner(root)?
        || !model::valid_sha1(&record.sha1)
        || record.bytes > MAX_FILE
        || record.created_ms > 8_640_000_000_000_000
    {
        return Err("备份归属或记录无效".into());
    }
    Ok(record)
}
pub(crate) fn backup_target(root: &Path, world_id: Option<&str>) -> Result<String> {
    if let Some(id) = world_id {
        selected_world(root, id)?;
        Ok(format!("saves/{id}/level.dat"))
    } else {
        Ok("options.txt".into())
    }
}
fn backup_entry(root: &Path, id: &str, target: &str) -> Result<BackupEntry> {
    let record = backup_record(root, id)?;
    if record.target != target {
        return Err("备份不属于所选世界或配置类型".into());
    }
    let filename = if target == "options.txt" {
        "options.txt"
    } else {
        "level.dat"
    };
    let metadata = fs::metadata(model::safe_path(
        root,
        &format!(".easycraft-backups/{id}/{filename}"),
    )?)
    .map_err(|_| "备份文件不存在")?;
    if !metadata.is_file() || metadata.len() != record.bytes {
        return Err("备份文件类型或大小不一致".into());
    }
    Ok(BackupEntry {
        id: id.into(),
        sha1: record.sha1,
        bytes: record.bytes,
        created_ms: record.created_ms,
    })
}
pub(crate) fn checked_backup(
    root: &Path,
    id: &str,
    target: &str,
) -> Result<(BackupEntry, Vec<u8>)> {
    let entry = backup_entry(root, id, target)?;
    let filename = if target == "options.txt" {
        "options.txt"
    } else {
        "level.dat"
    };
    let bytes = read(&model::safe_path(
        root,
        &format!(".easycraft-backups/{id}/{filename}"),
    )?)?;
    if bytes.len() as u64 != entry.bytes || hash(&bytes) != entry.sha1 {
        return Err("备份大小或哈希不一致，未恢复".into());
    }
    Ok((entry, bytes))
}
pub fn backups(root: &Path, world_id: Option<&str>) -> Result<BackupList> {
    let target = backup_target(root, world_id)?;
    let path = model::safe_path(root, ".easycraft-backups")?;
    let mut result = BackupList {
        entries: vec![],
        warnings: vec![],
    };
    if !path.exists() {
        return Ok(result);
    }
    let mut skipped = 0;
    for (index, entry) in fs::read_dir(path)
        .map_err(|_| "备份目录读取失败")?
        .enumerate()
    {
        if index >= 2000 {
            return Err("备份目录超过 2000 条，请先手动归档；现有文件未修改".into());
        }
        let entry = entry.map_err(|_| "备份条目读取失败")?;
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            skipped += 1;
            continue;
        };
        if uuid::Uuid::parse_str(&id).is_err() {
            skipped += 1;
            continue;
        }
        match backup_record(root, &id) {
            Ok(record) if record.target != target => continue,
            Ok(_) => match backup_entry(root, &id, &target) {
                Ok(entry) => result.entries.push(entry),
                Err(_) => skipped += 1,
            },
            Err(_) => skipped += 1,
        }
    }
    result.entries.sort_by(|a, b| {
        b.created_ms
            .cmp(&a.created_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    if skipped > 0 {
        result.warnings.push(format!(
            "已保留并跳过 {skipped} 个缺少归属、损坏或不支持的备份条目；未自动推断其目标。"
        ));
    }
    Ok(result)
}
fn change(changes: &mut Vec<ConfigChange>, key: &str, before: impl ToString, after: impl ToString) {
    let before = before.to_string();
    let after = after.to_string();
    if before != after {
        changes.push(ConfigChange {
            key: key.into(),
            before,
            after,
        });
    }
}
fn restore_plan(
    root: &Path,
    world_id: Option<&str>,
    id: &str,
) -> Result<(BackupPreview, Option<Vec<u8>>, Vec<u8>)> {
    let target = backup_target(root, world_id)?;
    let (backup, saved) = checked_backup(root, id, &target)?;
    let original = if world_id.is_some() {
        Some(read(&model::safe_path(root, &target)?)?)
    } else {
        options_bytes(root)?
    };
    let revision = original
        .as_deref()
        .map(hash)
        .unwrap_or_else(|| "missing".into());
    let mut changes = vec![];
    let replacement = if world_id.is_some() {
        let bytes = original.as_deref().ok_or("世界配置不存在")?;
        let current = world_settings(bytes)?;
        let mut saved = world_settings(&saved)?;
        saved.revision.clone_from(&revision);
        let replacement = world_replacement(bytes, saved.clone())?;
        let difficulty = |value: u8| {
            ["和平", "简单", "普通", "困难"]
                .get(value as usize)
                .copied()
                .unwrap_or("未知")
        };
        change(
            &mut changes,
            "难度",
            difficulty(current.difficulty),
            difficulty(saved.difficulty),
        );
        change(
            &mut changes,
            "锁定难度",
            current.difficulty_locked,
            saved.difficulty_locked,
        );
        change(
            &mut changes,
            "允许命令",
            current
                .allow_commands
                .map(|v| v.to_string())
                .unwrap_or_default(),
            saved
                .allow_commands
                .map(|v| v.to_string())
                .unwrap_or_default(),
        );
        change(
            &mut changes,
            "游戏模式",
            current.game_mode.map(|v| v.to_string()).unwrap_or_default(),
            saved.game_mode.map(|v| v.to_string()).unwrap_or_default(),
        );
        change(
            &mut changes,
            "世界时间（刻）",
            current.day_time.unwrap_or_default(),
            saved.day_time.unwrap_or_default(),
        );
        change(
            &mut changes,
            "天气",
            current.weather.unwrap_or_default(),
            saved.weather.unwrap_or_default(),
        );
        for rule in &current.game_rules {
            if let Some(old) = saved.game_rules.iter().find(|old| old.key == rule.key) {
                change(
                    &mut changes,
                    &format!("游戏规则：{}", rule.key),
                    &rule.value,
                    &old.value,
                );
            }
        }
        replacement
    } else {
        let current = parse_options(original.as_deref())?;
        let mut saved = parse_options(Some(&saved))?;
        saved.revision.clone_from(&revision);
        change(&mut changes, "游戏语言", &current.language, &saved.language);
        change(
            &mut changes,
            "主音量（0–1）",
            current.master_volume,
            saved.master_volume,
        );
        change(
            &mut changes,
            "音乐音量（0–1）",
            current.music_volume,
            saved.music_volume,
        );
        change(
            &mut changes,
            "渲染距离",
            current.render_distance,
            saved.render_distance,
        );
        change(&mut changes, "全屏", current.fullscreen, saved.fullscreen);
        options_replacement(original.as_deref(), saved)?
    };
    Ok((
        BackupPreview {
            backup,
            world_id: world_id.map(str::to_owned),
            revision,
            changes,
        },
        original,
        replacement,
    ))
}
pub fn preview_backup(root: &Path, world_id: Option<&str>, id: &str) -> Result<BackupPreview> {
    restore_plan(root, world_id, id).map(|(preview, _, _)| preview)
}
pub(crate) fn config_locks(root: &Path, world_id: Option<&str>) -> Result<Vec<fs::File>> {
    if let Some(world) = world_id {
        Ok(vec![session_lock(&selected_world(root, world)?)?])
    } else {
        lock_worlds(root)
    }
}
pub fn restore_backup(
    root: &Path,
    world_id: Option<&str>,
    id: &str,
    revision: &str,
    backup_sha1: &str,
) -> Result<String> {
    let _locks = config_locks(root, world_id)?;
    let (preview, original, replacement) = restore_plan(root, world_id, id)?;
    if preview.revision != revision || preview.backup.sha1 != backup_sha1 {
        return Err("当前配置或备份已变化，请重新预览；未恢复".into());
    }
    if preview.changes.is_empty() {
        return Err("所选配置与当前一致，无需恢复".into());
    }
    let target = backup_target(root, world_id)?;
    backed_write(root, &target, original.as_deref(), &replacement)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn tag(kind: u8, name: &str, payload: &[u8]) -> Vec<u8> {
        let mut bytes = vec![kind];
        bytes.extend_from_slice(&(name.len() as u16).to_be_bytes());
        bytes.extend_from_slice(name.as_bytes());
        bytes.extend_from_slice(payload);
        bytes
    }
    fn string(value: &str) -> Vec<u8> {
        let mut bytes = (value.len() as u16).to_be_bytes().to_vec();
        bytes.extend_from_slice(value.as_bytes());
        bytes
    }
    fn sample() -> Vec<u8> {
        let mut data = vec![];
        for (name, value) in [
            ("Difficulty", 2),
            ("DifficultyLocked", 0),
            ("allowCommands", 0),
            ("hardcore", 0),
            ("raining", 0),
            ("thundering", 0),
        ] {
            data.extend(tag(1, name, &[value]));
        }
        for (name, value) in [
            ("GameType", 0i32),
            ("DataVersion", 3955),
            ("rainTime", 6000),
            ("thunderTime", 6000),
            ("clearWeatherTime", 0),
        ] {
            data.extend(tag(3, name, &value.to_be_bytes()));
        }
        data.extend(tag(4, "DayTime", &9007199254740993i64.to_be_bytes()));
        data.extend(tag(4, "Time", &12345678i64.to_be_bytes()));
        data.extend(tag(8, "LevelName", &string("设置测试世界")));
        let mut opaque = 4i32.to_be_bytes().to_vec();
        opaque.extend_from_slice(&[0, 255, 77, 99]);
        data.extend(tag(7, "ModOpaqueBytes", &opaque));
        let mut rules = vec![];
        for (name, value) in [
            ("keepInventory", "false"),
            ("doDaylightCycle", "true"),
            ("doWeatherCycle", "true"),
            ("doMobSpawning", "true"),
            ("mobGriefing", "true"),
            ("doFireTick", "true"),
            ("naturalRegeneration", "true"),
            ("doInsomnia", "true"),
            ("doPatrolSpawning", "true"),
            ("doTraderSpawning", "true"),
            ("doTileDrops", "true"),
            ("doEntityDrops", "true"),
            ("doMobLoot", "true"),
            ("fallDamage", "true"),
            ("fireDamage", "true"),
            ("drowningDamage", "true"),
            ("showDeathMessages", "true"),
            ("sendCommandFeedback", "true"),
            ("commandBlockOutput", "true"),
            ("announceAdvancements", "true"),
            ("disableRaids", "false"),
            ("doImmediateRespawn", "false"),
            ("randomTickSpeed", "3"),
            ("spawnRadius", "10"),
            ("playersSleepingPercentage", "100"),
            ("maxEntityCramming", "24"),
            ("maxCommandChainLength", "65536"),
            ("modReadOnlyRule", "preserve-custom-text"),
        ] {
            rules.extend(tag(8, name, &string(value)));
        }
        rules.push(0);
        data.extend(tag(10, "GameRules", &rules));
        data.push(0);
        let mut raw = vec![10, 0, 0];
        raw.extend(tag(10, "Data", &data));
        raw.push(0);
        raw
    }
    fn gzip(raw: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(vec![], Compression::default());
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }
    fn root() -> PathBuf {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".native/tests")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(path.join("saves/世界 A")).unwrap();
        fs::write(path.join("saves/世界 A/level.dat"), gzip(&sample())).unwrap();
        path
    }
    #[test]
    fn launch_window_changes_only_fullscreen_before_start_and_preserves_backup() {
        let root = root();
        let original = b"customMod:keep:colon\r\nfullscreen:true\r\nrenderDistance:128\r\noverrideWidth:0\r\nfullscreenResolution:2560x1600@165\r\n";
        fs::write(root.join("options.txt"), original).unwrap();
        assert!(prepare_window(&root, model::WindowMode::Inherit)
            .unwrap()
            .is_none());
        assert_eq!(fs::read(root.join("options.txt")).unwrap(), original);
        let backup = prepare_window(&root, model::WindowMode::Windowed)
            .unwrap()
            .unwrap();
        assert_eq!(fs::read(&backup).unwrap(), original);
        assert_eq!(
            fs::read_to_string(root.join("options.txt")).unwrap(),
            String::from_utf8_lossy(original).replace("fullscreen:true", "fullscreen:false")
        );
        assert!(prepare_window(&root, model::WindowMode::Windowed)
            .unwrap()
            .is_none());
        assert!(!root.join("saves/世界 A/session.lock").exists());
        prepare_window(&root, model::WindowMode::Fullscreen).unwrap();
        assert_eq!(fs::read(root.join("options.txt")).unwrap(), original);
        fs::write(root.join("options.txt"), b"fullscreen:invalid\nother:value").unwrap();
        assert!(prepare_window(&root, model::WindowMode::Windowed).is_err());
        assert_eq!(
            fs::read(root.join("options.txt")).unwrap(),
            b"fullscreen:invalid\nother:value"
        );
        assert!(prepare_window(&root, model::WindowMode::Inherit)
            .unwrap()
            .is_none());
        fs::remove_file(root.join("options.txt")).unwrap();
        assert!(prepare_window(&root, model::WindowMode::Windowed)
            .unwrap()
            .is_none());
        assert!(!root.join("options.txt").exists());
        prepare_window(&root, model::WindowMode::Fullscreen).unwrap();
        assert_eq!(
            fs::read(root.join("options.txt")).unwrap(),
            b"fullscreen:true\n"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn difficulty_edit_preserves_every_other_nbt_byte_and_original_backup() {
        let root = root();
        let path = root.join("saves/世界 A/level.dat");
        let original = fs::read(&path).unwrap();
        let (mut expected, fields) = decode(&original).unwrap();
        let mut settings = load_world(&root, "世界 A").unwrap();
        assert_eq!(settings.day_time.as_deref(), Some("9007199254740993"));
        assert_eq!(settings.game_rules.len(), 28);
        settings.difficulty = 3;
        let backup = save_world(&root, "世界 A", settings).unwrap();
        assert_eq!(fs::read(backup).unwrap(), original);
        expected[fields["Difficulty"].1] = 3;
        assert_eq!(decode(&fs::read(path).unwrap()).unwrap().0, expected);
    }
    #[test]
    fn backup_restore_is_owned_revision_checked_and_keeps_current_unknown_world_data() {
        let root = root();
        let world = "世界 A";
        let path = root.join("saves/世界 A/level.dat");
        let mut settings = load_world(&root, world).unwrap();
        settings.difficulty = 3;
        let old = save_world(&root, world, settings).unwrap();
        let listed = backups(&root, Some(world)).unwrap();
        assert_eq!(listed.entries.len(), 1);
        let id = &listed.entries[0].id;
        let (mut current, fields) = decode(&fs::read(&path).unwrap()).unwrap();
        let unknown = current
            .windows(4)
            .position(|bytes| bytes == [0, 255, 77, 99])
            .unwrap();
        current[unknown + 1] = 254;
        let before = gzip(&current);
        fs::write(&path, &before).unwrap();
        let preview = preview_backup(&root, Some(world), id).unwrap();
        assert_eq!(preview.changes.len(), 1);
        assert_eq!(preview.changes[0].key, "难度");
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::create_dir_all(root.join("saves/世界 B")).unwrap();
        fs::write(root.join("saves/世界 B/level.dat"), &before).unwrap();
        assert!(preview_backup(&root, Some("世界 B"), id).is_err());
        assert!(preview_backup(&root, None, id).is_err());
        assert!(preview_backup(&root, Some(world), "../escape").is_err());
        let occupied = session_lock(&world_dir(&root, world).unwrap()).unwrap();
        assert!(restore_backup(
            &root,
            Some(world),
            id,
            &preview.revision,
            &preview.backup.sha1
        )
        .is_err());
        drop(occupied);
        let undo = restore_backup(
            &root,
            Some(world),
            id,
            &preview.revision,
            &preview.backup.sha1,
        )
        .unwrap();
        assert_eq!(fs::read(undo).unwrap(), before);
        current[fields["Difficulty"].1] = 2;
        assert_eq!(decode(&fs::read(&path).unwrap()).unwrap().0, current);
        assert!(preview_backup(&root, Some(world), id)
            .unwrap()
            .changes
            .is_empty());
        let unchanged = fs::read(&path).unwrap();
        assert!(restore_backup(
            &root,
            Some(world),
            id,
            &preview.revision,
            &preview.backup.sha1
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), unchanged);
        let foreign = self::root();
        let destination = foreign.join(format!(".easycraft-backups/{id}"));
        fs::create_dir_all(&destination).unwrap();
        fs::copy(&old, destination.join("level.dat")).unwrap();
        fs::copy(
            Path::new(&old).parent().unwrap().join("record.json"),
            destination.join("record.json"),
        )
        .unwrap();
        assert!(preview_backup(&foreign, Some(world), id).is_err());
        let legacy = root.join(format!(".easycraft-backups/{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("level.dat"), b"old unowned data").unwrap();
        assert!(!backups(&root, Some(world)).unwrap().warnings.is_empty());
        assert!(legacy.join("level.dat").exists());
        fs::write(&old, b"tampered").unwrap();
        assert!(preview_backup(&root, Some(world), id).is_err());
        assert_eq!(fs::read(path).unwrap(), unchanged);
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(foreign).unwrap();
    }
    #[test]
    fn options_restore_merges_supported_fields_preserves_new_unknown_lines_and_handles_missing_files(
    ) {
        let root = root();
        let path = root.join("options.txt");
        fs::write(
            &path,
            b"soundCategory_master:0.42\r\ncustomMod:original\r\n",
        )
        .unwrap();
        let mut settings = load_options(&root).unwrap();
        settings.master_volume = 0.75;
        save_options(&root, settings).unwrap();
        let list = backups(&root, None).unwrap();
        let id = &list.entries[0].id;
        let current = fs::read_to_string(&path)
            .unwrap()
            .replace("customMod:original", "customMod:latest");
        fs::write(&path, &current).unwrap();
        let preview = preview_backup(&root, None, id).unwrap();
        fs::write(&path, format!("{current}extraMod:keep\r\n")).unwrap();
        assert!(restore_backup(&root, None, id, &preview.revision, &preview.backup.sha1).is_err());
        let preview = preview_backup(&root, None, id).unwrap();
        let before = fs::read(&path).unwrap();
        let undo =
            restore_backup(&root, None, id, &preview.revision, &preview.backup.sha1).unwrap();
        assert_eq!(fs::read(undo).unwrap(), before);
        let restored = fs::read_to_string(&path).unwrap();
        assert!(
            restored.contains("customMod:latest\r\n") && restored.contains("extraMod:keep\r\n")
        );
        assert!(!restored.contains("customMod:original"));
        assert_eq!(load_options(&root).unwrap().master_volume, 0.42);
        fs::remove_file(&path).unwrap();
        let preview = preview_backup(&root, None, id).unwrap();
        assert_eq!(preview.revision, "missing");
        assert_eq!(
            restore_backup(&root, None, id, &preview.revision, &preview.backup.sha1).unwrap(),
            ""
        );
        assert_eq!(load_options(&root).unwrap().master_volume, 0.42);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rules_weather_time_and_default_mode_roundtrip_without_touching_unknown_data() {
        let root = root();
        let mut settings = load_world(&root, "世界 A").unwrap();
        settings.game_mode = Some(1);
        settings.day_time = Some("13000".into());
        settings.weather = Some("thunder".into());
        settings.allow_commands = Some(true);
        for rule in &mut settings.game_rules {
            if rule.key == "keepInventory" {
                rule.value = "true".into();
            }
            if rule.key == "randomTickSpeed" {
                rule.value = "9".into();
            }
        }
        save_world(&root, "世界 A", settings).unwrap();
        let after = load_world(&root, "世界 A").unwrap();
        assert_eq!(after.game_mode, Some(1));
        assert_eq!(after.weather.as_deref(), Some("thunder"));
        assert_eq!(after.day_time.as_deref(), Some("13000"));
        assert!(after
            .game_rules
            .iter()
            .any(|rule| rule.key == "keepInventory" && rule.value == "true"));
        let raw = decode(&fs::read(root.join("saves/世界 A/level.dat")).unwrap())
            .unwrap()
            .0;
        assert!(raw.windows(4).any(|bytes| bytes == [0, 255, 77, 99]));
        assert!(raw
            .windows(8)
            .any(|bytes| bytes == 12345678i64.to_be_bytes()));
    }
    #[test]
    fn stale_edits_running_worlds_hardcore_and_invalid_rules_are_rejected() {
        let root = root();
        let path = root.join("saves/世界 A/level.dat");
        let original = fs::read(&path).unwrap();
        let stale = load_world(&root, "世界 A").unwrap();
        let mut changed = stale.clone();
        changed.difficulty = 1;
        save_world(&root, "世界 A", changed).unwrap();
        let current = fs::read(&path).unwrap();
        assert!(save_world(&root, "世界 A", stale)
            .unwrap_err()
            .contains("变化"));
        assert_eq!(fs::read(&path).unwrap(), current);
        let lock = session_lock(&root.join("saves/世界 A")).unwrap();
        assert!(save_world(&root, "世界 A", load_world(&root, "世界 A").unwrap()).is_err());
        drop(lock);
        let mut invalid = load_world(&root, "世界 A").unwrap();
        invalid.game_rules[0].value = "wrong".into();
        assert!(save_world(&root, "世界 A", invalid).is_err());
        assert_eq!(fs::read(&path).unwrap(), current);
        let (mut raw, fields) = decode(&original).unwrap();
        raw[fields["hardcore"].1] = 1;
        fs::write(&path, gzip(&raw)).unwrap();
        let hardcore = load_world(&root, "世界 A").unwrap();
        assert!(save_world(&root, "世界 A", hardcore)
            .unwrap_err()
            .contains("极限"));
        assert!(load_world(&root, "../世界 A").is_err());
        assert!(decode(b"bad gzip").is_err());
        let mut bad = sample();
        bad[0] = 1;
        assert!(decode(&gzip(&bad)).is_err());
    }
    #[test]
    fn options_merge_preserves_unknown_lines_and_detects_conflicts() {
        let root = root();
        let original=b"version:3955\r\ncustomMod:keep:colon\r\nsoundCategory_master:1.0\r\nsoundCategory_music:0.5\r\nrenderDistance:12\r\nfullscreen:false\r\n";
        fs::write(root.join("options.txt"), original).unwrap();
        let mut options = load_options(&root).unwrap();
        let stale = options.clone();
        options.master_volume = 0.37;
        options.render_distance = 10;
        let backup = save_options(&root, options).unwrap();
        assert_eq!(fs::read(backup).unwrap(), original);
        let text = fs::read_to_string(root.join("options.txt")).unwrap();
        assert!(text.contains("customMod:keep:colon\r\n"));
        assert!(text.contains("soundCategory_master:0.37\r\n"));
        assert!(save_options(&root, stale).unwrap_err().contains("变化"));
        let mut invalid = load_options(&root).unwrap();
        invalid.master_volume = f64::NAN;
        assert!(save_options(&root, invalid).is_err());
    }
    #[test]
    fn language_defaults_edit_backup_restore_and_legacy_codes() {
        let root = root();
        initialize_options(&root, "1.10.2").unwrap();
        assert_eq!(load_options(&root).unwrap().language, "zh_CN");
        let original = b"lang:fr_fr\r\nresourcePacks:[\"vanilla\",\"file/translation.zip\"]\r\ncustomMod:keep:colon\r\n";
        fs::write(root.join("options.txt"), original).unwrap();
        initialize_options(&root, "1.21.1").unwrap();
        assert_eq!(fs::read(root.join("options.txt")).unwrap(), original);
        let mut options = load_options(&root).unwrap();
        options.language = "zh_cn".into();
        let backup = save_options(&root, options).unwrap();
        assert_eq!(fs::read(backup).unwrap(), original);
        let result = fs::read_to_string(root.join("options.txt")).unwrap();
        assert!(result.contains("lang:zh_cn\r\n"));
        assert!(result.contains("customMod:keep:colon\r\n"));
        assert!(result.contains("resourcePacks:[\"vanilla\",\"file/translation.zip\"]\r\n"));
        for invalid in ["", "zh_cn\nfullscreen:true", "../../zh", "中文"] {
            let mut value = load_options(&root).unwrap();
            value.language = invalid.into();
            assert!(save_options(&root, value).is_err());
            assert_eq!(
                fs::read_to_string(root.join("options.txt")).unwrap(),
                result
            );
        }
        let id = backups(&root, None).unwrap().entries[0].id.clone();
        let plan = preview_backup(&root, None, &id).unwrap();
        assert!(plan
            .changes
            .iter()
            .any(|v| v.key == "游戏语言" && v.after == "fr_fr"));
        assert_eq!(language_for_version("ZH_cn", "1.7.10"), "zh_CN");
        assert_eq!(language_for_version("en_us", "1.10.2"), "en_US");
        for version in ["1.11", "1.12.2", "1.21.1", "26.2", "26.4-snapshot-5"] {
            assert_eq!(language_for_version("zh_CN", version), "zh_cn");
        }
        let fresh = initial_options(Some(original), "1.21.1").unwrap();
        assert!(std::str::from_utf8(&fresh)
            .unwrap()
            .contains("lang:zh_cn\r\n"));
    }
    #[test]
    fn create_desktop_test_fixture() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".native/fixtures/world");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("level.dat"), gzip(&sample())).unwrap();
    }
}
