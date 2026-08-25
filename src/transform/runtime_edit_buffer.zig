const std = @import("std");
const fixed_edit_buffer = @import("fixed_edit_buffer.zig");
const source_layout = @import("source_layout.zig");
const unicode = @import("unicode.zig");

const Allocator = std.mem.Allocator;
const FixedEditPlan = fixed_edit_buffer.FixedEditPlan;

pub const Span = struct {
    start: u32,
    end: u32,
};

pub const FragmentPiece = union(enum) {
    /// Borrowed generated text. Runtime fragments never outlive the source,
    /// transform options, or generated-name allocator they borrow from.
    generated: []const u8,
    /// Dynamically formatted generated text owned by the fragment.
    owned_generated: []u8,
    original: Span,
    /// Zero-width marker used by layout-aware runtime emitters. The renderer
    /// aligns generated content with this original source position.
    line_head: source_layout.SourceAnchor,
    /// Pads removed multiline source through the anchor after unchanged
    /// suffix text on the ending line has already been emitted.
    source_padding: source_layout.SourceAnchor,
};

/// Structured runtime output. Static generated pieces borrow their text,
/// dynamically generated pieces own it, and original pieces retain source
/// provenance. This lets nested runtime replacements compose without copying
/// every punctuation token into a separate allocation.
pub const RuntimeFragment = struct {
    allocator: Allocator,
    pieces: std.ArrayList(FragmentPiece) = .empty,

    pub fn init(allocator: Allocator) RuntimeFragment {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *RuntimeFragment) void {
        for (self.pieces.items) |piece| switch (piece) {
            .owned_generated => |text| self.allocator.free(text),
            .generated, .original, .line_head, .source_padding => {},
        };
        self.pieces.deinit(self.allocator);
    }

    pub fn append_generated(self: *RuntimeFragment, text: []const u8) Allocator.Error!void {
        if (text.len == 0) return;
        try self.pieces.append(self.allocator, .{ .generated = text });
    }

    /// Takes ownership of `owned_text` only when this call succeeds.
    pub fn append_owned_generated(
        self: *RuntimeFragment,
        owned_text: []u8,
    ) Allocator.Error!void {
        if (owned_text.len == 0) {
            self.allocator.free(owned_text);
            return;
        }
        try self.pieces.ensureUnusedCapacity(self.allocator, 1);
        self.pieces.appendAssumeCapacity(.{ .owned_generated = owned_text });
    }

    pub fn append_original(self: *RuntimeFragment, start: u32, end: u32) Allocator.Error!void {
        std.debug.assert(start <= end);
        if (start == end) return;
        if (self.pieces.items.len > 0) {
            const previous = &self.pieces.items[self.pieces.items.len - 1];
            switch (previous.*) {
                .original => |span| if (span.end == start) {
                    previous.* = .{ .original = .{ .start = span.start, .end = end } };
                    return;
                },
                .generated, .owned_generated => {},
                .line_head, .source_padding => {},
            }
        }
        try self.pieces.append(self.allocator, .{
            .original = .{ .start = start, .end = end },
        });
    }

    pub fn record_line_head(
        self: *RuntimeFragment,
        anchor: source_layout.SourceAnchor,
    ) Allocator.Error!void {
        try self.pieces.append(self.allocator, .{ .line_head = anchor });
    }

    pub fn record_source_padding(
        self: *RuntimeFragment,
        anchor: source_layout.SourceAnchor,
    ) Allocator.Error!void {
        try self.pieces.append(self.allocator, .{ .source_padding = anchor });
    }

    /// Moves every piece from `child` into this fragment. `child` remains
    /// valid and empty, so normal `deinit` cleanup is still safe.
    pub fn append_fragment(
        self: *RuntimeFragment,
        child: *RuntimeFragment,
    ) Allocator.Error!void {
        if (child.pieces.items.len == 0) return;
        try self.pieces.ensureUnusedCapacity(self.allocator, child.pieces.items.len);
        for (child.pieces.items) |piece| self.pieces.appendAssumeCapacity(piece);
        child.pieces.clearRetainingCapacity();
    }
};

const Replacement = struct {
    span: Span,
    fragment: RuntimeFragment,
    sequence: u32,
};

