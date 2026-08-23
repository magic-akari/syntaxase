const std = @import("std");
const parser = @import("parser");
const runtime_edit_buffer = @import("../runtime_edit_buffer.zig");
const source_file = @import("../source_file.zig");

const Allocator = std.mem.Allocator;
const NodeIndex = parser.ast.NodeIndex;
const RuntimeEditBuffer = runtime_edit_buffer.RuntimeEditBuffer;
const SourceFile = source_file.SourceFile;

pub const SuperCall = struct {
    call: NodeIndex,
    whole_statement: bool,
};

pub const Task = struct {
    method: NodeIndex,
    class_body: NodeIndex,
    function: NodeIndex,
    super_calls: std.ArrayList(SuperCall) = .empty,
};

pub fn has_properties(tree: *const parser.ast.Tree, function: parser.ast.Function) bool {
    const parameters = switch (tree.data(function.params)) {
        .formal_parameters => |value| value,
        else => return false,
    };
    for (tree.extra(parameters.items)) |parameter| {
        if (tree.data(parameter) == .ts_parameter_property) return true;
    }
    return false;
}

pub fn lower(
    allocator: Allocator,
    file: *const SourceFile,
    edits: *RuntimeEditBuffer,
    task: Task,
    super_calls: []const SuperCall,
) Allocator.Error!void {
    const function = switch (file.tree.data(task.function)) {
        .function => |value| value,
        else => unreachable,
    };
    const parameters = switch (file.tree.data(function.params)) {
        .formal_parameters => |value| value,
        else => unreachable,
    };

    var property_names: std.ArrayList([]const u8) = .empty;
    defer property_names.deinit(allocator);
    for (file.tree.extra(parameters.items)) |parameter_index| {
        const property = switch (file.tree.data(parameter_index)) {
            .ts_parameter_property => |value| value,
            else => continue,
        };
        const name = parameter_name(&file.tree, property) orelse continue;
        try property_names.append(allocator, name);
    }
    if (property_names.items.len == 0) return;

    try lower_class_fields(allocator, file, edits, task.class_body, property_names.items);
    if (function.body == .null) return;

    var assignments: std.ArrayList(u8) = .empty;
    defer assignments.deinit(allocator);
    for (property_names.items, 0..) |name, index| {
        if (index > 0) try assignments.append(allocator, ',');
        try assignments.appendSlice(allocator, "this.");
        try assignments.appendSlice(allocator, name);
        try assignments.append(allocator, '=');
        try assignments.appendSlice(allocator, name);
    }

    if (task.super_calls.items.len == 0) {
        var statement: std.ArrayList(u8) = .empty;
        errdefer statement.deinit(allocator);
        try statement.append(allocator, ';');
        for (property_names.items) |name| {
            try statement.appendSlice(allocator, "this.");
            try statement.appendSlice(allocator, name);
            try statement.append(allocator, '=');
            try statement.appendSlice(allocator, name);
            try statement.append(allocator, ';');
        }
        const offset = constructor_assignment_offset(&file.tree, function.body);
        const owned = try statement.toOwnedSlice(allocator);
        edits.add_owned_replacement(offset, offset, owned) catch |err| {
            allocator.free(owned);
            return err;
        };
        return;
    }

    for (super_calls) |super_call| {
        const span = file.tree.span(super_call.call);
        if (super_call.whole_statement) {
            const suffix = try std.fmt.allocPrint(allocator, ",{s}", .{assignments.items});
            edits.add_owned_replacement(span.end, span.end, suffix) catch |err| {
                allocator.free(suffix);
                return err;
            };
        } else {
            try edits.add_replacement(span.start, span.start, "[");
            const suffix = try std.fmt.allocPrint(allocator, ",{s}][0]", .{assignments.items});
            edits.add_owned_replacement(span.end, span.end, suffix) catch |err| {
                allocator.free(suffix);
                return err;
            };
        }
    }
}

fn lower_class_fields(
    allocator: Allocator,
    file: *const SourceFile,
    edits: *RuntimeEditBuffer,
    class_body_index: NodeIndex,
    property_names: []const []const u8,
) Allocator.Error!void {
    var requested: std.StringHashMapUnmanaged(void) = .empty;
    defer requested.deinit(allocator);
    for (property_names) |name| try requested.put(allocator, name, {});

    var runtime_fields: std.StringHashMapUnmanaged(void) = .empty;
    defer runtime_fields.deinit(allocator);
    var declare_slots: std.StringHashMapUnmanaged(NodeIndex) = .empty;
    defer declare_slots.deinit(allocator);

    const class_body = switch (file.tree.data(class_body_index)) {
        .class_body => |value| value,
        else => unreachable,
    };
    for (file.tree.extra(class_body.body)) |member_index| {
        const property = switch (file.tree.data(member_index)) {
            .property_definition => |value| value,
            else => continue,
        };
        if (property.static or property.computed or property.accessor) continue;
        const name = switch (file.tree.data(property.key)) {
            .identifier_name => |identifier| file.tree.string(identifier.name),
            else => continue,
        };
        if (!requested.contains(name)) continue;
        if (!property.declare) {
            try runtime_fields.put(allocator, name, {});
        } else if (property.value == .null and !declare_slots.contains(name)) {
            try declare_slots.put(allocator, name, property.key);
        }
    }

    var planned: std.StringHashMapUnmanaged(void) = .empty;
    defer planned.deinit(allocator);
    var fields: std.ArrayList(u8) = .empty;
    defer fields.deinit(allocator);
    for (property_names) |name| {
        if (planned.contains(name)) continue;
        if (runtime_fields.contains(name)) {
            try planned.put(allocator, name, {});
            continue;
        }
        if (declare_slots.get(name)) |key| {
            const replacement = try std.fmt.allocPrint(allocator, "{s};", .{name});
            const span = file.tree.span(key);
            edits.add_owned_replacement(span.start, span.end, replacement) catch |err| {
                allocator.free(replacement);
                return err;
            };
        } else {
            try fields.appendSlice(allocator, name);
            try fields.append(allocator, ';');
        }
        try planned.put(allocator, name, {});
    }

    if (fields.items.len == 0) return;
    const insertion = try fields.toOwnedSlice(allocator);
    const offset = file.tree.span(class_body_index).start + 1;
    edits.add_owned_replacement(offset, offset, insertion) catch |err| {
        allocator.free(insertion);
        return err;
    };
}

fn parameter_name(
    tree: *const parser.ast.Tree,
    property: parser.ast.TSParameterProperty,
) ?[]const u8 {
    const binding = switch (tree.data(property.parameter)) {
        .binding_identifier => |identifier| identifier,
        .assignment_pattern => |assignment| switch (tree.data(assignment.left)) {
            .binding_identifier => |identifier| identifier,
            else => return null,
        },
        else => return null,
    };
    return tree.string(binding.name);
}

fn constructor_assignment_offset(tree: *const parser.ast.Tree, body_index: NodeIndex) u32 {
    const body = switch (tree.data(body_index)) {
        .function_body => |value| value,
        else => return tree.span(body_index).start + 1,
    };
    var offset = tree.span(body_index).start + 1;
    for (tree.extra(body.body)) |statement| {
        if (tree.data(statement) != .directive) break;
        offset = tree.span(statement).end;
    }
    return offset;
}
