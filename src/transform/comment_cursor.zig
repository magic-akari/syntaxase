const std = @import("std");
const parser = @import("parser");

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
        var index = self.first_starting_at_or_after(start);
        while (index < self.comments.len) : (index += 1) {
            const comment = self.comments[index];
            if (comment.span.start >= end) break;
            if (comment.span.end > end) continue;
            try output.appendSlice(allocator, self.source[comment.span.start..comment.span.end]);
            if (comment.type != .line) continue;

            const terminator = line_terminator_at(self.source, comment.span.end, end);
            try output.appendSlice(allocator, if (terminator.len > 0) terminator else "\n");
        }
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

fn line_terminator_at(source: []const u8, start: u32, end: u32) []const u8 {
    if (start >= end) return "";
    const remaining = source[start..end];
    if (std.mem.startsWith(u8, remaining, "\r\n")) return "\r\n";
    if (std.mem.startsWith(u8, remaining, "\r")) return "\r";
    if (std.mem.startsWith(u8, remaining, "\n")) return "\n";
    if (std.mem.startsWith(u8, remaining, "\u{2028}")) return "\u{2028}";
    if (std.mem.startsWith(u8, remaining, "\u{2029}")) return "\u{2029}";
    return "";
}

test "comment cursor starts at the requested range" {
    const allocator = std.testing.allocator;
    const source = "/* before */ const a = 1; // keep\nconst b = 2;";
    var tree = try parser.parse(allocator, source, .{ .comments = .flat });
    defer tree.deinit();

    const cursor = CommentCursor.init(source, tree.comments);
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(allocator);
    const start: u32 = @intCast(std.mem.indexOf(u8, source, "// keep").?);
    try cursor.append_range(&output, allocator, start, @intCast(source.len));
    try std.testing.expectEqualStrings("// keep\n", output.items);
}
