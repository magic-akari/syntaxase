const std = @import("std");
const syntaxase = @import("syntaxase");

/// Native verification shell. Source is read from stdin and transformed
/// source is written to stdout. The library API in `root.zig` is authoritative.
pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.smp_allocator;
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());

    var strip_types = false;
    var jsx_runtime: enum { disabled, automatic, classic, preserve } = .disabled;
    var jsx_development = false;
    var jsx_import_source: []const u8 = "react";
    var jsx_pragma: []const u8 = "React.createElement";
    var jsx_pragma_frag: []const u8 = "React.Fragment";
    for (args[1..]) |argument| {
        if (std.mem.eql(u8, argument, "--strip-types")) {
            strip_types = true;
        } else if (std.mem.eql(u8, argument, "--jsx=automatic")) {
            jsx_runtime = .automatic;
        } else if (std.mem.eql(u8, argument, "--jsx=classic")) {
            jsx_runtime = .classic;
        } else if (std.mem.eql(u8, argument, "--jsx=preserve")) {
            jsx_runtime = .preserve;
        } else if (std.mem.eql(u8, argument, "--jsx-development")) {
            jsx_development = true;
        } else if (std.mem.startsWith(u8, argument, "--jsx-import-source=")) {
            jsx_import_source = argument["--jsx-import-source=".len..];
        } else if (std.mem.startsWith(u8, argument, "--jsx-pragma=")) {
            jsx_pragma = argument["--jsx-pragma=".len..];
        } else if (std.mem.startsWith(u8, argument, "--jsx-pragma-frag=")) {
            jsx_pragma_frag = argument["--jsx-pragma-frag=".len..];
        } else {
            return error.InvalidArgument;
        }
    }

    var stdin_buffer: [4096]u8 = undefined;
    var stdin_reader = std.Io.File.stdin().reader(io, &stdin_buffer);
    const source = try stdin_reader.interface.allocRemaining(allocator, .unlimited);
    defer allocator.free(source);

    var result = if (strip_types)
        try syntaxase.stripTypes(allocator, source)
    else switch (jsx_runtime) {
        .disabled => try syntaxase.transform(allocator, source, .{}),
        .automatic => try syntaxase.transform(allocator, source, .{
            .jsx = .{ .automatic = .{
                .development = jsx_development,
                .import_source = jsx_import_source,
            } },
        }),
        .classic => try syntaxase.transform(allocator, source, .{
            .jsx = .{ .classic = .{
                .pragma = jsx_pragma,
                .pragma_frag = jsx_pragma_frag,
            } },
        }),
        .preserve => try syntaxase.transform(allocator, source, .{ .jsx = .preserve }),
    };
    defer result.deinit(allocator);

    var stdout_buffer: [4096]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writer(io, &stdout_buffer);
    try stdout_writer.interface.writeAll(result.code);
    try stdout_writer.interface.flush();
}
