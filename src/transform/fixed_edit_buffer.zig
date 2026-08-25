const std = @import("std");
const unicode = @import("unicode.zig");

const Allocator = std.mem.Allocator;

pub const Span = struct {
    start: u32,
    end: u32,
};

pub const FixedSubstitution = enum(u8) {
    semicolon = ';',
    left_parenthesis = '(',
    right_parenthesis = ')',

    fn byte(self: FixedSubstitution) u8 {
        return @intFromEnum(self);
    }
};

const BlankOperation = struct {
    span: Span,
};

const SubstitutionOperation = struct {
    span: Span,
    replacement: FixedSubstitution,
};

const Operation = union(enum) {
    blank: BlankOperation,
    substitution: SubstitutionOperation,

    fn span(self: Operation) Span {
        return switch (self) {
            .blank => |operation| operation.span,
            .substitution => |operation| operation.span,
        };
    }
};

/// Fixed-width edits registered in original UTF-8 byte coordinates.
pub const FixedEditBuffer = struct {
    allocator: Allocator,
    source: []const u8,
    operations: std.ArrayList(Operation) = .empty,

    pub fn init(allocator: Allocator, source: []const u8) FixedEditBuffer {
        std.debug.assert(source.len <= std.math.maxInt(u32));
        return .{
            .allocator = allocator,
            .source = source,
        };
    }

    pub fn deinit(self: *FixedEditBuffer) void {
        self.operations.deinit(self.allocator);
    }

    pub fn add_blank(self: *FixedEditBuffer, start: u32, end: u32) Allocator.Error!void {
        self.assert_range(start, end);
        if (start == end) return;

        try self.operations.append(self.allocator, .{
            .blank = .{ .span = .{ .start = start, .end = end } },
        });
    }

    pub fn add_substitution(
        self: *FixedEditBuffer,
        offset: u32,
        replacement: FixedSubstitution,
    ) Allocator.Error!void {
        return self.add_substitution_range(offset, offset + 1, replacement);
    }

    /// Replaces one or more source bytes with one syntax character while
    /// retaining the replaced span's UTF-16 width. This is used when the
    /// replaceable code point is non-ASCII: the replacement character is
    /// followed by padding spaces during rendering.
    pub fn add_substitution_range(
        self: *FixedEditBuffer,
        start: u32,
        end: u32,
        replacement: FixedSubstitution,
    ) Allocator.Error!void {
        self.assert_range(start, end);
        std.debug.assert(start < end);
        try self.operations.append(self.allocator, .{
            .substitution = .{
                .span = .{ .start = start, .end = end },
                .replacement = replacement,
            },
        });
    }

    /// Renders all fixed edits once from the original source.
    pub fn render(self: *FixedEditBuffer) Allocator.Error![]u8 {
        var plan = try self.seal();
        defer plan.deinit();
        return plan.render();
    }

    /// Normalizes the mutable edit collection into a reusable immutable plan.
    /// Runtime lowering can render independent original-source ranges without
    /// materializing or re-indexing an intermediate string.
    pub fn seal(self: *FixedEditBuffer) Allocator.Error!FixedEditPlan {
        return .{
            .allocator = self.allocator,
            .source = self.source,
            .operations = try self.normalize(),
        };
    }

    fn normalize(self: *FixedEditBuffer) Allocator.Error!std.ArrayList(Operation) {
        std.mem.sort(Operation, self.operations.items, {}, less_than_unnormalized_operation);

        var substitution_count: usize = 0;
        for (self.operations.items) |operation| {
            if (operation == .substitution) substitution_count += 1;
        }

        var result: std.ArrayList(Operation) = .empty;
        errdefer result.deinit(self.allocator);
        try result.ensureTotalCapacity(
            self.allocator,
            self.operations.items.len + substitution_count + 1,
        );

        var active_blank: ?Span = null;
        var previous_substitution: ?SubstitutionOperation = null;
        for (self.operations.items) |operation| switch (operation) {
            .blank => |blank| {
                var span = blank.span;
                if (previous_substitution) |substitution| {
                    if (span.start < substitution.span.end and
                        span.end > substitution.span.start)
                    {
                        if (span.end <= substitution.span.end) continue;
                        span.start = substitution.span.end;
                    }
                }

                if (active_blank) |*active| {
                    if (span.start <= active.end) {
                        active.end = @max(active.end, span.end);
                    } else {
                        append_blank_assume_capacity(&result, active.*);
                        active_blank = span;
                    }
                } else {
                    active_blank = span;
                }
            },
            .substitution => |substitution| {
                if (previous_substitution) |previous| {
                    if (previous.span.start == substitution.span.start) {
                        std.debug.assert(previous.replacement == substitution.replacement);
                        continue;
                    }
                    std.debug.assert(previous.span.end <= substitution.span.start);
                }

                if (active_blank) |active| {
                    if (active.end <= substitution.span.start) {
                        append_blank_assume_capacity(&result, active);
                        active_blank = null;
                    } else if (active.start < substitution.span.start) {
                        append_blank_assume_capacity(&result, .{
                            .start = active.start,
                            .end = substitution.span.start,
                        });
                    }

                    if (active.end > substitution.span.end) {
                        active_blank = .{
                            .start = @max(active.start, substitution.span.end),
                            .end = active.end,
                        };
                    } else {
                        active_blank = null;
                    }
                }

                result.appendAssumeCapacity(.{ .substitution = substitution });
                previous_substitution = substitution;
            },
        };
        if (active_blank) |blank| append_blank_assume_capacity(&result, blank);
        return result;
    }

    fn assert_range(self: *const FixedEditBuffer, start: u32, end: u32) void {
        std.debug.assert(start <= end);
        std.debug.assert(end <= self.source.len);
    }
};

