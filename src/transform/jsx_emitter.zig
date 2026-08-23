const std = @import("std");
const parser = @import("parser");
const fixed_edit_buffer = @import("fixed_edit_buffer.zig");
const js_string = @import("js_string.zig");
const jsx_config = @import("jsx_config.zig");
const jsx_entities = @import("jsx_entities.zig");
const runtime_edit_buffer = @import("runtime_edit_buffer.zig");
const runtime_name_allocator = @import("runtime_name_allocator.zig");
const source_file = @import("source_file.zig");
const source_layout = @import("source_layout.zig");

const Allocator = std.mem.Allocator;
const FixedEditPlan = fixed_edit_buffer.FixedEditPlan;
const NodeIndex = parser.ast.NodeIndex;
const RuntimeEditBuffer = runtime_edit_buffer.RuntimeEditBuffer;
const RuntimeFragment = runtime_edit_buffer.RuntimeFragment;
const RuntimeNameAllocator = runtime_name_allocator.RuntimeNameAllocator;
const SourceFile = source_file.SourceFile;

const CommentsRange = struct { start: u32, end: u32 };

const EmittedAttribute = struct {
    content: RuntimeFragment,
    is_key: bool,
    is_spread: bool,
};

const EmittedAttributes = struct {
    allocator: Allocator,
    entries: std.ArrayList(EmittedAttribute) = .empty,
    has_key_after_spread: bool = false,
    key: ?RuntimeFragment = null,
    trailing_comments: CommentsRange,

    fn deinit(self: *EmittedAttributes) void {
        for (self.entries.items) |*entry| entry.content.deinit();
        self.entries.deinit(self.allocator);
        if (self.key) |*key| key.deinit();
    }
};

const EmittedChild = struct {
    content: RuntimeFragment,
    is_spread: bool,
};

const EmittedChildren = struct {
    allocator: Allocator,
    values: std.ArrayList(EmittedChild) = .empty,
    comments_after_properties: RuntimeFragment,

    fn init(allocator: Allocator) EmittedChildren {
        return .{
            .allocator = allocator,
            .comments_after_properties = RuntimeFragment.init(allocator),
        };
    }

    fn deinit(self: *EmittedChildren) void {
        for (self.values.items) |*child| child.content.deinit();
        self.values.deinit(self.allocator);
        self.comments_after_properties.deinit();
    }
};

const RuntimeImport = struct {
    imported: []const u8,
    local: []const u8,
    source: []u8,
};

