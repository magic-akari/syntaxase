const std = @import("std");
const parser = @import("parser");
const fixed_edit_buffer = @import("../fixed_edit_buffer.zig");
const source_file = @import("../source_file.zig");

const Allocator = std.mem.Allocator;
const FixedEditPlan = fixed_edit_buffer.FixedEditPlan;
const NodeIndex = parser.ast.NodeIndex;
const SourceFile = source_file.SourceFile;

pub const Task = struct {
    index: NodeIndex,
    replacement_index: NodeIndex,
    exported: bool,
};

/// Emits an import-equals declaration without reconstructing its module
/// reference. Yuku spans retain the original quoting and qualified-name text.
pub fn emit(
    allocator: Allocator,
    file: *const SourceFile,
    fixed: *const FixedEditPlan,
    task: Task,
) Allocator.Error![]u8 {
    const declaration = switch (file.tree.data(task.index)) {
        .ts_import_equals_declaration => |value| value,
        else => unreachable,
    };
    const declaration_span = file.tree.span(task.index);
    const replacement_span = file.tree.span(task.replacement_index);
    const id_span = file.tree.span(declaration.id);
    const reference_span = file.tree.span(declaration.module_reference);

    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);
    try file.comment_cursor().append_range(&output, allocator, replacement_span.start, id_span.start);
    if (task.exported) try output.appendSlice(allocator, "export ");
    try output.appendSlice(allocator, "const  ");
    try fixed.append_range(&output, id_span.start, id_span.end);
    try output.appendSlice(allocator, " = ");
    try file.comment_cursor().append_range(&output, allocator, id_span.end, reference_span.start);

    switch (file.tree.data(declaration.module_reference)) {
        .ts_external_module_reference => {
            try output.appendSlice(allocator, "import.sync");
            const require_end = reference_span.start + "require".len;
            try fixed.append_range(&output, @intCast(require_end), reference_span.end);
        },
        else => try fixed.append_range(&output, reference_span.start, reference_span.end),
    }
    try file.comment_cursor().append_range(&output, allocator, reference_span.end, declaration_span.end);
    try output.append(allocator, ';');
    return output.toOwnedSlice(allocator);
}
