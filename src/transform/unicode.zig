const std = @import("std");

const Allocator = std.mem.Allocator;

/// Returns the JavaScript string width of UTF-8 source text.
///
/// Invalid UTF-8 bytes count as one code unit. Yuku inputs are expected to be
/// valid UTF-8, but the fallback keeps rendering total and deterministic.
pub fn utf16_width(source: []const u8) usize {
    var width: usize = 0;
    var offset: usize = 0;

    while (offset < source.len) {
        if (source[offset] < 0x80) {
            width += 1;
            offset += 1;
            continue;
        }
        const codepoint = next_codepoint(source, &offset);
        width += if (codepoint > 0xffff) 2 else 1;
    }

    return width;
}

/// Appends a fixed-width erasure of source.
///
/// Tabs and ECMAScript line terminators retain their original bytes. Every
/// other BMP code point becomes one ASCII space and every astral code point
/// becomes two, preserving JavaScript UTF-16 length.
pub fn append_blanked(
    output: *std.ArrayList(u8),
    allocator: Allocator,
    source: []const u8,
) Allocator.Error!void {
    // UTF-16 output is never wider in bytes than its UTF-8 input. Reserve once
    // and write directly into spare capacity so ASCII-heavy erased regions do
    // not pay an ArrayList capacity check for every source code point.
    try output.ensureUnusedCapacity(allocator, source.len);
    const destination = output.unusedCapacitySlice();
    var written: usize = 0;
    var offset: usize = 0;

    while (offset < source.len) {
        const plain_ascii_end = next_blanking_candidate(source, offset);
        if (plain_ascii_end > offset) {
            const length = plain_ascii_end - offset;
            @memset(destination[written..][0..length], ' ');
            written += length;
            offset = plain_ascii_end;
            if (offset == source.len) break;
        }

        const byte = source[offset];
        if (byte < 0x80) {
            destination[written] = switch (byte) {
                '\t', '\r', '\n' => byte,
                else => ' ',
            };
            written += 1;
            offset += 1;
            continue;
        }

        const start = offset;
        const codepoint = next_codepoint(source, &offset);

        if (codepoint == 0x2028 or codepoint == 0x2029) {
            const terminator = source[start..offset];
            @memcpy(destination[written..][0..terminator.len], terminator);
            written += terminator.len;
            continue;
        }

        destination[written] = ' ';
        written += 1;
        if (codepoint > 0xffff) {
            destination[written] = ' ';
            written += 1;
        }
    }
    output.items.len += written;
}

/// Finds the first byte that cannot be erased as an ordinary ASCII space.
/// Vector blocks are only consumed when every byte is ASCII and none is a
/// preserved tab or line terminator, so UTF-8 decoding always resumes at an
/// original code-point boundary.
inline fn next_blanking_candidate(source: []const u8, start: usize) usize {
    var offset = start;
    if (std.simd.suggestVectorLength(u8)) |vector_len| {
        const ByteVector = @Vector(vector_len, u8);
        const high_bit: ByteVector = @splat(0x80);
        const tab: ByteVector = @splat('\t');
        const cr: ByteVector = @splat('\r');
        const lf: ByteVector = @splat('\n');
        while (offset + vector_len <= source.len) : (offset += vector_len) {
            const bytes: ByteVector = source[offset..][0..vector_len].*;
            const candidates = (bytes >= high_bit) |
                (bytes == tab) |
                (bytes == cr) |
                (bytes == lf);
            if (@reduce(.Or, candidates)) break;
        }
    }

    while (offset < source.len) : (offset += 1) {
        const byte = source[offset];
        if (byte >= 0x80 or byte == '\t' or byte == '\r' or byte == '\n') break;
    }
    return offset;
}

fn append_blanked_scalar(
    output: *std.ArrayList(u8),
    allocator: Allocator,
    source: []const u8,
) Allocator.Error!void {
    try output.ensureUnusedCapacity(allocator, source.len);
    const destination = output.unusedCapacitySlice();
    var written: usize = 0;
    var offset: usize = 0;

    while (offset < source.len) {
        const byte = source[offset];
        if (byte < 0x80) {
            destination[written] = switch (byte) {
                '\t', '\r', '\n' => byte,
                else => ' ',
            };
            written += 1;
            offset += 1;
            continue;
        }

        const start = offset;
        const codepoint = next_codepoint(source, &offset);
        if (codepoint == 0x2028 or codepoint == 0x2029) {
            const terminator = source[start..offset];
            @memcpy(destination[written..][0..terminator.len], terminator);
            written += terminator.len;
            continue;
        }

        destination[written] = ' ';
        written += 1;
        if (codepoint > 0xffff) {
            destination[written] = ' ';
            written += 1;
        }
    }
    output.items.len += written;
}

