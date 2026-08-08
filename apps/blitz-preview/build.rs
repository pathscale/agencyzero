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
    let html = format!(
        "<!DOCTYPE html><html><head><title>AgencyZero Blitz Preview</title><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{css}</style></head><body><div id=\"root\"></div><script>{javascript}</script></body></html>"
    );

    let generated = format!("pub const EMBEDDED_HTML: &str = {html:?};\n");
    let output = PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("embedded.rs");
    fs::write(&output, generated)
        .unwrap_or_else(|error| panic!("could not write {}: {error}", output.display()));

    println!("cargo:rerun-if-changed={}", dist.display());
}
