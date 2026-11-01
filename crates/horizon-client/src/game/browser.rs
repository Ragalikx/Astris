//! Browser lifecycle adapter around the original loading screen and menu handlers.
use super::*;
use std::{cell::RefCell, rc::Rc};
use winit::platform::web::{
    ActiveEventLoopExtWebSys, EventLoopExtWebSys, PollStrategy, WindowAttributesExtWebSys,
};

#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    /// Number of session entries the host page read from the Origin Private File System.
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonSessionFileCount)]
    fn session_file_count_js() -> u32;
    /// The session path of entry `i`.
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonSessionFileName)]
    fn session_file_name_js(i: u32) -> Option<String>;
    /// The bytes of entry `i` (`None` for a folder); the host drops its copy.
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonSessionFileTake)]
    fn session_file_take_js(i: u32) -> Option<Vec<u8>>;
    /// The size of entry `i` when the host kept only its size (a region file, read back
    /// from the store when used), else -1.
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonSessionFileStored)]
    fn session_file_stored_js(i: u32) -> f64;
    /// Legacy IndexedDB session snapshot, offered only while the file store is still empty.
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonTakeSession)]
    fn take_session_js() -> Option<Vec<u8>>;
    /// Lightweight settings snapshot loaded from IndexedDB (applied after the base session).
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonTakeSessionSettings)]
    fn take_session_settings_js() -> Option<Vec<u8>>;
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonStage)]
    fn stage_js(message: &str);
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonFrame)]
    fn frame_js();
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonNotice)]
    fn notice_js(message: &str);
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonFailure)]
    fn failure_js(message: &str);
    /// The player quit the game: the page persists the session and returns to the launcher.
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonExit)]
    fn exit_js();
    /// The launcher's "limit FPS to the monitor's refresh rate" (on unless turned off).
    #[wasm_bindgen(js_namespace = globalThis, js_name = horizonFrameCap)]
    fn frame_cap_js() -> bool;
}

struct BrowserLogger;
static LOGGER: BrowserLogger = BrowserLogger;
static GPU_FAILED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PLAYING_UNPAUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static CURRENT_WORKERS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(2);
static PENDING_WORKERS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
/// A WebRTC connection the page dialed (`horizon_peer_join`), for the game to join.
static PENDING_PEER_JOIN: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
impl log::Log for BrowserLogger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::Level::Info
    }
    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = format!(
            "{} [{}:{}]: {}",
            record.target(),
            record.file().unwrap_or("?"),
            record.line().unwrap_or(0),
            record.args()
        );
        if record.level() == log::Level::Error && line.contains("WebGPU validation") {
            if GPU_FAILED.swap(true, Ordering::Relaxed)
                && !line.contains("Error while parsing WGSL")
            {
                return;
            }
            failure(&line);
        }
        match record.level() {
            log::Level::Error => web_sys::console::error_1(&line.into()),
            log::Level::Warn => web_sys::console::warn_1(&line.into()),
            _ => web_sys::console::info_1(&line.into()),
        }
    }
    fn flush(&self) {}
}

pub fn status(message: &str) {
    stage_js(message);
}
pub fn failure(message: &str) {
    failure_js(message);
}

