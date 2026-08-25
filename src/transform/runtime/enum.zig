const std = @import("std");
const parser = @import("parser");
const yuku_util = @import("yuku_util");
const fixed_edit_buffer = @import("../fixed_edit_buffer.zig");
const runtime_edit_buffer = @import("../runtime_edit_buffer.zig");
const runtime_name_allocator = @import("../runtime_name_allocator.zig");
const source_file = @import("../source_file.zig");
const source_layout = @import("../source_layout.zig");
const unicode = @import("../unicode.zig");

const Allocator = std.mem.Allocator;
const FixedEditPlan = fixed_edit_buffer.FixedEditPlan;
const NodeIndex = parser.ast.NodeIndex;
const RuntimeNameAllocator = runtime_name_allocator.RuntimeNameAllocator;
const RuntimeFragment = runtime_edit_buffer.RuntimeFragment;
const SourceFile = source_file.SourceFile;

const strict_binding_reserved_words = std.StaticStringMap(void).initComptime(.{
    .{ "await", {} },
    .{ "break", {} },
    .{ "case", {} },
    .{ "catch", {} },
    .{ "class", {} },
    .{ "const", {} },
    .{ "continue", {} },
    .{ "debugger", {} },
    .{ "default", {} },
    .{ "delete", {} },
    .{ "do", {} },
    .{ "else", {} },
    .{ "enum", {} },
    .{ "export", {} },
    .{ "extends", {} },
    .{ "false", {} },
    .{ "finally", {} },
    .{ "for", {} },
    .{ "function", {} },
    .{ "if", {} },
    .{ "implements", {} },
    .{ "import", {} },
    .{ "in", {} },
    .{ "instanceof", {} },
    .{ "interface", {} },
    .{ "let", {} },
    .{ "new", {} },
    .{ "null", {} },
    .{ "package", {} },
    .{ "private", {} },
    .{ "protected", {} },
    .{ "public", {} },
    .{ "return", {} },
    .{ "static", {} },
    .{ "super", {} },
    .{ "switch", {} },
    .{ "this", {} },
    .{ "throw", {} },
    .{ "true", {} },
    .{ "try", {} },
    .{ "typeof", {} },
    .{ "var", {} },
    .{ "void", {} },
    .{ "while", {} },
    .{ "with", {} },
    .{ "yield", {} },
});

const MemberPlan = struct {
    index: NodeIndex,
    name: ?[]const u8,
    local: ?[]const u8,
};

pub const IdentifierReplacement = struct {
    span: parser.ast.Span,
    text: []const u8,
};

pub const ReferenceMap = std.AutoHashMapUnmanaged(u32, std.ArrayList(NodeIndex));

pub fn deinit_reference_map(map: *ReferenceMap, allocator: Allocator) void {
    var iterator = map.valueIterator();
    while (iterator.next()) |references| references.deinit(allocator);
    map.deinit(allocator);
}

pub const Emission = struct {
    fragment: RuntimeFragment,
    identifier_replacements: []IdentifierReplacement,
};

