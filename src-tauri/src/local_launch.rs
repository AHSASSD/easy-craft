//! Existing installations use their own libraries/assets; registration never copies world contents.
use crate::{
    host::Host,
    minecraft,
    model::{self, Instance, Result},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

fn library_key(value: &Value) -> String {
    let name = value["name"].as_str().unwrap_or_default();
    let (coordinate, extension) = name.split_once('@').unwrap_or((name, "jar"));
    let parts: Vec<_> = coordinate.split(':').collect();
    format!(
        "{}:{}:{}@{}",
        parts.first().unwrap_or(&""),
        parts.get(1).unwrap_or(&""),
        parts.get(3).unwrap_or(&""),
        extension
    )
}
pub fn merge(profiles: &[Value]) -> Result<Value> {
    let mut merged = json!({"arguments":{"jvm":[],"game":[]},"libraries":[]});
    for child in profiles.iter().rev() {
        let mut libraries = merged["libraries"].as_array().cloned().unwrap_or_default();
        let mut positions: HashMap<String, usize> = libraries
            .iter()
            .enumerate()
            .map(|(i, v)| (library_key(v), i))
            .collect();
        for library in child["libraries"].as_array().ok_or("版本缺少依赖库清单")? {
            if !minecraft::allowed(library.get("rules"))? {
                continue;
            }
            let key = library_key(library);
            if let Some(index) = positions.get(&key) {
                libraries[*index] = library.clone();
            } else {
                positions.insert(key, libraries.len());
                libraries.push(library.clone());
            }
        }
        let mut arguments = merged["arguments"].clone();
        for kind in ["jvm", "game"] {
            if let Some(rows) = child["arguments"][kind].as_array() {
                arguments[kind]
                    .as_array_mut()
                    .ok_or("启动参数无效")?
                    .extend(rows.clone());
            }
        }
        for (key, value) in child.as_object().ok_or("版本元数据不是对象")? {
            if !["libraries", "arguments", "inheritsFrom"].contains(&key.as_str())
                && !(key == "logging" && value.as_object().is_some_and(|v| v.is_empty()))
            {
                merged[key] = value.clone();
            }
        }
        merged["libraries"] = Value::Array(libraries);
        merged["arguments"] = arguments;
    }
    if merged["libraries"]
        .as_array()
        .is_none_or(|v| v.len() > 4000)
    {
        return Err("合并后的依赖数量异常".into());
    }
    Ok(merged)
}
pub fn loader(profile: &Value) -> (String, String) {
    let libraries = profile["libraries"].as_array().cloned().unwrap_or_default();
    for (kind, prefix) in [
        ("neoforge", "net.neoforged:neoforge:"),
        ("forge", "net.minecraftforge:forge:"),
        ("fabric", "net.fabricmc:fabric-loader:"),
    ] {
        if let Some(version) = libraries
            .iter()
            .filter_map(|v| v["name"].as_str())
            .find_map(|v| v.strip_prefix(prefix))
        {
            let version = version.split([':', '@']).next().unwrap_or(version);
            return (kind.into(), version.into());
        }
    }
    // NeoForge versions may list only its processed client JAR and FML libraries.
    if let Some(args) = profile["arguments"]["game"].as_array() {
        for (kind, flag) in [
            ("neoforge", "--fml.neoForgeVersion"),
            ("forge", "--fml.forgeVersion"),
        ] {
            if let Some(pair) = args.windows(2).find(|v| v[0] == flag) {
                return (kind.into(), pair[1].as_str().unwrap_or_default().into());
            }
        }
    }
    ("vanilla".into(), String::new())
}
pub fn coordinate_path(name: &str) -> Result<String> {
    let (coordinate, extension) = name.split_once('@').unwrap_or((name, "jar"));
    let parts: Vec<_> = coordinate.split(':').collect();
    if !(3..=4).contains(&parts.len())
        || !["jar", "zip"].contains(&extension)
        || parts.iter().any(|p| {
            p.is_empty()
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-+".contains(&b))
        })
    {
        return Err("本地依赖坐标无效".into());
    }
    let classifier = parts.get(3).map(|v| format!("-{v}")).unwrap_or_default();
    Ok(format!(
        "{}/{}/{}/{}-{}{classifier}.{extension}",
        parts[0].replace('.', "/"),
        parts[1],
        parts[2],
        parts[1],
        parts[2]
    ))
}
// FML resolves processed artifacts itself, outside the JSON classpath.
pub fn companion_libraries(profile: &Value) -> Result<Vec<String>> {
    let kind = loader(profile).0;
    if ![
        "cpw.mods.modlauncher.Launcher",
        "cpw.mods.bootstraplauncher.BootstrapLauncher",
    ]
    .iter()
    .any(|v| profile["mainClass"] == *v)
        || !["forge", "neoforge"].contains(&kind.as_str())
    {
        return Ok(vec![]);
    }
    let args = profile["arguments"]["game"]
        .as_array()
        .ok_or("Forge 游戏参数缺失")?;
    let value = |flag: &str| -> Result<&str> {
        args.windows(2)
            .find(|v| v[0] == flag)
            .and_then(|v| v[1].as_str())
            .ok_or_else(|| format!("Forge 缺少参数 {flag}"))
    };
    let mc = value("--fml.mcVersion")?;
    let coordinates = if kind == "neoforge" && args.iter().any(|v| v == "--fml.neoFormVersion") {
        let neo = value("--fml.neoForgeVersion")?;
        let form = value("--fml.neoFormVersion")?;
        vec![
            format!("net.neoforged:neoforge:{neo}:universal"),
            format!("net.neoforged:neoforge:{neo}:client"),
            format!("net.minecraft:client:{mc}-{form}:srg"),
            format!("net.minecraft:client:{mc}-{form}:extra"),
        ]
    } else {
        let forge = value("--fml.forgeVersion")?;
        let group = value("--fml.forgeGroup")?;
        let mcp = value("--fml.mcpVersion")?;
        vec![
            format!("{group}:forge:{mc}-{forge}:universal"),
            format!("{group}:forge:{mc}-{forge}:client"),
            format!("net.minecraft:client:{mc}-{mcp}:srg"),
            format!("net.minecraft:client:{mc}-{mcp}:extra"),
        ]
    };
    coordinates
        .iter()
        .map(|name| coordinate_path(name))
        .collect()
}
pub fn read_profile(root: &Path, instance: &Instance) -> Result<Value> {
    let path = model::safe_path(
        root,
        &format!("instances/{}/local-profile.json", instance.id),
    )?;
    if fs::metadata(&path)
        .map_err(|_| "本地启动配置快照缺失，请重新添加版本")?
        .len()
        > 8 * 1024 * 1024
        || !crate::net::matches(&path, &instance.manifest_sha1, None)?
    {
        return Err("本地启动配置快照已变化，请重新添加版本".into());
    }
    let profile: Value =
        serde_json::from_slice(&fs::read(path).map_err(|_| "无法读取本地启动配置")?)
            .map_err(|_| "本地启动配置无效")?;
    // Older managed 1.12 Forge snapshots lost OS-specific LWJGL rows during merging.
    // Rehydrate from the hash-verified official base without modifying the saved snapshot.
    if instance.version == "1.12.2"
        && instance
            .local
            .as_ref()
            .is_some_and(|v| v.loader == "forge" && Path::new(&v.root) == root)
    {
        let directory = model::safe_path(root, "versions/1.12.2")?;
        for item in fs::read_dir(directory)
            .map_err(|_| "原版元数据目录不可读")?
            .take(32)
        {
            let path = item.map_err(|_| "原版元数据不可读")?.path();
            let hash = path.file_stem().and_then(|v| v.to_str()).unwrap_or("");
            if path.extension().is_some_and(|v| v == "json")
                && model::valid_sha1(hash)
                && fs::metadata(&path).is_ok_and(|m| m.len() <= 8 * 1024 * 1024)
                && crate::net::matches(&path, hash, None)?
            {
                let base: Value =
                    serde_json::from_slice(&fs::read(&path).map_err(|_| "原版元数据不可读")?)
                        .map_err(|_| "原版元数据无效")?;
                if base["id"] == instance.version {
                    return merge(&[profile, base]);
                }
            }
        }
        return Err("缺少已校验的 1.12.2 原版元数据，无法修复图形库配置".into());
    }
    Ok(profile)
}
pub fn prepare(
    host: &Host,
    instance: &Instance,
    cancel: &CancellationToken,
) -> Result<minecraft::Prepared> {
    let local = instance.local.as_ref().ok_or("不是本地引用版本")?;
    local.validate()?;
    let source = crate::local_import::checked_directory(Path::new(&local.root))?;
    let metadata = read_profile(&host.root, instance)?;
    let mut classpath = vec![];
    let mut natives = vec![];
    let mut missing = vec![];
    let rows = metadata["libraries"]
        .as_array()
        .ok_or("本地版本缺少依赖清单")?;
    host.progress(
        "local-libraries",
        "检查本地库位置，不遍历存档或 Mod 内容",
        0,
        rows.len() + 2,
    );
    for (index, library) in rows.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err("启动准备已取消".into());
        }
        if !minecraft::allowed(library.get("rules"))? {
            continue;
        }
        let artifact = if let Some(path) = library["downloads"]["artifact"]["path"].as_str() {
            Some(path.to_string())
        } else if library.get("downloads").is_none() {
            Some(coordinate_path(
                library["name"].as_str().ok_or("依赖名称缺失")?,
            )?)
        } else {
            None
        };
        if let Some(artifact) = artifact {
            let path = model::safe_path(&source, &format!("libraries/{artifact}"))?;
            if path.is_file() {
                classpath.push(path);
            } else {
                missing.push(format!("libraries/{artifact}"));
            }
        }
        if let Some(native) = library["natives"]["windows"].as_str() {
            let native = native.replace("${arch}", "64");
            let relative = library["downloads"]["classifiers"][&native]["path"]
                .as_str()
                .ok_or("原生库未提供本地路径")?;
            let path = model::safe_path(&source, &format!("libraries/{relative}"))?;
            if path.is_file() {
                natives.push(path);
            } else {
                missing.push(format!("libraries/{relative}"));
            }
        }
        host.progress(
            "local-libraries",
            "检查已安装的本地依赖",
            index + 1,
            rows.len() + 2,
        );
    }
    for relative in companion_libraries(&metadata)? {
        if !model::safe_path(&source, &format!("libraries/{relative}"))?.is_file() {
            missing.push(format!("libraries/{relative}"));
        }
    }
    let client = model::safe_path(&source, &local.client_jar)?;
    if client.is_file() {
        classpath.push(client);
    } else {
        missing.push(local.client_jar.clone());
    }
    let index = metadata["assetIndex"]["id"]
        .as_str()
        .ok_or("本地版本缺少资源索引名称")?;
    if !model::safe_path(&source, &format!("assets/indexes/{index}.json"))?.is_file() {
        missing.push(format!("assets/indexes/{index}.json"));
    }
    if !missing.is_empty() {
        return Err(format!("本地安装缺少 {} 项启动依赖：{}。未联网、未修改源目录；请用原启动器修复，或选择独立副本模式。",missing.len(),missing.iter().take(6).cloned().collect::<Vec<_>>().join("；")));
    }
    host.progress(
        "local-libraries",
        "本地启动依赖位置检查完成",
        rows.len() + 2,
        rows.len() + 2,
    );
    Ok(minecraft::Prepared {
        metadata,
        classpath,
        native_archives: natives,
        java_major: instance.java_major,
    })
}