type Initialization = (UiResources, Result<Renderer>);
type Handoff = Result<Option<Game<'static>>>;
struct BrowserHost {
    loading: Option<Box<Loading>>,
    game: Option<Box<Game<'static>>>,
    initialization: Rc<RefCell<Option<Initialization>>>,
    handoff: Rc<RefCell<Option<Handoff>>>,
    next_frame: Instant,
    drew_in_cycle: bool,
    in_poll_redraw: bool,
    polled_since_raf: u32,
    /// Frames only on requestAnimationFrame, VSync or not (the launcher's setting).
    display_cap: bool,
}
impl ApplicationHandler for BrowserHost {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        event_loop.set_poll_strategy(PollStrategy::Scheduler);
        let Some(loading) = &mut self.loading else {
            return;
        };
        if loading.window.is_some() {
            return;
        }
        // The page stretches the canvas over the viewport (play.css); start at that size so
        // the first surface is not 1x1, then winit's ResizeObserver reports every change.
        let viewport = web_sys::window()
            .and_then(|w| Some((w.inner_width().ok()?.as_f64()?, w.inner_height().ok()?.as_f64()?)))
            .unwrap_or((1280., 720.));
        let window = match event_loop.create_window(
            Window::default_attributes()
                .with_title("Horizon")
                .with_inner_size(winit::dpi::LogicalSize::new(viewport.0, viewport.1))
                .with_append(true),
        ) {
            Ok(window) => Arc::new(window),
            Err(e) => {
                failure(&e.to_string());
                event_loop.exit();
                return;
            }
        };
        loading.window = Some(window.clone());
        let Some(gui) = loading.gui.take() else {
            return;
        };
        let output = self.initialization.clone();
        wasm_bindgen_futures::spawn_local(async move {
            let wake = window.clone();
            status("Creating the Astris renderer (WebGPU)…");
            let renderer = loading_renderer_async(
                window,
                false,
                Some(&gui),
                None,
                horizon_client::graphics::GraphicsApi::Auto,
            )
            .await;
            *output.borrow_mut() = Some((gui, renderer));
            wake.request_redraw();
        });
    }
    fn window_event(&mut self, events: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
        if GPU_FAILED.load(Ordering::Relaxed) {
            return;
        }
        let redraw = matches!(event, WindowEvent::RedrawRequested);
        if redraw {
            self.drew_in_cycle = true;
            if self.in_poll_redraw {
                self.polled_since_raf = self.polled_since_raf.saturating_add(1);
            } else {
                self.polled_since_raf = 0;
            }
        }
        if let Some(game) = &mut self.game {
            if redraw {
                let now = Instant::now();
                let limit = game.framerate_limit();
                // When VSync is on and the cap is at or above a high-refresh rate (120+ Hz),
                // let requestAnimationFrame pace directly to avoid beat-frequency frame drops.
                let software_cap =
                    limit > 0 && limit < 260 && (!game.settings.vsync || limit < 120);
                if software_cap {
                    if now + Duration::from_micros(600) < self.next_frame {
                        self.drew_in_cycle = false;
                        return;
                    }
                    let interval = Duration::from_secs_f64(1.0 / limit as f64);
                    self.next_frame = if now.saturating_duration_since(self.next_frame) > interval {
                        now + interval
                    } else {
                        self.next_frame + interval
                    };
                }
            }
            game.window_event(events, id, event);
            if let Some(error) = &game.error {
                failure(&format!("Game event: {error}"));
            }
            if redraw {
                frame_js();
            }
            return;
        }
        let Some(loading) = &mut self.loading else {
            return;
        };
        if loading.renderer.is_some() {
            let shown = loading.shown;
            loading.window_event(events, id, event);
            // Raw network connections are outside this browser port's scope.
            if matches!(loading.menu.pending, Some(PendingWorldEntry::Server { .. })) {
                loading.menu.pending = None;
                notice_js("Multiplayer is off in the browser version.");
            }
            if redraw && loading.error.is_none() {
                frame_js();
                if !shown && loading.shown {
                    status("Menu ready; the game’s resources are loading in the background…");
                }
            }
        }
    }
    fn exiting(&mut self, _: &ActiveEventLoop) {
        // Quit Game and failures both end here; the page keeps a failure on screen.
        exit_js();
    }
    fn device_event(&mut self, events: &ActiveEventLoop, id: DeviceId, event: DeviceEvent) {
        if let Some(game) = &mut self.game {
            game.device_event(events, id, event);
        }
    }
    fn about_to_wait(&mut self, events: &ActiveEventLoop) {
        if GPU_FAILED.load(Ordering::Relaxed) {
            events.set_control_flow(ControlFlow::Wait);
            return;
        }
        if let Some(result) = self.handoff.borrow_mut().take() {
            match result {
                Ok(Some(game)) => {
                    self.game = Some(Box::new(game));
                    status("The game is ready: a world can be created or opened.");
                }
                Ok(None) => events.exit(),
                Err(e) => {
                    failure(&format!("Game handoff: {e}"));
                    events.exit();
                }
            }
        }
        if let Some(game) = &mut self.game {
            let join = PENDING_PEER_JOIN.swap(0, Ordering::Relaxed);
            if join != 0 {
                if game.title.is_some() {
                    let name = game.options.player_name();
                    let address = format!("{}{join}", horizon_client::peer::PREFIX);
                    if let Err(e) = game.connect_server(&address, &name) {
                        log::warn!("Horizon: could not join over WebRTC: {e}");
                        horizon_client::peer::close(join);
                    }
                } else {
                    notice_js("Leave the world first to join another one.");
                    horizon_client::peer::close(join);
                }
            }
            let pending_workers = PENDING_WORKERS.swap(0, Ordering::Relaxed);
            if pending_workers > 0 {
                game.settings.horizon.workers = pending_workers.clamp(1, 8);
                game.settings.save(&Game::options_path());
                game.apply_settings();
            }
            CURRENT_WORKERS.store(
                game.settings.horizon.worker_threads() as u32,
                Ordering::Relaxed,
            );
            PLAYING_UNPAUSED.store(
                game.title.is_none() && !game.pause && game.screen == Screen::Playing,
                Ordering::Relaxed,
            );
            let drew = std::mem::replace(&mut self.drew_in_cycle, false);
            game.about_to_wait(events);
            if let Some(error) = &game.error {
                failure(&format!("Game tick: {error}"));
            }
            // The browser shows one frame per display refresh: with VSync off the game
            // also draws up to two more between refreshes (about 3x the monitor's rate),
            // which the browser throws away. The launcher's display cap leaves those out,
            // for a third of the GPU and CPU work; a lower Max Framerate still applies.
            if game.settings.vsync || self.display_cap {
                events.set_control_flow(ControlFlow::Wait);
            } else {
                let streaming_busy = game.title.is_none()
                    && (game.streaming.busy() || !game.pending_uploads.is_empty());
                if streaming_busy || self.polled_since_raf >= 2 {
                    events.set_control_flow(ControlFlow::Wait);
                } else {
                    let limit = game.framerate_limit();
                    let now = Instant::now();
                    let ready = limit <= 0
                        || limit >= 260
                        || now + Duration::from_micros(150) >= self.next_frame;
                    if !drew && ready {
                        if let Some(window) = game.window.clone() {
                            self.in_poll_redraw = true;
                            self.window_event(events, window.id(), WindowEvent::RedrawRequested);
                            self.in_poll_redraw = false;
                            self.drew_in_cycle = false;
                        }
                    }
                    if self.polled_since_raf >= 2 {
                        events.set_control_flow(ControlFlow::Wait);
                    } else if limit > 0 && limit < 260 {
                        let after = Instant::now();
                        if self.next_frame > after + Duration::from_millis(5) {
                            events.set_control_flow(ControlFlow::WaitUntil(
                                self.next_frame - Duration::from_millis(4),
                            ));
                        } else {
                            events.set_control_flow(ControlFlow::Poll);
                        }
                    } else {
                        events.set_control_flow(ControlFlow::Poll);
                    }
                }
            }
            return;
        }
        PLAYING_UNPAUSED.store(false, Ordering::Relaxed);
        let Some(loading) = &mut self.loading else {
            events.set_control_flow(ControlFlow::Wait);
            return;
        };
        let pending_workers = PENDING_WORKERS.swap(0, Ordering::Relaxed);
        if pending_workers > 0 {
            loading.settings.horizon.workers = pending_workers.clamp(1, 8);
            loading.settings.save(&Game::options_path());
        }
        CURRENT_WORKERS.store(
            loading.settings.horizon.worker_threads() as u32,
            Ordering::Relaxed,
        );
        if let Some((gui, renderer)) = self.initialization.borrow_mut().take() {
            loading.gui = Some(gui);
            match renderer {
                Ok(renderer) => {
                    loading.renderer = Some(renderer);
                    loading.apply_menu_settings();
                }
                Err(e) => {
                    failure(&format!("Renderer: {e}"));
                    events.exit();
                    return;
                }
            }
        }
        if loading.renderer.is_some() {
            loading.about_to_wait(events);
        }
        if let Some(error) = &loading.error {
            failure(&error.to_string());
            events.exit();
            return;
        }
        let loaded = if loading.renderer.is_some() {
            loading.loaded.take()
        } else {
            None
        };
        match loaded {
            Some(Ok(loaded)) => {
                let mut loading = self.loading.take().unwrap();
                let output = self.handoff.clone();
                let wake = loading.window.clone();
                status("Resources ready; starting the game…");
                wasm_bindgen_futures::spawn_local(async move {
                    *output.borrow_mut() = Some(loading.finish_async(loaded).await);
                    if let Some(window) = wake {
                        window.request_redraw();
                    }
                });
            }
            Some(Err(error)) => {
                failure(&format!("Resource Worker: {error}"));
                events.exit();
            }
            None => {}
        }
        events.set_control_flow(ControlFlow::Wait);
    }
}
/// The 64-bit (memory64) build loads its own bindings, so its Workers use a matching script.
/// Relative to the page, so the game runs on whatever origin serves it.
#[cfg(target_pointer_width = "64")]
const WORKER_SCRIPT: &str = "./rust-worker64.js";
#[cfg(not(target_pointer_width = "64"))]
const WORKER_SCRIPT: &str = "./rust-worker.js";

