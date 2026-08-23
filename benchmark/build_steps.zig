const std = @import("std");

pub fn add(
    b: *std.Build,
    target: std.Build.ResolvedTarget,
) void {
    const yuku = b.dependency("yuku", .{
        .target = target,
        .optimize = .ReleaseFast,
    });
    const yuku_parser = yuku.module("parser");

    const syntaxase = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = .ReleaseFast,
    });
    syntaxase.addImport("parser", yuku_parser);
    syntaxase.addImport("yuku_util", yuku_parser.import_table.get("util").?);

    const native_module = b.createModule(.{
        .root_source_file = b.path("benchmark/native.zig"),
        .target = target,
        .optimize = .ReleaseFast,
    });
    native_module.addImport("syntaxase", syntaxase);

    const native = b.addExecutable(.{
        .name = "syntaxase-native-benchmark",
        .root_module = native_module,
    });
    const install_native = b.addInstallArtifact(native, .{});

    const step = b.step(
        "benchmark-native",
        "Build the native Syntaxase benchmark executable",
    );
    step.dependOn(&install_native.step);
}
