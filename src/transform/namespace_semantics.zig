const parser = @import("parser");

const NodeIndex = parser.ast.NodeIndex;

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
