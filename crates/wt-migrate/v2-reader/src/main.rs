use std::path::Path;

#[tokio::main]
async fn main() -> eyre::Result<()> {
    let mut args = std::env::args_os().skip(1);
    let source = args.next().ok_or_else(|| eyre::eyre!("missing source"))?;
    let destination = args
        .next()
        .ok_or_else(|| eyre::eyre!("missing destination"))?;
    if args.next().is_some() {
        eyre::bail!("usage: agencyzero-wt-v2-reader <v2-store> <empty-export-directory>");
    }
    agencyzero_wt_v2_reader::export_to(Path::new(&source), Path::new(&destination)).await
}