fn next_codepoint(source: []const u8, offset: *usize) u21 {
    const start = offset.*;
    const sequence_len = std.unicode.utf8ByteSequenceLength(source[start]) catch {
        offset.* += 1;
        return 0xfffd;
    };
    const end = start + sequence_len;
    if (end > source.len) {
        offset.* += 1;
        return 0xfffd;
    }

    const codepoint = std.unicode.utf8Decode(source[start..end]) catch {
        offset.* += 1;
        return 0xfffd;
    };
    offset.* = end;
    return codepoint;
}

test "utf16 width distinguishes BMP and astral code points" {
    try std.testing.expectEqual(@as(usize, 1), utf16_width("类"));
    try std.testing.expectEqual(@as(usize, 2), utf16_width("𝒳"));
    try std.testing.expectEqual(@as(usize, 3), utf16_width("类𝒳"));
}

test "blanking preserves tabs and ECMAScript line terminators" {
    const allocator = std.testing.allocator;
    const source = "A类𝒳\t\r\nB\u{2028}C\u{2029}";

    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(allocator);
    try append_blanked(&output, allocator, source);

    try std.testing.expectEqualStrings("    \t\r\n \u{2028} \u{2029}", output.items);
    try std.testing.expectEqual(utf16_width(source), utf16_width(output.items));
}

test "blanking appends after existing output without overwriting it" {
    const allocator = std.testing.allocator;
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(allocator);
    try output.appendSlice(allocator, "prefix:");
    try append_blanked(&output, allocator, "A类𝒳\t");
    try std.testing.expectEqualStrings("prefix:    \t", output.items);
}

test "vector blanking matches the scalar algorithm at every nearby boundary" {
    const allocator = std.testing.allocator;
    const vector_len = std.simd.suggestVectorLength(u8) orelse 16;
    const max_length = vector_len * 3 + 7;
    var source = try allocator.alloc(u8, max_length);
    defer allocator.free(source);

    for (source, 0..) |*byte, index| {
        byte.* = @truncate(index *% 131 +% 17);
    }

    var length: usize = 0;
    while (length <= source.len) : (length += 1) {
        var vector_output: std.ArrayList(u8) = .empty;
        defer vector_output.deinit(allocator);
        var scalar_output: std.ArrayList(u8) = .empty;
        defer scalar_output.deinit(allocator);

        try vector_output.appendSlice(allocator, "prefix:");
        try scalar_output.appendSlice(allocator, "prefix:");
        try append_blanked(&vector_output, allocator, source[0..length]);
        try append_blanked_scalar(&scalar_output, allocator, source[0..length]);
        try std.testing.expectEqualSlices(u8, scalar_output.items, vector_output.items);
    }
}

test "vector blanking preserves special sequences across vector boundaries" {
    const allocator = std.testing.allocator;
    const vector_len = std.simd.suggestVectorLength(u8) orelse 16;
    const sequences = [_][]const u8{
        "\r\n",
        "\u{2028}",
        "\u{2029}",
        "类",
        "𝒳",
        &.{0xf0},
        &.{ 0x80, 0xbf },
        &.{ 0xe2, 0x80 },
    };

    for (sequences) |sequence| {
        var position: usize = 0;
        while (position <= vector_len + 1) : (position += 1) {
            var source = try allocator.alloc(u8, position + sequence.len + vector_len + 1);
            defer allocator.free(source);
            @memset(source, 'x');
            @memcpy(source[position..][0..sequence.len], sequence);

            var vector_output: std.ArrayList(u8) = .empty;
            defer vector_output.deinit(allocator);
            var scalar_output: std.ArrayList(u8) = .empty;
            defer scalar_output.deinit(allocator);
            try append_blanked(&vector_output, allocator, source);
            try append_blanked_scalar(&scalar_output, allocator, source);
            try std.testing.expectEqualSlices(u8, scalar_output.items, vector_output.items);
        }
    }
}
