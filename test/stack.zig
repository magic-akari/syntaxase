const std = @import("std");
const syntaxase = @import("syntaxase");

fn expect_chain(link: []const u8, replacement: []const u8, count: usize) !void {
    const allocator = std.testing.allocator;
    var source: std.ArrayList(u8) = .empty;
    defer source.deinit(allocator);
    var expected: std.ArrayList(u8) = .empty;
    defer expected.deinit(allocator);
    try source.ensureTotalCapacity(allocator, 6 + link.len * count);
    try expected.ensureTotalCapacity(allocator, 6 + replacement.len * count);
    source.appendSliceAssumeCapacity("x = a");
    expected.appendSliceAssumeCapacity("x = a");
    for (0..count) |_| {
        source.appendSliceAssumeCapacity(link);
        expected.appendSliceAssumeCapacity(replacement);
    }
    source.appendAssumeCapacity(';');
    expected.appendAssumeCapacity(';');

    var stripped = try syntaxase.stripTypes(allocator, source.items, .{});
    defer stripped.deinit(allocator);
    try std.testing.expectEqualStrings(expected.items, stripped.code);
    try std.testing.expectEqual(@as(usize, 0), stripped.diagnostics.len);

    var transformed = try syntaxase.transform(allocator, source.items, .{});
    defer transformed.deinit(allocator);
    try std.testing.expectEqualStrings(expected.items, transformed.code);
    try std.testing.expectEqual(@as(usize, 0), transformed.diagnostics.len);
}

test "public APIs handle long expression chains on a 1 MiB stack" {
    const Runner = struct {
        fn check() !void {
            try expect_chain(" as any", "       ", 50_000);
            try expect_chain(" satisfies any", "              ", 50_000);
            try expect_chain("!", " ", 50_000);
            try expect_chain(".b", ".b", 50_000);
            try expect_chain("+a", "+a", 50_000);
            try expect_chain("<T>(b!)[c as C]?.d!", "   (b )[c     ]?.d ", 5_000);
        }

        fn run(result: *anyerror!void) void {
            result.* = check();
        }
    };
    var result: anyerror!void = undefined;
    const thread = try std.Thread.spawn(.{ .stack_size = 1024 * 1024 }, Runner.run, .{&result});
    thread.join();
    try result;
}
