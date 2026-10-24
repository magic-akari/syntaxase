const std = @import("std");
const benchmark = @import("benchmark/build_steps.zig");
const napi_zig = @import("napi_zig");
const wasm = @import("wasm/build_steps.zig");

// Android requires an NDK-backed bionic sysroot and is not published yet.
const npm_platforms: []const napi_zig.Platform = &.{
    .linux_x64_gnu,
    .linux_arm64_gnu,
    .linux_arm_gnu,
    .linux_x64_musl,
    .linux_arm64_musl,
    .linux_arm_musl,
    .macos_x64,
    .macos_arm64,
    .windows_x64,
    .windows_arm64,
    .freebsd_x64,
};

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const yuku = b.dependency("yuku", .{
        .target = target,
        .optimize = optimize,
    });

    const syntaxase = b.addModule("syntaxase", .{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = optimize,
    });
    const yuku_parser = yuku.module("parser");
    syntaxase.addImport("parser", yuku_parser);

    const normalized_transform = b.createModule(.{
        .root_source_file = b.path("src/ffi/normalized_transform.zig"),
        .target = target,
        .optimize = optimize,
    });
    normalized_transform.addImport("syntaxase", syntaxase);

    const napi_dep = b.dependency("napi_zig", .{});
    napi_zig.addLib(b, napi_dep, .{
        .name = "syntaxase",
        .root = b.path("src/ffi/napi.zig"),
        .target = target,
        .optimize = optimize,
        .imports = &.{
            .{ .name = "normalized_transform", .module = normalized_transform },
        },
        .npm = .{
            .scope = "@syntaxase",
            .description = "Lightning-fast type stripping and JSX lowering",
            .license = "MIT OR Apache-2.0",
            .repository = "magic-akari/syntaxase",
            .dts = .{ .file = b.path("src/js/index.d.ts") },
            .platforms = npm_platforms,
        },
    });

    const sync_js_files = b.addUpdateSourceFiles();
    sync_js_files.addCopyFileToSource(
        b.path("src/js/index.d.ts"),
        "npm/syntaxase/index.d.ts",
    );
    sync_js_files.addCopyFileToSource(
        b.path("src/js/index.d.ts"),
        "npm/syntaxase-wasm/index.d.ts",
    );
    sync_js_files.addCopyFileToSource(
        b.path("src/js/options.js"),
        "npm/syntaxase/options.js",
    );
    sync_js_files.addCopyFileToSource(
        b.path("src/js/options.js"),
        "npm/syntaxase-wasm/options.js",
    );
    const sync_js_step = b.step(
        "sync-js",
        "Update generated JavaScript package files from their canonical sources",
    );
    sync_js_step.dependOn(&sync_js_files.step);

    const cli_module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    cli_module.addImport("syntaxase", syntaxase);

    const cli = b.addExecutable(.{
        .name = "syntaxase",
        .root_module = cli_module,
    });
    b.installArtifact(cli);

    const run_cli = b.addRunArtifact(cli);
    run_cli.addPassthruArgs();
    const run_step = b.step("run", "Run the native Syntaxase CLI");
    run_step.dependOn(&run_cli.step);

    const unit_tests = b.addTest(.{ .root_module = syntaxase });
    const run_unit_tests = b.addRunArtifact(unit_tests);
    const unit_test_step = b.step("test-unit", "Run module-level unit tests");
    unit_test_step.dependOn(&run_unit_tests.step);

    const smoke_test_module = b.createModule(.{
        .root_source_file = b.path("test/smoke.zig"),
        .target = target,
        .optimize = optimize,
    });
    smoke_test_module.addImport("syntaxase", syntaxase);
    const smoke_tests = b.addTest(.{ .root_module = smoke_test_module });
    const run_smoke_tests = b.addRunArtifact(smoke_tests);
    const smoke_test_step = b.step("test-smoke", "Run public API smoke tests");
    smoke_test_step.dependOn(&run_smoke_tests.step);

    // Stack budgets cover release builds; Debug walker frames are much larger.
    const stack_yuku = b.dependency("yuku", .{
        .target = target,
        .optimize = .ReleaseFast,
    });
    const stack_parser = stack_yuku.module("parser");
    const stack_syntaxase = b.createModule(.{
        .root_source_file = b.path("src/root.zig"),
        .target = target,
        .optimize = .ReleaseFast,
    });
    stack_syntaxase.addImport("parser", stack_parser);
    const stack_test_module = b.createModule(.{
        .root_source_file = b.path("test/stack.zig"),
        .target = target,
        .optimize = .ReleaseFast,
    });
    stack_test_module.addImport("syntaxase", stack_syntaxase);
    const stack_tests = b.addTest(.{ .root_module = stack_test_module });
    const run_stack_tests = b.addRunArtifact(stack_tests);
    const stack_test_step = b.step("test-stack", "Run public API stack-budget tests in ReleaseFast");
    stack_test_step.dependOn(&run_stack_tests.step);

    const integration_test_module = b.createModule(.{
        .root_source_file = b.path("test/integration.zig"),
        .target = target,
        .optimize = optimize,
    });
    integration_test_module.addImport("syntaxase", syntaxase);
    const integration_tests = b.addTest(.{ .root_module = integration_test_module });
    const run_integration_tests = b.addRunArtifact(integration_tests);
    run_integration_tests.setCwd(b.path("."));
    const integration_test_step = b.step(
        "test-integration",
        "Run fixed-corpus integration tests",
    );
    integration_test_step.dependOn(&run_integration_tests.step);

    wasm.add(b);

    const test_step = b.step("test", "Run all native Zig correctness tests");
    test_step.dependOn(&run_unit_tests.step);
    test_step.dependOn(&run_smoke_tests.step);
    test_step.dependOn(&run_stack_tests.step);
    test_step.dependOn(&run_integration_tests.step);

    benchmark.add(b, target);
}