pub const Emitter = struct {
    allocator: Allocator,
    file: *const SourceFile,
    fixed: *const FixedEditPlan,
    names: *RuntimeNameAllocator,
    config: jsx_config.Config,
    jsx_nodes: []const NodeIndex,
    line_heads: std.AutoHashMapUnmanaged(u32, source_layout.SourceAnchor) = .empty,
    root_paddings: std.ArrayList(source_layout.SourceAnchor) = .empty,
    imports: std.ArrayList(RuntimeImport) = .empty,

    pub fn init(
        allocator: Allocator,
        file: *const SourceFile,
        fixed: *const FixedEditPlan,
        names: *RuntimeNameAllocator,
        config: jsx_config.Config,
        jsx_nodes: []const NodeIndex,
        jsx_roots: []const NodeIndex,
    ) Allocator.Error!Emitter {
        var emitter: Emitter = .{
            .allocator = allocator,
            .file = file,
            .fixed = fixed,
            .names = names,
            .config = config,
            .jsx_nodes = jsx_nodes,
        };
        errdefer emitter.deinit();
        try emitter.collect_anchors(jsx_roots);
        if (config == .classic) {
            try names.reserve(member_root(config.classic.pragma));
            try names.reserve(member_root(config.classic.pragma_frag));
        }
        return emitter;
    }

    pub fn deinit(self: *Emitter) void {
        self.line_heads.deinit(self.allocator);
        self.root_paddings.deinit(self.allocator);
        for (self.imports.items) |runtime_import| self.allocator.free(runtime_import.source);
        self.imports.deinit(self.allocator);
    }

    pub fn lower_roots(
        self: *Emitter,
        edits: *RuntimeEditBuffer,
        roots: []const NodeIndex,
    ) Allocator.Error!void {
        std.debug.assert(roots.len == self.root_paddings.items.len);
        for (roots, self.root_paddings.items) |index, padding_anchor| {
            var fragment = try self.emit_jsx(index);
            const span = self.file.tree.span(index);
            edits.add_fragment(span.start, span.end, fragment) catch |err| {
                fragment.deinit();
                return err;
            };
            var padding = RuntimeFragment.init(self.allocator);
            padding.record_source_padding(padding_anchor) catch |err| {
                padding.deinit();
                return err;
            };
            edits.add_fragment(padding_anchor.offset, padding_anchor.offset, padding) catch |err| {
                padding.deinit();
                return err;
            };
        }
        try self.append_runtime_imports(edits);
    }

    fn emit_jsx(self: *Emitter, index: NodeIndex) Allocator.Error!RuntimeFragment {
        return switch (self.config) {
            .classic => |config| self.emit_classic(index, config),
            .automatic => |config| self.emit_automatic(index, config),
            .disabled, .preserve => unreachable,
        };
    }

    fn emit_classic(
        self: *Emitter,
        index: NodeIndex,
        config: jsx_config.Classic,
    ) Allocator.Error!RuntimeFragment {
        var children = try self.emit_children(index);
        defer children.deinit();

        switch (self.file.tree.data(index)) {
            .jsx_fragment => {
                var element_type = try generated_fragment(self.allocator, config.pragma_frag);
                defer element_type.deinit();
                var properties = try self.emit_classic_properties(&.{}, &children.comments_after_properties);
                defer properties.deinit();
                return self.emit_create_element(
                    index,
                    config.pragma,
                    &element_type,
                    &properties,
                    &children,
                );
            },
            .jsx_element => |element| {
                const opening = self.file.tree.data(element.opening_element).jsx_opening_element;
                var element_type = try self.emit_element_type(opening.name);
                defer element_type.deinit();
                var attributes = try self.emit_attributes(element.opening_element, opening);
                defer attributes.deinit();
                try self.append_comments_fragment(
                    &children.comments_after_properties,
                    attributes.trailing_comments,
                );
                var properties = try self.emit_classic_properties(
                    attributes.entries.items,
                    &children.comments_after_properties,
                );
                defer properties.deinit();
                return self.emit_create_element(
                    index,
                    config.pragma,
                    &element_type,
                    &properties,
                    &children,
                );
            },
            else => unreachable,
        }
    }

    fn emit_automatic(
        self: *Emitter,
        index: NodeIndex,
        config: jsx_config.Automatic,
    ) Allocator.Error!RuntimeFragment {
        var children = try self.emit_children(index);
        defer children.deinit();

        switch (self.file.tree.data(index)) {
            .jsx_fragment => {
                const helper = try self.automatic_helper(config, "Fragment", null);
                var element_type = try generated_fragment(self.allocator, helper);
                defer element_type.deinit();
                var properties = try self.emit_automatic_properties(
                    &.{},
                    &children,
                    .{ .start = 0, .end = 0 },
                );
                defer properties.deinit();
                return self.emit_automatic_call(
                    index,
                    &element_type,
                    &properties,
                    null,
                    &children,
                    config,
                );
            },
            .jsx_element => |element| {
                const opening = self.file.tree.data(element.opening_element).jsx_opening_element;
                var element_type = try self.emit_element_type(opening.name);
                defer element_type.deinit();
                var attributes = try self.emit_attributes(element.opening_element, opening);
                defer attributes.deinit();

                if (attributes.has_key_after_spread) {
                    try self.append_comments_fragment(
                        &children.comments_after_properties,
                        attributes.trailing_comments,
                    );
                    var properties = try self.emit_classic_properties(
                        attributes.entries.items,
                        &children.comments_after_properties,
                    );
                    defer properties.deinit();
                    const create_element = try self.automatic_helper(
                        config,
                        "createElement",
                        config.import_source,
                    );
                    return self.emit_create_element(
                        index,
                        create_element,
                        &element_type,
                        &properties,
                        &children,
                    );
                }

                var properties = try self.emit_automatic_properties(
                    attributes.entries.items,
                    &children,
                    attributes.trailing_comments,
                );
                defer properties.deinit();
                return self.emit_automatic_call(
                    index,
                    &element_type,
                    &properties,
                    if (attributes.key) |*key| key else null,
                    &children,
                    config,
                );
            },
            else => unreachable,
        }
    }

    fn emit_automatic_call(
        self: *Emitter,
        index: NodeIndex,
        element_type: *RuntimeFragment,
        properties: *RuntimeFragment,
        key: ?*RuntimeFragment,
        children: *const EmittedChildren,
        config: jsx_config.Automatic,
    ) Allocator.Error!RuntimeFragment {
        var result = RuntimeFragment.init(self.allocator);
        errdefer result.deinit();
        try self.record_line_head(&result, index);

        var static_children = children.values.items.len > 1;
        for (children.values.items) |child| static_children = static_children or child.is_spread;
        if (config.development) {
            const helper = try self.automatic_helper(config, "jsxDEV", null);
            try append_fmt(&result, "{s}(", .{helper});
            try result.append_fragment(element_type);
            try result.append_generated(", ");
            try result.append_fragment(properties);
            try result.append_generated(", ");
            if (key) |key_fragment| {
                try result.append_fragment(key_fragment);
            } else {
                try result.append_generated("undefined");
            }
            try append_fmt(&result, ", {s})", .{if (static_children) "true" else "false"});
            return result;
        }

        const imported = if (static_children) "jsxs" else "jsx";
        const helper = try self.automatic_helper(config, imported, null);
        try append_fmt(&result, "{s}(", .{helper});
        try result.append_fragment(element_type);
        try result.append_generated(", ");
        try result.append_fragment(properties);
        if (key) |key_fragment| {
            try result.append_generated(", ");
            try result.append_fragment(key_fragment);
        }
        try result.append_generated(")");
        return result;
    }

    fn emit_create_element(
        self: *Emitter,
        index: NodeIndex,
        factory: []const u8,
        element_type: *RuntimeFragment,
        properties: *RuntimeFragment,
        children: *EmittedChildren,
    ) Allocator.Error!RuntimeFragment {
        var result = RuntimeFragment.init(self.allocator);
        errdefer result.deinit();
        try self.record_line_head(&result, index);
        try append_fmt(&result, "{s}(", .{factory});
        try result.append_fragment(element_type);
        try result.append_generated(", ");
        try result.append_fragment(properties);
        for (children.values.items) |*child| {
            try result.append_generated(", ");
            if (child.is_spread) try result.append_generated("...");
            try result.append_fragment(&child.content);
        }
        try result.append_generated(")");
        return result;
    }

    fn emit_attributes(
        self: *Emitter,
        opening_index: NodeIndex,
        opening: parser.ast.JSXOpeningElement,
    ) Allocator.Error!EmittedAttributes {
        var result: EmittedAttributes = .{
            .allocator = self.allocator,
            .trailing_comments = undefined,
        };
        errdefer result.deinit();
        var cursor = self.file.tree.span(opening.name).end;
        var has_spread = false;

        for (self.file.tree.extra(opening.attributes)) |attribute_index| {
            const span = self.file.tree.span(attribute_index);
            const leading = CommentsRange{ .start = cursor, .end = span.start };
            switch (self.file.tree.data(attribute_index)) {
                .jsx_spread_attribute => |attribute| {
                    const argument_span = self.file.tree.span(attribute.argument);
                    var content = RuntimeFragment.init(self.allocator);
                    errdefer content.deinit();
                    try self.append_comments_fragment(&content, leading);
                    try content.append_generated("...");
                    try self.append_comments_fragment(&content, .{
                        .start = span.start,
                        .end = argument_span.start,
                    });
                    var argument = try self.emit_single_expression(attribute.argument);
                    defer argument.deinit();
                    try content.append_fragment(&argument);
                    try self.append_comments_fragment(&content, .{
                        .start = argument_span.end,
                        .end = span.end,
                    });
                    try result.entries.append(self.allocator, .{
                        .content = content,
                        .is_key = false,
                        .is_spread = true,
                    });
                    has_spread = true;
                },
                .jsx_attribute => |attribute| {
                    const attribute_name = try self.jsx_name_text(attribute.name);
                    defer self.allocator.free(attribute_name);
                    var content = RuntimeFragment.init(self.allocator);
                    errdefer content.deinit();
                    try self.append_comments_fragment(&content, leading);
                    try append_string_literal(&content, attribute_name);
                    try content.append_generated(": ");
                    var value = try self.emit_attribute_value(attribute.value);
                    defer value.deinit();
                    try content.append_fragment(&value);

                    const is_key = std.mem.eql(u8, attribute_name, "key");
                    try result.entries.append(self.allocator, .{
                        .content = content,
                        .is_key = is_key,
                        .is_spread = false,
                    });
                    if (is_key) {
                        if (result.key) |*previous| previous.deinit();
                        var key = RuntimeFragment.init(self.allocator);
                        errdefer key.deinit();
                        try self.append_comments_fragment(&key, leading);
                        var key_value = try self.emit_attribute_value(attribute.value);
                        defer key_value.deinit();
                        try key.append_fragment(&key_value);
                        result.key = key;
                        result.has_key_after_spread = result.has_key_after_spread or has_spread;
                    }
                },
                else => unreachable,
            }
            cursor = span.end;
        }
        result.trailing_comments = .{
            .start = cursor,
            .end = self.file.tree.span(opening_index).end,
        };
        return result;
    }

    fn emit_attribute_value(
        self: *Emitter,
        value_index: NodeIndex,
    ) Allocator.Error!RuntimeFragment {
        if (value_index == .null) return generated_fragment(self.allocator, "true");
        switch (self.file.tree.data(value_index)) {
            .string_literal => |literal| {
                const decoded = try jsx_entities.decode(
                    self.allocator,
                    self.file.tree.string(literal.value),
                );
                defer self.allocator.free(decoded);
                const normalized = try normalize_attribute_string(self.allocator, decoded);
                defer self.allocator.free(normalized);
                var result = RuntimeFragment.init(self.allocator);
                errdefer result.deinit();
                try append_string_literal(&result, normalized);
                return result;
            },
            .jsx_expression_container => |container| {
                if (self.file.tree.data(container.expression) == .jsx_empty_expression) {
                    return generated_fragment(self.allocator, "undefined");
                }
                const span = self.file.tree.span(value_index);
                const expression_span = self.file.tree.span(container.expression);
                var result = RuntimeFragment.init(self.allocator);
                errdefer result.deinit();
                try self.append_comments_fragment(&result, .{
                    .start = span.start,
                    .end = expression_span.start,
                });
                var expression = try self.emit_single_expression(container.expression);
                defer expression.deinit();
                try result.append_fragment(&expression);
                try self.append_comments_fragment(&result, .{
                    .start = expression_span.end,
                    .end = span.end,
                });
                return result;
            },
            .jsx_element, .jsx_fragment => return self.emit_jsx(value_index),
            else => {
                const span = self.file.tree.span(value_index);
                var result = RuntimeFragment.init(self.allocator);
                errdefer result.deinit();
                try result.append_original(span.start, span.end);
                return result;
            },
        }
    }

    fn emit_children(self: *Emitter, parent: NodeIndex) Allocator.Error!EmittedChildren {
        var result = EmittedChildren.init(self.allocator);
        errdefer result.deinit();
        const range = switch (self.file.tree.data(parent)) {
            .jsx_element => |element| element.children,
            .jsx_fragment => |fragment| fragment.children,
            else => unreachable,
        };
        for (self.file.tree.extra(range)) |child_index| {
            switch (self.file.tree.data(child_index)) {
                .jsx_text => |text| {
                    const decoded = try jsx_entities.decode(
                        self.allocator,
                        self.file.tree.string(text.value),
                    );
                    defer self.allocator.free(decoded);
                    const cleaned = try clean_text(self.allocator, decoded);
                    defer self.allocator.free(cleaned);
                    if (cleaned.len == 0) continue;
                    var content = RuntimeFragment.init(self.allocator);
                    errdefer content.deinit();
                    try append_string_literal(&content, cleaned);
                    try result.values.append(self.allocator, .{
                        .content = content,
                        .is_spread = false,
                    });
                },
                .jsx_expression_container => |container| {
                    if (self.file.tree.data(container.expression) == .jsx_empty_expression) {
                        const span = self.file.tree.span(container.expression);
                        const comment = self.file.source()[span.start..span.end];
                        if (std.mem.trim(u8, comment, " \t\r\n").len == 0) continue;
                        if (result.values.items.len == 0) {
                            try result.comments_after_properties.append_generated(comment);
                        } else {
                            const previous = &result.values.items[result.values.items.len - 1];
                            try previous.content.append_generated(comment);
                        }
                        continue;
                    }
                    var content = try self.emit_child_expression(child_index, container.expression);
                    errdefer content.deinit();
                    try result.values.append(self.allocator, .{
                        .content = content,
                        .is_spread = false,
                    });
                },
                .jsx_spread_child => |spread| {
                    var content = try self.emit_child_expression(child_index, spread.expression);
                    errdefer content.deinit();
                    try result.values.append(self.allocator, .{
                        .content = content,
                        .is_spread = true,
                    });
                },
                .jsx_element, .jsx_fragment => {
                    var content = try self.emit_jsx(child_index);
                    errdefer content.deinit();
                    try result.values.append(self.allocator, .{
                        .content = content,
                        .is_spread = false,
                    });
                },
                else => unreachable,
            }
        }
        return result;
    }

    fn emit_child_expression(
        self: *Emitter,
        container_index: NodeIndex,
        expression_index: NodeIndex,
    ) Allocator.Error!RuntimeFragment {
        const container_span = self.file.tree.span(container_index);
        const expression_span = self.file.tree.span(expression_index);
        var result = RuntimeFragment.init(self.allocator);
        errdefer result.deinit();
        try self.append_comments_fragment(&result, .{
            .start = container_span.start,
            .end = expression_span.start,
        });
        var expression = try self.emit_single_expression(expression_index);
        defer expression.deinit();
        try result.append_fragment(&expression);
        try self.append_comments_fragment(&result, .{
            .start = expression_span.end,
            .end = container_span.end,
        });
        return result;
    }

    fn emit_single_expression(self: *Emitter, index: NodeIndex) Allocator.Error!RuntimeFragment {
        var expression = try self.emit_jsx_expression(index);
        if (self.file.tree.data(index) != .sequence_expression) return expression;
        defer expression.deinit();
        var result = RuntimeFragment.init(self.allocator);
        errdefer result.deinit();
        try result.append_generated("(");
        try result.append_fragment(&expression);
        try result.append_generated(")");
        return result;
    }

    fn emit_jsx_expression(self: *Emitter, index: NodeIndex) Allocator.Error!RuntimeFragment {
        switch (self.file.tree.data(index)) {
            .jsx_element, .jsx_fragment => return self.emit_jsx(index),
            else => {},
        }
        const span = self.file.tree.span(index);
        var result = RuntimeFragment.init(self.allocator);
        errdefer result.deinit();
        var cursor = span.start;
        var covered_until = span.start;
        var node_index = self.jsx_node_index_at_or_after(span.start);
        while (node_index < self.jsx_nodes.len) : (node_index += 1) {
            const child = self.jsx_nodes[node_index];
            const child_span = self.file.tree.span(child);
            if (child_span.start >= span.end) break;
            if (child_span.end > span.end or child_span.start < covered_until) continue;
            try result.append_original(cursor, child_span.start);
            var lowered = try self.emit_jsx(child);
            defer lowered.deinit();
            try result.append_fragment(&lowered);
            cursor = child_span.end;
            covered_until = child_span.end;
        }
        try result.append_original(cursor, span.end);
        return result;
    }

    fn emit_element_type(self: *Emitter, index: NodeIndex) Allocator.Error!RuntimeFragment {
        switch (self.file.tree.data(index)) {
            .jsx_identifier => |identifier| {
                const name = self.file.tree.string(identifier.name);
                if (!std.mem.eql(u8, name, "this") and is_intrinsic_name(name)) {
                    var result = RuntimeFragment.init(self.allocator);
                    errdefer result.deinit();
                    try append_string_literal(&result, name);
                    return result;
                }
                const span = self.file.tree.span(index);
                var result = RuntimeFragment.init(self.allocator);
                errdefer result.deinit();
                try result.append_original(span.start, span.end);
                return result;
            },
            .jsx_member_expression => {
                const span = self.file.tree.span(index);
                var result = RuntimeFragment.init(self.allocator);
                errdefer result.deinit();
                try result.append_original(span.start, span.end);
                return result;
            },
            .jsx_namespaced_name => {
                const name = try self.jsx_name_text(index);
                defer self.allocator.free(name);
                var result = RuntimeFragment.init(self.allocator);
                errdefer result.deinit();
                try append_string_literal(&result, name);
                return result;
            },
            else => unreachable,
        }
    }

    fn emit_classic_properties(
        self: *Emitter,
        entries: []EmittedAttribute,
        trailing_comments: *RuntimeFragment,
    ) Allocator.Error!RuntimeFragment {
        if (entries.len == 0) {
            var result = RuntimeFragment.init(self.allocator);
            errdefer result.deinit();
            try result.append_fragment(trailing_comments);
            try result.append_generated("null");
            return result;
        }
        var result = RuntimeFragment.init(self.allocator);
        errdefer result.deinit();
        try result.append_generated("{");
        for (entries, 0..) |*entry, index| {
            if (index > 0) try result.append_generated(", ");
            try result.append_fragment(&entry.content);
        }
        try result.append_fragment(trailing_comments);
        try result.append_generated("}");
        return result;
    }

    fn emit_automatic_properties(
        self: *Emitter,
        entries: []EmittedAttribute,
        children: *EmittedChildren,
        trailing_comments: CommentsRange,
    ) Allocator.Error!RuntimeFragment {
        var result = RuntimeFragment.init(self.allocator);
        errdefer result.deinit();
        try result.append_generated("{");
        var count: usize = 0;
        for (entries) |*entry| {
            if (entry.is_key) continue;
            if (count > 0) try result.append_generated(", ");
            try result.append_fragment(&entry.content);
            count += 1;
        }
        if (children.values.items.len > 0) {
            if (count > 0) try result.append_generated(", ");
            try self.append_comments_fragment(&result, trailing_comments);
            try result.append_fragment(&children.comments_after_properties);
            try append_string_literal(&result, "children");
            try result.append_generated(": ");
            try emit_automatic_children_value(&result, children);
        } else {
            try self.append_comments_fragment(&result, trailing_comments);
            try result.append_fragment(&children.comments_after_properties);
        }
        try result.append_generated("}");
        return result;
    }

    fn emit_automatic_children_value(
        result: *RuntimeFragment,
        children: *EmittedChildren,
    ) Allocator.Error!void {
        if (children.values.items.len == 1 and !children.values.items[0].is_spread) {
            try result.append_fragment(&children.values.items[0].content);
            return;
        }
        try result.append_generated("[");
        for (children.values.items, 0..) |*child, index| {
            if (index > 0) try result.append_generated(", ");
            if (child.is_spread) try result.append_generated("...");
            try result.append_fragment(&child.content);
        }
        try result.append_generated("]");
    }

    fn jsx_name_text(self: *Emitter, index: NodeIndex) Allocator.Error![]u8 {
        return switch (self.file.tree.data(index)) {
            .jsx_identifier => |identifier| self.allocator.dupe(
                u8,
                self.file.tree.string(identifier.name),
            ),
            .jsx_namespaced_name => |name| blk: {
                const namespace = try self.jsx_name_text(name.namespace);
                defer self.allocator.free(namespace);
                const local = try self.jsx_name_text(name.name);
                defer self.allocator.free(local);
                break :blk std.fmt.allocPrint(self.allocator, "{s}:{s}", .{ namespace, local });
            },
            .jsx_member_expression => |name| blk: {
                _ = name;
                const span = self.file.tree.span(index);
                break :blk self.allocator.dupe(u8, self.file.source()[span.start..span.end]);
            },
            else => unreachable,
        };
    }

    fn append_comments_fragment(
        self: *Emitter,
        result: *RuntimeFragment,
        range: CommentsRange,
    ) Allocator.Error!void {
        if (range.start >= range.end) return;
        var output: std.ArrayList(u8) = .empty;
        errdefer output.deinit(self.allocator);
        const cursor = self.file.comment_cursor();
        try cursor.append_range(&output, self.allocator, range.start, range.end);
        const owned = try output.toOwnedSlice(self.allocator);
        try result.append_owned_generated(owned);
    }

    fn automatic_helper(
        self: *Emitter,
        config: jsx_config.Automatic,
        imported: []const u8,
        source_override: ?[]const u8,
    ) Allocator.Error![]const u8 {
        const source = if (source_override) |override|
            try self.allocator.dupe(u8, override)
        else
            try std.fmt.allocPrint(
                self.allocator,
                "{s}/{s}",
                .{ config.import_source, if (config.development) "jsx-dev-runtime" else "jsx-runtime" },
            );
        errdefer self.allocator.free(source);
        for (self.imports.items) |runtime_import| {
            if (std.mem.eql(u8, runtime_import.source, source) and
                std.mem.eql(u8, runtime_import.imported, imported))
            {
                self.allocator.free(source);
                return runtime_import.local;
            }
        }
        const base = try std.fmt.allocPrint(self.allocator, "_{s}", .{imported});
        defer self.allocator.free(base);
        const local = try self.names.claim_generated_preferred(base, 2);
        try self.imports.append(self.allocator, .{
            .imported = imported,
            .local = local,
            .source = source,
        });
        return local;
    }

    fn append_runtime_imports(
        self: *Emitter,
        edits: *RuntimeEditBuffer,
    ) Allocator.Error!void {
        std.mem.sort(RuntimeImport, self.imports.items, {}, less_than_runtime_import);
        var start: usize = 0;
        while (start < self.imports.items.len) {
            var end = start + 1;
            while (end < self.imports.items.len and std.mem.eql(
                u8,
                self.imports.items[start].source,
                self.imports.items[end].source,
            )) : (end += 1) {}
            var line: std.ArrayList(u8) = .empty;
            defer line.deinit(self.allocator);
            try line.appendSlice(self.allocator, "import { ");
            for (self.imports.items[start..end], 0..) |runtime_import, index| {
                if (index > 0) try line.appendSlice(self.allocator, ", ");
                try line.appendSlice(self.allocator, runtime_import.imported);
                try line.appendSlice(self.allocator, " as ");
                try line.appendSlice(self.allocator, runtime_import.local);
            }
            try line.appendSlice(self.allocator, " } from ");
            try js_string.append_literal(&line, self.allocator, self.imports.items[start].source);
            try line.append(self.allocator, ';');
            try edits.add_generated_end_line(line.items);
            start = end;
        }
    }

    fn collect_anchors(
        self: *Emitter,
        roots: []const NodeIndex,
    ) Allocator.Error!void {
        var cursor = source_layout.SourceCursor.init(self.file.source());
        var node_index: usize = 0;
        var root_index: usize = 0;
        var previous_node_line: ?u32 = null;

        while (node_index < self.jsx_nodes.len or root_index < roots.len) {
            const node_offset = if (node_index < self.jsx_nodes.len)
                self.file.tree.span(self.jsx_nodes[node_index]).start
            else
                std.math.maxInt(u32);
            const root_end = if (root_index < roots.len)
                self.file.tree.span(roots[root_index]).end
            else
                std.math.maxInt(u32);
            const offset = @min(node_offset, root_end);
            const line = cursor.line_at_offset(offset);

            if (node_offset == offset) {
                if (previous_node_line != line.index) {
                    try self.line_heads.put(self.allocator, offset, .{
                        .offset = offset,
                        .line = line.index,
                    });
                    previous_node_line = line.index;
                }
                node_index += 1;
            }
            if (root_end == offset) {
                try self.root_paddings.append(self.allocator, .{
                    .offset = line.content_end,
                    .line = line.index,
                });
                root_index += 1;
            }
        }
    }

    fn record_line_head(
        self: *Emitter,
        result: *RuntimeFragment,
        index: NodeIndex,
    ) Allocator.Error!void {
        const offset = self.file.tree.span(index).start;
        if (self.line_heads.get(offset)) |anchor| try result.record_line_head(anchor);
    }

    fn jsx_node_index_at_or_after(self: *const Emitter, offset: u32) usize {
        var low: usize = 0;
        var high = self.jsx_nodes.len;
        while (low < high) {
            const middle = low + (high - low) / 2;
            if (self.file.tree.span(self.jsx_nodes[middle]).start >= offset) {
                high = middle;
            } else {
                low = middle + 1;
            }
        }
        return low;
    }
};

