const std = @import("std");

/// Automatic-runtime exports in their stable import order. Tag names retain
/// the runtime's spelling and also define the preferred local identifiers.
pub const Helper = enum(u8) {
    jsx,
    jsxs,
    jsxDEV,
    Fragment,
    createElement,

    pub fn import_name(self: Helper) []const u8 {
        return @tagName(self);
    }

    pub fn local_base(self: Helper) []const u8 {
        return switch (self) {
            inline else => |helper| "_" ++ @tagName(helper),
        };
    }

    pub fn runtime_module(self: Helper, development: bool) ?[]const u8 {
        if (self == .createElement) return null;
        return if (development) "jsx-dev-runtime" else "jsx-runtime";
    }

    pub fn matches_local_name(name: []const u8) bool {
        for (local_bases) |base| {
            if (!std.mem.startsWith(u8, name, base)) continue;
            const suffix = name[base.len..];
            if (suffix.len == 0) return true;
            for (suffix) |byte| {
                if (!std.ascii.isDigit(byte)) break;
            } else return true;
        }
        return false;
    }
};

const local_bases = blk: {
    const helpers = std.enums.values(Helper);
    var names: [helpers.len][]const u8 = undefined;
    for (helpers, 0..) |helper, index| names[index] = helper.local_base();
    break :blk names;
};