/// Moves the files the host read from its store into the session, one at a time, so
/// the page's copy of each is released as soon as Rust has its own.
fn restore_session_files() {
    horizon_core::session_io::set_main_thread();
    let (mut count, mut bytes, mut stored) = (0usize, 0usize, 0usize);
    for i in 0..session_file_count_js() {
        let Some(name) = session_file_name_js(i) else {
            continue;
        };
        let size = session_file_stored_js(i);
        if size >= 0.0 {
            stored += 1;
            if let Err(e) = horizon_core::session_io::put_stored(&name, size as usize) {
                log::warn!("Stored session file {name} skipped: {e}");
            }
            continue;
        }
        let result = match session_file_take_js(i) {
            None => horizon_core::session_io::put_dir(&name),
            Some(data) => {
                bytes += data.len();
                count += 1;
                horizon_core::session_io::put_file(&name, data)
            }
        };
        if let Err(e) = result {
            log::warn!("Stored session file {name} skipped: {e}");
        }
    }
    log::info!(
        "Restored {count} session files ({} MiB) from OPFS; {stored} region files read when used",
        bytes >> 20
    );
}

pub async fn start() -> Result<()> {
    horizon_threads::thread::Builder::new()
        .worker_script_url(WORKER_SCRIPT.into())
        .set_default();
    let _ = log::set_logger(&LOGGER);
    log::set_max_level(log::LevelFilter::Info);
    restore_session_files();
    if let Some(blob) = take_session_js() {
        match horizon_core::session_io::restore(&blob) {
            Ok(()) => log::info!("Restored {} MiB of saved session files", blob.len() >> 20),
            Err(e) => log::warn!("Saved session ignored: {e}"),
        }
    }
    if let Some(blob) = take_session_settings_js() {
        match horizon_core::session_io::restore(&blob) {
            Ok(()) => log::info!("Restored {} KiB of saved settings files", blob.len() >> 10),
            Err(e) => log::warn!("Saved settings ignored: {e}"),
        }
    }
    let player_dir = horizon_core::resource_io::current_dir().unwrap_or_default();
    let player_name = horizon_client::offline_name::browser_name(&player_dir);
    log::info!("Browser offline player profile ready: {player_name}");
    status("Loading the menu’s resources from this computer…");
    horizon_client::resource_io::browser::mount_menu_resources()
        .await
        .map_err(|e| format!("fetch: {e:?}"))?;
    log::info!("Browser resource mount complete");
    let root = PathBuf::from("resources");
    status("Building the interface and fonts…");
    let gui = UiResources::load(&root, &root)?;
    log::info!(
        "Browser HUD atlas: {}x{}, {} sprites",
        gui.atlas.width,
        gui.atlas.height,
        gui.atlas.sprites.len()
    );
    status("Creating the menu screens and loading the language…");
    let options = Options::parse(["--resources", "resources"].into_iter().map(String::from))?
        .ok_or("missing browser options")?;
    let options_path = player_dir.join("options.txt");
    let has_options = horizon_core::session_io::exists(&options_path);
    let has_graphics =
        horizon_core::session_io::exists(&player_dir.join(horizon_client::graphics::FILE));
    let mut settings = Settings::load(&options_path);
    if !has_graphics {
        // The machine's default (`worker_threads`); a choice made in the game or the
        // launcher replaces it.
        settings.horizon.workers = 0;
    } else {
        settings.horizon.workers = settings.horizon.worker_threads() as u32;
    }
    CURRENT_WORKERS.store(settings.horizon.worker_threads() as u32, Ordering::Relaxed);
    if !has_options {
        settings.render_distance = 5;
        settings.simulation_distance = 5;
    }
    let mut menu = startup_menu::StartupMenu::new(&options, None)?;
    menu.set_root(root.clone(), &settings);
    horizon_client::lang::set(horizon_client::lang::Language::load(
        &[&horizon_client::resource_io::browser::MountedSource],
        &settings.language,
    ));
    let (sender, receiver) = std::sync::mpsc::channel();
    let started = Instant::now();
    let progress = Progress::new();
    let worker_progress = progress.clone();
    let worker_settings = settings.clone();
    wasm_bindgen_futures::spawn_local(async move {
        match horizon_client::resource_io::browser::mount_world_resources().await {
            Ok(()) => {
                log::info!("Browser: starting original load_resources on resource-loader Worker");
                let result = horizon_threads::thread::Builder::new()
                    .name("resource-loader".into())
                    .spawn(move || {
                        let root = PathBuf::from("resources");
                        let result = load_resources(
                            root.clone(),
                            &root,
                            &worker_settings,
                            started,
                            true,
                            false,
                            &worker_progress,
                            &mut |_, _| {},
                        )
                        .map_err(|e| e.to_string());
                        let _ = sender.send(LoaderMsg::Done(result));
                    });
                if let Err(error) = result {
                    failure(&format!("Spawn resource-loader: {error}"));
                }
            }
            Err(error) => {
                let _ = sender.send(LoaderMsg::Done(Err(format!(
                    "World resource fetch: {error:?}"
                ))));
            }
        }
    });
    let loading = Loading {
        window: None,
        renderer: None,
        gui: Some(gui),
        settings,
        fullscreen: horizon_client::window::FullscreenState::new(false),
        options: Some(options),
        vanilla_root: root,
        pack_error: None,
        started,
        panorama_rotation: Default::default(),
        progress,
        receiver,
        loaded: None,
        delivered: false,
        handle: None,
        shown: false,
        menu,
        error: None,
    };
    status("Creating the game window…");
    EventLoop::new()?.spawn_app(BrowserHost {
        loading: Some(Box::new(loading)),
        game: None,
        handoff: Rc::new(RefCell::new(None)),
        next_frame: Instant::now(),
        drew_in_cycle: false,
        in_poll_redraw: false,
        polled_since_raf: 0,
        display_cap: frame_cap_js(),
        initialization: Rc::new(RefCell::new(None)),
    });
    Ok(())
}

