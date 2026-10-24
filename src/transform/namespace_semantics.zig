const std = @import("std");
const parser = @import("parser");

const NodeIndex = parser.ast.NodeIndex;
const Allocator = std.mem.Allocator;

/// Fixed stripping classifies namespace bodies independently of runtime
/// lowering. Cache structural results so nested runtime namespaces are not
/// reclassified at every ancestor, and use frames rather than recursion.
pub const StripNamespaces = struct {
    runtime_state: std.AutoHashMapUnmanaged(NodeIndex, bool) = .empty,
    frames: std.ArrayList(Frame) = .empty,

    const Frame = struct {
        index: NodeIndex,
        statements: []const NodeIndex,
        position: usize = 0,
        has_runtime_state: bool = false,
        ambient: bool,
    };

    const Statement = union(enum) {
        erased,
        runtime,
        nested: NodeIndex,
    };

    pub fn deinit(self: *StripNamespaces, allocator: Allocator) void {
        self.runtime_state.deinit(allocator);
        self.frames.deinit(allocator);
    }

    pub fn is_erasable(
        self: *StripNamespaces,
        allocator: Allocator,
        tree: *const parser.ast.Tree,
        index: NodeIndex,
    ) Allocator.Error!bool {
        if (tree.data(index).ts_module_declaration.declare) return true;
        if (self.runtime_state.get(index)) |runtime| return !runtime;

        std.debug.assert(self.frames.items.len == 0);
        try self.frames.append(allocator, module_frame(tree, index, false));
        while (self.frames.items.len > 0) {
            const frame = &self.frames.items[self.frames.items.len - 1];
            if (frame.has_runtime_state or frame.position == frame.statements.len) {
                const runtime = frame.has_runtime_state;
                try self.runtime_state.put(allocator, frame.index, runtime);
                _ = self.frames.pop();
                if (self.frames.items.len > 0 and runtime) {
                    self.frames.items[self.frames.items.len - 1].has_runtime_state = true;
                }
                continue;
            }

            const statement = frame.statements[frame.position];
            frame.position += 1;
            switch (classify_statement(tree, statement, frame.ambient)) {
                .erased => {},
                .runtime => frame.has_runtime_state = true,
                .nested => |nested| {
                    if (self.runtime_state.get(nested)) |runtime| {
                        frame.has_runtime_state = runtime;
                    } else {
                        try self.frames.append(allocator, module_frame(tree, nested, frame.ambient));
                    }
                },
            }
        }
        return !self.runtime_state.get(index).?;
    }

    fn module_frame(tree: *const parser.ast.Tree, index: NodeIndex, ambient: bool) Frame {
        const declaration = tree.data(index).ts_module_declaration;
        if (declaration.body != .null) {
            switch (tree.data(declaration.body)) {
                .ts_module_block => |block| return .{
                    .index = index,
                    .statements = tree.extra(block.body),
                    .ambient = ambient or declaration.declare,
                },
                else => {},
            }
        }
        return .{ .index = index, .statements = &.{}, .has_runtime_state = true, .ambient = ambient };
    }

    fn classify_statement(tree: *const parser.ast.Tree, initial: NodeIndex, ambient: bool) Statement {
        var index = initial;
        while (true) {
            switch (tree.data(index)) {
                .ts_interface_declaration,
                .ts_type_alias_declaration,
                .ts_namespace_export_declaration,
                .ts_global_declaration,
                .ts_import_equals_declaration,
                .import_declaration,
                => return .erased,
                // Non-ambient enums still need runtime lowering, including
                // const enums. Fixed stripping leaves those constructs intact.
                .ts_enum_declaration => |node| return if (node.is_const and (ambient or node.declare)) .erased else .runtime,
                .ts_module_declaration => return .{ .nested = index },
                .export_named_declaration => |node| {
                    if (node.declaration != .null) {
                        if (tree.data(node.declaration) == .ts_import_equals_declaration) {
                            return .runtime;
                        }
                        index = node.declaration;
                        continue;
                    }
                    if (node.source != .null) return .runtime;
                    if (node.export_kind == .type) return .erased;
                    for (tree.extra(node.specifiers)) |specifier| {
                        if (tree.data(specifier).export_specifier.export_kind != .type) return .runtime;
                    }
                    return .erased;
                },
                .export_default_declaration => |node| return if (tree.data(node.declaration) == .ts_interface_declaration) .erased else .runtime,
                else => return .runtime,
            }
        }
    }
};

