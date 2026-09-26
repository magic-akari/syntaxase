const std = @import("std");
const parser = @import("parser");
const namespace_semantics = @import("../namespace_semantics.zig");

const Allocator = std.mem.Allocator;
const NodeIndex = parser.ast.NodeIndex;
const Ctx = parser.traverser.basic.Ctx;

/// Identity and emission policy for one runtime declaration. Merged declarations
/// retain their original nodes but share the first value binding in this scope.
pub const Plan = struct {
    binding: NodeIndex,
    scope: NodeIndex,
    declare_binding: bool,
    top_level: bool,
    export_wrapper: NodeIndex,
};

pub const Declarations = struct {
    allocator: Allocator,
    scopes: std.AutoHashMapUnmanaged(u32, std.StringHashMapUnmanaged(NodeIndex)) = .empty,
    plans: std.AutoHashMapUnmanaged(u32, Plan) = .empty,

    pub fn init(allocator: Allocator) Declarations {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Declarations) void {
        var scopes = self.scopes.valueIterator();
        while (scopes.next()) |scope| scope.deinit(self.allocator);
        self.scopes.deinit(self.allocator);
        self.plans.deinit(self.allocator);
    }

    pub fn collect(self: *Declarations, tree: *const parser.ast.Tree) Allocator.Error!void {
        var visitor = Visitor{ .declarations = self };
        try parser.traverser.basic.traverse(Visitor, tree, &visitor);
    }

    pub fn get(self: *const Declarations, index: NodeIndex) Plan {
        return self.plans.get(@intFromEnum(index)).?;
    }

    const Visitor = struct {
        declarations: *Declarations,

        pub fn enter_node(self: *Visitor, data: parser.ast.NodeData, index: NodeIndex, ctx: *Ctx) Allocator.Error!parser.traverser.Action {
            const id: NodeIndex = switch (data) {
                .ts_enum_declaration => |node| if (node.declare) return .skip else node.id,
                .ts_module_declaration => |node| if (namespace_semantics.is_type_only_module(ctx.tree, node)) return .skip else node.id,
                .class => |node| if (!node.declare and node.type == .class_declaration) node.id else return .proceed,
                .function => |node| if (!node.declare and node.type == .function_declaration) node.id else return .proceed,
                .ts_type_annotation, .ts_interface_declaration, .ts_type_alias_declaration => return .skip,
                else => return .proceed,
            };
            if (id == .null) return .proceed;
            const name = switch (ctx.tree.data(id)) {
                .binding_identifier => |node| ctx.tree.string(node.name),
                else => ctx.tree.source[ctx.tree.span(id).start..ctx.tree.span(id).end],
            };
            const scope = declaration_scope(ctx);
            const scopes = try self.declarations.scopes.getOrPut(self.declarations.allocator, @intFromEnum(scope));
            if (!scopes.found_existing) scopes.value_ptr.* = .empty;
            const entry = try scopes.value_ptr.getOrPut(self.declarations.allocator, name);
            if (!entry.found_existing) entry.value_ptr.* = index;
            const parent = ctx.path.parent() orelse .null;
            const export_wrapper = if (parent != .null and ctx.tree.data(parent) == .export_named_declaration) parent else .null;
            try self.declarations.plans.put(self.declarations.allocator, @intFromEnum(index), .{
                .binding = entry.value_ptr.*,
                .scope = scope,
                .declare_binding = !entry.found_existing,
                .top_level = scope == ctx.tree.root,
                .export_wrapper = export_wrapper,
            });
            return .proceed;
        }
    };
};

fn declaration_scope(ctx: *const Ctx) NodeIndex {
    var depth: usize = 1;
    while (ctx.path.ancestor(depth)) |ancestor| : (depth += 1) {
        switch (ctx.tree.data(ancestor)) {
            .program,
            .block_statement,
            .switch_statement,
            .static_block,
            .ts_module_block,
            .function,
            .arrow_function_expression,
            => return ancestor,
            else => {},
        }
    }
    return ctx.tree.root;
}