fn generated_fragment(allocator: Allocator, text: []const u8) Allocator.Error!RuntimeFragment {
    var result = RuntimeFragment.init(allocator);
    errdefer result.deinit();
    try result.append_generated(text);
    return result;
}

fn append_string_literal(result: *RuntimeFragment, value: []const u8) Allocator.Error!void {
    const owned = try js_string.literal(result.allocator, value);
    try result.append_owned_generated(owned);
}

fn append_fmt(result: *RuntimeFragment, comptime format: []const u8, args: anytype) Allocator.Error!void {
    const owned = try std.fmt.allocPrint(result.allocator, format, args);
    try result.append_owned_generated(owned);
}

fn member_root(value: []const u8) []const u8 {
    const dot = std.mem.indexOfScalar(u8, value, '.') orelse return value;
    return value[0..dot];
}

fn is_intrinsic_name(name: []const u8) bool {
    return (name.len > 0 and name[0] >= 'a' and name[0] <= 'z') or
        std.mem.indexOfScalar(u8, name, '-') != null;
}

fn normalize_attribute_string(allocator: Allocator, value: []const u8) Allocator.Error![]u8 {
    var result: std.ArrayList(u8) = .empty;
    errdefer result.deinit(allocator);
    var cursor: usize = 0;
    while (cursor < value.len) {
        if (value[cursor] != '\n' or cursor + 1 >= value.len or !is_js_whitespace(value[cursor + 1])) {
            try result.append(allocator, value[cursor]);
            cursor += 1;
            continue;
        }
        try result.append(allocator, ' ');
        cursor += 1;
        while (cursor < value.len and is_js_whitespace(value[cursor])) cursor += 1;
    }
    return result.toOwnedSlice(allocator);
}