/// Immutable fixed-edit snapshot. Source coordinates remain Yuku UTF-8 byte
/// spans even when a rendered range has a different byte length.
pub const FixedEditPlan = struct {
    allocator: Allocator,
    source: []const u8,
    operations: std.ArrayList(Operation),

    pub fn deinit(self: *FixedEditPlan) void {
        self.operations.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn render(self: *const FixedEditPlan) Allocator.Error![]u8 {
        var output: std.ArrayList(u8) = .empty;
        errdefer output.deinit(self.allocator);
        try self.render_into(&output, self.allocator);
        return output.toOwnedSlice(self.allocator);
    }

    /// Appends the complete fixed-width rendering to a caller-owned buffer.
    pub fn render_into(
        self: *const FixedEditPlan,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
    ) Allocator.Error!void {
        try output.ensureUnusedCapacity(output_allocator, self.source.len);
        try self.append_range_into(
            output,
            output_allocator,
            0,
            @intCast(self.source.len),
        );
    }

    /// Appends a fixed-rendered original-source interval to `output`.
    pub fn append_range(
        self: *const FixedEditPlan,
        output: *std.ArrayList(u8),
        start: u32,
        end: u32,
    ) Allocator.Error!void {
        return self.append_range_into(output, self.allocator, start, end);
    }

    /// Appends an original-source interval using the allocator that owns
    /// `output`, which may differ from this plan's scratch allocator.
    pub fn append_range_into(
        self: *const FixedEditPlan,
        output: *std.ArrayList(u8),
        output_allocator: Allocator,
        start: u32,
        end: u32,
    ) Allocator.Error!void {
        std.debug.assert(start <= end);
        std.debug.assert(end <= self.source.len);

        var cursor = start;
        const first_operation = self.first_operation_ending_after(start);
        for (self.operations.items[first_operation..]) |operation| {
            const span = operation.span();
            if (span.end <= start) continue;
            if (span.start >= end) break;

            const operation_start = @max(span.start, start);
            const operation_end = @min(span.end, end);
            if (operation_start > cursor) {
                try output.appendSlice(
                    output_allocator,
                    self.source[cursor..operation_start],
                );
            }

            switch (operation) {
                .blank => try unicode.append_blanked(
                    output,
                    output_allocator,
                    self.source[operation_start..operation_end],
                ),
                .substitution => |substitution| {
                    std.debug.assert(operation_start == span.start);
                    std.debug.assert(operation_end == span.end);
                    try output.append(output_allocator, substitution.replacement.byte());
                    const replaced_width = unicode.utf16_width(
                        self.source[span.start..span.end],
                    );
                    std.debug.assert(replaced_width > 0);
                    var padding = replaced_width - 1;
                    while (padding > 0) : (padding -= 1) {
                        try output.append(output_allocator, ' ');
                    }
                },
            }
            cursor = operation_end;
        }

        if (cursor < end) {
            try output.appendSlice(output_allocator, self.source[cursor..end]);
        }
    }

    fn first_operation_ending_after(self: *const FixedEditPlan, position: u32) usize {
        var low: usize = 0;
        var high = self.operations.items.len;
        while (low < high) {
            const middle = low + (high - low) / 2;
            if (self.operations.items[middle].span().end <= position) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }
};

fn append_blank_assume_capacity(operations: *std.ArrayList(Operation), span: Span) void {
    if (span.start == span.end) return;
    operations.appendAssumeCapacity(.{ .blank = .{ .span = span } });
}

fn less_than_unnormalized_operation(_: void, left: Operation, right: Operation) bool {
    const left_span = left.span();
    const right_span = right.span();
    if (left_span.start != right_span.start) return left_span.start < right_span.start;
    if (left == .blank and right == .substitution) return true;
    if (left == .substitution and right == .blank) return false;
    return left_span.end < right_span.end;
}

test "render returns an owned source copy without edits" {
    const allocator = std.testing.allocator;
    const source = "const value = 1;\n";
    var edits = FixedEditBuffer.init(allocator, source);
    defer edits.deinit();

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings(source, output);
}

test "blanking preserves UTF-16 width rather than UTF-8 byte length" {
    const allocator = std.testing.allocator;
    const source = "const value: 类型𝒳 = input;\n";
    const erased = ": 类型𝒳";
    const start = std.mem.indexOf(u8, source, erased).?;

    var edits = FixedEditBuffer.init(allocator, source);
    defer edits.deinit();
    try edits.add_blank(@intCast(start), @intCast(start + erased.len));

    const output = try edits.render();
    defer allocator.free(output);

    try std.testing.expectEqualStrings("const value       = input;\n", output);
    try std.testing.expectEqual(unicode.utf16_width(source), unicode.utf16_width(output));
}

test "overlapping blanks merge and substitutions win" {
    const allocator = std.testing.allocator;
    const source = "abstract [key]: Type";
    var edits = FixedEditBuffer.init(allocator, source);
    defer edits.deinit();

    try edits.add_blank(0, 8);
    try edits.add_blank(4, 15);
    try edits.add_substitution(0, .semicolon);

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings(";               Type", output);
}

test "range substitutions preserve the replaced UTF-16 width" {
    const allocator = std.testing.allocator;
    const source = "value as 类型𝒳";
    var edits = FixedEditBuffer.init(allocator, source);
    defer edits.deinit();

    try edits.add_blank(5, @intCast(source.len));
    const final_scalar_start = source.len - "𝒳".len;
    try edits.add_substitution_range(
        @intCast(final_scalar_start),
        @intCast(source.len),
        .right_parenthesis,
    );

    const output = try edits.render();
    defer allocator.free(output);
    try std.testing.expectEqualStrings("value      ) ", output);
    try std.testing.expectEqual(unicode.utf16_width(source), unicode.utf16_width(output));
}

test "sealed plans render independent source ranges" {
    const allocator = std.testing.allocator;
    const source = "const left: 类型 = right as 𝒳;\n";
    var edits = FixedEditBuffer.init(allocator, source);
    defer edits.deinit();

    const annotation_start = std.mem.indexOf(u8, source, ": 类型").?;
    const annotation_end = annotation_start + ": 类型".len;
    const assertion_start = std.mem.indexOf(u8, source, " as 𝒳").?;
    const assertion_end = assertion_start + " as 𝒳".len;
    try edits.add_blank(@intCast(annotation_start), @intCast(annotation_end));
    try edits.add_blank(@intCast(assertion_start), @intCast(assertion_end));

    var plan = try edits.seal();
    defer plan.deinit();
    const whole = try plan.render();
    defer allocator.free(whole);

    var pieces: std.ArrayList(u8) = .empty;
    defer pieces.deinit(allocator);
    const split: u32 = @intCast(std.mem.indexOf(u8, source, "right").?);
    try plan.append_range(&pieces, 0, split);
    try plan.append_range(&pieces, split, @intCast(source.len));
    try std.testing.expectEqualStrings(whole, pieces.items);
}
