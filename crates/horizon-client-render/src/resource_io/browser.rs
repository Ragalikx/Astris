//! Local-development fetch adapter. Resource paths are fixed for the first port.
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

pub const RESOURCE_ROOT: &str = "resources";
pub const RESOURCE_BASE_URL: &str = "/resources/";

pub struct MountedSource;
impl horizon_client_core::lang::ResourceSource for MountedSource {
    fn read(&self, path: &str) -> Option<Vec<u8>> {
        super::read(format!("{RESOURCE_ROOT}/{path}")).ok()
    }
    fn namespaces(&self) -> Vec<String> {
        super::read_dir(format!("{RESOURCE_ROOT}/assets"))
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect()
    }
}

pub async fn mount_menu_resources() -> Result<(), wasm_bindgen::JsValue> {
    mount_bundle("menu").await
}
pub async fn mount_world_resources() -> Result<(), wasm_bindgen::JsValue> {
    mount_bundle("world").await
}
async fn mount_bundle(kind: &str) -> Result<(), wasm_bindgen::JsValue> {
    let started = web_time::Instant::now();
    log::info!("Browser resources: GET /{kind}-resources.bin");
    let window = web_sys::window().ok_or_else(|| wasm_bindgen::JsValue::from_str("no window"))?;
    let response: web_sys::Response = JsFuture::from(
        window.fetch_with_str(&format!("/{kind}-resources.bin")),
    )
    .await?
    .dyn_into()?;
    if !response.ok() {
        return Err(wasm_bindgen::JsValue::from_str(&format!(
            "menu resources: HTTP {}",
            response.status()
        )));
    }
    log::info!(
        "Browser resources: headers in {} ms; Content-Length={:?}; receiving body",
        started.elapsed().as_millis(),
        response.headers().get("Content-Length")?
    );
    let data = js_sys::Uint8Array::new(&JsFuture::from(response.array_buffer()?).await?);
    log::info!(
        "Browser resources: received {} bytes in {} ms; mounting immutable files",
        data.length(),
        started.elapsed().as_millis()
    );
    let mut at = 0u32;
    let mut count = 0u32;
    while at < data.length() {
        if data.length() - at < 8 {
            return Err(wasm_bindgen::JsValue::from_str("truncated resource header"));
        }
        let header = data.subarray(at, at + 8).to_vec();
        at += 8;
        let name_len = u32::from_le_bytes(header[..4].try_into().unwrap());
        let size = u32::from_le_bytes(header[4..].try_into().unwrap());
        let end = at
            .checked_add(name_len)
            .and_then(|v| v.checked_add(size))
            .filter(|&v| v <= data.length())
            .ok_or_else(|| wasm_bindgen::JsValue::from_str("truncated resource body"))?;
        let name = String::from_utf8(data.subarray(at, at + name_len).to_vec())
            .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?;
        at += name_len;
        let path = format!("{RESOURCE_ROOT}/{name}");
        if super::File::open(&path).is_err() {
            super::mounted::mount(path, data.subarray(at, end).to_vec())
                .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))?
        }
        at = end;
        count += 1;
        if count % 2048 == 0 {
            log::info!(
                "Browser resources: mounted {count} files; {at}/{} bundle bytes",
                data.length()
            );
        }
    }
    log::info!(
        "Browser resources: mounted {count} files in {} ms",
        started.elapsed().as_millis()
    );
    Ok(())
}

/// Fetch one prepared file and mount it under the path expected by original loaders.
/// This must finish before a synchronous decoder opens the resource.
pub async fn mount_resource(relative: &str) -> Result<(), wasm_bindgen::JsValue> {
    if relative.is_empty()
        || relative.split('/').any(|p| p.is_empty() || p == "..")
        || relative.contains(['\\', ':', '?', '#', '%'])
    {
        return Err(wasm_bindgen::JsValue::from_str(
            "invalid prepared resource path",
        ));
    }
    if super::File::open(format!("{RESOURCE_ROOT}/{relative}")).is_ok() {
        return Ok(());
    }
    let window = web_sys::window().ok_or_else(|| {
        wasm_bindgen::JsValue::from_str("resource fetch requires browser startup context")
    })?;
    let response =
        JsFuture::from(window.fetch_with_str(&format!("{RESOURCE_BASE_URL}{relative}"))).await?;
    let response: web_sys::Response = response.dyn_into()?;
    if !response.ok() {
        return Err(wasm_bindgen::JsValue::from_str(&format!(
            "resource {relative}: HTTP {}",
            response.status()
        )));
    }
    // Reject large responses before allocating the Rust copy where Content-Length is supplied.
    if response
        .headers()
        .get("Content-Length")?
        .and_then(|n| n.parse::<usize>().ok())
        .is_some_and(|n| n > 256 * 1024 * 1024)
    {
        return Err(wasm_bindgen::JsValue::from_str(
            "resource exceeds mount budget",
        ));
    }
    let buffer = JsFuture::from(response.array_buffer()?).await?;
    let bytes = js_sys::Uint8Array::new(&buffer).to_vec();
    super::mounted::mount(format!("{RESOURCE_ROOT}/{relative}"), bytes)
        .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
}

/// Mount the real registry inputs used by Assets::load, without copying a decoder.
pub async fn mount_registry_resources() -> Result<(), wasm_bindgen::JsValue> {
    for name in ["horizon-resources.json", "facts.json", "block-tags.json"] {
        mount_resource(name).await?;
    }
    Ok(())
}

/// Use Horizon's original registry/resource decoder after fetching its inputs.
pub async fn load_assets() -> Result<crate::assets::Assets, wasm_bindgen::JsValue> {
    mount_registry_resources().await?;
    crate::assets::Assets::load(std::path::Path::new(RESOURCE_ROOT))
        .map_err(|e| wasm_bindgen::JsValue::from_str(&e.to_string()))
}
