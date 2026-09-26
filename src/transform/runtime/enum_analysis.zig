const std = @import("std");
const parser = @import("parser");
const declarations = @import("declarations.zig");
const namespace_semantics = @import("../namespace_semantics.zig");

const Allocator = std.mem.Allocator;
const NodeIndex = parser.ast.NodeIndex;
const Ctx = parser.traverser.basic.Ctx;
pub const ValueKind = enum { unknown, number, string };
const Binding = union(enum) { other, enumeration: NodeIndex, member: NodeIndex };
const ScopeId = enum(u32) { none = std.math.maxInt(u32), _ };
const Scope = struct {
    node: NodeIndex,
    parent: ScopeId,
    hoist_target: ScopeId,
    members: NodeIndex = .null,
    bindings: std.StringHashMapUnmanaged(Binding) = .empty,
};
const Member = struct { owner: NodeIndex, kind: ?ValueKind = null };
const Reference = struct { node: NodeIndex, scope: ScopeId, shorthand: bool };
pub const CollectedReference = struct { node: NodeIndex, shorthand: bool };
pub const ReferenceMap = std.AutoHashMapUnmanaged(u32, std.ArrayList(CollectedReference));
pub const Target = struct { member: NodeIndex, shorthand: bool };

/// Only enum-related names are indexed. References are collected exclusively
/// inside enum initializers; namespace export reference rewriting is not done.
pub const Analysis = struct {
    allocator: Allocator,
    tree: *const parser.ast.Tree,
    declarations: *const declarations.Declarations,
    nested_bindings: std.StringHashMapUnmanaged(void) = .empty,
    receivers: std.AutoHashMapUnmanaged(u32, []const u8) = .empty,
    relevant_names: std.StringHashMapUnmanaged(void) = .empty,
    groups: std.AutoHashMapUnmanaged(u32, std.StringHashMapUnmanaged(NodeIndex)) = .empty,
    members: std.AutoHashMapUnmanaged(u32, Member) = .empty,
    scopes: std.ArrayList(Scope) = .empty,
    references: std.ArrayList(Reference) = .empty,
    resolved: std.AutoHashMapUnmanaged(u32, Binding) = .empty,
    targets: std.AutoHashMapUnmanaged(u32, Target) = .empty,
    resolve_references: bool = false,

    pub fn init(allocator: Allocator, tree: *const parser.ast.Tree, plans: *const declarations.Declarations) Analysis {
        return .{ .allocator = allocator, .tree = tree, .declarations = plans };
    }

    pub fn deinit(self: *Analysis) void {
        self.nested_bindings.deinit(self.allocator);
        self.receivers.deinit(self.allocator);
        self.relevant_names.deinit(self.allocator);
        var groups = self.groups.valueIterator();
        while (groups.next()) |group| group.deinit(self.allocator);
        self.groups.deinit(self.allocator);
        self.members.deinit(self.allocator);
        for (self.scopes.items) |*scope| scope.bindings.deinit(self.allocator);
        self.scopes.deinit(self.allocator);
        self.references.deinit(self.allocator);
        self.resolved.deinit(self.allocator);
        self.targets.deinit(self.allocator);
    }

    pub fn collect(self: *Analysis, enums: []const NodeIndex, references_by_member: *const ReferenceMap, has_nested_scopes: bool) Allocator.Error!void {
        self.resolve_references = references_by_member.count() > 0;
        if (enums.len == 0 or !self.resolve_references) return;
        for (enums) |index| {
            const node = self.tree.data(index).ts_enum_declaration;
            const name = declarations.identifier_name(self.tree, node.id);
            try self.relevant_names.put(self.allocator, name, {});
            const identity = self.declarations.get(index).binding;
            const group = try self.groups.getOrPut(self.allocator, @intFromEnum(identity));
            if (!group.found_existing) group.value_ptr.* = .empty;
            const body = self.tree.data(node.body).ts_enum_body;
            for (self.tree.extra(body.members)) |member_index| {
                const member = self.tree.data(member_index).ts_enum_member;
                try self.members.put(self.allocator, @intFromEnum(member_index), .{ .owner = index });
                if (member_name(self.tree, member)) |member_text| {
                    try self.relevant_names.put(self.allocator, member_text, {});
                    try group.value_ptr.put(self.allocator, member_text, member_index);
                }
            }
        }
        // The eraser already collected these references. Without a nested scope,
        // enum members shadow surrounding bindings and can be resolved locally.
        // External enum names still require lexical binding resolution.
        if (!has_nested_scopes and try self.collect_local(references_by_member)) return;
        var visitor = Visitor{ .analysis = self };
        try parser.traverser.basic.traverse(Visitor, self.tree, &visitor);
        for (self.references.items) |reference| {
            const name = self.tree.string(self.tree.data(reference.node).identifier_reference.name);
            const binding = self.lookup(reference.scope, name);
            if (binding == .enumeration) try self.resolved.put(self.allocator, @intFromEnum(reference.node), binding);
            if (binding == .member) {
                try self.targets.put(self.allocator, @intFromEnum(reference.node), .{
                    .member = binding.member,
                    .shorthand = reference.shorthand,
                });
            }
        }
    }

    fn collect_local(self: *Analysis, references_by_member: *const ReferenceMap) Allocator.Error!bool {
        var members = references_by_member.iterator();
        while (members.next()) |entry| {
            const enumeration = self.owner(@enumFromInt(entry.key_ptr.*));
            const identity = self.declarations.get(enumeration).binding;
            const group = self.groups.get(@intFromEnum(identity)).?;
            for (entry.value_ptr.items) |reference| {
                const name = self.tree.string(self.tree.data(reference.node).identifier_reference.name);
                if (group.get(name)) |member| {
                    try self.targets.put(self.allocator, @intFromEnum(reference.node), .{
                        .member = member,
                        .shorthand = reference.shorthand,
                    });
                } else if (self.relevant_names.contains(name)) {
                    // Discard partial local results before the scope-aware pass.
                    self.targets.clearRetainingCapacity();
                    return false;
                }
            }
        }
        return true;
    }

    pub fn target(self: *const Analysis, reference: NodeIndex) ?Target {
        return self.targets.get(@intFromEnum(reference));
    }

    pub fn owner(self: *const Analysis, member: NodeIndex) NodeIndex {
        return self.members.get(@intFromEnum(member)).?.owner;
    }

    pub fn member_kind(self: *Analysis, index: NodeIndex) Allocator.Error!ValueKind {
        const member = self.tree.data(index).ts_enum_member;
        if (member.initializer == .null) return .number;
        // Literal kinds need neither dependency resolution nor a cycle guard.
        var initializer = member.initializer;
        while (true) {
            switch (self.tree.data(initializer)) {
                .string_literal, .template_literal => return .string,
                .numeric_literal => return .number,
                .parenthesized_expression => |node| initializer = node.expression,
                .ts_as_expression => |node| initializer = node.expression,
                .ts_type_assertion => |node| initializer = node.expression,
                .ts_satisfies_expression => |node| initializer = node.expression,
                .ts_non_null_expression => |node| initializer = node.expression,
                else => break,
            }
        }
        if (!self.resolve_references) return self.expression_kind(initializer);
        // Members are indexed before resolution; recursive queries never grow
        // this map, so the entry remains stable throughout the dependency walk.
        const entry = self.members.getPtr(@intFromEnum(index)).?;
        if (entry.kind) |kind| return kind;
        // A recursive dependency remains unknown instead of recursing forever.
        entry.kind = .unknown;
        const kind = try self.expression_kind(initializer);
        entry.kind = kind;
        return kind;
    }

    fn expression_kind(self: *Analysis, index: NodeIndex) Allocator.Error!ValueKind {
        return switch (self.tree.data(index)) {
            .string_literal, .template_literal => .string,
            .numeric_literal => .number,
            .parenthesized_expression => |node| self.expression_kind(node.expression),
            .ts_as_expression => |node| self.expression_kind(node.expression),
            .ts_type_assertion => |node| self.expression_kind(node.expression),
            .ts_satisfies_expression => |node| self.expression_kind(node.expression),
            .ts_non_null_expression => |node| self.expression_kind(node.expression),
            .identifier_reference => if (self.targets.get(@intFromEnum(index))) |resolved| self.member_kind(resolved.member) else .unknown,
            .member_expression => |node| blk: {
                const binding = self.resolved.get(@intFromEnum(node.object)) orelse break :blk .unknown;
                if (binding != .enumeration) break :blk .unknown;
                const name = switch (self.tree.data(node.property)) {
                    .identifier_name => |id| self.tree.string(id.name),
                    .string_literal => |literal| self.tree.string(literal.value),
                    else => break :blk .unknown,
                };
                const group = self.groups.get(@intFromEnum(binding.enumeration)) orelse break :blk .unknown;
                const member = group.get(name) orelse break :blk .unknown;
                break :blk try self.member_kind(member);
            },
            .binary_expression => |node| blk: {
                const left = try self.expression_kind(node.left);
                const right = try self.expression_kind(node.right);
                if (node.operator == .add and (left == .string or right == .string)) break :blk .string;
                if (left == .number and right == .number) break :blk .number;
                break :blk .unknown;
            },
            else => .unknown,
        };
    }

    fn lookup(self: *const Analysis, start: ScopeId, name: []const u8) Binding {
        var current = start;
        while (current != .none) {
            const scope = self.scopes.items[@intFromEnum(current)];
            if (scope.bindings.get(name)) |binding| return binding;
            if (scope.members != .null) {
                const group = self.groups.get(@intFromEnum(scope.members)).?;
                if (group.get(name)) |member| return .{ .member = member };
            }
            current = scope.parent;
        }
        return .other;
    }

    fn bind(self: *Analysis, scope: ScopeId, name: []const u8, binding: Binding) Allocator.Error!void {
        if (!self.relevant_names.contains(name)) return;
        const entry = &self.scopes.items[@intFromEnum(scope)];
        try entry.bindings.put(self.allocator, name, binding);
    }

    const Visitor = struct {
        analysis: *Analysis,
        current: ScopeId = .none,
        member_depth: usize = 0,

        pub fn enter_node(self: *Visitor, data: parser.ast.NodeData, index: NodeIndex, ctx: *Ctx) Allocator.Error!parser.traverser.Action {
            const analysis = self.analysis;
            switch (data) {
                .ts_type_annotation, .ts_interface_declaration, .ts_type_alias_declaration, .ts_type_parameter_declaration => return .skip,
                .ts_enum_declaration => |node| {
                    if (node.declare) return .skip;
                    try analysis.bind(self.current, declarations.identifier_name(ctx.tree, node.id), .{ .enumeration = analysis.declarations.get(index).binding });
                },
                .ts_module_declaration => |node| {
                    if (namespace_semantics.is_type_only_module(ctx.tree, node)) return .skip;
                    try analysis.bind(self.current, declarations.identifier_name(ctx.tree, declarations.root_name(ctx.tree, node.id)), .other);
                },
                .function => |node| {
                    if (node.declare or node.type == .ts_declare_function) return .skip;
                    if (node.type == .function_declaration and node.id != .null) try analysis.bind(self.current, declarations.identifier_name(ctx.tree, node.id), .other);
                },
                .class => |node| {
                    if (node.declare) return .skip;
                    if (node.type == .class_declaration and node.id != .null) try analysis.bind(self.current, declarations.identifier_name(ctx.tree, node.id), .other);
                },
                .ts_enum_member => self.member_depth += 1,
                else => {},
            }
            if (is_scope(data)) {
                const parent = self.current;
                self.current = @enumFromInt(analysis.scopes.items.len);
                const members = if (data == .ts_enum_body) analysis.declarations.get(ctx.path.parent().?).binding else .null;
                const hoist_target = if (is_hoist_scope(data)) self.current else analysis.scopes.items[@intFromEnum(parent)].hoist_target;
                try analysis.scopes.append(analysis.allocator, .{ .node = index, .parent = parent, .hoist_target = hoist_target, .members = members });
                switch (data) {
                    .function => |node| {
                        try analysis.bind(self.current, "arguments", .other);
                        if (node.id != .null) try analysis.bind(self.current, declarations.identifier_name(ctx.tree, node.id), .other);
                    },
                    .class => |node| if (node.id != .null) {
                        try analysis.bind(self.current, declarations.identifier_name(ctx.tree, node.id), .other);
                    },
                    else => {},
                }
            }
            if (data == .binding_identifier) {
                if (self.member_depth > 0) try analysis.nested_bindings.put(analysis.allocator, ctx.tree.string(data.binding_identifier.name), {});
                const parent = ctx.path.parent();
                const declaration_id = if (parent) |p| switch (ctx.tree.data(p)) {
                    .function, .class, .ts_enum_declaration, .ts_module_declaration => true,
                    else => false,
                } else false;
                if (!declaration_id) {
                    var scope = self.current;
                    var depth: usize = 1;
                    while (ctx.path.ancestor(depth)) |ancestor| : (depth += 1) {
                        const node = ctx.tree.data(ancestor);
                        if (node == .variable_declaration) {
                            if (node.variable_declaration.kind == .@"var") {
                                scope = analysis.scopes.items[@intFromEnum(scope)].hoist_target;
                            }
                            break;
                        }
                        if (is_scope(node)) break;
                    }
                    try analysis.bind(scope, ctx.tree.string(data.binding_identifier.name), .other);
                }
            }
            if (data == .identifier_reference and self.member_depth > 0) {
                const name = ctx.tree.string(data.identifier_reference.name);
                if (!analysis.relevant_names.contains(name)) return .proceed;
                const parent = ctx.path.parent();
                const shorthand = if (parent) |p| switch (ctx.tree.data(p)) {
                    .object_property => |property| property.shorthand,
                    else => false,
                } else false;
                try analysis.references.append(analysis.allocator, .{ .node = index, .scope = self.current, .shorthand = shorthand });
            }
            return .proceed;
        }

        pub fn exit_node(self: *Visitor, data: parser.ast.NodeData, index: NodeIndex, _: *Ctx) void {
            if (data == .ts_enum_member) self.member_depth -= 1;
            if (self.current != .none) {
                const scope = self.analysis.scopes.items[@intFromEnum(self.current)];
                if (scope.node == index) self.current = scope.parent;
            }
        }
    };
};

fn is_scope(data: parser.ast.NodeData) bool {
    return switch (data) {
        .program, .function, .arrow_function_expression, .block_statement, .class, .static_block, .switch_statement, .catch_clause, .for_statement, .for_in_statement, .for_of_statement, .ts_module_block, .ts_enum_body => true,
        else => false,
    };
}

fn is_hoist_scope(data: parser.ast.NodeData) bool {
    return switch (data) {
        .program, .function, .arrow_function_expression, .static_block, .ts_module_block => true,
        else => false,
    };
}

pub fn member_name(tree: *const parser.ast.Tree, member: parser.ast.TSEnumMember) ?[]const u8 {
    return switch (tree.data(member.id)) {
        .identifier_name => |node| tree.string(node.name),
        .string_literal => |node| tree.string(node.value),
        else => null,
    };
}