/// Revision counter of the in-memory session files; the host persists when it changes.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_revision() -> f64 {
    horizon_core::session_io::revision() as f64
}

/// Revision counter of non-world files (`options.txt`, `horizon-graphics.txt`, packs).
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_settings_revision() -> f64 {
    horizon_core::session_io::settings_revision() as f64
}

/// Revision counter of world save files (`saves/*`).
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_world_revision() -> f64 {
    horizon_core::session_io::world_revision() as f64
}

/// Up to about `budget` bytes of session changes for the host to apply to OPFS
/// (format: `horizon_core::session_io::drain`).
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_drain(budget: u32) -> Vec<u8> {
    horizon_core::session_io::drain(budget as usize)
}

/// The number of the batch [`horizon_session_drain`] last returned.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_drained() -> f64 {
    horizon_core::session_io::drained() as f64
}

/// The host stored every batch up to `seq`: region files it holds may leave memory.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_applied(seq: f64) {
    horizon_core::session_io::applied(seq as u64);
}

/// The host failed to store a batch: every file stays in memory from now on.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_store_failed() {
    horizon_core::session_io::store_failed();
}

/// Bytes of session files in memory.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_resident() -> f64 {
    horizon_core::session_io::resident_bytes() as f64
}

/// Where the requests to read a file back are, in the module's memory: the host's file
/// Worker answers them (opfs-worker.js).
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_read_channel() -> f64 {
    horizon_core::session_io::read_channel() as f64
}

