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
        "<!doctype html><html><head><title>AgencyZero</title><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>{CSS_MARKER}</style></head><body><div id=\"root\"></div><script>globalThis.__AGENCYZERO_BLITZ__=true</script><script src=\"{JS_URL}\"></script></body></html>"
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

    /*
     * The versions of the crates that actually render, and of the component
     * library, so nobody has to take a build's word for what is in it.
     *
     * A whole session was spent disagreeing about whether a fix was present:
     * a caret asking for a pre-release silently resolved to a stale registry
     * copy, `bun install` reverted a locally linked `@pathscale/ui`, and a
     * Rust rebuild kept an older embedded frontend. Each produced a build that
     * looked right, was described as fixed, and was not. The version was
     * knowable at compile time every time, and simply was not written down.
     *
     * Read from the resolved graph rather than the manifest: the manifest says
     * what was asked for, and every one of those failures was the difference
     * between the ask and the answer.
     */
    write_resolved_manifest();

    // A commit moves HEAD or a ref; a code edit touches `src`. Either has to
    // rerun this script, or the stamp would describe some earlier build.
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=../../.git/refs");
    println!("cargo:rerun-if-changed=src");
    // The resolved graph and the installed component library are inputs to the
    // stamp above, so a change in either has to rerun this script.
    println!("cargo:rerun-if-changed=../../Cargo.toml");
    println!("cargo:rerun-if-changed=../../Cargo.lock");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=frontend/node_modules/@pathscale/ui/package.json");
}

/// Drop framework load commands that nothing in this binary references.
///
/// On macOS `tauri` and `tauri-runtime` depend on `objc2-web-kit`
/// unconditionally, not behind the `wry` feature, because `tauri-runtime`'s
/// public API names WKWebView types. That crate carries
/// `#[link(name = "WebKit", kind = "framework")]`, which travels in rlib
/// metadata rather than on the rustc command line, so a build that renders with
/// Blitz and never calls WebKit still gets an `LC_LOAD_DYLIB` for it and dyld
/// still loads the framework at launch.
///
/// Measured, because the obvious theory was wrong. Taking `tauri` with
/// `default-features = false` removes `wry` and `tauri-runtime-wry` from the
/// graph entirely, and `otool -L` still lists WebKit. The chuzz workspace takes
/// tauri the same way and its shipped binary has the same load command, so
/// nothing about feature selection reaches this. Only upstream gating
/// `objc2-web-kit` would.
///
/// `-dead_strip_dylibs` drops load commands nothing references, which decides
/// per link rather than per feature: stripped from a Blitz build, kept in a
/// webview build, with no second dependency graph. `otool -L` on a
/// `--features blitz-runtime` binary reports WebKit without this and does not
/// with it.
///
/// Here rather than in `.cargo/config.toml`, which is where it used to live.
/// That file also carried a `[patch]` table, machine-local paths kept ending up
/// beside it, and defending them cost four accidental commits and a
/// `skip-worktree` flag that hid the file from `git status` too. A build script
/// says the same thing without a file anything else can be added to, and scopes
/// it to the crates that link Tauri rather than every target in the workspace.
fn strip_unused_frameworks() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    println!("cargo::rustc-link-arg-bins=-Wl,-dead_strip_dylibs");
}

fn main() {
    strip_unused_frameworks();
    stamp_build();
    if std::env::var_os("CARGO_FEATURE_BLITZ_RUNTIME").is_some() {
        embed_blitz_assets();
    }
    tauri_build::build()
}

/// Write every resolved dependency version into the binary, plus the installed
/// component library, so a running app can state exactly what it was built
/// from.
///
/// A build stamp of a few hand-picked crates answers only the question someone
/// thought to ask. This records the whole graph: `cargo tree` output for the
/// Rust side and the resolved version of `@pathscale/ui` for the frontend,
/// which together are the two halves that drifted.
///
/// It exists because "is the fix in this build" cost most of a session and was
/// answered wrongly several times. A caret asking for a pre-release silently
/// resolved to a stale registry copy; `bun install` reverted a locally linked
/// `@pathscale/ui` mid-session; a Rust rebuild kept an older embedded
/// frontend. All three were knowable at compile time and none were written
/// down, so each produced a build that looked right and was described as fixed
/// when it was not.
fn write_resolved_manifest() {
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set for build scripts");
    let path = std::path::Path::new(&out_dir).join("resolved-manifest.txt");

    let mut manifest = String::new();

    // The whole Rust graph, deduplicated. A path or git source shows up here
    // as its source, which is the thing that must never ship unnoticed.
    let tree = std::process::Command::new("cargo")
        .args([
            "tree",
            "--locked",
            "--edges",
            "normal",
            "--prefix",
            "none",
            "--quiet",
        ])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .unwrap_or_else(|| "cargo tree unavailable\n".into());
    let mut crates: Vec<&str> = tree
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    crates.sort_unstable();
    crates.dedup();
    manifest.push_str(&format!("# rust: {} crates\n", crates.len()));
    for line in crates {
        manifest.push_str(line);
        manifest.push('\n');
    }

    // The component library as installed, not as requested. `bun.lock` is not
    // committed in this project, so the caret in `package.json` cannot answer
    // which version is on disk.
    let ui = std::fs::read_to_string("frontend/node_modules/@pathscale/ui/package.json")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.trim_start().starts_with("\"version\""))
                .and_then(|line| line.split('"').nth(3).map(str::to_owned))
        })
        .unwrap_or_else(|| "unknown".into());
    manifest.push_str(&format!("\n# frontend\n@pathscale/ui {ui}\n"));

    std::fs::write(&path, manifest).expect("write resolved-manifest.txt");

    println!("cargo:rerun-if-changed=../../Cargo.toml");
    println!("cargo:rerun-if-changed=../../Cargo.lock");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=frontend/node_modules/@pathscale/ui/package.json");
}