/// Runtime replacements remain keyed by original Yuku source spans. Fixed
/// edits outside a replacement are rendered directly from the sealed plan, so
/// no AST position is ever applied to a shifted intermediate string.
///
/// Replacements form a containment forest during rendering. A parent's
/// original fragment pieces are the only places where child replacements may
/// appear; generated pieces intentionally suppress children in removed syntax.
pub const RuntimeEditBuffer = struct {
    allocator: Allocator,
    fixed: *const FixedEditPlan,
    replacements: std.ArrayList(Replacement) = .empty,
    generated_end_lines: std.ArrayList([]u8) = .empty,
    layout: ?*const source_layout.SourceLayout = null,
    source_cursor: ?source_layout.SourceCursor = null,
    next_sequence: u32 = 0,
    render_line: usize = 0,

    pub fn init(allocator: Allocator, fixed: *const FixedEditPlan) RuntimeEditBuffer {
        return .{
            .allocator = allocator,
            .fixed = fixed,
        };
    }

    pub fn init_with_layout(
        allocator: Allocator,
        fixed: *const FixedEditPlan,
        layout: *const source_layout.SourceLayout,
    ) RuntimeEditBuffer {
        var result = init(allocator, fixed);
        result.layout = layout;
        return result;
    }

    pub fn deinit(self: *RuntimeEditBuffer) void {
        for (self.replacements.items) |*replacement| replacement.fragment.deinit();
        self.replacements.deinit(self.allocator);
        for (self.generated_end_lines.items) |line| self.allocator.free(line);
        self.generated_end_lines.deinit(self.allocator);
    }

    pub fn add_generated_end_line(
        self: *RuntimeEditBuffer,
        line: []const u8,
    ) Allocator.Error!void {
        const owned = try self.allocator.dupe(u8, line);
        errdefer self.allocator.free(owned);
        try self.generated_end_lines.append(self.allocator, owned);
    }

    pub fn add_replacement(
        self: *RuntimeEditBuffer,
        start: u32,
        end: u32,
        text: []const u8,
    ) Allocator.Error!void {
        const owned = try self.allocator.dupe(u8, text);
        errdefer self.allocator.free(owned);
        try self.add_owned_replacement(start, end, owned);
    }

    pub fn add_owned_replacement(
        self: *RuntimeEditBuffer,
        start: u32,
        end: u32,
        owned_text: []u8,
    ) Allocator.Error!void {
        std.debug.assert(start <= end);
        std.debug.assert(end <= self.fixed.source.len);
        try self.replacements.ensureUnusedCapacity(self.allocator, 1);

        var fragment = RuntimeFragment.init(self.allocator);
        try fragment.pieces.ensureUnusedCapacity(self.allocator, 1);
        fragment.pieces.appendAssumeCapacity(.{ .owned_generated = owned_text });
        self.replacements.appendAssumeCapacity(.{
            .span = .{ .start = start, .end = end },
            .fragment = fragment,
            .sequence = self.next_sequence,
        });
        self.next_sequence += 1;
    }

    /// Takes ownership of `fragment` only when this call succeeds.
    pub fn add_fragment(
        self: *RuntimeEditBuffer,
        start: u32,
        end: u32,
        fragment: RuntimeFragment,
    ) Allocator.Error!void {
        std.debug.assert(start <= end);
        std.debug.assert(end <= self.fixed.source.len);
        try self.replacements.ensureUnusedCapacity(self.allocator, 1);
        self.replacements.appendAssumeCapacity(.{
            .span = .{ .start = start, .end = end },
            .fragment = fragment,
            .sequence = self.next_sequence,
        });
        self.next_sequence += 1;
    }

    pub fn render(self: *RuntimeEditBuffer) Allocator.Error![]u8 {
        var output: std.ArrayList(u8) = .empty;
        errdefer output.deinit(self.allocator);
        try self.render_into(&output, self.allocator);
        return output.toOwnedSlice(self.allocator);
    }

    /// Appends the complete runtime-aware rendering to a caller-owned buffer.
    pub fn render_into(
        self: *RuntimeEditBuffer,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
    ) Allocator.Error!void {
        if (!replacements_are_sorted(self.replacements.items)) {
            std.mem.sort(Replacement, self.replacements.items, {}, less_than_replacement);
        }
        try output.ensureUnusedCapacity(output_allocator, self.fixed.source.len);
        self.render_line = 0;

        if (replacements_are_flat(self.replacements.items)) {
            try self.append_flat_replacements(output, output_allocator);
            try self.append_generated_end_lines(output, output_allocator);
            return;
        }

        const links = try ReplacementLinks.init(self.allocator, self.replacements.items);
        defer links.deinit(self.allocator);
        try self.append_original_with_children(
            output,
            output_allocator,
            .{ .start = 0, .end = @intCast(self.fixed.source.len) },
            links.first_root,
            &links,
        );
        try self.append_generated_end_lines(output, output_allocator);
    }

    fn append_flat_replacements(
        self: *RuntimeEditBuffer,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
    ) Allocator.Error!void {
        var cursor: u32 = 0;
        for (self.replacements.items) |*replacement| {
            try self.append_fixed_range(output, output_allocator, cursor, replacement.span.start);
            try self.append_flat_fragment(
                output,
                output_allocator,
                replacement.fragment.pieces.items,
            );
            cursor = replacement.span.end;
        }
        try self.append_fixed_range(
            output,
            output_allocator,
            cursor,
            @intCast(self.fixed.source.len),
        );
    }

    fn append_flat_fragment(
        self: *RuntimeEditBuffer,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
        pieces: []const FragmentPiece,
    ) Allocator.Error!void {
        for (pieces) |piece| switch (piece) {
            .generated => |text| try self.append_tracked(output, output_allocator, text),
            .owned_generated => |text| try self.append_tracked(output, output_allocator, text),
            .line_head, .source_padding => |anchor| try self.align_to_source(
                output,
                output_allocator,
                anchor,
            ),
            .original => |span| try self.append_fixed_range(
                output,
                output_allocator,
                span.start,
                span.end,
            ),
        };
    }

    fn append_generated_end_lines(
        self: *RuntimeEditBuffer,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
    ) Allocator.Error!void {
        if (self.generated_end_lines.items.len == 0) return;
        const ending = if (self.layout) |layout| blk: {
            const final_line = layout.lines.items.len - 1;
            break :blk layout.local_line_ending(final_line);
        } else self.ensure_source_cursor().preferred_line_ending();
        const has_trailing = source_layout.ends_with_line_terminator(output.items);
        if (output.items.len > 0 and !has_trailing) {
            try output.appendSlice(output_allocator, ending);
        }
        for (self.generated_end_lines.items, 0..) |line, index| {
            if (index > 0) try output.appendSlice(output_allocator, ending);
            try output.appendSlice(output_allocator, line);
        }
        if (has_trailing) try output.appendSlice(output_allocator, ending);
    }

    fn append_original_with_children(
        self: *RuntimeEditBuffer,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
        span: Span,
        first_child: usize,
        links: *const ReplacementLinks,
    ) Allocator.Error!void {
        var cursor = span.start;
        var child_index = first_child;
        while (child_index != none) {
            const child = &self.replacements.items[child_index];
            if (child.span.end <= span.start and child.span.start != child.span.end) {
                child_index = links.next_sibling[child_index];
                continue;
            }
            if (child.span.start >= span.end and child.span.start != child.span.end) break;
            if (child.span.start < span.start or child.span.end > span.end) {
                child_index = links.next_sibling[child_index];
                continue;
            }
            std.debug.assert(child.span.start >= cursor);
            try self.append_fixed_range(output, output_allocator, cursor, child.span.start);
            try self.append_replacement(output, output_allocator, child_index, links);
            cursor = child.span.end;
            child_index = links.next_sibling[child_index];
        }
        try self.append_fixed_range(output, output_allocator, cursor, span.end);
    }

    fn append_replacement(
        self: *RuntimeEditBuffer,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
        replacement_index: usize,
        links: *const ReplacementLinks,
    ) Allocator.Error!void {
        const replacement = &self.replacements.items[replacement_index];
        var child_index = links.first_child[replacement_index];
        for (replacement.fragment.pieces.items) |piece| switch (piece) {
            .generated => |text| try self.append_tracked(output, output_allocator, text),
            .owned_generated => |text| try self.append_tracked(output, output_allocator, text),
            .line_head, .source_padding => |anchor| try self.align_to_source(
                output,
                output_allocator,
                anchor,
            ),
            .original => |span| {
                while (child_index != none) {
                    const child = self.replacements.items[child_index];
                    if (child.span.start >= span.start and child.span.end <= span.end) break;
                    if (child.span.start >= span.end) break;
                    child_index = links.next_sibling[child_index];
                }
                try self.append_original_with_children(
                    output,
                    output_allocator,
                    span,
                    child_index,
                    links,
                );
                while (child_index != none) {
                    const child = self.replacements.items[child_index];
                    const point_at_end = child.span.start == child.span.end and child.span.start == span.end;
                    if (child.span.start >= span.end and !point_at_end) break;
                    child_index = links.next_sibling[child_index];
                }
            },
        };
    }

    fn append_fixed_range(
        self: *RuntimeEditBuffer,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
        start: u32,
        end: u32,
    ) Allocator.Error!void {
        const output_start = output.items.len;
        try self.fixed.append_range_into(output, output_allocator, start, end);
        if (self.layout) |layout| {
            const start_line = layout.line_at_offset(start);
            const end_line = layout.line_at_offset(end);
            self.render_line += end_line - start_line;
        } else {
            self.track_appended(output.items[output_start..]);
        }
    }

    fn append_tracked(
        self: *RuntimeEditBuffer,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
        text: []const u8,
    ) Allocator.Error!void {
        try output.appendSlice(output_allocator, text);
        self.track_appended(text);
    }

    fn align_to_source(
        self: *RuntimeEditBuffer,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
        anchor: source_layout.SourceAnchor,
    ) Allocator.Error!void {
        const target_line: usize = anchor.line;
        while (self.render_line < target_line) {
            const physical_line = self.source_line(self.render_line);
            const ending = self.source_line_ending(physical_line);
            try self.append_tracked(output, output_allocator, ending);
            const entered_line = self.source_line(self.render_line);
            const prefix_end = if (self.render_line == target_line)
                anchor.offset
            else
                entered_line.content_end;
            if (prefix_end > entered_line.start) {
                const output_start = output.items.len;
                try unicode.append_blanked(
                    output,
                    output_allocator,
                    self.fixed.source[entered_line.start..prefix_end],
                );
                self.track_appended(output.items[output_start..]);
            }
        }
    }

    fn source_line(self: *RuntimeEditBuffer, line: usize) source_layout.PhysicalLine {
        if (self.layout) |layout| return layout.lines.items[line];
        return self.ensure_source_cursor().line_at_index(@intCast(line));
    }

    fn source_line_ending(
        self: *RuntimeEditBuffer,
        line: source_layout.PhysicalLine,
    ) []const u8 {
        if (self.layout) |layout| return layout.local_line_ending(line.index);
        return self.ensure_source_cursor().line_ending(line);
    }

    fn ensure_source_cursor(self: *RuntimeEditBuffer) *source_layout.SourceCursor {
        if (self.source_cursor == null) {
            self.source_cursor = source_layout.SourceCursor.init(self.fixed.source);
        }
        return &self.source_cursor.?;
    }

    fn track_appended(self: *RuntimeEditBuffer, text: []const u8) void {
        self.render_line += source_layout.count_line_terminators(text);
    }
};

