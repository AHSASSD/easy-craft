use crate::model::{safe_path, write_file, Profile, Result};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const DEVICE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const SCOPE: &str = "XboxLive.signin offline_access";
#[derive(Serialize, Deserialize, Clone)]
pub struct Stored {
    pub client_id: String,
    refresh_token: String,
    pub profile: Profile,
}
pub struct Session {
    pub stored: Stored,
    pub access_token: String,
    expires: Instant,
}
pub struct Pending {
    device_code: String,
    pub user_code: String,
    pub interval: u64,
    expires: Instant,
    next: Instant,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub user_code: String,
    pub interval: u64,
    pub expires_in: u64,
}
impl Pending {
    pub fn public(&self) -> DeviceCode {
        DeviceCode {
            user_code: self.user_code.clone(),
            interval: self.interval,
            expires_in: self
                .expires
                .saturating_duration_since(Instant::now())
                .as_secs(),
        }
    }
}
pub fn valid_client(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok() && id.len() == 36
}
async fn response_json(response: reqwest::Response, cancel: &CancellationToken) -> Result<Value> {
    let mut stream = response.bytes_stream();
    let mut bytes = vec![];
    loop {
        let next = tokio::select! { _ = cancel.cancelled() => return Err("登录已取消".into()), next = stream.next() => next };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|_| "认证服务响应中断")?;
        if bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("认证响应大小异常".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "认证服务响应格式无效".into())
}
async fn request(
    client: &Client,
    url: &str,
    body: Value,
    bearer: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Value> {
    let mut request = client.post(url).json(&body);
    if let Some(token) = bearer {
        request = request.bearer_auth(token);
    }
    let response = tokio::select! { _ = cancel.cancelled() => return Err("登录已取消".into()), value = request.send() => value.map_err(|_| "认证服务连接失败，请重试")? };
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "认证服务 HTTP {}；请检查应用权限、Xbox 账户与 Minecraft API 访问许可",
            status.as_u16()
        ));
    }
    response_json(response, cancel).await
}
pub async fn begin(
    client: &Client,
    client_id: &str,
    cancel: &CancellationToken,
) -> Result<Pending> {
    if !valid_client(client_id) {
        return Err("请先配置 Easy Craft 自有应用的有效 Client ID".into());
    }
    let response = tokio::select! { _ = cancel.cancelled() => return Err("登录已取消".into()), value = client.post(DEVICE_URL).form(&[("client_id",client_id),("scope",SCOPE)]).send() => value.map_err(|_| "无法连接 Microsoft 设备授权服务")? };
    if !response.status().is_success() {
        return Err(
            "无法获取设备码；请确认 Client ID 支持个人 Microsoft 账户并启用公共客户端".into(),
        );
    }
    let value = response_json(response, cancel).await?;
    let interval = value["interval"].as_u64().unwrap_or(5).clamp(1, 60);
    let expires = value["expires_in"]
        .as_u64()
        .ok_or("设备码没有有效期")?
        .min(1800);
    Ok(Pending {
        device_code: value["device_code"].as_str().ok_or("设备码缺失")?.into(),
        user_code: value["user_code"].as_str().ok_or("用户码缺失")?.into(),
        interval,
        expires: Instant::now() + Duration::from_secs(expires),
        next: Instant::now() + Duration::from_secs(interval),
    })
}
pub async fn poll(
    client: &Client,
    client_id: &str,
    pending: &mut Pending,
    cancel: &CancellationToken,
) -> Result<Option<Session>> {
    if cancel.is_cancelled() {
        return Err("登录已取消".into());
    }
    if Instant::now() >= pending.expires {
        return Err("登录设备码已过期，请重新登录".into());
    }
    if Instant::now() < pending.next {
        return Ok(None);
    }
    pending.next = Instant::now() + Duration::from_secs(pending.interval);
    let response = tokio::select! { _ = cancel.cancelled() => return Err("登录已取消".into()), value = client.post(TOKEN_URL).form(&[("grant_type","urn:ietf:params:oauth:grant-type:device_code"),("client_id",client_id),("device_code",pending.device_code.as_str())]).send() => value.map_err(|_| "设备授权轮询连接失败，请重试登录")? };
    let status = response.status();
    let value = response_json(response, cancel).await?;
    if !status.is_success() {
        return match value["error"].as_str() {
            Some("authorization_pending") => Ok(None),
            Some("slow_down") => {
                pending.interval += 5;
                pending.next = Instant::now() + Duration::from_secs(pending.interval);
                Ok(None)
            }
            Some("authorization_declined") | Some("access_denied") => {
                Err("你已拒绝本次登录".into())
            }
            Some("expired_token") => Err("设备码已过期，请重新登录".into()),
            _ => Err("Microsoft 授权失败，请检查应用注册配置或重新登录".into()),
        };
    }
    exchange(client, client_id, value, cancel).await.map(Some)
}
async fn exchange(
    client: &Client,
    client_id: &str,
    oauth: Value,
    cancel: &CancellationToken,
) -> Result<Session> {
    let msa = oauth["access_token"]
        .as_str()
        .ok_or("Microsoft 访问令牌缺失")?;
    let xbox = request(client, "https://user.auth.xboxlive.com/user/authenticate", json!({"Properties":{"AuthMethod":"RPS","SiteName":"user.auth.xboxlive.com","RpsTicket":format!("d={msa}")},"RelyingParty":"http://auth.xboxlive.com","TokenType":"JWT"}), None, cancel).await?;
    let xbox_token = xbox["Token"].as_str().ok_or("Xbox 身份认证失败")?;
    let xsts = request(client, "https://xsts.auth.xboxlive.com/xsts/authorize", json!({"Properties":{"SandboxId":"RETAIL","UserTokens":[xbox_token]},"RelyingParty":"rp://api.minecraftservices.com/","TokenType":"JWT"}), None, cancel).await?;
    let xui = &xsts["DisplayClaims"]["xui"][0];
    let uhs = xui["uhs"].as_str().ok_or("Xbox 用户声明缺失")?;
    let xsts_token = xsts["Token"]
        .as_str()
        .ok_or("XSTS 认证失败，请检查 Xbox 家庭设置")?;
    let minecraft = request(
        client,
        "https://api.minecraftservices.com/authentication/login_with_xbox",
        json!({"identityToken":format!("XBL3.0 x={uhs};{xsts_token}")}),
        None,
        cancel,
    )
    .await?;
    let token = minecraft["access_token"]
        .as_str()
        .ok_or("Minecraft 访问令牌缺失")?;
    let response = tokio::select! { _ = cancel.cancelled() => return Err("登录已取消".into()), value = client.get("https://api.minecraftservices.com/entitlements/mcstore").bearer_auth(token).send() => value.map_err(|_| "无法验证 Minecraft Java 所有权")? };
    if !response.status().is_success() {
        return Err("Minecraft 所有权查询失败，请检查应用访问权限".into());
    }
    let entitlements = response_json(response, cancel).await?;
    if !entitlements["items"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            ["game_minecraft", "product_minecraft"]
                .contains(&item["name"].as_str().unwrap_or_default())
        })
    }) {
        return Err("该账户没有可验证的 Minecraft Java 使用权".into());
    }
    let response = tokio::select! { _ = cancel.cancelled() => return Err("登录已取消".into()), value = client.get("https://api.minecraftservices.com/minecraft/profile").bearer_auth(token).send() => value.map_err(|_| "无法获取 Minecraft 正版档案")? };
    if !response.status().is_success() {
        return Err("未找到可用的 Minecraft Java 正版档案，请确认购买状态与应用访问权限".into());
    }
    let profile = response_json(response, cancel).await?;
    let id = profile["id"]
        .as_str()
        .filter(|id| id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("Minecraft 档案 UUID 无效")?;
    let name = profile["name"]
        .as_str()
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 16
                && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        })
        .ok_or("Minecraft 玩家名称无效")?;
    let refresh_token = oauth["refresh_token"]
        .as_str()
        .ok_or("缺少刷新令牌，请重新授权 offline_access")?
        .to_owned();
    let expires = minecraft["expires_in"]
        .as_u64()
        .unwrap_or(3600)
        .clamp(60, 86400);
    Ok(Session {
        stored: Stored {
            client_id: client_id.into(),
            refresh_token,
            profile: Profile {
                id: id.into(),
                name: name.into(),
                xuid: xui["xid"].as_str().unwrap_or_default().into(),
                skin_url: profile["skins"]
                    .as_array()
                    .and_then(|skins| skins.iter().find(|skin| skin["state"] == "ACTIVE"))
                    .and_then(|skin| skin["url"].as_str())
                    .unwrap_or_default()
                    .into(),
            },
        },
        access_token: token.into(),
        expires: Instant::now() + Duration::from_secs(expires.saturating_sub(60)),
    })
}
pub async fn refresh(
    client: &Client,
    stored: &Stored,
    cancel: &CancellationToken,
) -> Result<Session> {
    let response = tokio::select! { _ = cancel.cancelled() => return Err("操作已取消".into()), value = client.post(TOKEN_URL).form(&[("grant_type","refresh_token"),("client_id",stored.client_id.as_str()),("refresh_token",stored.refresh_token.as_str()),("scope",SCOPE)]).send() => value.map_err(|_| "账户刷新连接失败")? };
    if !response.status().is_success() {
        return Err("账户凭据已失效，请重新进行 Microsoft 登录".into());
    }
    let mut value = response_json(response, cancel).await?;
    if value["refresh_token"].is_null() {
        value["refresh_token"] = Value::String(stored.refresh_token.clone());
    }
    exchange(client, &stored.client_id, value, cancel).await
}
impl Session {
    pub fn valid(&self) -> bool {
        Instant::now() < self.expires
    }
}
pub fn protect(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| "账户数据过大")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI binds credentials to the current Windows user; no secret enters the WebView.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("Windows 安全凭据操作失败；原始账户文件保留".into());
        }
        let result = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut _);
        Ok(result)
    }
}
pub fn save(root: &Path, account: &Stored) -> Result<()> {
    let bytes = serde_json::to_vec(account).map_err(|_| "无法序列化安全凭据")?;
    write_file(root, "account.dpapi", &protect(&bytes, true)?)
}
pub fn load(root: &Path) -> Result<Option<Stored>> {
    let path = safe_path(root, "account.dpapi")?;
    if !path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(path).map_err(|_| "无法读取安全账户文件")?;
    serde_json::from_slice(&protect(&bytes, false)?)
        .map(Some)
        .map_err(|_| "安全账户数据格式无效，原文件保留".into())
}
