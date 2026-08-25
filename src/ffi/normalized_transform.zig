const std = @import("std");
const syntaxase = @import("syntaxase");

pub const Mode = enum(u32) {
    transform = 0,
    automatic = 1,
    automatic_development = 2,
    classic = 3,
    preserve = 4,
    strip_types = 5,
    strip_types_tsx = 6,
};

pub fn parse_mode(raw_mode: u32) ?Mode {
    return std.enums.fromInt(Mode, raw_mode);
}

pub fn run_into(
    allocator: std.mem.Allocator,
    output: *std.ArrayList(u8),
    source: []const u8,
    mode: Mode,
    first_option: []const u8,
    second_option: []const u8,
) !syntaxase.TransformInfo {
    return switch (mode) {
        .transform => syntaxase.transform_into(allocator, output, source, .{}),
        .automatic, .automatic_development => syntaxase.transform_into(
            allocator,
            output,
            source,
            .{ .jsx = .{ .automatic = .{
                .development = mode == .automatic_development,
                .import_source = default_if_empty(first_option, "react"),
            } } },
        ),
        .classic => syntaxase.transform_into(allocator, output, source, .{
            .jsx = .{ .classic = .{
                .pragma = default_if_empty(first_option, "React.createElement"),
                .pragma_frag = default_if_empty(second_option, "React.Fragment"),
            } },
        }),
        .preserve => syntaxase.transform_into(allocator, output, source, .{
            .jsx = .preserve,
        }),
        .strip_types => syntaxase.strip_types_into(allocator, output, source, .{}),
        .strip_types_tsx => syntaxase.strip_types_into(
            allocator,
            output,
            source,
            .{ .lang = .tsx },
        ),
    };
}

fn default_if_empty(value: []const u8, default: []const u8) []const u8 {
    return if (value.len == 0) default else value;
}