/// True when [`horizon_session_drain`] has changes to hand over.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_pending() -> bool {
    horizon_core::session_io::pending()
}

/// Serialised session files (worlds, options), for exporting everything at once.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_snapshot() -> Vec<u8> {
    horizon_core::session_io::snapshot()
}

/// Serialised non-world files (`options.txt`, `horizon-graphics.txt`, packs) for fast settings persistence.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_session_settings_snapshot() -> Vec<u8> {
    horizon_core::session_io::settings_snapshot()
}

/// True while the player is actively in an unpaused world (`Screen::Playing`).
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_is_playing_unpaused() -> bool {
    PLAYING_UNPAUSED.load(Ordering::Relaxed)
}

/// Current worker thread count (`1..=8`).
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_get_workers() -> u32 {
    CURRENT_WORKERS.load(Ordering::Relaxed).clamp(1, 8)
}

// ---- Playing together over WebRTC (horizon_client::peer); the page carries the data
// channels (peer.js) and moves their bytes with these. ----

/// Whether the open world takes guests (Open to LAN, in a browser).
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_peer_hosting() -> bool {
    horizon_client::peer::hosting()
}

/// A guest's data channel opened: its connection id, or 0 when no world is open to guests.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_peer_accept() -> u32 {
    horizon_client::peer::accept().unwrap_or(0)
}