fn less_than_replacement(_: void, left: Replacement, right: Replacement) bool {
    if (left.span.start != right.span.start) return left.span.start < right.span.start;
    const left_insertion = left.span.start == left.span.end;
    const right_insertion = right.span.start == right.span.end;
    if (left_insertion != right_insertion) return left_insertion;
    if (left.span.end != right.span.end) return left.span.end > right.span.end;
    return left.sequence < right.sequence;
}

fn replacements_are_sorted(replacements: []const Replacement) bool {
    if (replacements.len < 2) return true;
    for (replacements[1..], replacements[0 .. replacements.len - 1]) |current, previous| {
        if (less_than_replacement({}, current, previous)) return false;
    }
    return true;
}

fn replacements_are_flat(replacements: []const Replacement) bool {
    var covered_until: u32 = 0;
    for (replacements) |replacement| {
        if (replacement.span.start < covered_until) return false;
        covered_until = replacement.span.end;
    }
    return true;
}

const none = std.math.maxInt(usize);

const ReplacementLinks = struct {
    first_root: usize = none,
    first_child: []usize,
    next_sibling: []usize,

    fn init(allocator: Allocator, replacements: []const Replacement) Allocator.Error!ReplacementLinks {
        const first_child = try allocator.alloc(usize, replacements.len);
        errdefer allocator.free(first_child);
        const next_sibling = try allocator.alloc(usize, replacements.len);
        errdefer allocator.free(next_sibling);
        @memset(first_child, none);
        @memset(next_sibling, none);

        var result: ReplacementLinks = .{
            .first_child = first_child,
            .next_sibling = next_sibling,
        };
        var last_root: usize = none;
        var last_child = try allocator.alloc(usize, replacements.len);
        defer allocator.free(last_child);
        @memset(last_child, none);
        var stack: std.ArrayList(usize) = .empty;
        defer stack.deinit(allocator);

        for (replacements, 0..) |replacement, index| {
            while (stack.getLastOrNull()) |parent_index| {
                const parent = replacements[parent_index].span;
                if (contains(parent, replacement.span)) break;
                _ = stack.pop();
            }

            if (stack.items.len == 0) {
                if (result.first_root == none) result.first_root = index;
                if (last_root != none) result.next_sibling[last_root] = index;
                last_root = index;
            } else {
                const parent_index = stack.getLast();
                if (result.first_child[parent_index] == none) {
                    result.first_child[parent_index] = index;
                } else {
                    result.next_sibling[last_child[parent_index]] = index;
                }
                last_child[parent_index] = index;
            }

            if (replacement.span.start != replacement.span.end) {
                try stack.append(allocator, index);
            }
        }
        return result;
    }

    fn deinit(self: *const ReplacementLinks, allocator: Allocator) void {
        allocator.free(self.first_child);
        allocator.free(self.next_sibling);
    }
};

