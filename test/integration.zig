const std = @import("std");
const syntaxase = @import("syntaxase");

const Allocator = std.mem.Allocator;
const cases_root = "test/integration/cases";
const max_fixture_size = 16 * 1024 * 1024;

const Kind = enum {
    manual,
    upstream,
};

const Operation = enum {
    stripTypes,
    transform,
};

const Oracle = enum {
    accept,
    input,
    reject,
};

const Expectation = enum {
    recovery,
};

const JSXRuntime = enum {
    automatic,
    classic,
    preserve,
};

const JSXOptions = struct {
    development: bool = false,
    importSource: ?[]const u8 = null,
    pragma: ?[]const u8 = null,
    pragmaFrag: ?[]const u8 = null,
    runtime: JSXRuntime = .automatic,
};

const Options = struct {
    jsx: ?JSXOptions = null,
};

const Blocker = struct {
    dependency: []const u8,
    reason: []const u8,
};

const Metadata = struct {
    schema: u32,
    kind: Kind,
    operation: Operation,
    options: Options = .{},
    invariant: ?[]const u8 = null,
    whyManual: ?[]const u8 = null,
    oracle: ?Oracle = null,
    origins: ?[]std.json.Value = null,
    blocker: ?Blocker = null,
    expectation: ?Expectation = null,
};

const Layout = struct {
    input_name: []const u8,
    has_output: bool,
};

const Corpus = struct {
    allocator: Allocator,
    case_dirs: std.ArrayList([]u8),

    fn discover(allocator: Allocator) !Corpus {
        const io = std.testing.io;
        var root = try std.Io.Dir.cwd().openDir(io, cases_root, .{ .iterate = true });
        defer root.close(io);

        var case_dirs: std.ArrayList([]u8) = .empty;
        errdefer {
            for (case_dirs.items) |case_dir| allocator.free(case_dir);
            case_dirs.deinit(allocator);
        }

        var walker = try root.walk(allocator);
        defer walker.deinit();
        while (try walker.next(io)) |entry| {
            if (entry.kind == .sym_link) {
                return invalid_fixture(entry.path, "symbolic links are not allowed");
            }
            if (entry.kind != .file or !std.mem.eql(u8, entry.basename, "case.json")) {
                continue;
            }
            const case_dir = std.fs.path.dirname(entry.path) orelse {
                return invalid_fixture(entry.path, "case.json must be inside a case directory");
            };
            try case_dirs.append(allocator, try allocator.dupe(u8, case_dir));
        }

        std.mem.sort([]u8, case_dirs.items, {}, less_than_path);
        return .{ .allocator = allocator, .case_dirs = case_dirs };
    }

    fn deinit(corpus: *Corpus) void {
        for (corpus.case_dirs.items) |case_dir| corpus.allocator.free(case_dir);
        corpus.case_dirs.deinit(corpus.allocator);
    }
};

