const std = @import("std");
const parser = @import("parser");

const Token = parser.ast.Token;
const TokenTag = parser.ast.TokenTag;
const Span = parser.ast.Span;

/// Allocation-free queries over Yuku's final native tokens in UTF-8 coordinates.
/// Source ranges are half-open and contain only whole tokens. Trivia and the
/// trailing EOF sentinel are excluded. The tree owns the borrowed token storage.
pub const TokenIndex = struct {
    source: []const u8,
    tokens: []const Token,

    pub fn init(source: []const u8, tokens: []const Token) TokenIndex {
        const end = if (tokens.len > 0 and tokens[tokens.len - 1].tag == .eof)
            tokens.len - 1
        else
            tokens.len;
        return .{ .source = source, .tokens = tokens[0..end] };
    }

    /// Returns a borrowed slice of the tokens fully contained in `span`.
    pub fn range(self: TokenIndex, span: Span) []const Token {
        const from = self.lower_bound(.start, span.start);
        if (span.end <= span.start) return self.tokens[from..from];
        const to = self.upper_bound(.end, span.end);
        return self.tokens[from..@max(from, to)];
    }

    pub fn first(self: TokenIndex, span: Span) ?Token {
        const token = self.after(span.start) orelse return null;
        return if (token.span.end <= span.end) token else null;
    }

    pub fn last(self: TokenIndex, span: Span) ?Token {
        const token = self.before(span.end) orelse return null;
        return if (token.span.start >= span.start) token else null;
    }

    /// Last token ending at or before the offset, including adjacent tokens.
    pub fn before(self: TokenIndex, offset: u32) ?Token {
        const end = self.upper_bound(.end, offset);
        return if (end == 0) null else self.tokens[end - 1];
    }

    /// First token starting at or after the offset; never a containing token.
    pub fn after(self: TokenIndex, offset: u32) ?Token {
        const start = self.lower_bound(.start, offset);
        return if (start == self.tokens.len) null else self.tokens[start];
    }

    /// Token containing the offset, or null in trivia and at EOF.
    pub fn at(self: TokenIndex, offset: u32) ?Token {
        const end = self.upper_bound(.start, offset);
        if (end == 0) return null;
        const token = self.tokens[end - 1];
        return if (offset < token.span.end) token else null;
    }

    pub fn find_first(self: TokenIndex, span: Span, tag: TokenTag) ?Token {
        var iterator = self.iterate(span);
        while (iterator.next()) |token| {
            if (token.tag == tag) return token;
        }
        return null;
    }

    /// Locates the start once; the end is checked lazily while scanning.
    pub fn iterate(self: TokenIndex, span: Span) Iterator {
        const start = self.lower_bound(.start, span.start);
        return .{ .remaining = self.tokens[start..], .end = span.end };
    }

    pub const Iterator = struct {
        remaining: []const Token,
        end: u32,

        pub fn next(self: *Iterator) ?Token {
            if (self.remaining.len == 0) return null;
            const token = self.remaining[0];
            if (token.span.end > self.end) {
                self.remaining = &.{};
                return null;
            }
            self.remaining = self.remaining[1..];
            return token;
        }
    };

    pub fn find_last(self: TokenIndex, span: Span, tag: TokenTag) ?Token {
        var end = self.upper_bound(.end, span.end);
        while (end > 0) {
            end -= 1;
            const token = self.tokens[end];
            if (token.span.start < span.start) break;
            if (token.tag == tag) return token;
        }
        return null;
    }

    const Column = enum { start, end };

    fn lower_bound(self: TokenIndex, comptime column: Column, offset: u32) usize {
        return self.bound(column, false, offset);
    }

    fn upper_bound(self: TokenIndex, comptime column: Column, offset: u32) usize {
        return self.bound(column, true, offset);
    }

    fn bound(self: TokenIndex, comptime column: Column, comptime inclusive: bool, offset: u32) usize {
        var low: usize = 0;
        var high = self.tokens.len;
        while (low < high) {
            const middle = low + (high - low) / 2;
            const position = @field(self.tokens[middle].span, @tagName(column));
            const advance = if (inclusive) position <= offset else position < offset;
            if (advance) low = middle + 1 else high = middle;
        }
        return low;
    }
};

test "queries distinguish containment, adjacency, trivia, and EOF" {
    const source = "foo(a); /* trailing */";
    var tree = try parser.parse(std.testing.allocator, source, .{ .tokens = true });
    defer tree.deinit();
    const tokens = TokenIndex.init(source, tree.tokens);
    try std.testing.expectEqual(.eof, tree.tokens[tree.tokens.len - 1].tag);
    try std.testing.expectEqual(tree.tokens.len - 1, tokens.tokens.len);
    try std.testing.expectEqual(.left_paren, tokens.before(4).?.tag);
    try std.testing.expectEqual(.right_paren, tokens.after(5).?.tag);
    try std.testing.expectEqual(.identifier, tokens.at(1).?.tag);
    try std.testing.expectEqual(.left_paren, tokens.after(1).?.tag);
    try std.testing.expect(tokens.before(0) == null);
    try std.testing.expect(tokens.at(7) == null);
    const end: u32 = @intCast(source.len);
    try std.testing.expect(tokens.at(end) == null);
    try std.testing.expect(tokens.after(end) == null);
    try std.testing.expectEqual(.semicolon, tokens.before(end).?.tag);
    try std.testing.expectEqual(@as(usize, 0), tokens.range(.{ .start = end, .end = end + 1 }).len);
}

