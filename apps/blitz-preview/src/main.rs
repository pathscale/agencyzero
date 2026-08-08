use anyrender_vello_cpu::VelloCpuWindowRenderer as WindowRenderer;
use blitz_dom::DocumentConfig;
use blitz_script::{DebugController, ScriptDocument};
use blitz_shell::{BlitzApplication, BlitzShellProxy, WindowConfig, create_default_event_loop};

include!(concat!(env!("OUT_DIR"), "/embedded.rs"));

fn main() {
    let event_loop = create_default_event_loop();
    let (proxy, receiver) = BlitzShellProxy::new(event_loop.create_proxy());

    let document = ScriptDocument::from_html(EMBEDDED_HTML, DocumentConfig::default());

    let window = WindowConfig::new(Box::new(document), WindowRenderer::new());
    let mut application = BlitzApplication::new(proxy, receiver);
    if let Some(controller) = DebugController::start_from_env(env!("CARGO_PKG_VERSION"))
        .expect("invalid Blitz debug-control configuration")
    {
        application.set_debug_controller(controller);
    }
    application.add_window(window);
    event_loop
        .run_app(application)
        .expect("AgencyZero Blitz preview event loop failed");
}
