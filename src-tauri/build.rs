fn main() {
    println!("cargo:rerun-if-env-changed=EASYCRAFT_MICROSOFT_CLIENT_ID");
    if let Ok(id) = std::env::var("EASYCRAFT_MICROSOFT_CLIENT_ID") {
        assert!(
            id.is_empty()
                || (id.len() == 36
                    && id.bytes().enumerate().all(|(i, b)| {
                        if [8, 13, 18, 23].contains(&i) {
                            b == b'-'
                        } else {
                            b.is_ascii_hexdigit()
                        }
                    })),
            "EASYCRAFT_MICROSOFT_CLIENT_ID must be an application GUID, not a secret"
        );
    }
    tauri_build::build()
}
