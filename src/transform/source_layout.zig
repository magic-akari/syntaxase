const std = @import("std");

const Allocator = std.mem.Allocator;

pub const LineTerminator = enum {
    none,
    lf,
    cr,
    crlf,
    line_separator,
    paragraph_separator,

    pub fn bytes(self: LineTerminator) []const u8 {
        return switch (self) {
            .none => "",
            .lf => "\n",
            .cr => "\r",
            .crlf => "\r\n",
            .line_separator => "\u{2028}",
            .paragraph_separator => "\u{2029}",
        };
    }
};

/// One ECMAScript physical line in original UTF-8 byte coordinates.
pub const PhysicalLine = struct {
    index: u32,
    start: u32,
    content_end: u32,
    end: u32,
    terminator: LineTerminator,
};

pub const SourceAnchor = struct {
    offset: u32,
    line: u32,
};

/// Allocation-free physical-line cursor for monotonically increasing source
/// offsets or line indices. It keeps only the current line and scans source
/// bytes with the same SIMD/SWAR terminator search used by `SourceLayout`.
pub const SourceCursor = struct {
    source: []const u8,
    current: PhysicalLine,
    first_terminator: LineTerminator,

    pub fn init(source: []const u8) SourceCursor {
        std.debug.assert(source.len <= std.math.maxInt(u32));
        const first = scan_physical_line(source, 0, 0);
        return .{
            .source = source,
            .current = first,
            .first_terminator = first.terminator,
        };
    }

    pub fn line_at_offset(self: *SourceCursor, offset: u32) PhysicalLine {
        std.debug.assert(offset <= self.source.len);
        std.debug.assert(offset >= self.current.start);
        while (self.current.terminator != .none and self.current.end <= offset) {
            self.advance();
        }
        return self.current;
    }

    pub fn line_at_index(self: *SourceCursor, index: u32) PhysicalLine {
        std.debug.assert(index >= self.current.index);
        while (self.current.index < index) self.advance();
        return self.current;
    }

    pub fn line_ending(self: *const SourceCursor, line: PhysicalLine) []const u8 {
        const local = line.terminator.bytes();
        if (local.len > 0) return local;
        return self.preferred_line_ending();
    }

    pub fn preferred_line_ending(self: *const SourceCursor) []const u8 {
        const first = self.first_terminator.bytes();
        return if (first.len > 0) first else "\n";
    }

    fn advance(self: *SourceCursor) void {
        std.debug.assert(self.current.terminator != .none);
        self.current = scan_physical_line(
            self.source,
            self.current.end,
            self.current.index + 1,
        );
    }
};

/// Physical-line index over the original source.
pub const SourceLayout = struct {
    lines: std.ArrayList(PhysicalLine) = .empty,
    source_len: u32,

    pub fn init(allocator: Allocator, source: []const u8) Allocator.Error!SourceLayout {
        std.debug.assert(source.len <= std.math.maxInt(u32));

        var layout: SourceLayout = .{
            .source_len = @intCast(source.len),
        };
        errdefer layout.deinit(allocator);

        while (true) {
            const start: u32 = if (layout.lines.getLastOrNull()) |last| last.end else 0;
            const line = scan_physical_line(
                source,
                start,
                @intCast(layout.lines.items.len),
            );
            try layout.lines.append(allocator, line);
            if (line.terminator == .none) break;
        }

        return layout;
    }

    pub fn deinit(self: *SourceLayout, allocator: Allocator) void {
        self.lines.deinit(allocator);
    }

    pub fn line_at_offset(self: *const SourceLayout, offset: u32) usize {
        std.debug.assert(offset <= self.source_len);

        var low: usize = 0;
        var high: usize = self.lines.items.len;

        while (low < high) {
            const middle = low + (high - low) / 2;
            const line = self.lines.items[middle];

            if (line.end <= offset and middle + 1 < self.lines.items.len) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }

        return @min(low, self.lines.items.len - 1);
    }

    pub fn local_line_ending(self: *const SourceLayout, line: usize) []const u8 {
        const local = self.lines.items[line].terminator.bytes();
        if (local.len > 0) return local;
        for (self.lines.items) |candidate| {
            const ending = candidate.terminator.bytes();
            if (ending.len > 0) return ending;
        }
        return "\n";
    }
};

fn scan_physical_line(source: []const u8, start: u32, index: u32) PhysicalLine {
    var offset: usize = start;
    while (true) {
        offset = next_terminator_candidate(source, offset);
        if (offset >= source.len) {
            return .{
                .index = index,
                .start = start,
                .content_end = @intCast(source.len),
                .end = @intCast(source.len),
                .terminator = .none,
            };
        }
        const terminator = terminator_at(source, offset);
        if (terminator == .none) {
            offset += 1;
            continue;
        }
        const terminator_len = terminator.bytes().len;
        return .{
            .index = index,
            .start = start,
            .content_end = @intCast(offset),
            .end = @intCast(offset + terminator_len),
            .terminator = terminator,
        };
    }
}

pub fn contains_line_terminator(source: []const u8) bool {
    var offset: usize = 0;
    while (true) {
        offset = next_terminator_candidate(source, offset);
        if (offset >= source.len) return false;
        if (terminator_at(source, offset) != .none) return true;
        offset += 1;
    }
}

pub fn line_terminator_prefix(source: []const u8) LineTerminator {
    if (source.len == 0) return .none;
    return terminator_at(source, 0);
}

pub fn ends_with_line_terminator(source: []const u8) bool {
    if (source.len == 0) return false;
    return switch (source[source.len - 1]) {
        '\r', '\n' => true,
        0xa8, 0xa9 => source.len >= 3 and
            line_terminator_prefix(source[source.len - 3 ..]) != .none,
        else => false,
    };
}