test "ranges contain whole tokens and support native tag searches" {
    const source = "foo(a, /* keep */ b);";
    var tree = try parser.parse(std.testing.allocator, source, .{ .tokens = true });
    defer tree.deinit();
    const tokens = TokenIndex.init(source, tree.tokens);
    const span: Span = .{ .start = 4, .end = 19 };
    try std.testing.expectEqual(@as(usize, 3), tokens.range(span).len);
    try std.testing.expectEqualStrings("a", tokens.first(span).?.text(source));
    try std.testing.expectEqualStrings("b", tokens.last(span).?.text(source));
    try std.testing.expectEqual(@as(u32, 5), tokens.find_first(span, .comma).?.span.start);
    try std.testing.expectEqual(@as(u32, 18), tokens.find_last(span, .identifier).?.span.start);
    try std.testing.expectEqual(@as(usize, 0), tokens.range(.{ .start = 1, .end = 2 }).len);
    try std.testing.expect(tokens.first(.{ .start = 4, .end = 4 }) == null);
    try std.testing.expect(tokens.last(.{ .start = 5, .end = 4 }) == null);
}

test "empty and trivia-only sources have no queryable tokens" {
    for ([_][]const u8{ "", " /* trivia */ " }) |source| {
        var tree = try parser.parse(std.testing.allocator, source, .{ .tokens = true });
        defer tree.deinit();
        const tokens = TokenIndex.init(source, tree.tokens);
        try std.testing.expectEqual(@as(usize, 0), tokens.tokens.len);
        try std.testing.expect(tokens.at(0) == null);
        try std.testing.expect(tokens.after(0) == null);
        try std.testing.expect(tokens.before(@intCast(source.len)) == null);
    }
}

test "queries preserve parser rescans, speculative rollback, flags, and byte positions" {
    const source = "let x: A<B<C>> = y;\nconst r = /ab+/gi;\n`a${x}b`;\n类 << 1;";
    var tree = try parser.parse(std.testing.allocator, source, .{ .lang = .ts, .tokens = true });
    defer tree.deinit();
    try std.testing.expect(!tree.hasErrors());
    const tokens = TokenIndex.init(source, tree.tokens);
    const span: Span = .{ .start = 0, .end = @intCast(source.len) };
    const closer = tokens.find_first(span, .greater_than).?;
    try std.testing.expectEqual(.greater_than, tokens.after(closer.span.end).?.tag);
    try std.testing.expect(tokens.find_first(span, .right_shift) == null);
    try std.testing.expectEqualStrings("/ab+/gi", tokens.find_first(span, .regex_literal).?.text(source));
    try std.testing.expect(tokens.find_first(span, .template_head).?.hasLineTerminatorBefore());
    const shift = tokens.find_first(span, .left_shift).?;
    const name = tokens.before(shift.span.start).?;
    try std.testing.expectEqualStrings("类", name.text(source));
    try std.testing.expectEqual(@as(u32, 3), name.span.end - name.span.start);
}

test "JSX and escaped contextual keywords retain their native kinds" {
    const source = "var \\u0061sync = <x title=\"a\">body</x>;";
    var tree = try parser.parse(std.testing.allocator, source, .{ .lang = .tsx, .tokens = true });
    defer tree.deinit();
    try std.testing.expect(!tree.hasErrors());
    const tokens = TokenIndex.init(source, tree.tokens);
    const span: Span = .{ .start = 0, .end = @intCast(source.len) };
    const name = tokens.find_first(span, .async).?;
    try std.testing.expect(name.isEscaped());
    try std.testing.expectEqualStrings("\\u0061sync", name.text(source));
    try std.testing.expectEqualStrings("body", tokens.find_first(span, .jsx_text).?.text(source));
    try std.testing.expectEqualStrings("\"a\"", tokens.find_first(span, .string_literal).?.text(source));
}

test "endpoint and directional queries agree with whole-token containment at every byte boundary" {
    const source = "foo(类, /* keep */ `a${b}`);";
    var tree = try parser.parse(std.testing.allocator, source, .{ .tokens = true });
    defer tree.deinit();
    const index = TokenIndex.init(source, tree.tokens);
    for (0..source.len + 2) |start| {
        for (0..source.len + 2) |end| {
            const span: Span = .{ .start = @intCast(start), .end = @intCast(end) };
            var first_token: ?Token = null;
            var last_token: ?Token = null;
            var iterator = index.iterate(span);
            for (index.tokens) |token| {
                if (token.span.start < start or token.span.end > end) continue;
                if (first_token == null) first_token = token;
                last_token = token;
                try std.testing.expectEqualDeep(@as(?Token, token), iterator.next());
            }
            try std.testing.expect(iterator.next() == null);
            try std.testing.expect(iterator.next() == null);
            try std.testing.expectEqualDeep(first_token, index.first(span));
            try std.testing.expectEqualDeep(last_token, index.last(span));
            for ([_]TokenTag{ .identifier, .comma, .template_head, .eof }) |tag| {
                var first_match: ?Token = null;
                var last_match: ?Token = null;
                for (index.tokens) |token| {
                    if (token.span.start < start or token.span.end > end or token.tag != tag) continue;
                    if (first_match == null) first_match = token;
                    last_match = token;
                }
                try std.testing.expectEqualDeep(first_match, index.find_first(span, tag));
                try std.testing.expectEqualDeep(last_match, index.find_last(span, tag));
            }
        }
    }
}