/// Emits one non-ambient Yuku enum as its JavaScript runtime declaration.
/// Original initializer ranges are read through `FixedEditPlan`, so type
/// syntax nested inside an expression is erased without shifting AST spans.
pub fn emit(
    allocator: Allocator,
    file: *const SourceFile,
    fixed: *const FixedEditPlan,
    names: *RuntimeNameAllocator,
    references_by_member: *const ReferenceMap,
    index: NodeIndex,
) Allocator.Error!Emission {
    const declaration = switch (file.tree.data(index)) {
        .ts_enum_declaration => |value| value,
        else => unreachable,
    };
    std.debug.assert(!declaration.declare);

    const id_span = file.tree.span(declaration.id);
    const enum_name = switch (file.tree.data(declaration.id)) {
        .binding_identifier => |identifier| file.tree.string(identifier.name),
        else => file.source()[id_span.start..id_span.end],
    };
    const body = switch (file.tree.data(declaration.body)) {
        .ts_enum_body => |value| value,
        else => unreachable,
    };
    const member_indices = file.tree.extra(body.members);

    var natural_names: std.StringHashMapUnmanaged(void) = .empty;
    defer natural_names.deinit(allocator);
    for (member_indices) |member_index| {
        const member = enum_member(&file.tree, member_index);
        if (member_reference_name(&file.tree, member)) |name| {
            if (member_can_use_reference_local(&file.tree, member)) {
                try natural_names.put(allocator, name, {});
            }
        }
    }

    const receiver = try names.claim_receiver(enum_name, &natural_names);
    var member_plans: std.ArrayList(MemberPlan) = .empty;
    defer member_plans.deinit(allocator);
    var assigned_names: std.StringHashMapUnmanaged(void) = .empty;
    defer assigned_names.deinit(allocator);
    var reference_locals: std.StringHashMapUnmanaged([]const u8) = .empty;
    defer reference_locals.deinit(allocator);

    for (member_indices) |member_index| {
        const member = enum_member(&file.tree, member_index);
        const reference_name = member_reference_name(&file.tree, member);
        var local: ?[]const u8 = null;
        if (reference_name) |name| {
            if (natural_names.contains(name)) {
                const duplicate = assigned_names.contains(name);
                try assigned_names.put(allocator, name, {});
                const member_local = if (is_strict_binding_identifier(name) and !duplicate)
                    name
                else
                    try names.claim_member_alias(name, &natural_names);
                try reference_locals.put(allocator, name, member_local);
                local = member_local;
            }
        }
        try member_plans.append(allocator, .{
            .index = member_index,
            .name = reference_name,
            .local = local,
        });
    }

    var writer = AlignedWriter.init(allocator, file);
    errdefer writer.deinit();
    var identifier_replacements: std.ArrayList(IdentifierReplacement) = .empty;
    defer identifier_replacements.deinit(allocator);
    try writer.claim_initial_line(file.tree.span(index).start);

    try writer.append("var");
    try writer.append_blanked(file.source()[file.tree.span(index).start + 3 .. id_span.start]);
    try writer.append_fixed(fixed, id_span.start, id_span.end);
    try writer.append(";(function(");
    try writer.append(receiver);
    try writer.append("){");

    if (member_plans.items.len > 0) {
        const first_span = file.tree.span(member_plans.items[0].index);
        try writer.append_comments(file.tree.span(index).start, first_span.start);
    } else {
        try writer.append_comments(file.tree.span(index).start, file.tree.span(index).end);
    }

    var previous_value: ?[]u8 = null;
    defer if (previous_value) |value| allocator.free(value);

    for (member_plans.items, 0..) |plan, member_number| {
        const member = enum_member(&file.tree, plan.index);
        const member_span = file.tree.span(plan.index);
        const id = file.tree.span(member.id);
        const next_boundary = if (member_number + 1 < member_plans.items.len)
            file.tree.span(member_plans.items[member_number + 1].index).start
        else
            file.tree.span(index).end;
        const member_references = if (references_by_member.get(@intFromEnum(plan.index))) |references|
            references.items
        else
            &.{};

        try writer.align_at(member_span.start);
        var key: std.ArrayList(u8) = .empty;
        defer key.deinit(allocator);
        try append_member_key(&key, allocator, &file.tree, member);

        if (member.initializer == .null) {
            if (plan.local) |local| {
                try writer.append("const ");
                try writer.append(local);
                try writer.append(" = ");
                if (previous_value) |previous| {
                    try writer.append(previous);
                    try writer.append(" + 1");
                } else {
                    try writer.append("0");
                }
                try writer.append(";");
                try append_numeric_assignment(&writer, receiver, key.items, local);
                try set_previous(allocator, &previous_value, local);
            } else {
                try writer.append(receiver);
                try writer.append("[");
                try writer.append(receiver);
                try writer.append("[");
                try writer.append(key.items);
                try writer.append("]=");
                if (previous_value) |previous| {
                    try writer.append(previous);
                    try writer.append(" + 1");
                } else {
                    try writer.append("0");
                }
                try writer.append("]=");
                try writer.append(key.items);
                try writer.append(";");
                const expression = try std.fmt.allocPrint(allocator, "{s}[{s}]", .{ receiver, key.items });
                if (previous_value) |value| allocator.free(value);
                previous_value = expression;
            }
            try writer.append_comments(member_span.end, next_boundary);
            continue;
        }

        const initializer_span = file.tree.span(member.initializer);
        const string_initializer = file.tree.data(member.initializer) == .string_literal;
        if (plan.local) |local| {
            try writer.append("const ");
            try writer.append(local);
            try writer.append("=");
            try writer.append_comments(id.end, initializer_span.start);
            try writer.append_expression(
                fixed,
                initializer_span,
                &reference_locals,
                member_references,
                &identifier_replacements,
            );
            try writer.append(";");
            if (string_initializer) {
                try writer.append(receiver);
                try writer.append("[");
                try writer.append(key.items);
                try writer.append("]=");
                try writer.append(local);
                try writer.append(";");
            } else {
                try append_numeric_assignment(&writer, receiver, key.items, local);
            }
            try set_previous(allocator, &previous_value, local);
        } else {
            try writer.append(receiver);
            try writer.append("[");
            if (!string_initializer) {
                try writer.append(receiver);
                try writer.append("[");
            }
            try writer.append(key.items);
            try writer.append("]=");
            try writer.append_comments(id.end, initializer_span.start);
            try writer.append_expression(
                fixed,
                initializer_span,
                &reference_locals,
                member_references,
                &identifier_replacements,
            );
            if (string_initializer) {
                try writer.append(";");
            } else {
                try writer.append("]=");
                try writer.append(key.items);
                try writer.append(";");
            }
            const expression = try std.fmt.allocPrint(allocator, "{s}[{s}]", .{ receiver, key.items });
            if (previous_value) |value| allocator.free(value);
            previous_value = expression;
        }
        try writer.append_comments(initializer_span.end, next_boundary);
    }

    try writer.align_at(file.tree.span(index).end - 1);
    try writer.append("})(");
    try writer.append_fixed(fixed, id_span.start, id_span.end);
    try writer.append("||(");
    try writer.append_fixed(fixed, id_span.start, id_span.end);
    try writer.append("={}));");
    const owned_replacements = try identifier_replacements.toOwnedSlice(allocator);
    errdefer allocator.free(owned_replacements);
    return .{
        .fragment = try writer.to_owned_fragment(),
        .identifier_replacements = owned_replacements,
    };
}

