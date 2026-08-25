const std = @import("std");
const parser = @import("parser");
const fixed_edit_buffer = @import("fixed_edit_buffer.zig");
const enum_lowering = @import("runtime/enum.zig");
const import_equals_lowering = @import("runtime/import_equals.zig");
const jsx_config = @import("jsx_config.zig");
const jsx_emitter = @import("jsx_emitter.zig");
const namespace_lowering = @import("runtime/namespace.zig");
const parameter_properties_lowering = @import("runtime/parameter_properties.zig");
const namespace_semantics = @import("namespace_semantics.zig");
const runtime_edit_buffer = @import("runtime_edit_buffer.zig");
const runtime_name_allocator = @import("runtime_name_allocator.zig");
const source_file = @import("source_file.zig");

const Allocator = std.mem.Allocator;
const Ctx = parser.traverser.basic.Ctx;
const FixedEditPlan = fixed_edit_buffer.FixedEditPlan;
const NodeIndex = parser.ast.NodeIndex;
const RuntimeEditBuffer = runtime_edit_buffer.RuntimeEditBuffer;
const RuntimeNameAllocator = runtime_name_allocator.RuntimeNameAllocator;
const SourceFile = source_file.SourceFile;

const NamespaceCaptureFrame = struct {
    task_index: usize,
    barrier_depth: u32,
    public_name: []const u8,
    declaration_id: NodeIndex,
};

