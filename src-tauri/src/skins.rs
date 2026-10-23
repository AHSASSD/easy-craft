use crate::{
    host::Host,
    model::{self, LaunchMode, Result},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;

pub fn validate(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 33
        || bytes.len() > 2 * 1024 * 1024
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[12..16] != b"IHDR"
    {
        return Err("请选择小于 2 MB 的 PNG 玩家皮肤".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width != 64 || ![32, 64].contains(&height) {
        return Err("皮肤尺寸须为 64×64 或 64×32".into());
    }
    Ok(())
}
fn key(host: &Host) -> Result<(String, String)> {
    let state = host.status();
    if state.settings.launch_mode == LaunchMode::Offline {
        let profile = model::offline_profile(&state.settings.offline_name)?;
        Ok((format!("skins/offline-{}.png", profile.id), String::new()))
    } else {
        use sha1::{Digest, Sha1};
        let profile = state.account.ok_or("尚未选择玩家账户")?;
        if profile.id.len() != 32 || !profile.id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("账户 UUID 无效".into());
        }
        let hash: String = Sha1::digest(profile.skin_url.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        Ok((
            format!("skins/microsoft-{}-{hash}.png", profile.id),
            profile.skin_url,
        ))
    }
}
pub fn texture_url(value: &str) -> Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(value).map_err(|_| "皮肤地址无效")?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str() != Some("textures.minecraft.net")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || !url.path().starts_with("/texture/")
    {
        return Err("拒绝非 Minecraft 官方皮肤地址".into());
    }
    url.set_scheme("https")
        .map_err(|_| "无法使用 HTTPS 皮肤地址")?;
    Ok(url)
}
pub async fn avatar(host: &Host) -> Result<Option<String>> {
    let (key, url) = match key(host) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let path = model::safe_path(&host.root, &key)?;
    let mut cached = None;
    if path.is_file()
        && std::fs::metadata(&path)
            .map_err(|_| "无法读取皮肤缓存")?
            .len()
            <= 2 * 1024 * 1024
    {
        let bytes = std::fs::read(&path).map_err(|_| "皮肤缓存读取失败")?;
        if validate(&bytes).is_ok() {
            cached = Some(bytes);
        }
    }
    if cached.is_none() && !url.is_empty() {
        let response = host
            .client
            .get(texture_url(&url)?)
            .send()
            .await
            .map_err(|_| "暂时无法下载玩家皮肤")?;
        if !response.status().is_success() {
            return Err("玩家皮肤下载失败".into());
        }
        let mut stream = response.bytes_stream();
        let mut bytes = vec![];
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| "皮肤接收中断")?;
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err("皮肤文件过大".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        validate(&bytes)?;
        model::write_file(&host.root, &key, &bytes)?;
        cached = Some(bytes);
    }
    Ok(cached.map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes))))
}
pub fn save(host: &Host, bytes: &[u8]) -> Result<()> {
    if host.status().settings.launch_mode != LaunchMode::Offline {
        return Err("正版头像自动使用账户皮肤，请在 Minecraft 官方档案更换皮肤".into());
    }
    validate(bytes)?;
    let (key, _) = key(host)?;
    model::write_file(&host.root, &key, bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn skin_validation_rejects_other_origins_formats_and_sizes() {
        assert!(texture_url("http://textures.minecraft.net/texture/example")
            .unwrap()
            .as_str()
            .starts_with("https://"));
        for value in [
            "https://evil.test/texture/x",
            "https://textures.minecraft.net.evil.test/texture/x",
            "file:///skin.png",
            "https://user@textures.minecraft.net/texture/x",
        ] {
            assert!(texture_url(value).is_err());
        }
        assert!(validate(b"<svg/>").is_err());
        let mut png = vec![0u8; 33];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&64u32.to_be_bytes());
        png[20..24].copy_from_slice(&64u32.to_be_bytes());
        assert!(validate(&png).is_ok());
        png[16..20].copy_from_slice(&128u32.to_be_bytes());
        assert!(validate(&png).is_err());
    }
}
