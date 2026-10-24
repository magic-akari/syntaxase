const std = @import("std");
const parser = @import("parser");
const source_layout = @import("source_layout.zig");

const Allocator = std.mem.Allocator;

/// Source-order lookup over Yuku's flat comment stream.
pub const CommentCursor = struct {
    source: []const u8,
    comments: []const parser.ast.Comment,

    pub fn init(source: []const u8, comments: []const parser.ast.Comment) CommentCursor {
        return .{ .source = source, .comments = comments };
    }

    pub fn append_range(
        self: *const CommentCursor,
        output: *std.ArrayList(u8),
        allocator: Allocator,
        start: u32,
        end: u32,
    ) Allocator.Error!void {
        if (start >= end) return;
        // Removing gaps cannot grow the range, except for one final synthetic newline.
        if (output.capacity - output.items.len > @as(usize, end) - start) {
            return self.append_range_with_capacity(output, allocator, start, end, true);
        }
        return self.append_range_with_capacity(output, allocator, start, end, false);
    }

    fn append_range_with_capacity(
        self: *const CommentCursor,
        output: *std.ArrayList(u8),
        allocator: Allocator,
        start: u32,
        end: u32,
        comptime spare_capacity: bool,
    ) Allocator.Error!void {
        var comments = self.iterate(start, end);
        while (comments.next_comment()) |comment| {
            const text = self.source[comment.span.start..comment.span.end];
            if (spare_capacity) output.appendSliceAssumeCapacity(text) else try output.appendSlice(allocator, text);
            if (comment.type != .line) continue;
            const ending = line_ending(self.source, comment.span.end, end).text;
            if (spare_capacity) output.appendSliceAssumeCapacity(ending) else try output.appendSlice(allocator, ending);
        }
    }

    /// Borrows whole comment text and the line endings needed by generated code.
    /// Contiguous comments share a chunk without copying their text.
    /// Each query is independent because runtime emitters may reorder source ranges.
    pub fn iterate(self: CommentCursor, start: u32, end: u32) Iterator {
        return .{
            .source = self.source,
            .remaining = if (start < end) self.comments[self.first_starting_at_or_after(start)..] else &.{},
            .end = end,
        };
    }

    pub const Iterator = struct {
        source: []const u8,
        remaining: []const parser.ast.Comment,
        end: u32,
        pending_terminator: []const u8 = &.{},

        pub fn next(self: *Iterator) ?[]const u8 {
            if (self.pending_terminator.len > 0) {
                const terminator = self.pending_terminator;
                self.pending_terminator = &.{};
                return terminator;
            }
            const comment = self.next_comment() orelse return null;
            var end = self.comment_end(comment);
            while (self.pending_terminator.len == 0 and self.remaining.len > 0) {
                const following = self.remaining[0];
                if (following.span.start != end or following.span.end > self.end) break;
                self.remaining = self.remaining[1..];
                end = self.comment_end(following);
            }
            return self.source[comment.span.start..end];
        }

        fn next_comment(self: *Iterator) ?parser.ast.Comment {
            while (self.remaining.len > 0) {
                const comment = self.remaining[0];
                self.remaining = self.remaining[1..];
                if (comment.span.start >= self.end) {
                    self.remaining = &.{};
                    return null;
                }
                if (comment.span.end > self.end) continue;
                return comment;
            }
            return null;
        }

        fn comment_end(self: *Iterator, comment: parser.ast.Comment) u32 {
            if (comment.type != .line) return comment.span.end;
            const ending = line_ending(self.source, comment.span.end, self.end);
            if (ending.source_len == 0) self.pending_terminator = ending.text;
            return comment.span.end + ending.source_len;
        }
    };

    fn line_ending(source: []const u8, start: u32, end: u32) struct { text: []const u8, source_len: u32 } {
        const terminator = source_layout.line_terminator_prefix(source[start..end]).bytes();
        return .{
            .text = if (terminator.len > 0) terminator else "\n",
            .source_len = @intCast(terminator.len),
        };
    }

    fn first_starting_at_or_after(self: *const CommentCursor, position: u32) usize {
        var low: usize = 0;
        var high = self.comments.len;
        while (low < high) {
            const middle = low + (high - low) / 2;
            if (self.comments[middle].span.start < position) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }
};

test "comment cursor starts at the requested range" {
    const allocator = std.testing.allocator;
    const source = "/* before */ const a = 1; // keep\nconst b = 2;";
    var tree = try parser.parse(allocator, source, .{ .comments = .collect });
    defer tree.deinit();

    const cursor = CommentCursor.init(source, tree.comments);
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(allocator);
    const start: u32 = @intCast(std.mem.indexOf(u8, source, "// keep").?);
    try cursor.append_range(&output, allocator, start, @intCast(source.len));
    try std.testing.expectEqualStrings("// keep\n", output.items);
}

test "comment iterator borrows text and preserves every line ending" {
    const allocator = std.testing.allocator;
    for ([_][]const u8{ "\n", "\r\n", "\r", "\u{2028}", "\u{2029}" }) |ending| {
        const source = try std.mem.concat(allocator, u8, &.{ "/* 类𝒳 */ // line", ending, " /* last *//* contiguous */" });
        defer allocator.free(source);
        const line = try std.mem.concat(allocator, u8, &.{ "// line", ending });
        defer allocator.free(line);
        var tree = try parser.parse(allocator, source, .{ .comments = .collect });
        defer tree.deinit();
        try std.testing.expectEqual(@as(usize, 4), tree.comments.len);

        const cursor = CommentCursor.init(source, tree.comments);
        var chunks = cursor.iterate(0, @intCast(source.len));
        for ([_][]const u8{ "/* 类𝒳 */", line, "/* last *//* contiguous */" }, 0..) |expected, index| {
            const text = chunks.next().?;
            try std.testing.expectEqualStrings(expected, text);
            try std.testing.expectEqual(@intFromPtr(source.ptr) + tree.comments[index].span.start, @intFromPtr(text.ptr));
        }
        try std.testing.expect(chunks.next() == null);
        try std.testing.expect(chunks.next() == null);
    }
}

test "comment iterator coalesces adjacent comments across line endings" {
    const allocator = std.testing.allocator;
    const source = "/* first */// line\r\n/* last *//* adjacent */";
    var tree = try parser.parse(allocator, source, .{ .comments = .collect });
    defer tree.deinit();
    var chunks = CommentCursor.init(source, tree.comments).iterate(0, @intCast(source.len));
    const text = chunks.next().?;
    try std.testing.expectEqualStrings(source, text);
    try std.testing.expectEqual(@intFromPtr(source.ptr), @intFromPtr(text.ptr));
    try std.testing.expect(chunks.next() == null);
}

test "comment iterator ranges remain independent and exclude partial comments" {
    const allocator = std.testing.allocator;
    const source = "/* first */ const x = 1; /* middle */ const y = 2; /* last */";
    var tree = try parser.parse(allocator, source, .{ .comments = .collect });
    defer tree.deinit();
    const cursor = CommentCursor.init(source, tree.comments);
    const first = tree.comments[0].span;
    const middle = tree.comments[1].span;
    const last = tree.comments[2].span;

    var tail = cursor.iterate(last.start, last.end);
    var head = cursor.iterate(first.start, first.end);
    try std.testing.expectEqualStrings("/* last */", tail.next().?);
    try std.testing.expectEqualStrings("/* first */", head.next().?);
    try std.testing.expect(tail.next() == null);
    try std.testing.expect(head.next() == null);

    var partial = cursor.iterate(first.start + 1, last.end - 1);
    try std.testing.expectEqualStrings("/* middle */", partial.next().?);
    try std.testing.expect(partial.next() == null);
    var gap = cursor.iterate(first.end, middle.start);
    try std.testing.expect(gap.next() == null);
    var empty = cursor.iterate(middle.start, middle.start);
    try std.testing.expect(empty.next() == null);
    var inverted = cursor.iterate(last.end, first.start);
    try std.testing.expect(inverted.next() == null);
    var absent = CommentCursor.init(source, &.{}).iterate(0, @intCast(source.len));
    try std.testing.expect(absent.next() == null);
}

test "comment ranges terminate line comments at range boundaries and EOF" {
    const allocator = std.testing.allocator;
    const source = "// first\r\n// last";
    var tree = try parser.parse(allocator, source, .{ .comments = .collect });
    defer tree.deinit();
    const cursor = CommentCursor.init(source, tree.comments);
    const first = tree.comments[0].span;
    const last = tree.comments[1].span;
    const cases = [_]struct { end: u32, expected: []const u8 }{
        .{ .end = first.end, .expected = "// first\n" },
        .{ .end = first.end + 1, .expected = "// first\r" },
        .{ .end = last.start, .expected = "// first\r\n" },
        .{ .end = last.end, .expected = "// first\r\n// last\n" },
    };
    for (cases) |case| {
        var output: std.ArrayList(u8) = .empty;
        defer output.deinit(allocator);
        try cursor.append_range(&output, allocator, 0, case.end);
        try std.testing.expectEqualStrings(case.expected, output.items);

        output.clearRetainingCapacity();
        var chunks = cursor.iterate(0, case.end);
        while (chunks.next()) |chunk| try output.appendSlice(allocator, chunk);
        try std.testing.expectEqualStrings(case.expected, output.items);
    }
}

test "comment range capacity bounds include the synthetic EOF newline" {
    const allocator = std.testing.allocator;
    const source = "// EOF";
    var tree = try parser.parse(allocator, source, .{ .comments = .collect });
    defer tree.deinit();
    const cursor = CommentCursor.init(source, tree.comments);
    for ([_]usize{ 0, source.len, source.len + 1, source.len + 32 }) |capacity| {
        var output: std.ArrayList(u8) = .empty;
        defer output.deinit(allocator);
        const prefix = "prefix: ";
        try output.ensureTotalCapacityPrecise(allocator, prefix.len + capacity);
        output.appendSliceAssumeCapacity(prefix);
        try cursor.append_range(&output, allocator, 0, @intCast(source.len));
        try std.testing.expectEqualStrings("prefix: // EOF\n", output.items);
    }
}
