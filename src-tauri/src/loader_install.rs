//! Fresh Forge/NeoForge clients through the exact verified official installer.
use crate::{
    host::Host,
    local_launch,
    model::{self, Result},
    net,
};
use serde_json::Value;
use std::{fs, io::Read, path::Path};
use tokio_util::sync::CancellationToken;

fn entry(installer: &Path, name: &str) -> Result<Value> {
    let file = fs::File::open(installer).map_err(|_| "安装器不可读")?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "安装器不是有效 JAR")?;
    let file = zip
        .by_name(name.trim_start_matches('/'))
        .map_err(|_| "安装器缺少版本清单")?;
    if file.size() > 8 * 1024 * 1024 {
        return Err("安装器版本清单过大".into());
    }
    serde_json::from_reader(file.take(8 * 1024 * 1024)).map_err(|_| "安装器版本清单无效".into())
}
pub async fn install(
    host: &Host,
    loader: &str,
    kind: &str,
    java: &str,
    base: &Value,
    cancel: &CancellationToken,
) -> Result<Value> {
    let game = base["id"]
        .as_str()
        .filter(|id| model::valid_id(id))
        .ok_or("原版元数据缺少有效游戏版本")?;
    if !model::valid_id(game)
        || !crate::forge::valid_loader(loader)
        || !["forge", "neoforge"].contains(&kind)
    {
        return Err("加载器或版本无效".into());
    }
    host.progress(
        "pack-loader",
        &format!("获取 {kind} {loader} 官方安装器"),
        0,
        1,
    );
    let installer = if kind == "forge" {
        crate::forge::download(host, game, loader, cancel).await?
    } else {
        let url = format!("https://maven.neoforged.net/releases/net/neoforged/neoforge/{loader}/neoforge-{loader}-installer.jar");
        let sha1 = net::neoforge_checksum(&host.client, &format!("{url}.sha1"), cancel).await?;
        net::neoforge_download(
            &host.client,
            &host.root,
            &net::Artifact {
                url,
                sha1,
                size: None,
                path: format!("downloads/neoforge/{loader}-installer.jar"),
            },
            cancel,
        )
        .await?
    };
    let manifest = entry(&installer, "install_profile.json")?;
    if manifest["minecraft"] != game {
        return Err("官方安装器目标 Minecraft 版本不符".into());
    }
    let profile = entry(
        &installer,
        manifest["json"]
            .as_str()
            .ok_or("安装器缺少版本 JSON 路径")?,
    )?;
    if profile["inheritsFrom"] != game {
        return Err("加载器继承版本不符".into());
    }
    let merged = local_launch::merge(&[profile.clone(), base.clone()])?;
    let stage = model::safe_path(
        &host.root,
        &format!("loader-install/{}", uuid::Uuid::new_v4()),
    )?;
    fs::create_dir_all(&stage).map_err(|_| "无法创建加载器安装暂存目录")?;
    model::write_file(&stage, "launcher_profiles.json", b"{\"profiles\":{}}")?;
    model::save_json(&stage, &format!("versions/{game}/{game}.json"), base)?;
    let client = model::safe_path(&host.root, &format!("versions/{game}/client.jar"))?;
    let to = model::safe_path(&stage, &format!("versions/{game}/{game}.jar"))?;
    fs::copy(client, to).map_err(|_| "无法准备已校验的原版客户端")?;
    // Runtime and processor downloads use the launcher's retry/hash pipeline.
    // The Java installer is responsible for its own bundled files and processors.
    let mut downloads = vec![];
    for source in [&manifest, &merged] {
        for lib in source["libraries"].as_array().ok_or("安装器缺少依赖列表")? {
            if !crate::minecraft::allowed(lib.get("rules"))? {
                continue;
            }
            let artifact = &lib["downloads"]["artifact"];
            if artifact["url"].as_str().is_some_and(|url| !url.is_empty()) {
                downloads.push(net::Artifact {
                    url: artifact["url"].as_str().unwrap().into(),
                    sha1: artifact["sha1"]
                        .as_str()
                        .ok_or("安装依赖缺少 SHA-1")?
                        .into(),
                    path: format!(
                        "libraries/{}",
                        artifact["path"].as_str().ok_or("安装依赖缺少路径")?
                    ),
                    size: artifact["size"].as_u64(),
                });
            }
        }
    }
    if downloads.len() > 3000 {
        return Err("加载器安装依赖过多".into());
    }
    for (index, artifact) in downloads.iter().enumerate() {
        if cancel.is_cancelled() {
            return Err("加载器安装已取消".into());
        }
        host.progress(
            "pack-loader-libraries",
            &format!("准备 {kind} 运行库与处理器依赖"),
            index,
            downloads.len(),
        );
        let from = model::safe_path(&host.root, &artifact.path)?;
        let to = model::safe_path(&stage, &artifact.path)?;
        if net::matches(&from, &artifact.sha1, artifact.size)? && !to.exists() {
            fs::create_dir_all(to.parent().ok_or("安装依赖路径无效")?)
                .map_err(|_| "无法创建安装依赖目录")?;
            fs::copy(from, &to).map_err(|_| "无法复用已校验的安装依赖")?;
        }
        net::installer_library_download(&host.client, &stage, artifact, cancel).await?;
    }
    host.progress(
        "pack-loader-processors",
        &format!("执行 {kind} 官方客户端处理器"),
        0,
        1,
    );
    let log_path = stage.join("installer-output.log");
    let log = fs::File::create(&log_path).map_err(|_| "无法创建加载器安装日志")?;
    host.log(&format!("{kind} 官方安装日志：{}", log_path.display()), &[]);
    let mut child = tokio::process::Command::new(java)
        .arg("-jar")
        .arg(&installer)
        .arg("--installClient")
        .arg(&stage)
        .current_dir(&stage)
        .stdout(log.try_clone().map_err(|_| "无法打开安装日志")?)
        .stderr(log)
        .kill_on_drop(true)
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|_| "无法执行官方加载器安装器")?;
    let status = tokio::select! {
        status = child.wait() => status.map_err(|_| "无法读取加载器安装结果")?,
        _ = cancel.cancelled() => { let _=child.kill().await; let _=child.wait().await; return Err("加载器安装已取消".into()); },
        _ = tokio::time::sleep(std::time::Duration::from_secs(900)) => { let _=child.kill().await; let _=child.wait().await; return Err(format!("加载器安装超时；日志：{}",log_path.display())); }
    };
    if !status.success() {
        return Err(format!(
            "{kind} 官方安装器失败；日志：{}",
            log_path.display()
        ));
    }
    let id = profile["id"]
        .as_str()
        .filter(|id| model::valid_id(id))
        .ok_or("加载器版本 ID 无效")?;
    let installed: Value = model::load_json(&stage, &format!("versions/{id}/{id}.json"))?;
    if installed != profile {
        return Err("安装器生成的版本配置与已校验的版本不一致".into());
    }
    let mut outputs = local_launch::companion_libraries(&merged)?;
    for lib in merged["libraries"].as_array().ok_or("加载器缺少运行库")? {
        if !crate::minecraft::allowed(lib.get("rules"))? {
            continue;
        }
        if let Some(relative) = lib["downloads"]["artifact"]["path"].as_str() {
            outputs.push(relative.to_string());
        } else if lib.get("downloads").is_none() {
            outputs.push(local_launch::coordinate_path(
                lib["name"].as_str().ok_or("库坐标缺失")?,
            )?);
        }
    }
    outputs.sort();
    outputs.dedup();
    for relative in outputs {
        if cancel.is_cancelled() {
            return Err("加载器安装已取消".into());
        }
        if let Some(artifact) = downloads
            .iter()
            .find(|artifact| artifact.path == format!("libraries/{relative}"))
        {
            if !net::reuse_installer_library(&host.root, artifact, &stage, cancel)? {
                return Err(format!("官方安装依赖在提交前发生变化：{relative}"));
            }
        } else {
            local_launch::commit_repaired_library(&stage, &host.root, &relative)?;
        }
    }
    host.progress(
        "pack-loader",
        &format!("{kind} {loader} 客户端安装完成"),
        1,
        1,
    );
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Explicit isolated catalogs produced by the native Forge/NeoForge installer tests; never launches Minecraft"]
    async fn installed_processor_loaders_prepare_real_launch_arguments() {
        let roots: Vec<std::path::PathBuf> = serde_json::from_str(
            &std::env::var("EASYCRAFT_PROCESSOR_TEST_ROOTS")
                .expect("explicit test catalogs required"),
        )
        .unwrap();
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".native")
            .canonicalize()
            .unwrap();
        for root in roots {
            assert!(root.canonicalize().unwrap().starts_with(&workspace));
            let host = Host::new(root.clone()).unwrap();
            let state = host.status();
            assert!(!state.instances.is_empty());
            let mut reports = vec![];
            for instance in &state.instances {
                assert!(instance
                    .local
                    .as_ref()
                    .is_some_and(|local| ["forge", "neoforge"].contains(&local.loader.as_str())));
                let prepared =
                    local_launch::prepare(&host, instance, &CancellationToken::new()).unwrap();
                assert!(prepared.classpath.iter().all(|file| file.is_file()));
                let args = crate::minecraft::command_args(
                    &host,
                    instance,
                    &prepared,
                    &model::offline_profile("PackTest").unwrap(),
                    "0",
                    &state.settings,
                )
                .unwrap();
                assert!(!args.iter().any(|arg| arg.contains("${")));
                let (command, _argument_file) =
                    local_launch::command_arguments(&host.root, instance, &args).unwrap();
                let java = local_launch::java_for(instance, &state.settings.java_path, &host.root)
                    .await
                    .unwrap();
                assert_eq!(java.major, instance.java_major);
                let report = host.mod_check(&instance.id, true).unwrap();
                assert!(report.issues.is_empty(), "{:?}", report.issues);
                reports.push(serde_json::json!({"name":instance.name,"game":instance.version,"loader":instance.local,"java":java.major,"classpathFiles":prepared.classpath.len(),"argumentCount":args.len(),"commandArgumentCount":command.len(),"gameDirectory":instance.game_path(&host.root).unwrap(),"modCheck":report}));
            }
            fs::write(
                root.join("launch-preparation-results.json"),
                serde_json::to_vec_pretty(&reports).unwrap(),
            )
            .unwrap();
            println!("Launch preparation passed: {}", root.display());
        }
    }
}
