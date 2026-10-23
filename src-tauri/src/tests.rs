use crate::{auth, host, minecraft, model, net};
use serde_json::json;
use std::{collections::HashMap, fs, path::PathBuf};
fn root() -> PathBuf {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".native/tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    root
}
#[test]
fn automatic_memory_reserves_system_space_and_bounds_heap() {
    assert_eq!(crate::memory::recommend(8192, 6144), (4096, 1024));
    assert_eq!(crate::memory::recommend(32768, 8192), (4096, 4096));
    assert_eq!(crate::memory::recommend(8192, 256), (512, 1024));
    assert_eq!(crate::memory::recommend(131072, 120000), (16384, 4096));
    let status = crate::memory::status().unwrap();
    assert!(status.total_mb > 0 && status.available_mb <= status.total_mb);
    assert!(crate::memory::optimize().is_ok());
    assert!(!crate::memory::process_ids().unwrap().is_empty());
}
#[test]
fn fabric_coordinates_are_bounded_and_cannot_escape_cache() {
    assert_eq!(
        crate::fabric::maven_path("net.fabricmc:fabric-loader:0.16.14").unwrap(),
        "net/fabricmc/fabric-loader/0.16.14/fabric-loader-0.16.14.jar"
    );
    for name in [
        "../x:loader:1",
        "net.fabricmc:../bad:1",
        "x:y:../../evil",
        "x:y:z:classifier",
        "x:y:",
        "x..y:z:1",
    ] {
        assert!(crate::fabric::maven_path(name).is_err(), "{name}");
    }
}
fn pack_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(vec![]));
    for (name, bytes) in entries {
        writer
            .start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
#[test]
fn pack_preview_reads_real_index_and_rejects_traversal_conflicts_and_bad_hashes() {
    let manifest = json!({"formatVersion":1,"game":"minecraft","name":"测试包","versionId":"1","dependencies":{"minecraft":"1.21.1","fabric-loader":"0.16.14"},"files":[{"path":"mods/test.jar","hashes":{"sha1":"0".repeat(40),"sha512":"0".repeat(128)},"downloads":["https://cdn.modrinth.com/data/test.jar"],"fileSize":10}]});
    let bytes = serde_json::to_vec(&manifest).unwrap();
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".native/fixtures");
    fs::create_dir_all(&fixtures).unwrap();
    fs::write(
        fixtures.join("preview.mrpack"),
        pack_zip(&[
            ("modrinth.index.json", &bytes),
            ("overrides/config/example.json", b"{}"),
        ]),
    )
    .unwrap();
    let preview = crate::packs::preview(&pack_zip(&[
        ("modrinth.index.json", &bytes),
        ("overrides/config/example.json", b"{}"),
    ]))
    .unwrap();
    assert_eq!(preview.kind, "MRPACK");
    assert_eq!(preview.downloads, 1);
    assert!(preview.dependencies.contains(&"minecraft: 1.21.1".into()));
    assert!(crate::packs::preview(&pack_zip(&[("../escape.txt", b"x")])).is_err());
    assert!(
        crate::packs::preview(&pack_zip(&[("Mods/A.jar", b"x"), ("mods/a.jar", b"x")])).is_err()
    );
    let mut bad = manifest.clone();
    bad["files"][0]["hashes"]["sha1"] = json!("bad");
    assert!(crate::packs::preview(&pack_zip(&[(
        "modrinth.index.json",
        &serde_json::to_vec(&bad).unwrap()
    )]))
    .is_err());
    let mut bad = manifest;
    bad["files"][0]["downloads"] = json!(["https://cdn.modrinth.com.evil.test/file.jar"]);
    assert!(crate::packs::preview(&pack_zip(&[(
        "modrinth.index.json",
        &serde_json::to_vec(&bad).unwrap()
    )]))
    .is_err());
}
#[test]
fn rejects_path_traversal_and_windows_devices() {
    let root = root();
    for path in [
        "../saves",
        "a/../../b",
        "C:/x",
        "a\\..\\x",
        "/absolute",
        "NUL.txt",
        "lib/CON",
        "hello.",
        "hello ",
        "a:stream",
    ] {
        assert!(model::safe_path(&root, path).is_err(), "{path}");
    }
    assert!(model::safe_path(&root, "assets/objects/ab/abcdef").is_ok());
}
#[test]
fn official_origin_allowlist_rejects_redirect_targets_and_credentials() {
    for url in [
        "http://libraries.minecraft.net/x",
        "https://libraries.minecraft.net.evil.test/x",
        "https://user@libraries.minecraft.net/x",
        "https://libraries.minecraft.net:444/x",
        "file:///C:/x",
    ] {
        assert!(net::trusted_url(url).is_err());
    }
    assert!(net::trusted_url("https://resources.download.minecraft.net/ab/hash").is_ok());
}
#[test]
fn sha1_requires_content_match() {
    let file = root().join("blob");
    fs::write(&file, b"hello").unwrap();
    assert!(net::matches(&file, "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d", Some(5)).unwrap());
    assert!(!net::matches(&file, "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d", Some(6)).unwrap());
    assert!(!net::matches(&file, "0000000000000000000000000000000000000000", Some(5)).unwrap());
}
#[test]
fn resumes_only_at_confirmed_range_and_restarts_on_200() {
    assert_eq!(net::resume_offset(206, 5, Some("bytes 5-9/10")).unwrap(), 5);
    assert_eq!(net::resume_offset(200, 5, None).unwrap(), 0);
    assert!(net::resume_offset(206, 5, Some("bytes 0-9/10")).is_err());
    assert!(net::resume_offset(416, 5, None).is_err());
}
#[test]
fn platform_rules_respect_order_os_arch_and_features() {
    assert!(minecraft::allowed(None).unwrap());
    assert!(!minecraft::allowed(Some(&json!([]))).unwrap());
    assert!(minecraft::allowed(Some(
        &json!([{"action":"allow"},{"action":"disallow","os":{"name":"osx"}}])
    ))
    .unwrap());
    assert!(!minecraft::allowed(Some(&json!([{"action":"allow","os":{"arch":"x86"}}]))).unwrap());
    assert!(!minecraft::allowed(Some(
        &json!([{"action":"allow","features":{"is_demo_user":true}}])
    ))
    .unwrap());
}
#[test]
fn command_arguments_preserve_spaces_and_never_use_shell_splitting() {
    let values = json!(["--gameDir","${game_directory}",{"rules":[{"action":"allow","os":{"name":"windows"}}],"value":["-cp","${classpath}"]}]);
    let vars = HashMap::from([
        ("game_directory", "E:\\MC worlds\\我的世界".to_string()),
        ("classpath", "A B.jar;C.jar".to_string()),
    ]);
    assert_eq!(
        minecraft::arguments(&values, &vars).unwrap(),
        [
            "--gameDir",
            "E:\\MC worlds\\我的世界",
            "-cp",
            "A B.jar;C.jar"
        ]
    );
    assert!(minecraft::arguments(&json!(["${unknown}"]), &vars).is_err());
}
#[test]
fn java_detection_parses_real_property_format() {
    assert_eq!(
        minecraft::parse_java(
            "    java.specification.version = 21\n    sun.arch.data.model = 64\n"
        )
        .unwrap(),
        (21, true)
    );
    assert_eq!(
        minecraft::parse_java("java.specification.version = 1.8\nsun.arch.data.model = 32")
            .unwrap(),
        (8, false)
    );
    assert!(minecraft::parse_java("broken java").is_err());
}
#[test]
fn windows_dpapi_roundtrip_and_tamper_detection() {
    let original = b"test-refresh-token-not-a-real-credential";
    let encrypted = auth::protect(original, true).unwrap();
    assert_ne!(encrypted, original);
    assert_eq!(auth::protect(&encrypted, false).unwrap(), original);
    assert!(auth::protect(b"invalid blob", false).is_err());
}
#[test]
fn native_archive_extracts_only_dlls_into_its_owned_directory() {
    use std::io::Write;
    let root = root();
    let archive = root.join("native.jar");
    let mut writer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    writer.start_file("windows/test.dll", options).unwrap();
    writer.write_all(b"test-native-bytes").unwrap();
    writer.start_file("META-INF/LICENSE", options).unwrap();
    writer.write_all(b"test-license").unwrap();
    writer.finish().unwrap();
    minecraft::extract_natives(&[archive], &root, "instances/test/natives").unwrap();
    assert_eq!(
        fs::read(root.join("instances/test/natives/windows/test.dll")).unwrap(),
        b"test-native-bytes"
    );
    assert!(!root
        .join("instances/test/natives/META-INF/LICENSE")
        .exists());
}
#[test]
fn credentials_are_redacted_from_bounded_logs() {
    let line = model::redact(
        "access super-secret and super-secret",
        &["super-secret".to_string()],
    );
    assert!(!line.contains("super-secret"));
    assert!(line.contains("[REDACTED]"));
    assert_eq!(model::redact(&"x".repeat(10000), &[]).len(), 8192);
}
#[test]
fn atomic_save_preserves_invalid_source_on_read_failure() {
    let root = root();
    fs::write(root.join("settings.json"), b"{broken").unwrap();
    assert!(model::load_json::<model::Settings>(&root, "settings.json").is_err());
    assert_eq!(fs::read(root.join("settings.json")).unwrap(), b"{broken");
    model::save_json(&root, "test.json", &json!({"n":1})).unwrap();
    model::save_json(&root, "test.json", &json!({"n":2})).unwrap();
    assert!(fs::read_to_string(root.join("test.json"))
        .unwrap()
        .contains('2'));
}
#[test]
fn native_host_rejects_unsigned_launch_and_invalid_settings() {
    let host = host::Host::new(root()).unwrap();
    assert!(host
        .start_launch("anything".into())
        .unwrap_err()
        .contains("登录"));
    assert!(!auth::valid_client("not-a-client-id"));
    assert!(host.start_install("../x".into(), "name".into()).is_err());
}
#[test]
fn offline_identity_matches_java_and_validates_names() {
    let profile = model::offline_profile("Notch").unwrap();
    assert_eq!(profile.id, "b50ad385829d3141a2167e7d7539ba7f");
    assert_eq!(profile.name, "Notch");
    assert!(profile.xuid.is_empty());
    assert_ne!(model::offline_profile("notch").unwrap().id, profile.id);
    for name in [
        "",
        "ab",
        "12345678901234567",
        "玩家",
        "a b",
        "../x",
        "--user",
    ] {
        assert!(model::offline_profile(name).is_err(), "{name}");
    }
}
#[tokio::test]
async fn offline_settings_migrate_persist_and_do_not_claim_online_account() {
    let root = root();
    model::save_json(
        &root,
        "settings.json",
        &json!({"clientId":"", "javaPath":"", "memoryMb":2048}),
    )
    .unwrap();
    let host = host::Host::new(root.clone()).unwrap();
    assert!(!host.root.to_string_lossy().starts_with("\\\\?\\"));
    assert!(host.status().settings.launch_mode == model::LaunchMode::Microsoft);
    let mut settings = host.status().settings;
    settings.launch_mode = model::LaunchMode::Offline;
    assert!(host.save_settings(settings.clone()).await.is_err());
    settings.offline_name = "EasyPlayer".into();
    host.save_settings(settings).await.unwrap();
    assert!(host.status().account.is_none());
    assert!(host
        .start_launch("missing".into())
        .unwrap_err()
        .contains("本地实例不存在"));
    drop(host);
    let reopened = host::Host::new(root).unwrap();
    assert!(reopened.status().settings.launch_mode == model::LaunchMode::Offline);
    assert_eq!(reopened.status().settings.offline_name, "EasyPlayer");
    assert!(reopened.status().account.is_none());
}
#[test]
fn offline_and_microsoft_arguments_stay_distinct() {
    let host = host::Host::new(root()).unwrap();
    let prepared = minecraft::Prepared {
        metadata: json!({"mainClass":"net.minecraft.client.main.Main", "assetIndex":{"id":"17"},
            "arguments":{"jvm":["-cp","${classpath}"], "game":["--username","${auth_player_name}","--uuid","${auth_uuid}","--accessToken","${auth_access_token}","--userType","${user_type}","--clientId","${clientid}","--xuid","${auth_xuid}"]}}),
        classpath: vec![host.root.join("client.jar")],
        native_archives: vec![],
        java_major: 21,
    };
    let instance = model::Instance {
        id: "test".into(),
        name: "test".into(),
        version: "1.21.1".into(),
        manifest_sha1: "0".repeat(40),
        java_major: 21,
        fabric_version: String::new(),
        fabric_sha1: String::new(),
    };
    let mut settings = host.status().settings;
    settings.launch_mode = model::LaunchMode::Offline;
    settings.client_id = "online-app-must-not-leak".into();
    let profile = model::offline_profile("Notch").unwrap();
    let args =
        minecraft::command_args(&host, &instance, &prepared, &profile, "0", &settings).unwrap();
    assert!(args.windows(2).any(|pair| pair == ["--userType", "legacy"]));
    assert!(args.windows(2).any(|pair| pair == ["--accessToken", "0"]));
    assert!(!args.contains(&settings.client_id));
    assert!(!args.contains(&"--demo".into()));
    settings.launch_mode = model::LaunchMode::Microsoft;
    let args = minecraft::command_args(
        &host,
        &instance,
        &prepared,
        &profile,
        "test-online-token",
        &settings,
    )
    .unwrap();
    assert!(args.windows(2).any(|pair| pair == ["--userType", "msa"]));
    assert!(args.contains(&settings.client_id));
    assert!(args.contains(&"test-online-token".into()));
}
#[test]
fn data_directory_is_exclusive_and_unlocks_on_shutdown() {
    let root = root();
    let first = host::Host::new(root.clone()).unwrap();
    assert!(host::Host::new(root.clone())
        .err()
        .unwrap()
        .contains("另一个 Easy Craft"));
    drop(first);
    assert!(host::Host::new(root).is_ok());
}
#[tokio::test]
#[ignore = "Requires public Mojang network and workspace Java"]
async fn official_metadata_and_java_integration() {
    let host = host::Host::new(root()).unwrap();
    let versions = minecraft::versions(&host, &tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();
    assert!(versions.iter().any(|entry| entry.id == "1.21.1"));
    let java = minecraft::probe_java(&std::env::var("EASYCRAFT_JAVA").unwrap())
        .await
        .unwrap();
    assert_eq!(java.major, 21);
    assert!(java.is_64_bit);
    println!(
        "Official manifest {} releases; Java {} x64",
        versions.len(),
        java.major
    );
}
#[tokio::test]
#[ignore = "Downloads official 1.21.1 assets into .native/integration; never launches Minecraft"]
async fn official_install_integration() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".native/integration");
    let host = host::Host::new(root).unwrap();
    host.start_install("1.21.1".into(), "原版集成验证".into())
        .unwrap();
    let start = std::time::Instant::now();
    let mut last = String::new();
    loop {
        let status = host.status();
        let label = format!(
            "{} {}/{}",
            status.task.phase, status.task.completed, status.task.total
        );
        if label != last {
            println!("{label}");
            last = label;
        }
        if status.task.status != "running" {
            assert_eq!(status.task.status, "succeeded", "{}", status.task.message);
            assert!(status
                .instances
                .iter()
                .any(|entry| entry.version == "1.21.1"));
            break;
        }
        assert!(start.elapsed().as_secs() < 900, "Install timed out");
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    let instance = host.status().instances.last().unwrap().clone();
    let entry = model::Version {
        id: instance.version.clone(),
        sha1: instance.manifest_sha1.clone(),
        url: format!(
            "https://piston-meta.mojang.com/v1/packages/{}/{}.json",
            instance.manifest_sha1, instance.version
        ),
        kind: "release".into(),
    };
    let index: serde_json::Value =
        serde_json::from_slice(&fs::read(host.root.join("assets/indexes/17.json")).unwrap())
            .unwrap();
    let asset = index["objects"]
        .as_object()
        .unwrap()
        .values()
        .find(|value| {
            value["size"]
                .as_u64()
                .is_some_and(|size| size > 0 && size < 1024)
        })
        .unwrap();
    let hash = asset["hash"].as_str().unwrap();
    let size = asset["size"].as_u64().unwrap();
    let relative = format!("assets/objects/{}/{hash}", &hash[..2]);
    let file = model::safe_path(&host.root, &relative).unwrap();
    let partial = model::safe_path(&host.root, &format!("{relative}.part")).unwrap();
    fs::write(&file, vec![b'X'; size as usize]).unwrap();
    fs::write(&partial, vec![b'X'; size as usize]).unwrap();
    let prepared = minecraft::prepare(&host, &entry, &tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();
    assert!(net::matches(&file, hash, Some(size)).unwrap());
    let settings = host.status().settings;
    let profile = model::Profile {
        id: "0".repeat(32),
        name: "IntegrationFixture".into(),
        xuid: String::new(),
        skin_url: String::new(),
    };
    let args = minecraft::command_args(
        &host,
        &instance,
        &prepared,
        &profile,
        "fixture-token-not-used",
        &settings,
    )
    .unwrap();
    assert!(args.contains(&"net.minecraft.client.main.Main".into()));
    assert!(args.iter().all(|arg| !arg.contains("${")));
    assert_eq!(prepared.java_major, 21);
    println!("Official metadata arguments validated; corrupted cache and full-size partial repaired. No game process launched.");
}

#[tokio::test]
#[ignore = "Requires installed .native/integration assets; rejects all network through a closed local proxy"]
async fn cached_offline_preparation_integration() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".native/integration");
    let mut host = host::Host::new(root).unwrap();
    std::sync::Arc::get_mut(&mut host).unwrap().client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all("http://127.0.0.1:1").unwrap())
        .timeout(std::time::Duration::from_millis(100))
        .build()
        .unwrap();
    let instance = host
        .status()
        .instances
        .into_iter()
        .find(|item| item.version == "1.21.1")
        .expect("Run install integration first");
    let entry = model::Version {
        id: instance.version.clone(),
        sha1: instance.manifest_sha1.clone(),
        url: format!(
            "https://piston-meta.mojang.com/v1/packages/{}/{}.json",
            instance.manifest_sha1, instance.version
        ),
        kind: "release".into(),
    };
    let prepared = minecraft::prepare(&host, &entry, &tokio_util::sync::CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(prepared.java_major, 21);
    let mut settings = host.status().settings;
    settings.launch_mode = model::LaunchMode::Offline;
    settings.offline_name = "EC_OfflineTest".into();
    let profile = model::offline_profile(&settings.offline_name).unwrap();
    let args =
        minecraft::command_args(&host, &instance, &prepared, &profile, "0", &settings).unwrap();
    assert!(args.iter().all(|arg| !arg.contains("${")));
    println!("PASS: cached 1.21.1 resources verified and offline arguments prepared with all HTTP routed to an unavailable local proxy; no account needed.");
}