fn enum_member(tree: *const parser.ast.Tree, index: NodeIndex) parser.ast.TSEnumMember {
    return switch (tree.data(index)) {
        .ts_enum_member => |member| member,
        else => unreachable,
    };
}

fn member_reference_name(
    tree: *const parser.ast.Tree,
    member: parser.ast.TSEnumMember,
) ?[]const u8 {
    return switch (tree.data(member.id)) {
        .identifier_name => |identifier| tree.string(identifier.name),
        .string_literal => |literal| tree.string(literal.value),
        else => null,
    };
}

fn member_can_use_reference_local(
    tree: *const parser.ast.Tree,
    member: parser.ast.TSEnumMember,
) bool {
    return switch (tree.data(member.id)) {
        .identifier_name => true,
        .string_literal => |literal| is_identifier_name(tree.string(literal.value)),
        else => false,
    };
}

fn append_member_key(
    output: *std.ArrayList(u8),
    allocator: Allocator,
    tree: *const parser.ast.Tree,
    member: parser.ast.TSEnumMember,
) Allocator.Error!void {
    switch (tree.data(member.id)) {
        .identifier_name => |identifier| try append_string_literal(output, allocator, tree.string(identifier.name)),
        .string_literal => {
            const span = tree.span(member.id);
            try output.appendSlice(allocator, tree.source[span.start..span.end]);
        },
        else => {
            const span = tree.span(member.id);
            try output.appendSlice(allocator, tree.source[span.start..span.end]);
        },
    }
}

fn append_string_literal(
    output: *std.ArrayList(u8),
    allocator: Allocator,
    value: []const u8,
) Allocator.Error!void {
    try output.append(allocator, '"');
    for (value) |byte| {
        switch (byte) {
            '"' => try output.appendSlice(allocator, "\\\""),
            '\\' => try output.appendSlice(allocator, "\\\\"),
            '\n' => try output.appendSlice(allocator, "\\n"),
            '\r' => try output.appendSlice(allocator, "\\r"),
            '\t' => try output.appendSlice(allocator, "\\t"),
            0x08 => try output.appendSlice(allocator, "\\b"),
            0x0c => try output.appendSlice(allocator, "\\f"),
            0...0x07, 0x0b, 0x0e...0x1f => {
                var buffer: [6]u8 = undefined;
                const escaped = std.fmt.bufPrint(&buffer, "\\u00{x:0>2}", .{byte}) catch unreachable;
                try output.appendSlice(allocator, escaped);
            },
            else => try output.append(allocator, byte),
        }
    }
    try output.append(allocator, '"');
}