/// Runtime-state classification shared by fixed erasure and namespace
/// lowering. It operates directly on Yuku nodes and intentionally does not add
/// an independent semantic validation layer.
pub fn is_type_only_module(
    tree: *const parser.ast.Tree,
    declaration: parser.ast.TSModuleDeclaration,
) bool {
    if (declaration.declare) return true;
    if (declaration.body == .null) return false;

    const block = switch (tree.data(declaration.body)) {
        .ts_module_block => |value| value,
        else => return false,
    };
    for (tree.extra(block.body)) |statement| {
        if (statement_has_runtime_state(tree, statement)) return false;
    }
    return true;
}

pub fn statement_has_runtime_state(tree: *const parser.ast.Tree, index: NodeIndex) bool {
    return switch (tree.data(index)) {
        .ts_interface_declaration,
        .ts_type_alias_declaration,
        .ts_namespace_export_declaration,
        .ts_global_declaration,
        => false,
        // A namespace-local alias does not instantiate the namespace by itself.
        .ts_import_equals_declaration => false,
        .ts_module_declaration => |node| !is_type_only_module(tree, node),
        .export_named_declaration => |node| if (node.declaration != .null)
            switch (tree.data(node.declaration)) {
                .ts_import_equals_declaration => |declaration| declaration.import_kind != .type,
                else => statement_has_runtime_state(tree, node.declaration),
            }
        else
            node.export_kind != .type,
        else => true,
    };
}

pub fn is_supported_runtime_export_declaration(
    tree: *const parser.ast.Tree,
    index: NodeIndex,
) bool {
    return switch (tree.data(index)) {
        .function => |node| node.type == .function_declaration and !node.declare,
        .class => |node| node.type == .class_declaration and !node.declare,
        .ts_enum_declaration => |node| !node.declare,
        .ts_module_declaration => |node| !is_type_only_module(tree, node),
        else => false,
    };
}

fn expect_namespace_modes(source: []const u8, strip_erased: bool, lowering_erased: bool) !void {
    const allocator = std.testing.allocator;
    var tree = try parser.parse(allocator, source, .{ .lang = .ts });
    defer tree.deinit();
    try std.testing.expectEqual(@as(usize, 0), tree.diagnostics.items.len);
    const index = tree.extra(tree.data(tree.root).program.body)[0];
    var namespaces: StripNamespaces = .{};
    defer namespaces.deinit(allocator);
    try std.testing.expectEqual(strip_erased, try namespaces.is_erasable(allocator, &tree, index));
    try std.testing.expectEqual(lowering_erased, is_type_only_module(&tree, tree.data(index).ts_module_declaration));
}

test "fixed namespace classification preserves runtime syntax and the lowering policy" {
    try expect_namespace_modes("namespace N { const enum E { A } }", false, false);
    try expect_namespace_modes("namespace N { interface T {} export { type T, value }; }", false, false);
    try expect_namespace_modes("namespace N { interface T {} export { value, type T }; }", false, false);
    try expect_namespace_modes("namespace N { export import x = A.x; }", false, false);
    try expect_namespace_modes("namespace N { 'use strict'; }", false, false);
    try expect_namespace_modes("namespace N { export type { T } from 'pkg'; }", false, true);
    try expect_namespace_modes("namespace N { declare namespace M { const x: number; } }", false, true);
}