#[tokio::test]
#[ignore = "Downloads official Fabric 0.16.14 and verifies a new isolated 1.21.1 instance"]
async fn official_fabric_install_integration() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".native/integration");
    let host = host::Host::new(root).unwrap();
    host.start_install_fabric("1.21.1".into(), "Fabric 集成验证".into(), "0.16.14".into())
        .unwrap();
    let start = std::time::Instant::now();
    loop {
        let state = host.status();
        if state.task.status != "running" {
            assert_eq!(state.task.status, "succeeded", "{}", state.task.message);
            break;
        }
        assert!(start.elapsed().as_secs() < 900, "Fabric install timed out");
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    let instance = host.status().instances.last().unwrap().clone();
    assert_eq!(instance.fabric_version, "0.16.14");
    assert!(model::valid_sha1(&instance.fabric_sha1));
    let entry = model::Version {
        id: instance.version.clone(),
        sha1: instance.manifest_sha1.clone(),
        url: format!(
            "https://piston-meta.mojang.com/v1/packages/{}/{}.json",
            instance.manifest_sha1, instance.version
        ),
        kind: "release".into(),
    };
    let cancel = tokio_util::sync::CancellationToken::new();
    let mut prepared = minecraft::prepare(&host, &entry, &cancel).await.unwrap();
    crate::fabric::prepare(&host, &instance, &mut prepared, &cancel)
        .await
        .unwrap();
    assert_eq!(
        prepared.metadata["mainClass"],
        "net.fabricmc.loader.impl.launch.knot.KnotClient"
    );
    assert!(prepared
        .classpath
        .iter()
        .any(|path| path.to_string_lossy().contains("fabric-loader-0.16.14.jar")));
    println!(
        "PASS: real Fabric 0.16.14 installed and verified in isolated Minecraft 1.21.1 instance"
    );
}