fn append_numeric_assignment(
    writer: *AlignedWriter,
    receiver: []const u8,
    key: []const u8,
    value: []const u8,
) Allocator.Error!void {
    try writer.append(receiver);
    try writer.append("[");
    try writer.append(receiver);
    try writer.append("[");
    try writer.append(key);
    try writer.append("]=");
    try writer.append(value);
    try writer.append("]=");
    try writer.append(key);
    try writer.append(";");
}

fn set_previous(allocator: Allocator, previous: *?[]u8, value: []const u8) Allocator.Error!void {
    const next = try allocator.dupe(u8, value);
    if (previous.*) |old| allocator.free(old);
    previous.* = next;
}

const AlignedWriter = struct {
    allocator: Allocator,
    file: *const SourceFile,
    preview: std.ArrayList(u8) = .empty,
    generated: std.ArrayList(u8) = .empty,
    fragment: RuntimeFragment,
    claimed_lines: std.AutoHashMapUnmanaged(u32, void) = .empty,
    current_line: u32 = 0,
    current_column: usize = 0,
    previous_source_line: ?u32 = null,
    previous_output_line: ?u32 = null,

    fn init(allocator: Allocator, file: *const SourceFile) AlignedWriter {
        return .{
            .allocator = allocator,
            .file = file,
            .fragment = RuntimeFragment.init(allocator),
        };
    }

    fn deinit(self: *AlignedWriter) void {
        self.preview.deinit(self.allocator);
        self.generated.deinit(self.allocator);
        self.fragment.deinit();
        self.claimed_lines.deinit(self.allocator);
    }

    fn to_owned_fragment(self: *AlignedWriter) Allocator.Error!RuntimeFragment {
        try self.flush_generated();
        self.preview.deinit(self.allocator);
        self.preview = .empty;
        self.generated.deinit(self.allocator);
        self.generated = .empty;
        self.claimed_lines.deinit(self.allocator);
        self.claimed_lines = .empty;
        const result = self.fragment;
        self.fragment = RuntimeFragment.init(self.allocator);
        return result;
    }

    fn claim_initial_line(self: *AlignedWriter, source_offset: u32) Allocator.Error!void {
        const line: u32 = @intCast(self.file.source_layout().line_at_offset(source_offset));
        try self.claimed_lines.put(self.allocator, line, {});
        self.previous_source_line = line;
        self.previous_output_line = 0;
    }

    fn align_at(self: *AlignedWriter, source_offset: u32) Allocator.Error!void {
        const layout = self.file.source_layout();
        const source_line: u32 = @intCast(layout.line_at_offset(source_offset));
        if (self.claimed_lines.contains(source_line)) return;
        try self.claimed_lines.put(self.allocator, source_line, {});

        const physical_line = layout.lines.items[source_line];
        const prefix = self.file.source()[physical_line.start..source_offset];
        const source_column = unicode.utf16_width(prefix);
        const source_delta = source_line - self.previous_source_line.?;
        const desired_line = self.previous_output_line.? + source_delta;
        const target_line = @max(self.current_line, desired_line);

        if (self.current_line < target_line) {
            while (self.current_line < target_line) {
                try self.append(layout.local_line_ending(@intCast(source_line)));
            }
            try self.append_blanked(prefix);
        } else if (self.current_column < source_column) {
            var spaces = source_column - self.current_column;
            while (spaces > 0) : (spaces -= 1) try self.append(" ");
        } else if (self.current_column > source_column) {
            try self.append(layout.local_line_ending(@intCast(source_line)));
            try self.append_blanked(prefix);
        }

        self.previous_source_line = source_line;
        self.previous_output_line = self.current_line;
    }

    fn append(self: *AlignedWriter, text: []const u8) Allocator.Error!void {
        if (text.len == 0) return;
        try self.preview.appendSlice(self.allocator, text);
        try self.generated.appendSlice(self.allocator, text);
        self.advance(text);
    }

    fn append_blanked(self: *AlignedWriter, text: []const u8) Allocator.Error!void {
        const start = self.generated.items.len;
        try unicode.append_blanked(&self.generated, self.allocator, text);
        const blanked = self.generated.items[start..];
        try self.preview.appendSlice(self.allocator, blanked);
        self.advance(blanked);
    }

    fn append_fixed(
        self: *AlignedWriter,
        fixed: *const FixedEditPlan,
        start: u32,
        end: u32,
    ) Allocator.Error!void {
        try self.flush_generated();
        try self.fragment.append_original(start, end);
        const output_start = self.preview.items.len;
        try fixed.append_range(&self.preview, start, end);
        self.advance(self.preview.items[output_start..]);
    }

    fn append_comments(self: *AlignedWriter, start: u32, end: u32) Allocator.Error!void {
        try self.flush_generated();
        var comments: std.ArrayList(u8) = .empty;
        defer comments.deinit(self.allocator);
        try self.file.comment_cursor().append_range(&comments, self.allocator, start, end);
        if (comments.items.len > 0) try self.append(comments.items);
    }

    fn append_expression(
        self: *AlignedWriter,
        fixed: *const FixedEditPlan,
        expression_span: parser.ast.Span,
        reference_locals: *const std.StringHashMapUnmanaged([]const u8),
        reference_nodes: []const NodeIndex,
        replacements: *std.ArrayList(IdentifierReplacement),
    ) Allocator.Error!void {
        for (reference_nodes) |reference| {
            const data = self.file.tree.data(reference);
            const span = self.file.tree.span(reference);
            if (span.start < expression_span.start or span.end > expression_span.end) continue;
            const name = switch (data) {
                .identifier_reference => |identifier| self.file.tree.string(identifier.name),
                else => continue,
            };
            const local = reference_locals.get(name) orelse continue;
            if (std.mem.eql(u8, name, local)) continue;
            try replacements.append(self.allocator, .{ .span = span, .text = local });
        }
        try self.append_fixed(fixed, expression_span.start, expression_span.end);
    }

    fn flush_generated(self: *AlignedWriter) Allocator.Error!void {
        if (self.generated.items.len == 0) return;
        const owned = try self.generated.toOwnedSlice(self.allocator);
        self.generated = .empty;
        self.fragment.append_owned_generated(owned) catch |err| {
            self.allocator.free(owned);
            return err;
        };
    }

    fn advance(self: *AlignedWriter, text: []const u8) void {
        var segment_start: usize = 0;
        var offset: usize = 0;
        while (offset < text.len) {
            const terminator = source_layout.line_terminator_prefix(text[offset..]);
            if (terminator == .none) {
                offset += 1;
                continue;
            }
            self.current_column += unicode.utf16_width(text[segment_start..offset]);
            self.current_line += 1;
            self.current_column = 0;
            offset += terminator.bytes().len;
            segment_start = offset;
        }
        self.current_column += unicode.utf16_width(text[segment_start..]);
    }
};

fn is_identifier_name(name: []const u8) bool {
    if (name.len == 0) return false;
    var offset: usize = 0;
    var first = true;
    while (offset < name.len) {
        const sequence_len = std.unicode.utf8ByteSequenceLength(name[offset]) catch return false;
        if (offset + sequence_len > name.len) return false;
        const codepoint = std.unicode.utf8Decode(name[offset..][0..sequence_len]) catch return false;
        const valid = if (codepoint < 0x80) blk: {
            const byte: u8 = @intCast(codepoint);
            break :blk std.ascii.isAlphabetic(byte) or byte == '_' or byte == '$' or
                (!first and std.ascii.isDigit(byte));
        } else if (first)
            yuku_util.UnicodeId.canStartId(codepoint)
        else
            yuku_util.UnicodeId.canContinueId(codepoint);
        if (!valid) return false;
        offset += sequence_len;
        first = false;
    }
    return true;
}

fn is_strict_binding_identifier(name: []const u8) bool {
    return !strict_binding_reserved_words.has(name);
}
