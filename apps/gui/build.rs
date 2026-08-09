use brotli::CompressorWriter;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

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
        .unwrap_or_else(|error| panic!("could not write embedded asset: {error}"));
    input.len()
}

fn embed_blitz_assets() {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let dist = manifest.join("dist");
    let css_path = only_asset(&dist.join("static/css"), "css");
    let js_path = only_asset(&dist.join("static/js"), "js");
    let output_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let quality = if std::env::var("PROFILE").as_deref() == Ok("release") {
        9
    } else {
        2
    };
    let css_len = compress_asset(&css_path, &output_dir.join("embedded.css.br"), quality);
    let js_len = compress_asset(&js_path, &output_dir.join("embedded.js.br"), quality);
    let html = format!(
        "<!doctype html><html><head><title>AgencyZero</title><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{CSS_MARKER}</style></head><body><div id=\"root\"></div><script src=\"{JS_URL}\"></script></body></html>"
    );
    let generated = format!(
        "const BLITZ_SHELL_HTML: &str = {html:?};\n\
         const BLITZ_CSS_MARKER: &str = {CSS_MARKER:?};\n\
         const BLITZ_JS_URL: &str = {JS_URL:?};\n\
         const BLITZ_CSS_LEN: usize = {css_len};\n\
         const BLITZ_JS_LEN: usize = {js_len};\n\
         const BLITZ_CSS_BROTLI: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/embedded.css.br\"));\n\
         const BLITZ_JS_BROTLI: &[u8] = include_bytes!(concat!(env!(\"OUT_DIR\"), \"/embedded.js.br\"));\n"
    );
    fs::write(output_dir.join("blitz_embedded.rs"), generated)
        .unwrap_or_else(|error| panic!("could not write Blitz embedded module: {error}"));
    println!("cargo:rerun-if-changed={}", css_path.display());
    println!("cargo:rerun-if-changed={}", js_path.display());
}

/// First line of a command's stdout, or `None` when it fails or prints nothing.
fn first_line(cmd: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(cmd).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let line = text.lines().next()?.trim().to_string();
    (!line.is_empty()).then_some(line)
}

/// Stamps the binary with which code it is and when it was compiled.
///
/// `version` alone cannot answer "am I testing the fix?" — 0.1.0 has named
/// every build for weeks, and a stale bundle looks identical to a fresh one.
/// The commit says which code; a trailing `*` says the tree had uncommitted
/// edits on top of it; the timestamp says when, which is what gets compared
/// against "I just rebuilt". Read back through `env!` in `main.rs`.
fn stamp_build() {
    let sha =
        first_line("git", &["rev-parse", "--short=9", "HEAD"]).unwrap_or_else(|| "unknown".into());
    let dirty = first_line("git", &["status", "--porcelain"]).is_some();
    println!(
        "cargo:rustc-env=AZ_GIT_SHA={sha}{}",
        if dirty { "*" } else { "" }
    );

    // Local time on purpose: this string is read by a human comparing it to
    // the clock on the same machine that ran the build.
    let built = first_line("date", &["+%Y-%m-%d %H:%M:%S"]).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=AZ_BUILT_AT={built}");

    // A commit moves HEAD or a ref; a code edit touches `src`. Either has to
    // rerun this script, or the stamp would describe some earlier build.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs");
    println!("cargo:rerun-if-changed=src");
}

fn main() {
    stamp_build();
    if std::env::var_os("CARGO_FEATURE_BLITZ_RUNTIME").is_some() {
        embed_blitz_assets();
    }
    tauri_build::build()
}