pub async fn java_for(
    instance: &Instance,
    configured: &str,
    root: &Path,
) -> Result<minecraft::JavaInfo> {
    tokio::time::timeout(
        std::time::Duration::from_secs(15),
        find_java(instance, configured, root),
    )
    .await
    .map_err(|_| "本机 Java 匹配超时，请在实例设置中手动选择 Java。".to_string())?
}
async fn find_java(
    instance: &Instance,
    configured: &str,
    root: &Path,
) -> Result<minecraft::JavaInfo> {
    if let Ok(java) = minecraft::probe_java(configured).await {
        if java.is_64_bit && java.major == instance.java_major {
            return Ok(java);
        }
    }
    let mut roots = vec![root.join("runtimes")];
    if let Some(local) = &instance.local {
        roots.push(PathBuf::from(&local.root).join("runtime"));
    }
    for variable in ["JAVA_HOME", "JDK_HOME"] {
        if let Some(value) = std::env::var_os(variable) {
            roots.push(PathBuf::from(value));
        }
    }
    if let Some(base) = Path::new(configured).ancestors().nth(4) {
        roots.push(base.join(format!("java{}", instance.java_major)));
    }
    if let Some(base) = std::env::var_os("APPDATA") {
        let base = PathBuf::from(base);
        roots.extend([
            base.join(".hmcl/java"),
            base.join("PrismLauncher/java"),
            base.join("ModrinthApp/meta/java_versions"),
        ]);
    }
    if let Some(base) = std::env::var_os("ProgramFiles") {
        let base = PathBuf::from(base);
        roots.extend([
            base.join("Java"),
            base.join("Eclipse Adoptium"),
            base.join("Zulu"),
            base.join("Amazon Corretto"),
        ]);
    }
    fn visit(root: &Path, depth: usize, budget: &mut usize, paths: &mut Vec<PathBuf>) {
        use std::os::windows::fs::MetadataExt;
        if depth > 4 || *budget == 0 || paths.len() >= 24 {
            return;
        }
        *budget -= 1;
        if !fs::symlink_metadata(root).is_ok_and(|v| v.is_dir() && v.file_attributes() & 0x400 == 0)
        {
            return;
        }
        let executable = root.join("bin/java.exe");
        if executable.is_file() {
            paths.push(executable);
            return;
        }
        if let Ok(items) = fs::read_dir(root) {
            for item in items.take(64).flatten() {
                if item.file_type().is_ok_and(|v| v.is_dir()) {
                    visit(&item.path(), depth + 1, budget, paths);
                }
            }
        }
    }
    let mut paths = vec![];
    let mut budget = 256;
    for candidate in roots {
        visit(&candidate, 0, &mut budget, &mut paths);
    }
    for path in paths {
        if let Ok(java) = minecraft::probe_java(&path.to_string_lossy()).await {
            if java.is_64_bit && java.major == instance.java_major {
                return Ok(java);
            }
        }
    }
    Err(format!("此版本需要 64 位 Java {}。已检查配置与常见本机运行时目录，未找到匹配版本；请在实例设置中选择对应 java.exe。",instance.java_major))
}
pub struct JvmArgumentFile {
    path: PathBuf,
}
fn launcher_encoding(text: &str) -> Result<Vec<u8>> {
    use windows_sys::Win32::Globalization::{GetACP, WideCharToMultiByte, WC_NO_BEST_FIT_CHARS};
    let page = unsafe { GetACP() };
    if page == 65001 {
        return Ok(text.as_bytes().to_vec());
    }
    let wide: Vec<u16> = text.encode_utf16().collect();
    let mut replaced = 0;
    let size = unsafe {
        WideCharToMultiByte(
            page,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            wide.len() as i32,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            &mut replaced,
        )
    };
    if size <= 0 {
        return Err("无法编码 JVM 参数文件".into());
    }
    let mut bytes = vec![0u8; size as usize];
    let count = unsafe {
        WideCharToMultiByte(
            page,
            WC_NO_BEST_FIT_CHARS,
            wide.as_ptr(),
            wide.len() as i32,
            bytes.as_mut_ptr(),
            size,
            std::ptr::null(),
            &mut replaced,
        )
    };
    if count != size || replaced != 0 {
        return Err("Java 参数文件无法表示此安装路径的字符，请使用较短的兼容路径。".into());
    }
    Ok(bytes)
}
impl Drop for JvmArgumentFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
pub fn command_arguments(
    root: &Path,
    instance: &Instance,
    args: &[String],
) -> Result<(Vec<String>, Option<JvmArgumentFile>)> {
    if instance.local.is_none()
        || instance.java_major < 9
        || args.iter().map(|v| v.len() + 3).sum::<usize>() < 12000
    {
        return Ok((args.to_vec(), None));
    }
    let profile = read_profile(root, instance)?;
    let main = profile["mainClass"].as_str().ok_or("缺少启动主类")?;
    let main_index = args
        .iter()
        .position(|v| v == main)
        .ok_or("启动主类参数不存在")?;
    let mut body = String::new();
    for arg in &args[..main_index] {
        if arg.contains(['\r', '\n', '\0']) {
            return Err("JVM 参数含无效控制字符".into());
        }
        body.push('"');
        body.push_str(&arg.replace('\\', "\\\\").replace('"', "\\\""));
        body.push_str("\"\n");
    }
    let relative = format!("instances/{}/launch-jvm.args", instance.id);
    let bytes = match launcher_encoding(&body) {
        Ok(v) => v,
        Err(_)
            if args
                .iter()
                .map(|v| v.encode_utf16().count() + 3)
                .sum::<usize>()
                < 26000 =>
        {
            return Ok((args.to_vec(), None))
        }
        Err(e) => return Err(e),
    };
    model::write_file(root, &relative, &bytes)?;
    let path = model::safe_path(root, &relative)?;
    let mut result = vec![format!("@{}", path.to_string_lossy())];
    result.extend_from_slice(&args[main_index..]);
    Ok((result, Some(JvmArgumentFile { path })))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forge_processed_artifacts_are_checked_even_when_not_in_the_classpath() {
        let mut profile = json!({"mainClass":"cpw.mods.modlauncher.Launcher","libraries":[],"arguments":{"game":["--fml.mcVersion","1.16.5","--fml.forgeVersion","36.2.34","--fml.forgeGroup","net.minecraftforge","--fml.mcpVersion","20210115.111550"]}});
        let paths = companion_libraries(&profile).unwrap();
        assert_eq!(paths.len(), 4);
        assert_eq!(
            paths[0],
            "net/minecraftforge/forge/1.16.5-36.2.34/forge-1.16.5-36.2.34-universal.jar"
        );
        assert!(paths[3].ends_with("client-1.16.5-20210115.111550-extra.jar"));
        profile["arguments"]["game"][5] = json!("../escape");
        assert!(companion_libraries(&profile).is_err());
        assert!(
            companion_libraries(&json!({"mainClass":"net.minecraft.client.main.Main"}))
                .unwrap()
                .is_empty()
        );
        let neo = json!({"mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher","libraries":[],"arguments":{"game":["--fml.mcVersion","1.21.1","--fml.neoForgeVersion","21.1.139","--fml.neoFormVersion","20240808.144430"]}});
        let paths = companion_libraries(&neo).unwrap();
        assert_eq!(
            paths[2],
            "net/minecraft/client/1.21.1-20240808.144430/client-1.21.1-20240808.144430-srg.jar"
        );
    }
    #[test]
    fn forge_and_neoforge_inheritance_preserves_base_args_and_replaces_library_versions() {
        let base = json!({"id":"1.16.5","mainClass":"net.minecraft.client.main.Main","arguments":{"jvm":["-cp","${classpath}"],"game":["--gameDir","${game_directory}"]},"libraries":[{"name":"org.ow2.asm:asm:5.0"}],"javaVersion":{"majorVersion":8}});
        let forge = json!({"id":"Forge","mainClass":"cpw.mods.modlauncher.Launcher","arguments":{"jvm":["--add-opens=java.base/java.util.jar=ALL-UNNAMED"],"game":["--launchTarget","fmlclient","--fml.forgeVersion","36.2.34"]},"libraries":[{"name":"org.ow2.asm:asm:9.1"}]});
        let merged = merge(&[forge, base]).unwrap();
        assert_eq!(merged["libraries"].as_array().unwrap().len(), 1);
        assert_eq!(merged["libraries"][0]["name"], "org.ow2.asm:asm:9.1");
        assert_eq!(merged["arguments"]["jvm"].as_array().unwrap().len(), 3);
        assert_eq!(loader(&merged), ("forge".into(), "36.2.34".into()));
        assert_eq!(
            coordinate_path("cpw.mods:modlauncher:11.0.4@jar").unwrap(),
            "cpw/mods/modlauncher/11.0.4/modlauncher-11.0.4.jar"
        );
        assert!(coordinate_path("a:../outside:1").is_err());
        assert_eq!(
            loader(
                &json!({"libraries":[],"arguments":{"game":["--fml.neoForgeVersion","21.1.139"]}})
            ),
            ("neoforge".into(), "21.1.139".into())
        );
    }
    #[test]
    fn os_alternatives_do_not_replace_windows_lwjgl() {
        let profile = json!({"libraries":[
            {"name":"org.lwjgl.lwjgl:lwjgl:2.9.4", "rules":[{"action":"allow"},{"action":"disallow","os":{"name":"osx"}}]},
            {"name":"org.lwjgl.lwjgl:lwjgl:2.9.2", "rules":[{"action":"allow","os":{"name":"osx"}}]}
        ]});
        let merged = merge(&[profile]).unwrap();
        assert_eq!(merged["libraries"].as_array().unwrap().len(), 1);
        assert_eq!(
            merged["libraries"][0]["name"],
            "org.lwjgl.lwjgl:lwjgl:2.9.4"
        );
    }
}