/// Runtime tasks collected during the fixed eraser's existing Yuku traversal.
/// The common JSX-only path records only identifiers that can collide with an
/// automatic-runtime helper. Dynamic enum and namespace names enable a flat
/// post-traversal node scan so their arbitrary generated names retain the same
/// conservative collision behavior.
pub const RuntimeFeatureCollection = struct {
    allocator: Allocator,
    names: RuntimeNameAllocator,
    enums: std.ArrayList(NodeIndex) = .empty,
    enum_references: enum_lowering.ReferenceMap = .empty,
    import_equals: std.ArrayList(import_equals_lowering.Task) = .empty,
    parameter_properties: std.ArrayList(parameter_properties_lowering.Task) = .empty,
    parameter_property_tasks: std.AutoHashMapUnmanaged(u32, usize) = .empty,
    namespaces: std.ArrayList(namespace_lowering.DeclarationTask) = .empty,
    namespace_exports: std.ArrayList(namespace_lowering.ExportTask) = .empty,
    namespace_capture_stack: std.ArrayList(NamespaceCaptureFrame) = .empty,
    capture_barrier_depth: u32 = 0,
    enum_member_stack: std.ArrayList(NodeIndex) = .empty,
    collect_jsx: bool,
    jsx_nodes: std.ArrayList(NodeIndex) = .empty,
    jsx_roots: std.ArrayList(NodeIndex) = .empty,
    jsx_depth: u32 = 0,

    pub fn init(allocator: Allocator, collect_jsx: bool) RuntimeFeatureCollection {
        return .{
            .allocator = allocator,
            .names = RuntimeNameAllocator.init(allocator),
            .collect_jsx = collect_jsx,
        };
    }

    pub fn deinit(self: *RuntimeFeatureCollection) void {
        self.enums.deinit(self.allocator);
        enum_lowering.deinit_reference_map(&self.enum_references, self.allocator);
        self.import_equals.deinit(self.allocator);
        for (self.parameter_properties.items) |*task| task.super_calls.deinit(self.allocator);
        self.parameter_properties.deinit(self.allocator);
        self.parameter_property_tasks.deinit(self.allocator);
        self.namespaces.deinit(self.allocator);
        self.namespace_exports.deinit(self.allocator);
        self.namespace_capture_stack.deinit(self.allocator);
        self.enum_member_stack.deinit(self.allocator);
        self.jsx_nodes.deinit(self.allocator);
        self.jsx_roots.deinit(self.allocator);
        self.names.deinit();
    }

    pub fn collect_node(
        self: *RuntimeFeatureCollection,
        data: parser.ast.NodeData,
        index: NodeIndex,
        ctx: *Ctx,
    ) Allocator.Error!void {
        const runtime_name = switch (data) {
            .binding_identifier => |identifier| identifier.name,
            .identifier_reference => |identifier| identifier.name,
            .jsx_identifier => |identifier| identifier.name,
            else => null,
        };
        if (runtime_name) |string| {
            const name = ctx.tree.string(string);
            if (is_automatic_runtime_name(name)) try self.names.add_source_name(name);
            self.collect_active_namespace_identifier(index, name);
        }

        if (data == .ts_module_declaration) {
            try self.enter_namespace(data.ts_module_declaration, index, ctx);
        } else {
            self.enter_capture_boundary(data, ctx.tree);
        }
        if (data == .ts_enum_member) {
            try self.enum_member_stack.append(self.allocator, index);
        }
        if (self.collect_jsx and is_jsx_node(data)) {
            try self.jsx_nodes.append(self.allocator, index);
            if (self.jsx_depth == 0) try self.jsx_roots.append(self.allocator, index);
            self.jsx_depth += 1;
        }

        switch (data) {
            .identifier_reference => {
                const member = self.enum_member_stack.getLastOrNull() orelse return;
                const entry = try self.enum_references.getOrPut(
                    self.allocator,
                    @intFromEnum(member),
                );
                if (!entry.found_existing) entry.value_ptr.* = .empty;
                try entry.value_ptr.append(self.allocator, index);
            },
            .ts_enum_declaration => |declaration| {
                if (declaration.declare) return;
                try self.enums.append(self.allocator, index);
            },
            .ts_import_equals_declaration => |declaration| {
                if (declaration.import_kind == .type) return;
                const export_wrapper = if (ctx.path.parent()) |parent|
                    switch (ctx.tree.data(parent)) {
                        .export_named_declaration => |wrapper| if (wrapper.declaration == index)
                            parent
                        else
                            null,
                        else => null,
                    }
                else
                    null;
                const exported = export_wrapper != null;
                if (exported and nearest_runtime_namespace(ctx) != .null) return;
                try self.import_equals.append(self.allocator, .{
                    .index = index,
                    .replacement_index = export_wrapper orelse index,
                    .exported = exported,
                });
            },
            .method_definition => |method| {
                if (method.kind != .constructor) return;
                const parent = ctx.path.parent() orelse return;
                if (ctx.tree.data(parent) != .class_body) return;
                const function = switch (ctx.tree.data(method.value)) {
                    .function => |value| value,
                    else => return,
                };
                if (!parameter_properties_lowering.has_properties(ctx.tree, function)) return;
                const task_index = self.parameter_properties.items.len;
                try self.parameter_properties.append(self.allocator, .{
                    .method = index,
                    .class_body = parent,
                    .function = method.value,
                });
                try self.parameter_property_tasks.put(
                    self.allocator,
                    @intFromEnum(method.value),
                    task_index,
                );
            },
            .call_expression => |call| {
                if (ctx.tree.data(call.callee) != .super) return;
                const task_index = self.nearest_parameter_property_task(ctx) orelse return;
                const whole_statement = call_is_whole_expression_statement(ctx.tree, index, ctx);
                try self.parameter_properties.items[task_index].super_calls.append(self.allocator, .{
                    .call = index,
                    .whole_statement = whole_statement,
                });
            },
            .ts_module_declaration => {},
            .export_named_declaration => |wrapper| {
                if (wrapper.export_kind == .type or wrapper.declaration == .null) return;
                const owner = nearest_runtime_namespace(ctx);
                if (owner == .null) return;
                if (!namespace_semantics.is_supported_runtime_export_declaration(
                    ctx.tree,
                    wrapper.declaration,
                )) return;
                if (ctx.tree.data(wrapper.declaration) == .ts_module_declaration) return;
                try self.namespace_exports.append(self.allocator, .{
                    .wrapper = index,
                    .declaration = wrapper.declaration,
                    .owner = owner,
                });
            },
            else => {},
        }
    }

    pub fn finish_name_collection(
        self: *RuntimeFeatureCollection,
        tree: *const parser.ast.Tree,
    ) Allocator.Error!void {
        if (self.enums.items.len == 0 and self.namespaces.items.len == 0) return;

        for (tree.nodes.items(.data)) |data| {
            const string = switch (data) {
                .binding_identifier => |identifier| identifier.name,
                .identifier_reference => |identifier| identifier.name,
                .jsx_identifier => |identifier| identifier.name,
                else => continue,
            };
            try self.names.add_source_name(tree.string(string));
        }
    }

    pub fn exit_node(
        self: *RuntimeFeatureCollection,
        data: parser.ast.NodeData,
        index: NodeIndex,
        ctx: *const Ctx,
    ) void {
        _ = index;
        if (data == .ts_enum_member) {
            std.debug.assert(self.enum_member_stack.items.len > 0);
            _ = self.enum_member_stack.pop();
        }
        if (self.collect_jsx and is_jsx_node(data)) {
            std.debug.assert(self.jsx_depth > 0);
            self.jsx_depth -= 1;
        }
        switch (data) {
            .ts_module_declaration => |declaration| {
                if (namespace_semantics.is_type_only_module(ctx.tree, declaration)) return;
                std.debug.assert(self.namespace_capture_stack.items.len > 0);
                _ = self.namespace_capture_stack.pop();
                std.debug.assert(self.capture_barrier_depth > 0);
                self.capture_barrier_depth -= 1;
            },
            .function,
            .class,
            .ts_enum_declaration,
            .ts_import_equals_declaration,
            .arrow_function_expression,
            .static_block,
            => {
                std.debug.assert(self.capture_barrier_depth > 0);
                self.capture_barrier_depth -= 1;
            },
            else => {},
        }
    }

    fn nearest_parameter_property_task(
        self: *const RuntimeFeatureCollection,
        ctx: *const Ctx,
    ) ?usize {
        var depth: usize = 1;
        while (ctx.path.ancestor(depth)) |ancestor| : (depth += 1) {
            if (self.parameter_property_tasks.get(@intFromEnum(ancestor))) |task_index| return task_index;
            switch (ctx.tree.data(ancestor)) {
                .function, .class => return null,
                else => {},
            }
        }
        return null;
    }

    fn enter_namespace(
        self: *RuntimeFeatureCollection,
        declaration: parser.ast.TSModuleDeclaration,
        index: NodeIndex,
        ctx: *const Ctx,
    ) Allocator.Error!void {
        if (namespace_semantics.is_type_only_module(ctx.tree, declaration)) return;
        self.collect_declaration_capture(declaration.id, ctx.tree);

        const parent = ctx.path.parent();
        const wrapped_export = if (parent) |parent_index|
            switch (ctx.tree.data(parent_index)) {
                .export_named_declaration => |wrapper| wrapper.declaration == index,
                else => false,
            }
        else
            false;
        const task_index = self.namespaces.items.len;
        try self.namespaces.append(self.allocator, .{
            .index = index,
            .export_owner = if (wrapped_export) nearest_runtime_namespace(ctx) else .null,
        });
        self.capture_barrier_depth += 1;
        const public_name = switch (ctx.tree.data(declaration.id)) {
            .binding_identifier => |identifier| ctx.tree.string(identifier.name),
            else => ctx.tree.source[ctx.tree.span(declaration.id).start..ctx.tree.span(declaration.id).end],
        };
        try self.namespace_capture_stack.append(self.allocator, .{
            .task_index = task_index,
            .barrier_depth = self.capture_barrier_depth,
            .public_name = public_name,
            .declaration_id = declaration.id,
        });
    }

    fn enter_capture_boundary(
        self: *RuntimeFeatureCollection,
        data: parser.ast.NodeData,
        tree: *const parser.ast.Tree,
    ) void {
        switch (data) {
            .function => |function| {
                if (!function.declare and function.type != .ts_declare_function) {
                    self.collect_declaration_capture(function.id, tree);
                }
            },
            .class => |class| {
                if (!class.declare) self.collect_declaration_capture(class.id, tree);
            },
            .ts_enum_declaration => |declaration| {
                if (!declaration.declare) self.collect_declaration_capture(declaration.id, tree);
            },
            .ts_import_equals_declaration => |declaration| {
                if (declaration.import_kind != .type) {
                    self.collect_declaration_capture(declaration.id, tree);
                }
            },
            .arrow_function_expression, .static_block => {},
            else => return,
        }
        self.capture_barrier_depth += 1;
    }

    fn collect_declaration_capture(
        self: *RuntimeFeatureCollection,
        id: NodeIndex,
        tree: *const parser.ast.Tree,
    ) void {
        if (id == .null) return;
        const name = switch (tree.data(id)) {
            .binding_identifier => |identifier| tree.string(identifier.name),
            else => return,
        };
        self.collect_active_namespace_capture(name);
    }

    fn collect_active_namespace_capture(
        self: *RuntimeFeatureCollection,
        name: []const u8,
    ) void {
        const frame = self.namespace_capture_stack.getLastOrNull() orelse return;
        if (self.capture_barrier_depth != frame.barrier_depth) return;
        const task = &self.namespaces.items[frame.task_index];
        if (task.capture_risk) return;
        if (std.mem.eql(u8, name, frame.public_name)) task.capture_risk = true;
    }

    fn collect_active_namespace_identifier(
        self: *RuntimeFeatureCollection,
        index: NodeIndex,
        name: []const u8,
    ) void {
        if (self.namespace_capture_stack.getLastOrNull()) |frame| {
            if (frame.declaration_id == index) return;
        }
        self.collect_active_namespace_capture(name);
    }
};

