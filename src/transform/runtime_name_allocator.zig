const std = @import("std");

const Allocator = std.mem.Allocator;

/// Claims identifiers synthesized by runtime lowerings. Source names are
/// borrowed from the Yuku tree; generated names are owned by this allocator.
pub const RuntimeNameAllocator = struct {
    allocator: Allocator,
    source_names: std.StringHashMapUnmanaged(void) = .empty,
    reserved_names: std.StringHashMapUnmanaged(void) = .empty,
    next_suffixes: std.StringHashMapUnmanaged(u32) = .empty,
    owned_names: std.ArrayList([]u8) = .empty,
    owned_suffix_bases: std.ArrayList([]u8) = .empty,

    pub fn init(allocator: Allocator) RuntimeNameAllocator {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *RuntimeNameAllocator) void {
        self.source_names.deinit(self.allocator);
        self.reserved_names.deinit(self.allocator);
        self.next_suffixes.deinit(self.allocator);
        for (self.owned_names.items) |name| self.allocator.free(name);
        self.owned_names.deinit(self.allocator);
        for (self.owned_suffix_bases.items) |base| self.allocator.free(base);
        self.owned_suffix_bases.deinit(self.allocator);
    }

    pub fn add_source_name(self: *RuntimeNameAllocator, name: []const u8) Allocator.Error!void {
        try self.source_names.put(self.allocator, name, {});
    }

    pub fn reserve(self: *RuntimeNameAllocator, name: []const u8) Allocator.Error!void {
        try self.reserved_names.put(self.allocator, name, {});
    }

    pub fn is_used(self: *const RuntimeNameAllocator, name: []const u8) bool {
        return self.source_names.contains(name) or self.reserved_names.contains(name);
    }

    /// The preferred receiver is allowed to be the declaration's own source
    /// binding. A suffix is required only after another lowering claimed it or
    /// when an enum member needs the same local name.
    pub fn claim_receiver(
        self: *RuntimeNameAllocator,
        preferred: []const u8,
        member_names: *const std.StringHashMapUnmanaged(void),
    ) Allocator.Error![]const u8 {
        if (!self.reserved_names.contains(preferred) and !member_names.contains(preferred)) {
            return preferred;
        }
        return self.claim_suffixed(preferred, 1, member_names);
    }

    pub fn claim_member_alias(
        self: *RuntimeNameAllocator,
        member_name: []const u8,
        member_names: *const std.StringHashMapUnmanaged(void),
    ) Allocator.Error![]const u8 {
        const base = try std.fmt.allocPrint(self.allocator, "_{s}", .{member_name});

        if (!member_names.contains(base) and !self.is_used(base)) {
            self.reserve_owned(base) catch |err| {
                self.allocator.free(base);
                return err;
            };
            return base;
        }

        self.allocator.free(base);
        const suffix_base = try std.fmt.allocPrint(self.allocator, "_{s}", .{member_name});
        defer self.allocator.free(suffix_base);
        return self.claim_suffixed(suffix_base, 1, member_names);
    }

    /// Claims a generated helper name. The unsuffixed name must be reserved by
    /// the caller when it is free; this method handles only the collision path.
    pub fn claim_generated(
        self: *RuntimeNameAllocator,
        base: []const u8,
        minimum_suffix: u32,
    ) Allocator.Error![]const u8 {
        const unavailable: std.StringHashMapUnmanaged(void) = .empty;
        return self.claim_suffixed(base, minimum_suffix, &unavailable);
    }

    pub fn claim_generated_preferred(
        self: *RuntimeNameAllocator,
        preferred: []const u8,
        minimum_suffix: u32,
    ) Allocator.Error![]const u8 {
        if (self.is_used(preferred)) return self.claim_generated(preferred, minimum_suffix);
        const owned = try self.allocator.dupe(u8, preferred);
        self.reserve_owned(owned) catch |err| {
            self.allocator.free(owned);
            return err;
        };
        return owned;
    }

    fn claim_suffixed(
        self: *RuntimeNameAllocator,
        base: []const u8,
        minimum_suffix: u32,
        additionally_unavailable: *const std.StringHashMapUnmanaged(void),
    ) Allocator.Error![]const u8 {
        const next_suffix_ptr = try self.next_suffix(base, minimum_suffix);
        var suffix = @max(next_suffix_ptr.*, minimum_suffix);
        while (true) : (suffix += 1) {
            const candidate = try std.fmt.allocPrint(self.allocator, "{s}{d}", .{ base, suffix });
            if (self.is_used(candidate) or additionally_unavailable.contains(candidate)) {
                self.allocator.free(candidate);
                continue;
            }

            self.reserve_owned(candidate) catch |err| {
                self.allocator.free(candidate);
                return err;
            };
            next_suffix_ptr.* = suffix + 1;
            return candidate;
        }
    }

    fn next_suffix(
        self: *RuntimeNameAllocator,
        base: []const u8,
        minimum_suffix: u32,
    ) Allocator.Error!*u32 {
        if (self.next_suffixes.getPtr(base)) |existing| return existing;

        const owned_base = try self.allocator.dupe(u8, base);
        errdefer self.allocator.free(owned_base);
        try self.next_suffixes.put(self.allocator, owned_base, minimum_suffix);
        self.owned_suffix_bases.append(self.allocator, owned_base) catch |err| {
            _ = self.next_suffixes.remove(owned_base);
            return err;
        };
        return self.next_suffixes.getPtr(owned_base).?;
    }

    fn reserve_owned(self: *RuntimeNameAllocator, owned_name: []u8) Allocator.Error!void {
        try self.reserved_names.put(self.allocator, owned_name, {});
        self.owned_names.append(self.allocator, owned_name) catch |err| {
            _ = self.reserved_names.remove(owned_name);
            return err;
        };
    }
};

test "runtime receivers may reuse their source binding but avoid member locals" {
    const allocator = std.testing.allocator;
    var names = RuntimeNameAllocator.init(allocator);
    defer names.deinit();
    try names.add_source_name("E");
    try names.add_source_name("E1");

    var members: std.StringHashMapUnmanaged(void) = .empty;
    defer members.deinit(allocator);
    try members.put(allocator, "E", {});

    try std.testing.expectEqualStrings("E2", try names.claim_receiver("E", &members));
}

test "runtime suffix claims resume after the previous winner" {
    const allocator = std.testing.allocator;
    var names = RuntimeNameAllocator.init(allocator);
    defer names.deinit();
    try names.reserve("N");
    try names.add_source_name("N1");
    try names.add_source_name("N2");

    var unavailable: std.StringHashMapUnmanaged(void) = .empty;
    defer unavailable.deinit(allocator);
    try std.testing.expectEqualStrings("N3", try names.claim_receiver("N", &unavailable));
    try std.testing.expectEqualStrings("N4", try names.claim_receiver("N", &unavailable));
}