pub fn count_line_terminators(source: []const u8) usize {
    var count: usize = 0;
    var offset: usize = 0;
    while (true) {
        offset = next_terminator_candidate(source, offset);
        if (offset >= source.len) return count;
        const terminator = terminator_at(source, offset);
        if (terminator == .none) {
            offset += 1;
            continue;
        }
        count += 1;
        offset += terminator.bytes().len;
    }
}

fn terminator_at(source: []const u8, offset: usize) LineTerminator {
    return switch (source[offset]) {
        '\n' => .lf,
        '\r' => if (offset + 1 < source.len and source[offset + 1] == '\n') .crlf else .cr,
        0xe2 => unicode_terminator_at(source, offset),
        else => .none,
    };
}

/// Skips ASCII runs eight bytes at a time. The zero-byte trick detects LF,
/// CR, or the first byte of U+2028/U+2029 without platform-specific intrinsics;
/// LLVM lowers this SWAR path efficiently on both AArch64 and x86-64.
inline fn next_terminator_candidate(source: []const u8, start: usize) usize {
    var offset = start;
    if (std.simd.suggestVectorLength(u8)) |vector_len| {
        const ByteVector = @Vector(vector_len, u8);
        const lf: ByteVector = @splat('\n');
        const cr: ByteVector = @splat('\r');
        const e2: ByteVector = @splat(0xe2);
        while (offset + vector_len <= source.len) : (offset += vector_len) {
            const bytes: ByteVector = source[offset..][0..vector_len].*;
            const candidates = (bytes == lf) | (bytes == cr) | (bytes == e2);
            if (@reduce(.Or, candidates)) break;
        }
    }

    const repeated_01: u64 = 0x0101_0101_0101_0101;
    const high_bits: u64 = 0x8080_8080_8080_8080;
    const lf: u64 = repeated_01 * '\n';
    const cr: u64 = repeated_01 * '\r';
    const e2: u64 = repeated_01 * 0xe2;

    while (offset + @sizeOf(u64) <= source.len) : (offset += @sizeOf(u64)) {
        const word = std.mem.readInt(u64, source[offset..][0..@sizeOf(u64)], .little);
        const candidates = zero_byte_mask(word ^ lf, repeated_01, high_bits) |
            zero_byte_mask(word ^ cr, repeated_01, high_bits) |
            zero_byte_mask(word ^ e2, repeated_01, high_bits);
        if (candidates != 0) break;
    }
    while (offset < source.len) : (offset += 1) {
        const byte = source[offset];
        if (byte == '\n' or byte == '\r' or byte == 0xe2) break;
    }
    return offset;
}

inline fn zero_byte_mask(value: u64, repeated_01: u64, high_bits: u64) u64 {
    return (value -% repeated_01) & ~value & high_bits;
}

inline fn unicode_terminator_at(source: []const u8, offset: usize) LineTerminator {
    if (offset + 2 >= source.len or source[offset + 1] != 0x80) return .none;
    return switch (source[offset + 2]) {
        0xa8 => .line_separator,
        0xa9 => .paragraph_separator,
        else => .none,
    };
}

test "source layout retains every ECMAScript line terminator" {
    const allocator = std.testing.allocator;
    const source = "a\r\nb\rc\n类\u{2028}d\u{2029}";
    var layout = try SourceLayout.init(allocator, source);
    defer layout.deinit(allocator);

    try std.testing.expectEqual(@as(usize, 6), layout.lines.items.len);
    try std.testing.expectEqual(LineTerminator.crlf, layout.lines.items[0].terminator);
    try std.testing.expectEqual(LineTerminator.cr, layout.lines.items[1].terminator);
    try std.testing.expectEqual(LineTerminator.lf, layout.lines.items[2].terminator);
    try std.testing.expectEqual(LineTerminator.line_separator, layout.lines.items[3].terminator);
    try std.testing.expectEqual(LineTerminator.paragraph_separator, layout.lines.items[4].terminator);
    try std.testing.expectEqual(LineTerminator.none, layout.lines.items[5].terminator);
}

test "line lookup uses UTF-8 byte offsets" {
    const allocator = std.testing.allocator;
    const source = "类\nnext";
    var layout = try SourceLayout.init(allocator, source);
    defer layout.deinit(allocator);

    try std.testing.expectEqual(@as(usize, 0), layout.line_at_offset(0));
    try std.testing.expectEqual(@as(usize, 0), layout.line_at_offset(3));
    try std.testing.expectEqual(@as(usize, 1), layout.line_at_offset(4));
}

test "source cursor matches indexed layout for monotonic offsets" {
    const allocator = std.testing.allocator;
    const source = "a\r\nb\rc\n类\u{2028}d\u{2029}";
    var layout = try SourceLayout.init(allocator, source);
    defer layout.deinit(allocator);
    var cursor = SourceCursor.init(source);

    var offset: u32 = 0;
    while (offset <= source.len) : (offset += 1) {
        const expected = layout.lines.items[layout.line_at_offset(offset)];
        const actual = cursor.line_at_offset(offset);
        try std.testing.expectEqualDeep(expected, actual);
    }
    try std.testing.expectEqualStrings("\r\n", cursor.preferred_line_ending());
}

test "line terminator helpers recognize prefixes and suffixes" {
    try std.testing.expectEqual(LineTerminator.crlf, line_terminator_prefix("\r\nrest"));
    try std.testing.expectEqual(LineTerminator.line_separator, line_terminator_prefix("\u{2028}rest"));
    try std.testing.expectEqual(LineTerminator.none, line_terminator_prefix("rest"));
    try std.testing.expect(ends_with_line_terminator("line\n"));
    try std.testing.expect(ends_with_line_terminator("line\u{2029}"));
    try std.testing.expect(!ends_with_line_terminator("line"));
}
