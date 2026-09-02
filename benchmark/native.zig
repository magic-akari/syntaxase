const std = @import("std");
const syntaxase = @import("syntaxase");

const type_strip_benchmark = syntaxase.type_strip_benchmark;

const warmup_nanoseconds = 300 * std.time.ns_per_ms;
const sample_nanoseconds = 100 * std.time.ns_per_ms;
const sample_count = 7;

const Action = enum { inspect, measure, callgrind };
const Mode = enum { strip, jsx, stages };

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.smp_allocator;
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len != 3) return error.InvalidArgument;

    const action = std.meta.stringToEnum(Action, args[1]) orelse
        return error.InvalidArgument;
    const mode = std.meta.stringToEnum(Mode, args[2]) orelse
        return error.InvalidArgument;

    var stdin_buffer: [4096]u8 = undefined;
    var stdin_reader = std.Io.File.stdin().reader(io, &stdin_buffer);
    const source = try stdin_reader.interface.allocRemaining(allocator, .unlimited);
    defer allocator.free(source);

    switch (action) {
        .inspect => try inspect(io, allocator, source, mode),
        .measure => try measure(io, allocator, source, mode),
        .callgrind => try callgrind(source, mode),
    }
}

fn callgrind(source: []const u8, mode: Mode) !void {
    if (mode != .stages) return error.UnsupportedMode;
    const checksum = try callgrind_stages(source);
    std.mem.doNotOptimizeAway(checksum);
}

fn callgrind_stages(source: []const u8) !usize {
    const allocator = std.heap.smp_allocator;
    const callgrind_client = std.valgrind.callgrind;
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const scratch = arena.allocator();

    callgrind_client.toggleCollect();
    var file = try type_strip_benchmark.parse(scratch, source);
    callgrind_client.toggleCollect();
    callgrind_client.dumpStatsAt("parse");
    defer file.deinit();

    var edits = type_strip_benchmark.init_edits(scratch, &file);
    defer edits.deinit();
    callgrind_client.toggleCollect();
    try type_strip_benchmark.erase(&file, &edits);
    callgrind_client.toggleCollect();
    callgrind_client.dumpStatsAt("erase");

    callgrind_client.toggleCollect();
    var plan = try type_strip_benchmark.seal(&edits);
    callgrind_client.toggleCollect();
    callgrind_client.dumpStatsAt("seal");
    defer plan.deinit();

    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(allocator);
    callgrind_client.toggleCollect();
    try type_strip_benchmark.render_into(&plan, &output, allocator);
    callgrind_client.toggleCollect();

    var expected = try syntaxase.stripTypes(allocator, source, .{});
    defer expected.deinit(allocator);
    if (!std.mem.eql(u8, output.items, expected.code)) {
        return error.TypeStripBenchmarkOutputMismatch;
    }
    return output.items.len;
}

fn inspect(
    io: std.Io,
    allocator: std.mem.Allocator,
    source: []const u8,
    mode: Mode,
) !void {
    var result = try transform_once(allocator, source, mode);
    defer result.deinit(allocator);

    if (result.diagnostics.len > 0) {
        for (result.diagnostics) |diagnostic| {
            std.debug.print(
                "{s}: {s} [{d}, {d}]\n",
                .{
                    diagnostic.severity.toString(),
                    diagnostic.message,
                    diagnostic.span.start,
                    diagnostic.span.end,
                },
            );
        }
        return error.UnexpectedDiagnostics;
    }

    var stdout_buffer: [4096]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
    try stdout_writer.interface.writeAll(result.code);
    try stdout_writer.interface.flush();
}

fn measure(
    io: std.Io,
    allocator: std.mem.Allocator,
    source: []const u8,
    mode: Mode,
) !void {
    var checksum: usize = 0;
    const warmup_start = std.Io.Clock.awake.now(io);
    var warmup_iterations: usize = 0;
    while (warmup_start.durationTo(std.Io.Clock.awake.now(io)).nanoseconds < warmup_nanoseconds) {
        checksum +%= try run_once(allocator, source, mode);
        warmup_iterations += 1;
    }

    var calibration: [3]i128 = undefined;
    for (&calibration) |*elapsed| {
        elapsed.* = try measure_iterations(io, allocator, source, mode, 1, &checksum);
    }
    std.mem.sort(i128, &calibration, {}, std.sort.asc(i128));
    const calibrated = @max(calibration[1], 1);
    const estimated = @divTrunc(sample_nanoseconds, calibrated);
    const iterations: usize = @intCast(@max(1, @min(10_000, estimated)));

    var samples: [sample_count]i128 = undefined;
    for (&samples) |*sample| {
        const elapsed = try measure_iterations(io, allocator, source, mode, iterations, &checksum);
        sample.* = @divTrunc(elapsed, @as(i128, @intCast(iterations)));
    }
    std.mem.sort(i128, &samples, {}, std.sort.asc(i128));
    const median = samples[sample_count / 2];

    var stdout_buffer: [512]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
    try stdout_writer.interface.print(
        "{{\"medianNanoseconds\":{d},\"iterationsPerSample\":{d}," ++
            "\"warmupIterations\":{d},\"checksum\":{d}}}\n",
        .{ median, iterations, warmup_iterations, checksum },
    );
    try stdout_writer.interface.flush();
}

fn measure_iterations(
    io: std.Io,
    allocator: std.mem.Allocator,
    source: []const u8,
    mode: Mode,
    iterations: usize,
    checksum: *usize,
) !i128 {
    const start = std.Io.Clock.awake.now(io);
    for (0..iterations) |_| checksum.* +%= try run_once(allocator, source, mode);
    const end = std.Io.Clock.awake.now(io);
    return start.durationTo(end).nanoseconds;
}

fn run_once(allocator: std.mem.Allocator, source: []const u8, mode: Mode) !usize {
    var result = try transform_once(allocator, source, mode);
    defer result.deinit(allocator);

    std.mem.doNotOptimizeAway(result.code.ptr);
    std.mem.doNotOptimizeAway(result.diagnostics.ptr);
    return result.code.len +% result.diagnostics.len;
}

fn transform_once(
    allocator: std.mem.Allocator,
    source: []const u8,
    mode: Mode,
) !syntaxase.TransformResult {
    return switch (mode) {
        .strip => syntaxase.stripTypes(allocator, source, .{}),
        .jsx => syntaxase.transform(allocator, source, .{
            .jsx = .{ .automatic = .{} },
        }),
        .stages => error.UnsupportedMode,
    };
}
