use brotli::CompressorWriter;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const CSS_MARKER: &str = "__AGENCYZERO_EMBEDDED_CSS__";
const JS_URL: &str = "tauri://localhost/__agencyzero__/app.js";

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

fn compress_asset(path: &Path, output: &Path, quality: u32) -> usize {
    let input =
        fs::read(path).unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()));
    let mut compressed = Vec::new();
    {
        let mut encoder = CompressorWriter::new(&mut compressed, 4096, quality, 22);
        encoder
            .write_all(&input)
            .unwrap_or_else(|error| panic!("could not compress {}: {error}", path.display()));
    }
    fs::write(output, compressed)
        .unwrap_or_else(|error| panic!("could not write {}: {error}", output.display()));
    input.len()
}

fn main() {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let dist = manifest.join("../gui/dist");
    let css_path = only_asset(&dist.join("static/css"), "css");
    let js_path = only_asset(&dist.join("static/js"), "js");
    let output_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let quality = if std::env::var("PROFILE").as_deref() == Ok("release") {
        9
    } else {
        2
    };
    let css_brotli = output_dir.join("embedded.css.br");
    let js_brotli = output_dir.join("embedded.js.br");
    let css_len = compress_asset(&css_path, &css_brotli, quality);
    let js_len = compress_asset(&js_path, &js_brotli, quality);
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
        "<!DOCTYPE html><html><head><title>AgencyZero Blitz Preview</title><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{CSS_MARKER}</style></head><body><div id=\"root\"></div>{ipc_probe}<script src=\"{JS_URL}\"></script></body></html>"
    );

    let generated = format!(
        "pub const EMBEDDED_SHELL_HTML: &str = {html:?};\n\
         pub const EMBEDDED_CSS_MARKER: &str = {CSS_MARKER:?};\n\
         pub const EMBEDDED_JS_URL: &str = {JS_URL:?};\n\
         pub const EMBEDDED_BROTLI_QUALITY: u32 = {quality};\n\
         pub const EMBEDDED_CSS_LEN: usize = {css_len};\n\
         pub const EMBEDDED_JS_LEN: usize = {js_len};\n\
         pub const EMBEDDED_CSS_BROTLI: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/embedded.css.br\"));\n\
         pub const EMBEDDED_JS_BROTLI: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/embedded.js.br\"));\n"
    );
    let output = output_dir.join("embedded.rs");
    fs::write(&output, generated)
        .unwrap_or_else(|error| panic!("could not write {}: {error}", output.display()));

    println!("cargo:rerun-if-changed={}", css_path.display());
    println!("cargo:rerun-if-changed={}", js_path.display());
    tauri_build::build();
}
