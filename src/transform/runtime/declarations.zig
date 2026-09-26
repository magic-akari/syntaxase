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
    sites: std.ArrayList(Site) = .empty,
    scopes: std.AutoHashMapUnmanaged(u32, std.StringHashMapUnmanaged(NodeIndex)) = .empty,
    plans: std.AutoHashMapUnmanaged(u32, Plan) = .empty,

    pub fn init(allocator: Allocator) Declarations {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Declarations) void {
        self.sites.deinit(self.allocator);
        var scopes = self.scopes.valueIterator();
        while (scopes.next()) |scope| scope.deinit(self.allocator);
        self.scopes.deinit(self.allocator);
        self.plans.deinit(self.allocator);
    }

    const Site = struct { index: NodeIndex, id: NodeIndex, scope: NodeIndex, export_wrapper: NodeIndex };

    /// Capture declaration context during the eraser's existing traversal.
    pub fn collect_node(self: *Declarations, data: parser.ast.NodeData, index: NodeIndex, ctx: *const Ctx) Allocator.Error!void {
        const id: NodeIndex = switch (data) {
            .ts_enum_declaration => |node| if (node.declare) return else node.id,
            .ts_module_declaration => |node| if (namespace_semantics.is_type_only_module(ctx.tree, node)) return else node.id,
            .class => |node| if (!node.declare and node.type == .class_declaration) node.id else return,
            .function => |node| if (!node.declare and node.type == .function_declaration) node.id else return,
            else => return,
        };
        if (id == .null) return;
        const parent = ctx.path.parent() orelse .null;
        const wrapper = if (parent != .null and ctx.tree.data(parent) == .export_named_declaration) parent else .null;
        try self.sites.append(self.allocator, .{ .index = index, .id = id, .scope = declaration_scope(ctx), .export_wrapper = wrapper });
    }

    pub fn collect(self: *Declarations, tree: *const parser.ast.Tree) Allocator.Error!void {
        for (self.sites.items) |site| {
            const name = identifier_name(tree, root_name(tree, site.id));
            const scopes = try self.scopes.getOrPut(self.allocator, @intFromEnum(site.scope));
            if (!scopes.found_existing) scopes.value_ptr.* = .empty;
            const entry = try scopes.value_ptr.getOrPut(self.allocator, name);
            if (!entry.found_existing) entry.value_ptr.* = site.index;
            try self.plans.put(self.allocator, @intFromEnum(site.index), .{
                .binding = entry.value_ptr.*,
                .scope = site.scope,
                .declare_binding = !entry.found_existing,
                .top_level = site.scope == tree.root,
                .export_wrapper = site.export_wrapper,
            });
        }
    }

    pub fn get(self: *const Declarations, index: NodeIndex) Plan {
        return self.plans.get(@intFromEnum(index)).?;
    }
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

pub fn root_name(tree: *const parser.ast.Tree, index: NodeIndex) NodeIndex {
    var current = index;
    while (tree.data(current) == .ts_qualified_name) current = tree.data(current).ts_qualified_name.left;
    return current;
}

pub fn identifier_name(tree: *const parser.ast.Tree, index: NodeIndex) []const u8 {
    return switch (tree.data(index)) {
        .binding_identifier => |node| tree.string(node.name),
        .identifier_reference => |node| tree.string(node.name),
        .identifier_name => |node| tree.string(node.name),
        else => tree.source[tree.span(index).start..tree.span(index).end],
    };
}
