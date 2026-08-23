const std = @import("std");

pub fn add(b: *std.Build) void {
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
        .cpu_features_add = std.Target.wasm.featureSet(&.{
            .bulk_memory,
            .nontrapping_fptoint,
            .sign_ext,
            .simd128,
        }),
    });
    const yuku = b.dependency("yuku", .{
        .target = wasm_target,
        .optimize = .ReleaseSmall,
    });
    const yuku_parser = yuku.module("parser");

    const syntaxase = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = wasm_target,
        .optimize = .ReleaseSmall,
        .strip = true,
    });
    syntaxase.addImport("parser", yuku_parser);
    syntaxase.addImport("yuku_util", yuku_parser.import_table.get("util").?);

    const normalized_transform = b.createModule(.{
        .root_source_file = b.path("src/ffi/normalized_transform.zig"),
        .target = wasm_target,
        .optimize = .ReleaseSmall,
        .strip = true,
    });
    normalized_transform.addImport("syntaxase", syntaxase);

    const wasm_module = b.createModule(.{
        .root_source_file = b.path("wasm/root.zig"),
        .target = wasm_target,
        .optimize = .ReleaseSmall,
        .strip = true,
    });
    wasm_module.addImport("normalized_transform", normalized_transform);

    const wasm = b.addExecutable(.{
        .name = "syntaxase",
        .root_module = wasm_module,
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;

    const embed_module = b.createModule(.{
        .root_source_file = b.path("wasm/embed.zig"),
        .target = b.graph.host,
        .optimize = .ReleaseSafe,
    });
    const embed = b.addExecutable(.{
        .name = "embed-syntaxase-wasm",
        .root_module = embed_module,
    });
    const run_embed = b.addRunArtifact(embed);
    run_embed.addArtifactArg(wasm);
    const bytes_module = run_embed.addOutputFileArg("wasm.js");

    const install_bridge = b.addInstallFileWithDir(
        b.path("npm/syntaxase-wasm/index.js"),
        .prefix,
        "wasm/index.js",
    );
    const install_options = b.addInstallFileWithDir(
        b.path("src/js/options.js"),
        .prefix,
        "wasm/options.js",
    );
    const install_types = b.addInstallFileWithDir(
        b.path("src/js/index.d.ts"),
        .prefix,
        "wasm/index.d.ts",
    );
    const install_bytes = b.addInstallFileWithDir(
        bytes_module,
        .prefix,
        "wasm/wasm.js",
    );

    const wasm_step = b.step("wasm", "Build the synchronous inline WebAssembly package");
    wasm_step.dependOn(&install_bridge.step);
    wasm_step.dependOn(&install_options.step);
    wasm_step.dependOn(&install_types.step);
    wasm_step.dependOn(&install_bytes.step);

    const update_package = b.addUpdateSourceFiles();
    update_package.addCopyFileToSource(
        b.path("src/js/index.d.ts"),
        "npm/syntaxase-wasm/index.d.ts",
    );
    update_package.addCopyFileToSource(
        b.path("src/js/options.js"),
        "npm/syntaxase-wasm/options.js",
    );
    update_package.addCopyFileToSource(
        bytes_module,
        "npm/syntaxase-wasm/wasm.js",
    );
    const package_step = b.step(
        "wasm-package",
        "Update the publishable syntaxase-wasm package",
    );
    package_step.dependOn(&update_package.step);
}