test "fixture corpus has one complete contract per case" {
    const allocator = std.testing.allocator;
    var corpus = try Corpus.discover(allocator);
    defer corpus.deinit();

    try std.testing.expect(corpus.case_dirs.items.len > 0);

    var manual_invariants = std.StringHashMap(void).init(allocator);
    defer {
        var keys = manual_invariants.keyIterator();
        while (keys.next()) |key| allocator.free(key.*);
        manual_invariants.deinit();
    }

    for (corpus.case_dirs.items) |case_dir| {
        const layout = try inspect_layout(case_dir);

        var parsed = try parse_metadata(allocator, case_dir);
        defer parsed.deinit();
        const metadata = parsed.value;

        try require(metadata.schema == 1, case_dir, "unsupported case schema");
        switch (metadata.kind) {
            .manual => {
                const invariant = metadata.invariant orelse {
                    return invalid_fixture(case_dir, "manual case is missing invariant");
                };
                const why_manual = metadata.whyManual orelse {
                    return invalid_fixture(case_dir, "manual case is missing whyManual");
                };
                try require(invariant.len > 0, case_dir, "manual invariant must not be empty");
                try require(why_manual.len > 0, case_dir, "whyManual must not be empty");
                try require(metadata.origins == null, case_dir, "manual case must not have origins");
                try require(metadata.oracle == null, case_dir, "manual case must not have an oracle");

                const invariant_copy = try allocator.dupe(u8, invariant);
                errdefer allocator.free(invariant_copy);
                const result = try manual_invariants.getOrPut(invariant_copy);
                if (result.found_existing) {
                    allocator.free(invariant_copy);
                    return invalid_fixture(case_dir, "manual invariant is duplicated");
                }
            },
            .upstream => {
                const origins = metadata.origins orelse {
                    return invalid_fixture(case_dir, "upstream case is missing origins");
                };
                try require(origins.len > 0, case_dir, "upstream origins must not be empty");
                try require(metadata.oracle != null, case_dir, "upstream case is missing oracle");
                try require(metadata.invariant == null, case_dir, "upstream case must not have invariant");
                try require(metadata.whyManual == null, case_dir, "upstream case must not have whyManual");
            },
        }

        if (metadata.operation == .stripTypes) {
            try require(metadata.options.jsx == null, case_dir, "stripTypes case must not have JSX options");
        }
        if (layout.has_output) {
            try require(metadata.blocker == null, case_dir, "blocked case must not have committed output");
            try require(metadata.expectation == null, case_dir, "output case must not declare recovery");
        } else {
            try require(metadata.expectation == .recovery, case_dir, "case without output must declare recovery");
        }
    }
}

test "output fixtures match committed Syntaxase expectations" {
    const allocator = std.testing.allocator;
    var corpus = try Corpus.discover(allocator);
    defer corpus.deinit();

    var output_cases: usize = 0;
    for (corpus.case_dirs.items) |case_dir| {
        const layout = try inspect_layout(case_dir);
        if (!layout.has_output) continue;

        const source = try read_case_file(allocator, case_dir, layout.input_name);
        defer allocator.free(source);

        var parsed = try parse_metadata(allocator, case_dir);
        defer parsed.deinit();
        const metadata = parsed.value;

        var result = try evaluate(allocator, source, layout.input_name, metadata);
        defer result.deinit(allocator);

        const expected = try read_case_file(allocator, case_dir, "output.js");
        defer allocator.free(expected);
        if (!std.mem.eql(u8, expected, result.code)) {
            std.debug.print("fixture output differs: {s}\n", .{case_dir});
            try std.testing.expectEqualStrings(expected, result.code);
        }
        output_cases += 1;
    }

    try std.testing.expect(output_cases > 0);
}

test "recovery fixtures execute without a secondary rejection policy" {
    const allocator = std.testing.allocator;
    var corpus = try Corpus.discover(allocator);
    defer corpus.deinit();

    var recovery_cases: usize = 0;
    var diagnosed_cases: usize = 0;
    for (corpus.case_dirs.items) |case_dir| {
        const layout = try inspect_layout(case_dir);
        if (layout.has_output) continue;

        const source = try read_case_file(allocator, case_dir, layout.input_name);
        defer allocator.free(source);

        var parsed = try parse_metadata(allocator, case_dir);
        defer parsed.deinit();

        var result = try evaluate(allocator, source, layout.input_name, parsed.value);
        defer result.deinit(allocator);
        if (result.diagnostics.len > 0) diagnosed_cases += 1;
        recovery_cases += 1;
    }

    try std.testing.expect(recovery_cases > 0);
    try std.testing.expect(diagnosed_cases > 0);
}

