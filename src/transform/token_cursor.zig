const std = @import("std");
const parser = @import("parser");

const Token = parser.ast.Token;

/// Allocation-free cursor over the parser-authoritative Yuku token stream.
///
/// Whitespace and comments are not tokens. Seeking into trivia selects the
/// following token; seeking inside a token selects that token.
pub const TokenCursor = struct {
    source: []const u8,
    tokens: []const Token,
    index: usize = 0,

    pub fn init(source: []const u8, tokens: []const Token) TokenCursor {
        return .{
            .source = source,
            .tokens = tokens,
        };
    }

    /// Positions the cursor at the token containing `position`, or at the
    /// first token following it when `position` lies in trivia.
    pub fn seek(self: *TokenCursor, position: u32) void {
        self.index = self.index_containing_or_after(position);
    }

    pub fn current(self: *const TokenCursor) ?Token {
        if (self.index >= self.tokens.len) return null;
        return self.tokens[self.index];
    }

    pub fn current_text(self: *const TokenCursor) ?[]const u8 {
        const token = self.current() orelse return null;
        return self.text(token);
    }

    pub fn current_is(self: *const TokenCursor, expected: []const u8) bool {
        const actual = self.current_text() orelse return false;
        return std.mem.eql(u8, actual, expected);
    }

    /// Returns the first parser token fully contained in the byte interval.
    pub fn first_in_range(self: *const TokenCursor, start: u32, end: u32) ?Token {
        var index = self.index_containing_or_after(start);
        while (index < self.tokens.len) : (index += 1) {
            const token = self.tokens[index];
            if (token.span.start >= end) return null;
            if (token.span.start >= start and token.span.end <= end) return token;
        }
        return null;
    }

    /// Returns the last parser token fully contained in the byte interval.
    pub fn last_in_range(self: *const TokenCursor, start: u32, end: u32) ?Token {
        var index = self.index_starting_at_or_after(end);
        while (index > 0) {
            index -= 1;
            const token = self.tokens[index];
            if (token.span.end <= start) return null;
            if (token.span.start >= start and token.span.end <= end) return token;
        }
        return null;
    }

    /// Finds the first matching token fully contained in the byte interval.
    pub fn find_forward(
        self: *const TokenCursor,
        start: u32,
        end: u32,
        expected: []const u8,
    ) ?Token {
        var index = self.index_containing_or_after(start);

        while (index < self.tokens.len) : (index += 1) {
            const token = self.tokens[index];
            if (token.span.start >= end) return null;
            if (token.span.start < start or token.span.end > end) continue;
            if (std.mem.eql(u8, self.text(token), expected)) return token;
        }
        return null;
    }

    /// Finds the last matching token fully contained in the byte interval.
    pub fn find_backward(
        self: *const TokenCursor,
        start: u32,
        end: u32,
        expected: []const u8,
    ) ?Token {
        var index = self.index_starting_at_or_after(end);

        while (index > 0) {
            index -= 1;
            const token = self.tokens[index];
            if (token.span.end <= start) return null;
            if (token.span.start < start or token.span.end > end) continue;
            if (std.mem.eql(u8, self.text(token), expected)) return token;
        }
        return null;
    }

    pub fn move_next(self: *TokenCursor) bool {
        if (self.index >= self.tokens.len) return false;
        self.index += 1;
        return self.index < self.tokens.len;
    }

    pub fn move_previous(self: *TokenCursor) bool {
        if (self.index == 0) return false;
        self.index -= 1;
        return true;
    }

    pub fn text(self: *const TokenCursor, token: Token) []const u8 {
        return self.source[token.span.start..token.span.end];
    }

    fn index_containing_or_after(self: *const TokenCursor, position: u32) usize {
        var low: usize = 0;
        var high: usize = self.tokens.len;

        while (low < high) {
            const middle = low + (high - low) / 2;
            if (self.tokens[middle].span.end <= position) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }

    fn index_starting_at_or_after(self: *const TokenCursor, position: u32) usize {
        var low: usize = 0;
        var high: usize = self.tokens.len;

        while (low < high) {
            const middle = low + (high - low) / 2;
            if (self.tokens[middle].span.start < position) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }
};

test "seek selects a containing or following token" {
    const source = "const value: Foo = input;";
    var tree = try parser.parse(std.testing.allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    var cursor = TokenCursor.init(source, tree.tokens);

    cursor.seek(6);
    try std.testing.expectEqualStrings("value", cursor.current_text().?);

    cursor.seek(11);
    try std.testing.expect(cursor.current_is(":"));

    cursor.seek(12);
    try std.testing.expect(cursor.current_is("Foo"));

    cursor.seek(@intCast(source.len));
    try std.testing.expect(cursor.current() == null);
}

test "cursor moves across parser-rescanned TypeScript tokens" {
    const source = "a?.b<T>; q = p << 1 >> 2;";
    var tree = try parser.parse(std.testing.allocator, source, .{
        .lang = .ts,
        .comments = .none,
        .tokens = true,
    });
    defer tree.deinit();

    var cursor = TokenCursor.init(source, tree.tokens);
    cursor.seek(4);

    try std.testing.expect(cursor.current_is("<"));
    try std.testing.expect(cursor.move_next());
    try std.testing.expect(cursor.current_is("T"));
    try std.testing.expect(cursor.move_next());
    try std.testing.expect(cursor.current_is(">"));

    cursor.seek(15);
    try std.testing.expect(cursor.current_is("<<"));
    try std.testing.expect(cursor.move_previous());
    try std.testing.expect(cursor.current_is("p"));
}

test "cursor uses Yuku JSX token boundaries" {
    const source = "const node = <x title=\"a\">body</x>;";
    var tree = try parser.parse(std.testing.allocator, source, .{
        .lang = .tsx,
        .comments = .none,
        .tokens = true,
    });
    defer tree.deinit();

    var cursor = TokenCursor.init(source, tree.tokens);
    cursor.seek(16);
    try std.testing.expect(cursor.current_is("title"));

    cursor.seek(24);
    try std.testing.expect(cursor.current_is("\"a\""));

    cursor.seek(28);
    try std.testing.expect(cursor.current_is("body"));
}

test "range lookup skips comments and respects direction" {
    const source = "import { A, /* keep */ type B, C } from \"m\";";
    var tree = try parser.parse(std.testing.allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    const cursor = TokenCursor.init(source, tree.tokens);
    const forward = cursor.find_forward(0, @intCast(source.len), ",").?;
    const backward = cursor.find_backward(0, @intCast(source.len), ",").?;

    try std.testing.expectEqualStrings(",", cursor.text(forward));
    try std.testing.expectEqual(@as(u32, 10), forward.span.start);
    try std.testing.expectEqualStrings(",", cursor.text(backward));
    try std.testing.expectEqual(@as(u32, 29), backward.span.start);
}

test "range endpoints come from the final parser token stream" {
    const source = "type Result = Box<Foo>;";
    var tree = try parser.parse(std.testing.allocator, source, .{
        .lang = .ts,
        .comments = .flat,
        .tokens = true,
    });
    defer tree.deinit();

    const cursor = TokenCursor.init(source, tree.tokens);
    const first = cursor.first_in_range(5, 22).?;
    const last = cursor.last_in_range(5, 22).?;
    try std.testing.expectEqualStrings("Result", cursor.text(first));
    try std.testing.expectEqualStrings(">", cursor.text(last));
}
