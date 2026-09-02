use std::path::Path;

use gungraun::prelude::*;
use gungraun::{Callgrind, EntryPoint, EventKind, OutputFormat, Stdio};

fn callgrind_config() -> BinaryBenchmarkConfig {
    let mut callgrind =
        Callgrind::with_args(["--branch-sim=no", "--cache-sim=no", "--collect-atstart=no"]);
    callgrind
        .entry_point(EntryPoint::None)
        .format([EventKind::Ir]);

    let mut output_format = OutputFormat::default();
    output_format.show_intermediate(true);

    let mut config = BinaryBenchmarkConfig::default();
    config.tool(callgrind).output_format(output_format);
    config
}

fn command(corpus_file_name: &str) -> gungraun::Command {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let executable = root.join("zig-out/bin/syntaxase-native-benchmark");
    let corpus = root
        .join("benchmark/.cache/gungraun")
        .join(corpus_file_name);

    gungraun::Command::new(executable)
        .args(["callgrind", "stages"])
        .stdin(Stdio::File(corpus))
        .build()
}

#[binary_benchmark]
#[bench::astro_config("astro-config.ts")]
#[bench::effect_schema_ast("effect-schema-ast.ts")]
#[bench::hono_types("hono-types.ts")]
fn bench_type_strip(corpus_file_name: &str) -> gungraun::Command {
    command(corpus_file_name)
}

binary_benchmark_group!(
    name = type_strip,
    config = callgrind_config(),
    benchmarks = bench_type_strip
);

main!(binary_benchmark_groups = type_strip);
