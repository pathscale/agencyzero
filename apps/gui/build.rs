use std::process::Command;

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
    tauri_build::build()
}
