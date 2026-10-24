use crate::model::{self, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{fs, io::Read, path::Path};

const MAX: usize = 10 * 1024 * 1024;
const FILE: &str = "appearance/background.png";

fn validate(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 33
        || bytes.len() > MAX
        || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || &bytes[12..16] != b"IHDR"
    {
        return Err("背景须为不超过 10 MiB 的 PNG 图片".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 16 * 1024 * 1024 {
        return Err("背景尺寸须在 1600 万像素以内".into());
    }
    Ok(())
}

pub fn background(root: &Path, replacement: Option<&[u8]>) -> Result<Option<String>> {
    let bytes = if let Some(bytes) = replacement {
        if !bytes.is_empty() {
            validate(bytes)?;
        }
        // Empty content is the persisted default, so reset uses the same atomic write.
        model::write_file(root, FILE, bytes)?;
        bytes.to_vec()
    } else {
        let path = model::safe_path(root, FILE)?;
        let mut bytes = Vec::new();
        match fs::File::open(path) {
            Ok(file) => {
                file.take(MAX as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "背景读取失败")?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("背景读取失败；原素材保留".into()),
        }
        bytes
    };
    if bytes.is_empty() {
        return Ok(None);
    }
    validate(&bytes)?;
    Ok(Some(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(bytes)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_persists_resets_and_preserves_old_file_on_invalid_input() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../.native/appearance-tests")
            .join(uuid::Uuid::new_v4().to_string());
        assert_eq!(background(&root, None).unwrap(), None);
        let mut png = vec![0; 33];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[12..16].copy_from_slice(b"IHDR");
        png[16..20].copy_from_slice(&1920u32.to_be_bytes());
        png[20..24].copy_from_slice(&1080u32.to_be_bytes());
        let host = crate::host::Host::new(root.clone()).unwrap();
        let saved = host.background(Some(png.clone())).unwrap();
        drop(host);
        let reopened = crate::host::Host::new(root.clone()).unwrap();
        assert_eq!(reopened.background(None).unwrap(), saved);
        drop(reopened);
        assert!(saved
            .as_ref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert_eq!(background(&root, None).unwrap(), saved);
        assert!(background(&root, Some(b"<svg/>")).is_err());
        png[16..20].copy_from_slice(&100_000u32.to_be_bytes());
        assert!(background(&root, Some(&png)).is_err());
        assert_eq!(background(&root, None).unwrap(), saved);
        assert!(background(&root, Some(&vec![0; MAX + 1])).is_err());
        assert_eq!(background(&root, Some(&[])).unwrap(), None);
        assert_eq!(background(&root, None).unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }
}