fn contains(parent: Span, child: Span) bool {
    if (child.start == child.end) {
        return parent.start <= child.start and child.start < parent.end;
    }
    const same = parent.start == child.start and parent.end == child.end;
    return !same and parent.start <= child.start and child.end <= parent.end;
}

test "runtime replacements compose against original fixed source ranges" {
    const allocator = std.testing.allocator;
    const source =
        \\const value: number = 1;
        \\enum E { A }
        \\const observed: E = E.A;
        \\
    ;

    var fixed_edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer fixed_edits.deinit();
    const first_annotation = std.mem.indexOf(u8, source, ": number").?;
    const second_annotation = std.mem.lastIndexOf(u8, source, ": E").?;
    try fixed_edits.add_blank(
        @intCast(first_annotation),
        @intCast(first_annotation + ": number".len),
    );
    try fixed_edits.add_blank(
        @intCast(second_annotation),
        @intCast(second_annotation + ": E".len),
    );

    var fixed = try fixed_edits.seal();
    defer fixed.deinit();
    var runtime = RuntimeEditBuffer.init(allocator, &fixed);
    defer runtime.deinit();

    const enum_start = std.mem.indexOf(u8, source, "enum E { A }").?;
    try runtime.add_replacement(
        @intCast(enum_start),
        @intCast(enum_start + "enum E { A }".len),
        "var E;(function(E){const A=0;E[E[\"A\"]=A]=\"A\";})(E||(E={}));",
    );

    const output = try runtime.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings(
        "const value         = 1;\n" ++
            "var E;(function(E){const A=0;E[E[\"A\"]=A]=\"A\";})(E||(E={}));\n" ++
            "const observed    = E.A;\n",
        output,
    );
}

