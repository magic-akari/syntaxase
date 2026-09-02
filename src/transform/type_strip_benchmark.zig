const std = @import("std");
const fixed_edit_buffer = @import("fixed_edit_buffer.zig");
const source_file = @import("source_file.zig");
const type_eraser = @import("type_eraser.zig");

const Allocator = std.mem.Allocator;

pub const ParsedSource = source_file.SourceFile;
pub const Edits = fixed_edit_buffer.FixedEditBuffer;
pub const Plan = fixed_edit_buffer.FixedEditPlan;

pub fn parse(allocator: Allocator, source: []const u8) Allocator.Error!ParsedSource {
    return ParsedSource.parse(allocator, source, .ts);
}

pub fn init_edits(allocator: Allocator, file: *const ParsedSource) Edits {
    return Edits.init(allocator, file.source());
}

pub fn erase(file: *ParsedSource, edits: *Edits) Allocator.Error!void {
    try type_eraser.erase(&file.tree, file.token_cursor(), edits);
}

pub fn seal(edits: *Edits) Allocator.Error!Plan {
    return edits.seal();
}

pub fn render_into(
    plan: *const Plan,
    output: *std.ArrayList(u8),
    output_allocator: Allocator,
) Allocator.Error!void {
    try plan.render_into(output, output_allocator);
}
