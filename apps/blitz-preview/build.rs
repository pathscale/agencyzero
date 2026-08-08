use std::fs;
use std::path::{Path, PathBuf};

fn only_asset(dir: &Path, extension: &str) -> PathBuf {
    let mut matches = fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", dir.display()))
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == extension));
    let asset = matches
        .next()
        .unwrap_or_else(|| panic!("no .{extension} asset in {}", dir.display()));
    assert!(
        matches.next().is_none(),
        "expected one .{extension} asset in {}",
        dir.display()
    );
    asset
}

fn main() {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let dist = manifest.join("../gui/dist");
    let css_path = only_asset(&dist.join("static/css"), "css");
    let js_path = only_asset(&dist.join("static/js"), "js");
    let css = fs::read_to_string(&css_path)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", css_path.display()));
    let javascript = fs::read_to_string(&js_path)
        .unwrap_or_else(|error| panic!("could not read {}: {error}", js_path.display()))
        .replace("</script", "<\\/script");
    let ipc_probe = r##"
      <script>
        (async () => {
          const status = document.createElement("div");
          status.id = "native-ipc-status";
          status.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 14px;border-radius:8px;background:#17191d;color:#f5f7fa;font:600 13px system-ui;border:1px solid #3b4048";
          status.textContent = "Native IPC pending";
          document.body.appendChild(status);
          try {
            const reply = await window.__TAURI_INTERNALS__.invoke("greet", { name: "Boa" });
            status.dataset.status = "passed";
            status.style.borderColor = "#24a148";
            status.textContent = `Native IPC passed: ${reply}`;
          } catch (error) {
            status.dataset.status = "failed";
            status.style.borderColor = "#da1e28";
            status.textContent = `Native IPC failed: ${String(error)}`;
          }
        })();
      </script>
    "##;
    let html = format!(
        "<!DOCTYPE html><html><head><title>AgencyZero Blitz Preview</title><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{css}</style></head><body><div id=\"root\"></div>{ipc_probe}<script>{javascript}</script></body></html>"
    );

    let generated = format!("pub const EMBEDDED_HTML: &str = {html:?};\n");
    let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("embedded.rs");
    fs::write(&output, generated)
        .unwrap_or_else(|error| panic!("could not write {}: {error}", output.display()));

    println!("cargo:rerun-if-changed={}", dist.display());
    tauri_build::build();
}
