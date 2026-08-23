const std = @import("std");
const parser = @import("parser");
const comment_cursor_module = @import("comment_cursor.zig");
const source_layout_module = @import("source_layout.zig");
const token_cursor_module = @import("token_cursor.zig");

const Allocator = std.mem.Allocator;

/// Parsed source and the lossless indexes used by Syntaxase transforms.
///
/// The Yuku tree owns the AST, tokens, comments, and diagnostics. The source
/// bytes remain borrowed from the caller for the lifetime of this value.
pub const SourceFile = struct {
    allocator: Allocator,
    tree: parser.ast.Tree,
    layout: ?source_layout_module.SourceLayout = null,

    pub fn parse(
        allocator: Allocator,
        source_text: []const u8,
        lang: parser.ast.Lang,
    ) Allocator.Error!SourceFile {
        var tree = try parser.parse(allocator, source_text, .{
            .source_type = .module,
            .lang = lang,
            .preserve_parens = true,
            .comments = .flat,
            .tokens = true,
        });
        errdefer tree.deinit();

        return .{
            .allocator = allocator,
            .tree = tree,
        };
    }

    pub fn deinit(self: *SourceFile) void {
        if (self.layout) |*layout| layout.deinit(self.allocator);
        self.tree.deinit();
    }

    pub fn ensure_layout(self: *SourceFile) Allocator.Error!void {
        if (self.layout != null) return;
        self.layout = try source_layout_module.SourceLayout.init(self.allocator, self.source());
    }

    pub fn source_layout(self: *const SourceFile) *const source_layout_module.SourceLayout {
        return &self.layout.?;
    }

    pub fn source(self: *const SourceFile) []const u8 {
        return self.tree.source;
    }

    pub fn token_cursor(self: *const SourceFile) token_cursor_module.TokenCursor {
        return token_cursor_module.TokenCursor.init(self.tree.source, self.tree.tokens);
    }

    pub fn comment_cursor(self: *const SourceFile) comment_cursor_module.CommentCursor {
        return comment_cursor_module.CommentCursor.init(self.tree.source, self.tree.comments);
    }
};

test "source file collects parser-authoritative tokens and comments" {
    const allocator = std.testing.allocator;
    const source = "const value: Foo /* keep */ = input;";
    var file = try SourceFile.parse(allocator, source, .ts);
    defer file.deinit();

    try std.testing.expect(file.tree.tokens.len > 0);
    try std.testing.expectEqual(@as(usize, 1), file.tree.comments.len);

    var cursor = file.token_cursor();
    cursor.seek(11);
    try std.testing.expect(cursor.current_is(":"));
}

test "source file preserves Yuku diagnostics without rejecting the tree" {
    const allocator = std.testing.allocator;
    const source = "const = ;";
    var file = try SourceFile.parse(allocator, source, .ts);
    defer file.deinit();

    try std.testing.expect(file.tree.hasErrors());
    try std.testing.expect(file.tree.tokens.len > 0);
}

test "source file layout shares native byte coordinates" {
    const allocator = std.testing.allocator;
    const source = "类\nconst value = 1;";
    var file = try SourceFile.parse(allocator, source, .ts);
    defer file.deinit();
    try file.ensure_layout();

    try std.testing.expectEqual(@as(usize, 1), file.source_layout().line_at_offset(4));
}

test "source file receives decoded escaped identifier names from Yuku" {
    const allocator = std.testing.allocator;
    var file = try SourceFile.parse(allocator, "const _\\u006Asx = 1;", .ts);
    defer file.deinit();

    try std.testing.expect(!file.tree.hasErrors());
    for (file.tree.nodes.items(.data)) |data| {
        if (data != .binding_identifier) continue;
        const name = file.tree.string(data.binding_identifier.name);
        if (std.mem.eql(u8, name, "_jsx")) return;
    }
    return error.TestExpectedEqual;
}
