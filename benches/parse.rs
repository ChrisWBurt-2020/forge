//! Benchmarks parsing OpenAPI JSON documents into a `Forge`.
//!
//! The documents come from `FORGE_SPEC`, one path or several separated
//! like `PATH` (`:` on Unix):
//!
//! ```sh
//! FORGE_SPEC=/path/to/openapi.json cargo bench --bench parse
//! FORGE_SPEC=a.json:b.json cargo bench --bench parse -- forge
//! ```
//!
//! Each benchmark gets every document, named by its file name.

use std::fmt;
use std::path::PathBuf;
use std::sync::OnceLock;

use divan::counter::BytesCount;
use divan::{AllocProfiler, Bencher, black_box};
use forge::Forge;

#[global_allocator]
static ALLOC: AllocProfiler = AllocProfiler::system();

fn main() {
    divan::main();
}

/// A document read from a file named in `FORGE_SPEC`.
struct Spec {
    path: PathBuf,
    json: Vec<u8>,
}

impl fmt::Display for Spec {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.path.file_name() {
            Some(name) => write!(f, "{}", name.to_string_lossy()),
            None => write!(f, "{}", self.path.display()),
        }
    }
}

/// Returns the documents in `FORGE_SPEC`, read once and checked to parse,
/// so a bad document fails before anything is timed.
fn specs() -> &'static [Spec] {
    static SPECS: OnceLock<Vec<Spec>> = OnceLock::new();
    SPECS.get_or_init(|| {
        let Some(paths) = std::env::var_os("FORGE_SPEC") else {
            panic!("missing FORGE_SPEC: set it to the OpenAPI JSON document(s) to benchmark");
        };
        let specs: Vec<Spec> = std::env::split_paths(&paths)
            .filter(|path| !path.as_os_str().is_empty())
            .map(|path| {
                let json = std::fs::read(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
                if let Err(err) = serde_json::from_slice::<Forge>(&json) {
                    panic!("parse {}: {err}", path.display());
                }
                Spec { path, json }
            })
            .collect();
        assert!(!specs.is_empty(), "FORGE_SPEC names no files");
        specs
    })
}

/// Parses the document into a `Forge`: reading the JSON, then linking it.
#[divan::bench(args = specs())]
fn forge(bencher: Bencher, spec: &Spec) {
    bencher
        .counter(BytesCount::of_slice(&spec.json))
        .bench(|| -> Forge { serde_json::from_slice(black_box(&spec.json)).unwrap() });
}

/// Parses the document into a `serde_json::Value`, as a baseline for how
/// much of [`forge`] is reading JSON at all.
#[divan::bench(args = specs())]
fn json_value(bencher: Bencher, spec: &Spec) {
    bencher
        .counter(BytesCount::of_slice(&spec.json))
        .bench(|| -> serde_json::Value { serde_json::from_slice(black_box(&spec.json)).unwrap() });
}

/// Skips the JSON entirely and reads nothing but whether it is well
/// formed, as a floor for any parse of the document.
#[divan::bench(args = specs())]
fn json_ignored(bencher: Bencher, spec: &Spec) {
    bencher
        .counter(BytesCount::of_slice(&spec.json))
        .bench(|| serde_json::from_slice::<serde::de::IgnoredAny>(black_box(&spec.json)).unwrap());
}
