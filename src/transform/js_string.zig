const std = @import("std");

const Allocator = std.mem.Allocator;

/// Serializes UTF-8 text as a JavaScript string literal without emitting a
/// physical ECMAScript line separator.
pub fn literal(allocator: Allocator, value: []const u8) Allocator.Error![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);
    try append_literal(&output, allocator, value);
    return output.toOwnedSlice(allocator);
}

pub fn append_literal(
    output: *std.ArrayList(u8),
    allocator: Allocator,
    value: []const u8,
) Allocator.Error!void {
    try output.append(allocator, '"');
    var offset: usize = 0;
    while (offset < value.len) {
        const byte = value[offset];
        if (byte == 0xed and offset + 2 < value.len) {
            const second = value[offset + 1];
            const third = value[offset + 2];
            if (second >= 0xa0 and second <= 0xbf and third >= 0x80 and third <= 0xbf) {
                const surrogate: u16 = 0xd800 |
                    (@as(u16, second & 0x3f) << 6) |
                    @as(u16, third & 0x3f);
                const hex = "0123456789abcdef";
                try output.appendSlice(allocator, &.{
                    '\\',                          'u',
                    hex[(surrogate >> 12) & 0x0f], hex[(surrogate >> 8) & 0x0f],
                    hex[(surrogate >> 4) & 0x0f],  hex[surrogate & 0x0f],
                });
                offset += 3;
                continue;
            }
        }
        switch (byte) {
            '"' => try output.appendSlice(allocator, "\\\""),
            '\\' => try output.appendSlice(allocator, "\\\\"),
            0x08 => try output.appendSlice(allocator, "\\b"),
            0x0c => try output.appendSlice(allocator, "\\f"),
            '\n' => try output.appendSlice(allocator, "\\n"),
            '\r' => try output.appendSlice(allocator, "\\r"),
            '\t' => try output.appendSlice(allocator, "\\t"),
            0x00...0x07, 0x0b, 0x0e...0x1f => {
                const hex = "0123456789abcdef";
                try output.appendSlice(allocator, &.{
                    '\\', 'u', '0', '0', hex[byte >> 4], hex[byte & 0x0f],
                });
            },
            0xe2 => {
                const remaining = value[offset..];
                if (std.mem.startsWith(u8, remaining, "\u{2028}")) {
                    try output.appendSlice(allocator, "\\u2028");
                    offset += "\u{2028}".len - 1;
                } else if (std.mem.startsWith(u8, remaining, "\u{2029}")) {
                    try output.appendSlice(allocator, "\\u2029");
                    offset += "\u{2029}".len - 1;
                } else {
                    try output.append(allocator, byte);
                }
            },
            else => try output.append(allocator, byte),
        }
        offset += 1;
    }
    try output.append(allocator, '"');
}

test "JavaScript strings escape controls and physical separators" {
    const allocator = std.testing.allocator;
    const output = try literal(allocator, "a\n\"\\\u{2028}\u{2029}");
    defer allocator.free(output);
    try std.testing.expectEqualStrings("\"a\\n\\\"\\\\\\u2028\\u2029\"", output);
}
