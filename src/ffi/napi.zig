const std = @import("std");
const napi = @import("napi-zig");
const normalized_transform = @import("normalized_transform");

pub fn run(
    env: napi.Env,
    source: []const u8,
    raw_mode: u32,
    first_option: []const u8,
    second_option: []const u8,
) !napi.Val {
    const mode = normalized_transform.parse_mode(raw_mode) orelse
        return error.InvalidMode;
    const allocator = env.allocator();

    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(allocator);

    var info = try normalized_transform.run_into(
        allocator,
        &output,
        source,
        mode,
        first_option,
        second_option,
    );
    defer info.deinit(allocator);

    return env.createString(output.items);
}

comptime {
    napi.module(@This());
}