fn is_automatic_runtime_name(name: []const u8) bool {
    const bases = [_][]const u8{
        "_jsx",
        "_jsxs",
        "_jsxDEV",
        "_Fragment",
        "_createElement",
    };
    for (bases) |base| {
        if (!std.mem.startsWith(u8, name, base)) continue;
        const suffix = name[base.len..];
        if (suffix.len == 0) return true;
        for (suffix) |byte| {
            if (!std.ascii.isDigit(byte)) break;
        } else return true;
    }
    return false;
}

/// Emits the runtime tasks already collected by the fixed traversal.
pub fn lower(
    allocator: Allocator,
    file: *const SourceFile,
    fixed: *const FixedEditPlan,
    edits: *RuntimeEditBuffer,
    collection: *RuntimeFeatureCollection,
    jsx: jsx_config.Config,
) Allocator.Error!void {
    const lower_jsx = jsx.lowers_jsx() and collection.jsx_roots.items.len > 0;
    var emitter: jsx_emitter.Emitter = undefined;
    if (lower_jsx) {
        emitter = try jsx_emitter.Emitter.init(
            allocator,
            file,
            fixed,
            &collection.names,
            jsx,
            collection.jsx_nodes.items,
            collection.jsx_roots.items,
        );
    }
    defer if (lower_jsx) emitter.deinit();
    var namespace_lowerer = namespace_lowering.Lowerer.init(
        allocator,
        file,
        fixed,
        edits,
        &collection.names,
    );
    defer namespace_lowerer.deinit();
    try namespace_lowerer.register_declarations(collection.namespaces.items);
    for (collection.namespaces.items) |task| {
        try namespace_lowerer.lower_declaration(task);
    }
    for (collection.enums.items) |index| {
        var emission = try enum_lowering.emit(
            allocator,
            file,
            fixed,
            &collection.names,
            &collection.enum_references,
            index,
        );
        defer allocator.free(emission.identifier_replacements);
        const span = file.tree.span(index);
        edits.add_fragment(span.start, span.end, emission.fragment) catch |err| {
            emission.fragment.deinit();
            return err;
        };
        for (emission.identifier_replacements) |replacement| {
            try edits.add_replacement(
                replacement.span.start,
                replacement.span.end,
                replacement.text,
            );
        }
    }
    for (collection.import_equals.items) |task| {
        const replacement = try import_equals_lowering.emit(allocator, file, fixed, task);
        const span = file.tree.span(task.replacement_index);
        edits.add_owned_replacement(span.start, span.end, replacement) catch |err| {
            allocator.free(replacement);
            return err;
        };
    }
    for (collection.parameter_properties.items) |task| {
        try parameter_properties_lowering.lower(
            allocator,
            file,
            edits,
            task,
            task.super_calls.items,
        );
    }
    for (collection.namespace_exports.items) |task| {
        try namespace_lowerer.lower_export(task);
    }
    if (lower_jsx) try emitter.lower_roots(edits, collection.jsx_roots.items);
}