fn is_js_whitespace(byte: u8) bool {
    return switch (byte) {
        ' ', '\t', '\n', '\r', 0x0b, 0x0c => true,
        else => false,
    };
}

fn clean_text(allocator: Allocator, value: []const u8) Allocator.Error![]u8 {
    var normalized: std.ArrayList(u8) = .empty;
    defer normalized.deinit(allocator);
    var cursor: usize = 0;
    while (cursor < value.len) {
        if (value[cursor] == '\r') {
            try normalized.append(allocator, '\n');
            cursor += if (cursor + 1 < value.len and value[cursor + 1] == '\n') 2 else 1;
            continue;
        }
        try normalized.append(allocator, if (value[cursor] == '\t') ' ' else value[cursor]);
        cursor += 1;
    }

    var last_non_empty: usize = 0;
    var line_index: usize = 0;
    var lines = std.mem.splitScalar(u8, normalized.items, '\n');
    while (lines.next()) |line| : (line_index += 1) {
        if (std.mem.trim(u8, line, " ").len > 0) last_non_empty = line_index;
    }

    var result: std.ArrayList(u8) = .empty;
    errdefer result.deinit(allocator);
    lines = std.mem.splitScalar(u8, normalized.items, '\n');
    line_index = 0;
    const line_count = std.mem.count(u8, normalized.items, "\n") + 1;
    while (lines.next()) |raw_line| : (line_index += 1) {
        var line = raw_line;
        if (line_index != 0) line = std.mem.trimStart(u8, line, " ");
        if (line_index + 1 != line_count) line = std.mem.trimEnd(u8, line, " ");
        if (line.len == 0) continue;
        try result.appendSlice(allocator, line);
        if (line_index != last_non_empty) try result.append(allocator, ' ');
    }
    return result.toOwnedSlice(allocator);
}

fn less_than_runtime_import(_: void, left: RuntimeImport, right: RuntimeImport) bool {
    const source_order = std.mem.order(u8, left.source, right.source);
    if (source_order != .eq) return source_order == .lt;
    const left_order = runtime_import_order(left.imported);
    const right_order = runtime_import_order(right.imported);
    if (left_order != right_order) return left_order < right_order;
    return std.mem.lessThan(u8, left.imported, right.imported);
}

fn runtime_import_order(imported: []const u8) u8 {
    if (std.mem.eql(u8, imported, "jsx")) return 0;
    if (std.mem.eql(u8, imported, "jsxs")) return 1;
    if (std.mem.eql(u8, imported, "jsxDEV")) return 2;
    if (std.mem.eql(u8, imported, "Fragment")) return 3;
    if (std.mem.eql(u8, imported, "createElement")) return 4;
    return std.math.maxInt(u8);
}