/// This page's data channel to a host opened: the connection id to join with.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_peer_dial() -> u32 {
    horizon_client::peer::dial()
}

/// Join the host behind a dialed connection, from the title screen.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_peer_join(id: u32) {
    PENDING_PEER_JOIN.store(id, Ordering::Relaxed);
}

/// Bytes from the data channel; false once the connection closed.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_peer_push(id: u32, data: &[u8]) -> bool {
    horizon_client::peer::push(id, data)
}

/// Up to `max` bytes for the data channel (maybe none), or nothing once the connection
/// closed with nothing left.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_peer_take(id: u32, max: u32) -> Option<Vec<u8>> {
    let (bytes, closed) = horizon_client::peer::take(id, max as usize);
    (!closed || !bytes.is_empty()).then_some(bytes)
}

/// The data channel closed.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_peer_close(id: u32) {
    horizon_client::peer::close(id);
}

/// Updates the worker thread count (`1..=8`) live from the host UI.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_set_workers(workers: u32) {
    let w = workers.clamp(1, 8);
    CURRENT_WORKERS.store(w, Ordering::Relaxed);
    PENDING_WORKERS.store(w, Ordering::Relaxed);
}

/// Stores a file the player picked in the page (resource pack, shader pack) in the
/// folder the game scans for it. The browser has no file manager, so this is the install step.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_import_file(kind: &str, name: &str, bytes: &[u8]) -> std::result::Result<(), String> {
    let folder = match kind {
        "resourcepack" => "resourcepacks",
        "shaderpack" => "shaderpacks",
        other => return Err(format!("unknown import kind: {other}")),
    };
    // A bare file name: no folders, no way out of the target directory.
    let name = name.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    if name.is_empty() || name == "." || name == ".." {
        return Err("invalid file name".into());
    }
    horizon_core::session_io::create_dir_all(folder).map_err(|e| e.to_string())?;
    horizon_core::session_io::write(format!("{folder}/{name}"), bytes).map_err(|e| e.to_string())?;
    log::info!("Imported {kind} {name} ({} KiB)", bytes.len() >> 10);
    Ok(())
}