test "structured fragments apply nested replacements only in original pieces" {
    const allocator = std.testing.allocator;
    const source = "before outer { child: T } after";

    var fixed_edits = fixed_edit_buffer.FixedEditBuffer.init(allocator, source);
    defer fixed_edits.deinit();
    const annotation = std.mem.indexOf(u8, source, ": T").?;
    try fixed_edits.add_blank(@intCast(annotation), @intCast(annotation + 3));
    var fixed = try fixed_edits.seal();
    defer fixed.deinit();

    var runtime = RuntimeEditBuffer.init(allocator, &fixed);
    defer runtime.deinit();
    const parent_start = std.mem.indexOf(u8, source, "outer").?;
    const parent_end = std.mem.indexOf(u8, source, " after").?;
    const child_start = std.mem.indexOf(u8, source, "child").?;
    const child_end = annotation + 3;

    var parent = RuntimeFragment.init(allocator);
    parent.append_generated("wrap(") catch |err| {
        parent.deinit();
        return err;
    };
    parent.append_original(@intCast(child_start), @intCast(child_end)) catch |err| {
        parent.deinit();
        return err;
    };
    parent.append_generated(")") catch |err| {
        parent.deinit();
        return err;
    };
    runtime.add_fragment(@intCast(parent_start), @intCast(parent_end), parent) catch |err| {
        parent.deinit();
        return err;
    };

    // This child lies in syntax removed by the parent and is suppressed.
    try runtime.add_replacement(
        @intCast(parent_start),
        @intCast(parent_start + "outer".len),
        "removed-prefix-child",
    );
    // This child lies in an original fragment and composes normally.
    try runtime.add_replacement(
        @intCast(child_start),
        @intCast(child_start + "child".len),
        "inner",
    );

    const output = try runtime.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings("before wrap(inner   ) after", output);
}