fn inspect_layout(case_dir: []const u8) !Layout {
    const io = std.testing.io;
    const allocator = std.testing.allocator;
    const full_path = try std.fs.path.join(allocator, &.{ cases_root, case_dir });
    defer allocator.free(full_path);

    var directory = try std.Io.Dir.cwd().openDir(io, full_path, .{ .iterate = true });
    defer directory.close(io);

    var input_name: ?[]const u8 = null;
    var has_output = false;
    var iterator = directory.iterate();
    while (try iterator.next(io)) |entry| {
        if (entry.kind == .sym_link) {
            return invalid_fixture(case_dir, "symbolic links are not allowed");
        }
        if (entry.kind == .directory) {
            return invalid_fixture(case_dir, "nested case directories are not allowed");
        }
        if (supported_input_name(entry.name)) |name| {
            if (input_name != null) {
                return invalid_fixture(case_dir, "case has multiple input files");
            }
            input_name = name;
            continue;
        }
        if (std.mem.eql(u8, entry.name, "output.js")) {
            if (has_output) return invalid_fixture(case_dir, "case has multiple output files");
            has_output = true;
            continue;
        }
        if (!std.mem.eql(u8, entry.name, "case.json")) {
            return invalid_fixture(case_dir, "case contains an unknown file");
        }
    }

    return .{
        .input_name = input_name orelse return invalid_fixture(case_dir, "case has no input file"),
        .has_output = has_output,
    };
}

fn parse_metadata(allocator: Allocator, case_dir: []const u8) !std.json.Parsed(Metadata) {
    const source = try read_case_file(allocator, case_dir, "case.json");
    defer allocator.free(source);
    return std.json.parseFromSlice(Metadata, allocator, source, .{
        .allocate = .alloc_always,
        .ignore_unknown_fields = true,
    });
}

fn read_case_file(allocator: Allocator, case_dir: []const u8, name: []const u8) ![]u8 {
    const path = try std.fs.path.join(allocator, &.{ cases_root, case_dir, name });
    defer allocator.free(path);
    return std.Io.Dir.cwd().readFileAlloc(
        std.testing.io,
        path,
        allocator,
        .limited(max_fixture_size),
    );
}

fn evaluate(
    allocator: Allocator,
    source: []const u8,
    input_name: []const u8,
    metadata: Metadata,
) !syntaxase.TransformResult {
    if (metadata.operation == .stripTypes) {
        return syntaxase.stripTypes(allocator, source);
    }

    const jsx = metadata.options.jsx orelse {
        if (std.mem.eql(u8, input_name, "input.tsx")) {
            return syntaxase.transform(allocator, source, .{
                .jsx = .{ .automatic = .{} },
            });
        }
        return syntaxase.transform(allocator, source, .{});
    };

    return switch (jsx.runtime) {
        .automatic => syntaxase.transform(allocator, source, .{
            .jsx = .{ .automatic = .{
                .development = jsx.development,
                .import_source = jsx.importSource orelse "react",
            } },
        }),
        .classic => syntaxase.transform(allocator, source, .{
            .jsx = .{ .classic = .{
                .pragma = jsx.pragma orelse "React.createElement",
                .pragma_frag = jsx.pragmaFrag orelse "React.Fragment",
            } },
        }),
        .preserve => syntaxase.transform(allocator, source, .{ .jsx = .preserve }),
    };
}

fn supported_input_name(name: []const u8) ?[]const u8 {
    const supported = [_][]const u8{
        "input.cts",
        "input.mts",
        "input.ts",
        "input.tsx",
    };
    for (supported) |candidate| {
        if (std.mem.eql(u8, name, candidate)) return candidate;
    }
    return null;
}

fn less_than_path(_: void, left: []u8, right: []u8) bool {
    return std.mem.order(u8, left, right) == .lt;
}

fn require(condition: bool, case_dir: []const u8, message: []const u8) !void {
    if (!condition) return invalid_fixture(case_dir, message);
}

fn invalid_fixture(case_dir: []const u8, message: []const u8) error{InvalidFixture} {
    std.debug.print("invalid fixture {s}: {s}\n", .{ case_dir, message });
    return error.InvalidFixture;
}
