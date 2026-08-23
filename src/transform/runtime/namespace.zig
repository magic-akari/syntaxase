const std = @import("std");
const parser = @import("parser");
const fixed_edit_buffer = @import("../fixed_edit_buffer.zig");
const runtime_edit_buffer = @import("../runtime_edit_buffer.zig");
const runtime_name_allocator = @import("../runtime_name_allocator.zig");
const source_file = @import("../source_file.zig");
const unicode = @import("../unicode.zig");

const Allocator = std.mem.Allocator;
const FixedEditPlan = fixed_edit_buffer.FixedEditPlan;
const NodeIndex = parser.ast.NodeIndex;
const RuntimeEditBuffer = runtime_edit_buffer.RuntimeEditBuffer;
const RuntimeNameAllocator = runtime_name_allocator.RuntimeNameAllocator;
const SourceFile = source_file.SourceFile;

pub const DeclarationTask = struct {
    index: NodeIndex,
    export_owner: NodeIndex = .null,
    capture_risk: bool = false,
};

pub const ExportTask = struct {
    wrapper: NodeIndex,
    declaration: NodeIndex,
    owner: NodeIndex,
};

const Binding = struct {
    public_name: []const u8,
    receiver_name: []const u8,
};

pub const Lowerer = struct {
    allocator: Allocator,
    file: *const SourceFile,
    fixed: *const FixedEditPlan,
    edits: *RuntimeEditBuffer,
    names: *RuntimeNameAllocator,
    bindings: std.AutoHashMapUnmanaged(u32, Binding) = .empty,
    capture_risks: std.AutoHashMapUnmanaged(u32, bool) = .empty,

    pub fn init(
        allocator: Allocator,
        file: *const SourceFile,
        fixed: *const FixedEditPlan,
        edits: *RuntimeEditBuffer,
        names: *RuntimeNameAllocator,
    ) Lowerer {
        return .{
            .allocator = allocator,
            .file = file,
            .fixed = fixed,
            .edits = edits,
            .names = names,
        };
    }

    pub fn deinit(self: *Lowerer) void {
        self.bindings.deinit(self.allocator);
        self.capture_risks.deinit(self.allocator);
    }

    pub fn register_declarations(
        self: *Lowerer,
        tasks: []const DeclarationTask,
    ) Allocator.Error!void {
        try self.capture_risks.ensureTotalCapacity(self.allocator, @intCast(tasks.len));
        for (tasks) |task| {
            self.capture_risks.putAssumeCapacity(@intFromEnum(task.index), task.capture_risk);
        }
    }

    pub fn lower_declaration(self: *Lowerer, task: DeclarationTask) Allocator.Error!void {
        const declaration = switch (self.file.tree.data(task.index)) {
            .ts_module_declaration => |value| value,
            else => unreachable,
        };
        if (declaration.body == .null) return;
        const body = switch (self.file.tree.data(declaration.body)) {
            .ts_module_block => declaration.body,
            else => return,
        };
        const namespace_binding = try self.resolve_binding(task.index);
        const declaration_span = self.file.tree.span(task.index);
        const id_span = self.file.tree.span(declaration.id);
        const body_span = self.file.tree.span(body);

        var header: std.ArrayList(u8) = .empty;
        errdefer header.deinit(self.allocator);
        try header.appendSlice(self.allocator, "var");
        try unicode.append_blanked(
            &header,
            self.allocator,
            self.file.source()[declaration_span.start + 3 .. id_span.start],
        );
        try self.fixed.append_range(&header, id_span.start, id_span.end);
        try header.appendSlice(self.allocator, ";(function(");
        try header.appendSlice(self.allocator, namespace_binding.receiver_name);
        try header.appendSlice(self.allocator, "){");
        try self.file.comment_cursor().append_range(
            &header,
            self.allocator,
            declaration_span.start,
            body_span.start + 1,
        );
        const owned_header = try header.toOwnedSlice(self.allocator);
        self.edits.add_owned_replacement(
            declaration_span.start,
            body_span.start + 1,
            owned_header,
        ) catch |err| {
            self.allocator.free(owned_header);
            return err;
        };

        var footer: std.ArrayList(u8) = .empty;
        errdefer footer.deinit(self.allocator);
        try footer.appendSlice(self.allocator, "})(");
        if (task.export_owner != .null) {
            const owner = try self.resolve_binding(task.export_owner);
            try footer.appendSlice(self.allocator, namespace_binding.public_name);
            try footer.append(self.allocator, '=');
            try append_namespace_property(&footer, self.allocator, owner.receiver_name, namespace_binding.public_name);
            try footer.appendSlice(self.allocator, "||(");
            try append_namespace_property(&footer, self.allocator, owner.receiver_name, namespace_binding.public_name);
            try footer.appendSlice(self.allocator, "={})");
        } else {
            try footer.appendSlice(self.allocator, namespace_binding.public_name);
            try footer.appendSlice(self.allocator, "||(");
            try footer.appendSlice(self.allocator, namespace_binding.public_name);
            try footer.appendSlice(self.allocator, "={})");
        }
        try footer.appendSlice(self.allocator, ");");
        const owned_footer = try footer.toOwnedSlice(self.allocator);
        self.edits.add_owned_replacement(body_span.end - 1, body_span.end, owned_footer) catch |err| {
            self.allocator.free(owned_footer);
            return err;
        };
    }

    pub fn lower_export(self: *Lowerer, task: ExportTask) Allocator.Error!void {
        const id = declaration_identifier(&self.file.tree, task.declaration) orelse return;
        const owner = try self.resolve_binding(task.owner);
        const id_span = self.file.tree.span(id);
        const declaration_span = self.file.tree.span(task.declaration);
        const exported_name = self.file.source()[id_span.start..id_span.end];
        const insertion = try std.fmt.allocPrint(
            self.allocator,
            "{s}.{s}={s};",
            .{ owner.receiver_name, exported_name, exported_name },
        );
        self.edits.add_owned_replacement(
            declaration_span.end,
            declaration_span.end,
            insertion,
        ) catch |err| {
            self.allocator.free(insertion);
            return err;
        };
    }

    fn resolve_binding(self: *Lowerer, index: NodeIndex) Allocator.Error!Binding {
        const key = @intFromEnum(index);
        if (self.bindings.get(key)) |existing| return existing;
        const declaration = switch (self.file.tree.data(index)) {
            .ts_module_declaration => |value| value,
            else => unreachable,
        };
        const public_name = switch (self.file.tree.data(declaration.id)) {
            .binding_identifier => |identifier| self.file.tree.string(identifier.name),
            else => self.file.source()[self.file.tree.span(declaration.id).start..self.file.tree.span(declaration.id).end],
        };

        var unavailable: std.StringHashMapUnmanaged(void) = .empty;
        defer unavailable.deinit(self.allocator);
        if (self.capture_risks.get(key) orelse false) {
            try unavailable.put(self.allocator, public_name, {});
        }
        const receiver_name = try self.names.claim_receiver(public_name, &unavailable);
        const result: Binding = .{
            .public_name = public_name,
            .receiver_name = receiver_name,
        };
        try self.bindings.put(self.allocator, key, result);
        return result;
    }
};

fn append_namespace_property(
    output: *std.ArrayList(u8),
    allocator: Allocator,
    receiver: []const u8,
    name: []const u8,
) Allocator.Error!void {
    try output.appendSlice(allocator, receiver);
    try output.append(allocator, '.');
    try output.appendSlice(allocator, name);
}

fn declaration_identifier(tree: *const parser.ast.Tree, index: NodeIndex) ?NodeIndex {
    return switch (tree.data(index)) {
        .function => |node| node.id,
        .class => |node| node.id,
        .ts_enum_declaration => |node| node.id,
        else => null,
    };
}