fn is_jsx_node(data: parser.ast.NodeData) bool {
    return switch (data) {
        .jsx_element, .jsx_fragment => true,
        else => false,
    };
}

fn nearest_runtime_namespace(ctx: *const Ctx) NodeIndex {
    var depth: usize = 1;
    while (ctx.path.ancestor(depth)) |ancestor| : (depth += 1) {
        switch (ctx.tree.data(ancestor)) {
            .ts_module_declaration => |declaration| {
                if (!namespace_semantics.is_type_only_module(ctx.tree, declaration)) return ancestor;
            },
            else => {},
        }
    }
    return .null;
}

fn call_is_whole_expression_statement(
    tree: *const parser.ast.Tree,
    call: NodeIndex,
    ctx: *const Ctx,
) bool {
    var value = call;
    var depth: usize = 1;
    while (ctx.path.ancestor(depth)) |parent| : (depth += 1) {
        if (is_transparent_expression_wrapper(tree, parent, value)) {
            value = parent;
            continue;
        }
        return switch (tree.data(parent)) {
            .expression_statement => |statement| statement.expression == value,
            else => false,
        };
    }
    return false;
}

fn is_transparent_expression_wrapper(
    tree: *const parser.ast.Tree,
    parent: NodeIndex,
    value: NodeIndex,
) bool {
    return switch (tree.data(parent)) {
        .ts_as_expression => |node| node.expression == value,
        .ts_satisfies_expression => |node| node.expression == value,
        .ts_non_null_expression => |node| node.expression == value,
        .ts_type_assertion => |node| node.expression == value,
        .ts_instantiation_expression => |node| node.expression == value,
        .parenthesized_expression => |node| node.expression == value,
        .chain_expression => |node| node.expression == value,
        else => false,
    };
}
